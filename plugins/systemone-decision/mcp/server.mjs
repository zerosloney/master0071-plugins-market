#!/usr/bin/env node
// systemone-decision MCP server — stdio JSON-RPC, zero dependencies, requires Node >= 18.
// 只注册 2 个工具，控制工具 schema 的上下文开销，场景全部来自 scenarios.mjs 场景库：
//   1. systemone_scenario — action: list / describe / run / batch / stats，覆盖全部内置场景
//   2. systemone_decide   — 直接提交自定义 questions 的低层入口
// 供应商配置见插件 README.md：SYSTEMONE_API_KEY / SYSTEMONE_BASE_URL / SYSTEMONE_MODEL / SYSTEMONE_TIMEOUT_MS。
// stdout 只输出 JSON-RPC 消息，诊断信息一律走 stderr。

import { appendFileSync, createReadStream, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { findScenario, resolveScenarios } from './scenarios.mjs';
import { writeEndpointConfig, isInsecureBaseUrl, rejectDataPath } from '../endpoint-config.mjs';
import {
  buildSummary,
  deriveFields,
  formatAnswerLines,
  normalizeAnswer,
  normalizeDecision,
  renderTemplate,
} from './format.mjs';
import {
  SUPPORTED_TYPES,
  coerceOptionMap,
  coerceParamsCriteria,
  describeCriteria,
  hasCriteria,
  isBorderlineAnswer,
  isNonEmptyString,
  isSupportedType,
  supportsAddCriteria,
  toRequestQuestion,
  validateCriteria,
} from './question-types.mjs';

const SERVER_INFO = { name: 'systemone-decision', version: '0.5.10' };

// 本服务端实现的 MCP 协议版本，按新到旧排列。initialize 时若客户端报的是列表外的
// 版本，回落到列表首个（最新的），而不是原样回显——回显等于对任意版本都声称支持
//（口径同 worktree-ops/mcp/protocol.mjs）。
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// 启动自检：Node 版本过低时直接给出可读提示，而不是让后续代码在半路炸出难懂的异常。
// mcp.json 里 command 是裸名 "node"（规范允许），解释器由宿主的 PATH 解析——
// 宿主 PATH 里没有 node 属于宿主侧问题，本进程连启动都做不到；这里能兜住的是
// 「node 找到了但版本太老」这一类。
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write(
    `[systemone-decision] Node.js 18 or newer is required; this server runs on ${process.versions.node}.\n` +
      'Install a newer Node.js and make sure the host launches it with that version on PATH.\n',
  );
  process.exit(1);
}

// 场景库 = 内置 15 个 + 自定义场景（场景文件 / 设置页 / 环境变量，同 id 覆盖内置，
// 靠后的来源覆盖靠前的）。均在进程启动时读取，改动后需重启宿主生效；非法条目跳过并告警到 stderr。
const scenarioSources = [];
const scenarioLoadProblems = [];
const CUSTOM_JSON = process.env.SYSTEMONE_PLUGIN_SCENARIOS || process.env.SYSTEMONE_SCENARIOS || '';
const SCENARIOS_FILE_RAW = process.env.SYSTEMONE_PLUGIN_SCENARIOS_FILE || process.env.SYSTEMONE_SCENARIOS_FILE || '';
// 设置页的值不可信（与 baseUrl 同口径）：非 .json / 落在 .git 或插件安装目录内一律不读，
// 只记一条告警——内置 15 场景照常可用，配置错了不会静默毁掉别处的文件。
const SCENARIOS_FILE_REJECT = SCENARIOS_FILE_RAW.trim() === '' ? null : rejectDataPath(SCENARIOS_FILE_RAW, ['.json']);
const SCENARIOS_FILE = SCENARIOS_FILE_REJECT ? '' : SCENARIOS_FILE_RAW;
if (SCENARIOS_FILE.trim() !== '') {
  try {
    scenarioSources.push({ label: `场景文件 ${SCENARIOS_FILE}`, json: readFileSync(SCENARIOS_FILE, 'utf8') });
  } catch (e) {
    scenarioLoadProblems.push(`场景文件 ${SCENARIOS_FILE} 读取失败：${e.message}`);
  }
} else if (SCENARIOS_FILE_REJECT) {
  scenarioLoadProblems.push(
    `场景文件设置被拒绝（${SCENARIOS_FILE_REJECT}）：SYSTEMONE_SCENARIOS_FILE=${SCENARIOS_FILE_RAW}；已忽略该文件，仅用内置与设置页场景。`,
  );
}
scenarioSources.push({ label: '自定义场景', json: CUSTOM_JSON });
const { scenarios: SCENARIOS, problems: scenarioProblems } = resolveScenarios(scenarioSources);
const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
for (const problem of [...scenarioLoadProblems, ...scenarioProblems]) {
  process.stderr.write(`[systemone-decision] ${problem}\n`);
}
// 把已解析端点（设置页 > 环境变量 > 默认）落盘共享给需求预检 hook——hook 进程拿不到
// SYSTEMONE_PLUGIN_* 注入，不落盘的话设置页切换供应商后 hook 会打旧端点并静默失效。
// config() 是函数声明，已提升，此处可先调用。
writeEndpointConfig(config());

/** 结构化错误码（与 README「错误码」一节一一对应）。 */
const ERROR_CODES = {
  invalidParams: 'invalid_params', // 参数/用法非法：校验失败、未知场景、动作不支持
  missingApiKey: 'missing_api_key', // 未配置 API Key
  notConfigured: 'not_configured', // 依赖的功能未启用（如未配置审计日志）
  insecureEndpoint: 'insecure_endpoint', // 端点非加密，拒绝携带 Key 外发
  upstream: 'upstream_error', // 上游返回错误或响应不可用
  timeout: 'timeout', // 请求超时
  budgetExhausted: 'budget_exhausted', // 批量总预算用尽，该条未执行
  internal: 'internal_error', // 未预期异常
};

class ToolError extends Error {
  // code 是结构化错误码：isError 结果里带 errorCode，调用方按码归类，不去解析中文文案。
  // 文案会改（改文案不该翻转归类），错误码才是契约。
  constructor(message, code = ERROR_CODES.invalidParams) {
    super(message);
    this.code = code;
  }
}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function snippet(s) {
  const t = String(s);
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

function config() {
  // 配置优先级：宿主配置项（注入 SYSTEMONE_PLUGIN_*，空串视为未配置）> 环境变量 > 内置默认
  const timeoutRaw = Number(process.env.SYSTEMONE_PLUGIN_TIMEOUT_MS || process.env.SYSTEMONE_TIMEOUT_MS);
  return {
    apiKey: process.env.SYSTEMONE_API_KEY || process.env.UNISOUND_API_KEY || '',
    baseUrl: (process.env.SYSTEMONE_PLUGIN_BASE_URL || process.env.SYSTEMONE_BASE_URL || 'https://maas-api.unisound.com/v1').replace(/\/+$/, ''),
    model: process.env.SYSTEMONE_PLUGIN_MODEL || process.env.SYSTEMONE_MODEL || 'u2-decision',
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30000,
  };
}

// ---------- 决策缓存：相同输入（模型+state+问题）短 TTL 内免远端往返 ----------

const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.SYSTEMONE_PLUGIN_CACHE_TTL_MS || process.env.SYSTEMONE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000; // 默认 5 分钟；0 = 关闭
})();
const CACHE_MAX = 200;
const decisionCache = new Map(); // key → { at, data }；Map 迭代序即插入序，尾部为最近使用

// 稳定的 JSON 序列化：对象的键按字典序排。
// 缓存 key 用 JSON.stringify 时，逻辑相同的输入只要键序不同就落到不同 key 上，
// 缓存被白白打散——同一个 state 换个字段顺序就重新发一次远端请求，白付一次延迟与外发。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue; // 与 JSON.stringify 一致：undefined 值的键不出现
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

function cacheKey(model, state, request) {
  return `${model}\u0000${stableStringify(state)}\u0000${stableStringify(request)}`;
}

// ---------- 审计日志：LOG_FILE 指向 JSONL 文件时逐条追加，action=stats 消费 ----------

// 只收 .jsonl（README 与 stats 的读法本就是 JSONL）：把可扩展名限死，配置写错时最坏是没日志，
// 而不是把别的应用正在写的 .log 当成我们的账本轮转掉。
const LOG_FILE_RAW = process.env.SYSTEMONE_PLUGIN_LOG_FILE || process.env.SYSTEMONE_LOG_FILE || '';
const LOG_FILE_REJECT = LOG_FILE_RAW.trim() === '' ? null : rejectDataPath(LOG_FILE_RAW, ['.jsonl']);
const LOG_FILE = LOG_FILE_REJECT ? '' : LOG_FILE_RAW;
if (LOG_FILE_REJECT) {
  process.stderr.write(
    `[systemone-decision] 审计日志设置被拒绝（${LOG_FILE_REJECT}）：SYSTEMONE_LOG_FILE=${LOG_FILE_RAW}；本次进程不写审计日志。\n`,
  );
}
// 审计日志只追加不轮转的话，长跑进程会让 action=stats 一次读进几 MB 并逐行 parse。
// 超上限时**轮转**（旧文件改名保留一份）而非原地截断：截断等于删除，路径指错时用户数据当场消失。
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logBroken = false;
function appendLog(entry) {
  if (!LOG_FILE || logBroken) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    let size = 0;
    try {
      size = statSync(LOG_FILE).size;
    } catch {
      size = 0; // 文件还不存在
    }
    // 字节数按 UTF-8 计（Buffer.byteLength）：中文行用 line.length 会低估约 3 倍，5MB 上限实际装得下 ~15MB
    if (size + Buffer.byteLength(line) > LOG_MAX_BYTES) {
      const archive = `${LOG_FILE}.1`;
      // 只保留一代归档：先丢上一轮，再把当前整段改名保留——旧实现是 writeFileSync 原地清空，
      // 等于删除；一旦 LOG_FILE 指错，用户数据就不是"更早记录不保留"而是当场全没了。
      try {
        unlinkSync(archive);
      } catch {
        /* 还没有归档 */
      }
      renameSync(LOG_FILE, archive);
      writeFileSync(LOG_FILE, `# 已达 ${LOG_MAX_BYTES} 字节上限，上一段记录轮转至 ${archive}\n`);
    }
    appendFileSync(LOG_FILE, line);
  } catch (e) {
    logBroken = true;
    process.stderr.write(`[systemone-decision] 审计日志写入失败，本次进程内停用：${e.message}\n`);
  }
}

// ---------- 信任边界校验：发给外部 API 的请求体在此统一校验 ----------

// intentional-simple: 100K 字符按「对话数组级业务上下文」估的上限，挡住把整个代码库塞进
// state 的滥用（决策模型输入窗口远小于此）；若出现超大合法 state 用例再上调。
const STATE_MAX_CHARS = 100_000;
// 题数上限与场景库对齐：scenarios.mjs validateScenario 对场景 questions 收 1~16 个
//（延迟随问题数线性增长），decide 直提路径不允许更宽松
const QUESTIONS_MAX = 16;
// 单题 instructions 长度上限：instructions 每次请求都全文发给决策模型，挡住把整段文档
// 塞进单题说明的滥用（思路同 STATE_MAX_CHARS）
const INSTRUCTIONS_MAX_CHARS = 10_000;

function validateState(state) {
  if (state === null || (typeof state !== 'string' && typeof state !== 'object')) {
    throw new ToolError('state 必须是字符串、对象或数组');
  }
  let text;
  if (typeof state === 'string') {
    if (state.trim() === '') {
      throw new ToolError('state 不能是空字符串');
    }
    text = state;
  } else {
    // state 来自 stdin 的 JSON.parse，不存在循环引用，序列化只为量长度
    text = JSON.stringify(state);
  }
  if (text.length > STATE_MAX_CHARS) {
    throw new ToolError(`state 过大（${text.length} 字符 > 上限 ${STATE_MAX_CHARS}）：决策模型处理不了超长输入，请精简业务上下文`);
  }
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new ToolError('questions 必须是 {问题ID: 问题对象} 映射，且至少包含一个问题');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new ToolError('questions 至少包含一个问题');
  }
  // 题数上限与场景路径对齐：scenarios.mjs validateScenario 对场景 questions 收 1~16 个，
  // decide 直提路径不允许更宽松（延迟随问题数线性增长）
  if (entries.length > QUESTIONS_MAX) {
    throw new ToolError(`questions 一次最多 ${QUESTIONS_MAX} 个问题（当前 ${entries.length} 个）：延迟随问题数线性增长，请拆分为多次调用`);
  }
  for (const [qid, q] of entries) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ToolError(`questions.${qid} 必须是对象`);
    }
    if (!isSupportedType(q.type)) {
      throw new ToolError(`questions.${qid}.type 必须是 ${SUPPORTED_TYPES.join(' / ')}，收到: ${JSON.stringify(q.type)}`);
    }
    if (!isNonEmptyString(q.instructions)) {
      throw new ToolError(`questions.${qid}.instructions 必须是非空字符串`);
    }
    // instructions 每次请求都全文发给决策模型：挡住把整段文档塞进单题说明的滥用（思路同 STATE_MAX_CHARS）
    if (q.instructions.length > INSTRUCTIONS_MAX_CHARS) {
      throw new ToolError(`questions.${qid}.instructions 过长（${q.instructions.length} 字符 > 上限 ${INSTRUCTIONS_MAX_CHARS}）：请精简题目说明`);
    }
    // criteria 规则（choice 选项对象 / score 等级数组 / noul 无判据）收拢在 question-types，
    // 与场景加载校验同一套口径（谁严以谁为准）；报错取第一条
    for (const problem of validateCriteria(q)) {
      throw new ToolError(`questions.${qid}.criteria ${problem}`);
    }
  }
}

// ---------- 供应商接入点：换厂商只改环境变量，不动这里 ----------

async function callSystemone(state, questions, timeoutMsOverride) {
  const cfg = config();
  if (!cfg.apiKey) {
    throw new ToolError(
      '缺少 API Key：请设置环境变量 SYSTEMONE_API_KEY（或 UNISOUND_API_KEY）后重启宿主。' +
        'Key 只能走环境变量（各宿主都没有安全的凭据存储），unisound 的 Key 在 https://maas.unisound.com/admin/project/api-key 管理。',
      ERROR_CODES.missingApiKey
    );
  }
  const key = cacheKey(cfg.model, state, questions);
  if (CACHE_TTL_MS > 0) {
    const hit = decisionCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      decisionCache.delete(key);
      decisionCache.set(key, hit); // 刷新 LRU 位次
      return { ...hit.data, cached: true };
    }
  }
  // 有意保留的双实现：本函数与 hooks/decide-client.mjs 的 decide() 是同一 SystemOne 协议的
  // 两份传输层（URL 拼 /systemone、Bearer 头、{model, state, questions} 请求体、insecure 端点
  // 检查）——错误契约不同（这里抛 ToolError → MCP isError 结果；hook 侧抛错由调用方按
  // fail-open 契约放行），抽共享模块的回归风险大于收益。改协议形状时必须两处同步，
  // 以 test/smoke.mjs 与 test/hook.smoke.mjs 为锚。
  const url = `${cfg.baseUrl}/systemone`;
  // 不安全端点（非 https 且非本机回环）拒绝携带 Bearer Key：共享配置文件在用户可写目录，
  // 值不可信；明文外发凭据比单次工具调用失败严重得多
  if (isInsecureBaseUrl(cfg.baseUrl)) {
    throw new ToolError(
      `baseUrl ${cfg.baseUrl} 不是加密端点（https 或本机回环），为避免 API Key 明文外泄已拒绝请求。` +
        '请改用 https 端点（SYSTEMONE_BASE_URL 或插件设置页）。本机调试可用 http://127.0.0.1:<port>。',
      ERROR_CODES.insecureEndpoint
    );
  }
  // 与 hooks 侧 decide-client 同口径：调用方传入的剩余预算只收缩、不放大已配置的单条超时
  const timeoutMs = Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0 ? Math.min(cfg.timeoutMs, timeoutMsOverride) : cfg.timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) {
      throw new ToolError(`systemone 请求超时（${timeoutMs}ms）：POST ${url}`, ERROR_CODES.timeout);
    }
    throw new ToolError(`systemone 请求失败：POST ${url}，原因：${e.message}`, ERROR_CODES.upstream);
  }
  // 响应头之后 body 仍可能缓慢滴流：读取阶段继续受同一 timer 保护——若收到响应头就清掉
  // timer，故障端点会让 tools/call 在 await res.text() 上无限挂起
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (ac.signal.aborted) {
      throw new ToolError(`systemone 响应体读取超时（${timeoutMs}ms）：POST ${url}`, ERROR_CODES.timeout);
    }
    throw e; // 非 abort 的读取失败维持原样上抛（dispatch 归为工具异常）
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let hint = '';
    if (/permission/i.test(text)) {
      hint =
        `。提示：Key 认证已通过，但没有 ${cfg.model} 模型权限——` +
        '请到 MaaS 控制台确认该 Key 所属项目已开通对应模型；' +
        '若是刚更换过 SYSTEMONE_API_KEY，注意运行中的进程持有启动时的环境变量快照，需重启宿主程序后生效';
    }
    throw new ToolError(`systemone HTTP ${res.status}：${snippet(text)}（POST ${url}）${hint}`, ERROR_CODES.upstream);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ToolError(`systemone 响应不是合法 JSON：${snippet(text)}`, ERROR_CODES.upstream);
  }
  if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
    throw new ToolError(`systemone 响应缺少 answers 字段：${snippet(text)}`, ERROR_CODES.upstream);
  }
  if (CACHE_TTL_MS > 0) {
    decisionCache.set(key, { at: Date.now(), data });
    if (decisionCache.size > CACHE_MAX) {
      decisionCache.delete(decisionCache.keys().next().value); // 淘汰最久未使用
    }
  }
  return data;
}

function metaOf(data) {
  return {
    model: data.model,
    request_id: data.request_id,
    latency_ms: data.latency_ms,
    usage: data.usage,
  };
}

function thresholdOf(args, fallback = 0.7) {
  const raw = args.confidenceThreshold;
  // 空值一律回退 fallback（调用参数未给时为场景默认阈值，场景未定义则 0.7），
  // 与 config() 把空串视为「未配置」同一套约定：
  // Number(null) 与 Number('') 都得 0，而 0 落在合法区间内，会把复核阈值静默关掉
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  // 非数字非字符串（true / [] / {}）不参与强转——Number([]) 与 Number(false) 同样得 0
  const t = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
    throw new ToolError('confidenceThreshold 必须是 0~1 之间的数字');
  }
  return t;
}

function formatOf(args) {
  const raw = args.format;
  // 空串视为未配置（回退 full），与 thresholdOf / config() 的「空串=未配置」同一套约定
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return 'full';
  if (raw === 'full' || raw === 'brief') return raw;
  throw new ToolError('format 必须是 full（默认，完整明细）或 brief（精简，省上下文）');
}

// ---------- 决策执行（场景 run 与 systemone_decide 共用） ----------

/**
 * @param {unknown} state - 业务上下文
 * @param {object} questions - 问题定义（含本地展示字段 label，发送前剥离）
 * @param {object} opts - 执行选项
 * @param {number} opts.threshold - 低置信度阈值
 * @param {object} [opts.meta] - 场景元数据 { id, title, derive, recommendation }，自定义决策留空
 * @param {string} [opts.format] - full（默认，含逐题明细/摘要/原始响应）| brief（精简，省上下文）
 * @param {number} [opts.timeoutMs] - 本次请求的超时上限（批量判定按剩余预算收敛）
 */
async function executeDecision(state, questions, { threshold, meta = {}, format = 'full', timeoutMs } = {}) {
  validateState(state);
  validateQuestions(questions);
  const request = {};
  for (const [qid, q] of Object.entries(questions)) {
    request[qid] = toRequestQuestion(q); // noul 无判据，剥掉 criteria
  }
  const data = await callSystemone(state, request, timeoutMs);

  const answers = {};
  const low = [];
  for (const [qid, q] of Object.entries(questions)) {
    const a = normalizeAnswer(q, data.answers[qid]);
    answers[qid] = a;
    if (!a.present) {
      low.push(qid); // 响应缺失该答案，视作无法判断
    } else if (a.confidence === null || a.confidence < threshold) {
      // confidence 缺失/非法（已在 normalizeAnswer 收敛为 null）与低于阈值同等对待：
      // 无法证明可信的判定不自动放行
      low.push(qid);
    } else if (isBorderlineAnswer(a, q, data.answers[qid])) {
      low.push(qid);
    }
  }

  const { decision, labels, confidences } = normalizeDecision(data.answers, questions);
  const derived = deriveFields(meta.derive, decision);
  const recommendation = meta.recommendation
    ? renderTemplate(meta.recommendation, { labels, decision, confidences, derived })
    : '';
  const summary = buildSummary({
    title: meta.title || 'SystemOne 通用决策',
    model: data.model,
    requestId: data.request_id,
    latencyMs: data.latency_ms,
    lines: formatAnswerLines(questions, data.answers),
    recommendation,
    needsReview: low.length > 0,
    lowQuestions: low,
  });

  const cached = data.cached === true;
  appendLog({
    scenario: meta.id ?? null,
    model: data.model,
    request_id: data.request_id,
    latency_ms: data.latency_ms,
    decision,
    derived,
    confidences,
    needs_human_review: low.length > 0,
    low_confidence_questions: low,
    cached,
  });
  if (format === 'brief') {
    return {
      ok: true,
      scenario: meta.id ?? null,
      model: data.model,
      latency_ms: data.latency_ms,
      decision,
      labels,
      derived,
      confidences,
      needs_human_review: low.length > 0,
      low_confidence_questions: low,
      confidence_threshold: threshold,
      recommendation,
      cached,
    };
  }
  return {
    ok: true,
    scenario: meta.id ?? null,
    meta: metaOf(data),
    answers,
    decision,
    labels,
    derived,
    confidences,
    needs_human_review: low.length > 0,
    low_confidence_questions: low,
    confidence_threshold: threshold,
    recommendation,
    summary,
    raw: data,
    cached,
  };
}

// ---------- 场景调度：list / describe / run ----------

function listScenarios(keyword) {
  const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
  // 被跳过的场景定义（非法条目 / 场景文件读不到）：原因随结果一起返回，
  // 别只留在启动日志的 stderr 里——用户在 action=list 里看不到就无从判断自己写错了什么。
  const skipped = [...scenarioLoadProblems, ...scenarioProblems];
  const items = SCENARIOS.filter((s) => {
    if (!needle) return true;
    return [s.id, s.title, s.description, ...s.aliases].join(' ').toLowerCase().includes(needle);
  }).map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    aliases: s.aliases,
    source: s.source,
    question_count: Object.keys(s.questions).length,
    questions: Object.entries(s.questions).map(([qid, q]) => `${qid}:${q.type}`),
  }));
  const summary = [
    `## SystemOne 场景库（${items.length} 个）`,
    ...items.map(
      (s) => `- **${s.id}**${s.source === 'custom' ? '（自定义）' : ''}：${s.title} — ${s.description}（${s.questions.join('，')}）`
    ),
    // 被跳过的场景定义要说清楚「哪条、为什么」：原先只写进启动日志的 stderr，
    // 用户在 action=list 里看不到，只能靠猜（整条场景消失，且没有解释）。
    skipped.length
      ? `\n⚠ ${skipped.length} 条场景定义被跳过（原因见 problems 字段）：${skipped.slice(0, 3).join('；')}${skipped.length > 3 ? ' …' : ''}`
      : '',
    '',
    '用 action=describe 查看场景问题定义，用 action=run 执行决策。',
  ].join('\n');
  return { ok: true, action: 'list', count: items.length, scenarios: items, problems: skipped, summary };
}

function describeScenario(ref) {
  if (!isNonEmptyString(ref)) {
    throw new ToolError(`action=describe 需要 scenario（场景 id 或别名），可用场景：${SCENARIO_IDS.join('、')}`);
  }
  const scenario = findScenario(SCENARIOS, ref);
  if (!scenario) {
    throw new ToolError(`未知场景 "${ref}"，可用场景：${SCENARIO_IDS.join('、')}`);
  }
  const questions = Object.entries(scenario.questions).map(([qid, q]) => ({
    id: qid,
    type: q.type,
    label: q.label,
    instructions: q.instructions,
    criteria: q.criteria ?? null,
  }));
  const summary = [
    `## ${scenario.title}`,
    `- **场景 id**：${scenario.id}${scenario.aliases.length ? `（别名：${scenario.aliases.join('、')}）` : ''}`,
    `- **说明**：${scenario.description}`,
    ...questions.map((q) => {
      const criteria = describeCriteria(q);
      return `- **${q.label}** \`${q.id}\`（${q.type}）：${q.instructions}\n  - 选项：${criteria}`;
    }),
    scenario.recommendation ? `- **建议模板**：${scenario.recommendation}` : null,
    '',
    '用 action=run 执行，可用 params 按问题 id 覆盖 criteria / instructions。',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ok: true,
    action: 'describe',
    scenario: scenario.id,
    title: scenario.title,
    description: scenario.description,
    aliases: scenario.aliases,
    source: scenario.source,
    questions,
    recommendation: scenario.recommendation,
    summary,
  };
}

/** 按 params 覆盖场景问题定义：instructions / label 局部替换，criteria 整体替换，addCriteria 在 choice 上追加选项。 */
function applyParams(scenario, params) {
  if (params === undefined || params === null) return scenario.questions;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ToolError('params 必须是 {问题ID: 覆盖项} 对象');
  }
  const knownIds = Object.keys(scenario.questions);
  for (const qid of Object.keys(params)) {
    if (!knownIds.includes(qid)) {
      throw new ToolError(`params 包含未知问题 id "${qid}"，场景 ${scenario.id} 可覆盖：${knownIds.join('、')}`);
    }
  }
  const merged = {};
  for (const [qid, question] of Object.entries(scenario.questions)) {
    const override = params[qid];
    if (override === undefined) {
      merged[qid] = question;
      continue;
    }
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      throw new ToolError(`params.${qid} 必须是对象`);
    }
    const next = { ...question };
    if (typeof override.instructions === 'string' && override.instructions.trim() !== '') {
      next.instructions = override.instructions;
    }
    if (typeof override.label === 'string' && override.label.trim() !== '') {
      next.label = override.label;
    }
    if (override.criteria !== undefined) {
      if (!hasCriteria(question.type)) {
        throw new ToolError(`params.${qid}.criteria：noul 问题没有 criteria`);
      }
      // criteria 规则收拢在 question-types：choice 选项映射 String 化（null/undefined 先拦），
      // score 至少 2 级；数量上下限仍由 executeDecision → validateQuestions 兜底
      const { criteria, problem } = coerceParamsCriteria(question.type, override.criteria);
      if (problem) {
        throw new ToolError(`params.${qid}.criteria（${question.type}）${problem}`);
      }
      next.criteria = criteria;
    }
    if (override.addCriteria !== undefined) {
      if (!supportsAddCriteria(question.type)) {
        throw new ToolError(`params.${qid}.addCriteria 仅支持 choice 问题`);
      }
      // 与 criteria 主路径同一套口径（question-types 的 coerceOptionMap）：键与值 String 化
      // 容忍 JSON 里的数字键/枚举，null/undefined 先拦；数量不设限（追加单个选项是合法意图），
      // 合并后的总选项数仍由 executeDecision → validateQuestions 的量表上限兜底。
      const { criteria: added, problem } = coerceOptionMap(override.addCriteria);
      if (problem) {
        throw new ToolError(`params.${qid}.addCriteria ${problem}`);
      }
      next.criteria = { ...(next.criteria || {}), ...added };
    }
    merged[qid] = next;
  }
  return merged;
}

function scenarioMeta(scenario) {
  return { id: scenario.id, title: scenario.title, derive: scenario.derive, recommendation: scenario.recommendation };
}

function runScenario(args) {
  if (!isNonEmptyString(args.scenario)) {
    throw new ToolError(`action=run 需要 scenario（场景 id 或别名），可用场景：${SCENARIO_IDS.join('、')}`);
  }
  const scenario = findScenario(SCENARIOS, args.scenario);
  if (!scenario) {
    throw new ToolError(`未知场景 "${args.scenario}"，可用场景：${SCENARIO_IDS.join('、')}`);
  }
  const questions = applyParams(scenario, args.params);
  const format = formatOf(args);
  // 阈值优先级：调用参数 > 场景定义默认（如 security_triage 0.8）> 全局 0.7
  return executeDecision(args.state, questions, {
    threshold: thresholdOf(args, scenario.confidenceThreshold ?? 0.7),
    meta: scenarioMeta(scenario),
    format,
  });
}

// ---------- 批量决策：同一场景对多条 state 依次判定，单条失败不中断 ----------

const BATCH_MAX = 10;
// 整批聚合预算：串行判定 10 条若各吃满单条超时（默认 30s）会到 300s，而宿主 MCP 客户端
// 对单次工具调用的超时通常在 30s 量级，客户端先断则已完成结果全丢。留 25s 收口。
// 预算可用环境变量注入（SYSTEMONE_BATCH_BUDGET_MS，0 = 全部条目直接标记未执行），
// 供测试真实触发 budget_exhausted 分支，无需 mock 时钟。
const BATCH_BUDGET_MS = (() => {
  const raw = Number(process.env.SYSTEMONE_PLUGIN_BATCH_BUDGET_MS || process.env.SYSTEMONE_BATCH_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 25_000;
})();

async function runBatch(args) {
  if (!isNonEmptyString(args.scenario)) {
    throw new ToolError(`action=batch 需要 scenario（场景 id 或别名），可用场景：${SCENARIO_IDS.join('、')}`);
  }
  const scenario = findScenario(SCENARIOS, args.scenario);
  if (!scenario) {
    throw new ToolError(`未知场景 "${args.scenario}"，可用场景：${SCENARIO_IDS.join('、')}`);
  }
  if (!Array.isArray(args.states) || args.states.length < 2) {
    throw new ToolError('states 必须是至少 2 个元素的数组（单条判定用 action=run）');
  }
  if (args.states.length > BATCH_MAX) {
    throw new ToolError(`states 一次最多 ${BATCH_MAX} 条（当前 ${args.states.length} 条）：批量过大易超时，请分批`);
  }
  const questions = applyParams(scenario, args.params);
  const threshold = thresholdOf(args, scenario.confidenceThreshold ?? 0.7);
  const meta = scenarioMeta(scenario);
  const cfg = config();
  const startedAt = Date.now();
  const results = [];
  for (const [index, state] of args.states.entries()) {
    const left = BATCH_BUDGET_MS - (Date.now() - startedAt);
    if (left <= 0) {
      // 预算耗尽：逐条标出未执行并提示分批，已完成的结果照常返回，不让客户端超时把成果全吞掉。
      // budget_exhausted 是结构化标记：判定不得依赖 error 文案，改文案不该翻转归类
      results.push({
        index,
        ok: false,
        budget_exhausted: true,
        errorCode: ERROR_CODES.budgetExhausted,
        error: `批量总预算 ${BATCH_BUDGET_MS}ms 已用尽，该条未执行，请分批重试`,
      });
      continue;
    }
    // 单条超时 = min(配置的单条上限, 剩余预算按剩余条目均分)。
    // 只取 min(cfg.timeoutMs, 剩余预算) 时第 1 条最坏能吃满整批预算（单条上限 30s > 整批 25s），
    // 后面 9 条全被标 budget_exhausted——用户拿到的结果只剩 1 条。均分后没有哪一条能独占预算：
    // 批次总耗时仍锁在 BATCH_BUDGET_MS 内，且每条都有一次被判定的机会。
    // 代价（如实说明）：端点本身慢于均分份额时，本批每条都会超时——报错一致、可按更小批次重试，
    // 好过「一条慢的拖死其余、其余连跑都没跑」。
    const share = Math.max(1, Math.floor(left / (args.states.length - index)));
    const timeoutMs = Math.min(cfg.timeoutMs, share);
    try {
      // batch 走精简形状（不含逐题明细/摘要/原始响应），避免批量返回撑爆上下文
      const r = await executeDecision(state, questions, { threshold, meta, format: 'brief', timeoutMs });
      results.push({ index, ...r, ok: true }); // ok 显式置后：brief 结果本就带 ok:true，展开后仍须保住
    } catch (e) {
      results.push({
        index,
        ok: false,
        errorCode: e instanceof ToolError ? e.code : ERROR_CODES.internal,
        error: e.message,
      });
    }
  }
  const failed = results.filter((r) => !r.ok);
  const exhausted = failed.filter((r) => r.budget_exhausted === true).length;
  const summary = [
    `## ${scenario.title} · 批量判定（${results.length} 条）`,
    ...results.map((r) =>
      r.ok
        ? `- #${r.index + 1}：${r.recommendation || '（无建议）'}${r.needs_human_review ? ' ⚠️ 需人工复核' : ''}`
        : `- #${r.index + 1}：失败 — ${r.error}`
    ),
    failed.length
      ? `\n${failed.length} 条失败（其中 ${exhausted} 条因超出 ${BATCH_BUDGET_MS}ms 批量预算未执行）${exhausted ? '，其余正常，请对未执行部分分批重试' : '，其余正常'}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    ok: true,
    action: 'batch',
    scenario: scenario.id,
    count: results.length,
    failed: failed.length,
    budget_exhausted: exhausted > 0,
    elapsed_ms: Date.now() - startedAt,
    results,
    summary,
  };
}

// ---------- 决策统计：消费审计日志（LOG_FILE），按场景汇总复核率与判定分布 ----------

// 流式逐行读取，不整文件读进内存再 split/parse：
// 审计日志轮转上限 5MB（可达 5 万行），一次 readFileSync + split('\n') + 逐行 JSON.parse
// 会同步阻塞事件循环几百毫秒——MCP 服务是单线程 stdio 进程，期间所有工具调用都排队。
// 统计口径不变：总条数、按场景聚合、缓存命中、平均延迟、高频判定都照旧。
async function readStats() {
  if (!LOG_FILE) {
    throw new ToolError(
      '未启用审计日志：设置环境变量 SYSTEMONE_LOG_FILE（或插件设置项）指向一个 JSONL 文件路径后，' +
        '每次决策会逐条落盘，action=stats 才有数据可统计',
      ERROR_CODES.notConfigured
    );
  }
  const byScenario = new Map();
  let total = 0;
  let cached = 0;
  let readable = true;
  const lines = createInterface({
    input: createReadStream(LOG_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // 坏行跳过（与旧实现一致：解析失败不当条目）
      }
      if (!e) continue; // 与旧实现的 filter(Boolean) 一致：JSON null 不计入
      total += 1;
      const id = e.scenario ?? '(通用决策)';
      const s = byScenario.get(id) ?? { count: 0, review: 0, cached: 0, latency_total: 0, decisions: {} };
      s.count += 1;
      if (e.needs_human_review) s.review += 1;
      if (e.cached) {
        s.cached += 1;
        cached += 1;
      }
      s.latency_total += Number(e.latency_ms) || 0;
      for (const [qid, v] of Object.entries(e.decision || {})) {
        const key = `${qid}=${typeof v === 'boolean' ? (v ? 'true' : 'false') : v}`;
        s.decisions[key] = (s.decisions[key] ?? 0) + 1;
      }
      byScenario.set(id, s);
    }
  } catch (e) {
    readable = false;
  } finally {
    lines.close();
  }
  if (!readable) {
    throw new ToolError(`审计日志不存在或不可读：${LOG_FILE}（还没有决策落盘？）`, ERROR_CODES.notConfigured);
  }
  if (total === 0) {
    throw new ToolError(`审计日志为空：${LOG_FILE}（还没有决策落盘？）`, ERROR_CODES.notConfigured);
  }
  const scenarios = {};
  for (const [id, s] of byScenario) {
    scenarios[id] = {
      count: s.count,
      review_rate: Number((s.review / s.count).toFixed(3)),
      cached: s.cached,
      avg_latency_ms: Math.round(s.latency_total / s.count),
      top_decisions: Object.fromEntries(Object.entries(s.decisions).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    };
  }
  // 摘要与结果都只回显文件名，不回显绝对路径：工具结果整体进模型上下文，
  // 绝对路径会带出用户名与目录结构（对模型判定没有增量信息）。
  const logName = path.basename(LOG_FILE);
  const summary = [
    `## SystemOne 决策统计（${total} 条，日志 ${logName}）`,
    ...Object.entries(scenarios).map(([id, s]) => {
      const top = Object.entries(s.top_decisions)
        .slice(0, 3)
        .map(([k, n]) => `${k}×${n}`)
        .join('，');
      return `- **${id}**：${s.count} 次，复核率 ${(s.review_rate * 100).toFixed(1)}%，缓存命中 ${s.cached}，平均延迟 ${s.avg_latency_ms}ms${top ? `；高频判定：${top}` : ''}`;
    }),
  ].join('\n');
  return { ok: true, action: 'stats', log_file: logName, total, cached, scenarios, summary };
}

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'systemone_scenario',
    description:
      'SystemOne 场景决策：把业务状态与预置的结构化问题一次性提交给决策模型，返回带概率分布的判定、' +
      '归一化决策（decision/labels/derived）与处置建议（recommendation）。action=list 列出场景，' +
      'action=describe 查看场景问题定义，action=run 执行决策，action=batch 对同一场景批量判定多条 state' +
      '（最多 10 条，返回精简结果；整批预算 25s，超预算的条目会标为未执行并提示分批），' +
      'action=stats 汇总审计日志（需配置 SYSTEMONE_LOG_FILE）。' +
      '内置场景：customer_service 工单分流、content_moderation 内容审核、agent_routing 智能体路由、' +
      'result_verification 结果校验、software_dev 软件开发任务判定（类型/复杂度/是否先探查代码库）、' +
      'test_failure 测试失败根因分流、pr_review 代码评审合并门禁、incident_response 事故定级与回滚处置、' +
      'security_triage 安全告警真伪与遏制（默认阈值 0.8）、sales_lead 销售线索、risk_control 金融风控、' +
      'recruiting 招聘筛选、data_governance 数据打标归因、education 教育题目归类、requirements 需求优先级。' +
      '场景判据可用 params 按问题 id 覆盖（criteria 整体替换 / addCriteria 追加选项）；' +
      '相同输入 5 分钟内命中本地缓存（cached 标记），可用 SYSTEMONE_CACHE_TTL_MS=0 关闭。' +
      '还可用 SYSTEMONE_SCENARIOS 环境变量或 SYSTEMONE_SCENARIOS_FILE 场景文件追加自定义场景，action=list 可见全部。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'run', 'batch', 'stats'],
          description: 'list=列出场景；describe=查看场景问题定义；run=执行决策；batch=批量决策；stats=决策统计',
        },
        scenario: {
          type: 'string',
          description: '场景 id 或别名（describe/run/batch 必填），如 customer_service / 工单分流 / software_dev',
        },
        state: {
          type: ['string', 'object', 'array'],
          description:
            '业务上下文（run 必填）：工单文本、任务描述、对话数组或结构化对象，非字符串会被序列化后送入模型',
        },
        states: {
          type: 'array',
          description:
            '业务上下文数组（batch 必填，2~10 条）：每条与 state 同构，逐条判定。整批共享 25s 预算，' +
            '超预算的条目返回 error 标注未执行，请分批重试',
        },
        params: {
          type: 'object',
          additionalProperties: { type: 'object' },
          description:
            '可选：按问题 id 覆盖场景问题定义。' +
            '{instructions, label, criteria(整体替换选项，choice 传对象/score 传≥2级标签数组), addCriteria(仅 choice，追加选项)}，' +
            '如 {"department":{"criteria":{"vip":"VIP 专属通道","general":"普通通道"}}}',
        },
        keyword: { type: 'string', description: '可选：action=list 时按关键词过滤场景（匹配 id/标题/说明/别名）' },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值；未传时用场景默认（如 security_triage 0.8），再回退 0.7' },
        format: {
          type: 'string',
          enum: ['full', 'brief'],
          description: '可选：full=完整结果（默认，含逐题明细/摘要/原始响应）；brief=精简结果（省上下文）',
        },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const action = args.action;
      if (action === 'list') return listScenarios(args.keyword);
      if (action === 'describe') return describeScenario(args.scenario);
      if (action === 'run') return runScenario(args);
      if (action === 'batch') return runBatch(args);
      if (action === 'stats') return readStats();
      throw new ToolError('action 必须是 list / describe / run / batch / stats');
    },
  },
  {
    name: 'systemone_decide',
    description:
      '通用决策（SystemOne 协议）：一次请求对同一业务上下文提出多个结构化问题（choice 单选 / noul 概率 / score 评分），' +
      '返回带概率分布和置信度的判定。场景库没有的临时判断用它；已有内置场景时优先用 systemone_scenario。',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: ['string', 'object', 'array'],
          description: '业务上下文：工单文本、对话数组或结构化对象，非字符串会被序列化后送入模型',
        },
        questions: {
          type: 'object',
          description:
            '问题映射 {问题ID: 问题对象}。问题对象：{type: "choice", instructions, criteria: {选项ID: 描述}} | ' +
            '{type: "noul", instructions}（回答是/否类，返回 0~1 概率）| {type: "score", instructions, criteria: [等级描述...]}（索引即分值）。' +
            'label 可选（本地展示名，用于逐题明细与摘要；不发给 API）',
        },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
        format: {
          type: 'string',
          enum: ['full', 'brief'],
          description: '可选：full=完整结果（默认）；brief=精简结果（省上下文）',
        },
      },
      required: ['state', 'questions'],
    },
    handler: async (args) =>
      executeDecision(args.state, args.questions || {}, { threshold: thresholdOf(args), format: formatOf(args) }),
  },
];

// ---------- stdio JSON-RPC 主循环 ----------

function reply(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function dispatch(msg) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SERVER_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const params = msg.params || {};
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        throw new RpcError(-32602, `未知工具: ${params.name}`);
      }
      try {
        const result = await tool.handler(params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        // isError 结果带结构化 errorCode：调用方按码归类（参数非法 / 缺 Key / 上游错误 / 超时…），
        // 不去解析中文文案——文案会改，改文案不该翻转归类。
        if (e instanceof ToolError) {
          return {
            content: [{ type: 'text', text: `工具 ${tool.name} 失败：${e.message}` }],
            isError: true,
            errorCode: e.code,
          };
        }
        return {
          content: [{ type: 'text', text: `工具 ${tool.name} 异常：${e.message || e}` }],
          isError: true,
          errorCode: ERROR_CODES.internal,
        };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') continue;
    if (msg.jsonrpc !== '2.0') continue;
    // id 非法（对象/数组/布尔）时无法回写合法响应，直接忽略
    if (msg.id !== undefined && msg.id !== null && typeof msg.id !== 'string' && typeof msg.id !== 'number') continue;
    if (msg.id === undefined || msg.id === null) continue; // notification，无需响应
    dispatch(msg)
      .then((result) => reply({ jsonrpc: '2.0', id: msg.id, result }))
      .catch((e) => {
        const code = e instanceof RpcError ? e.code : -32603;
        reply({ jsonrpc: '2.0', id: msg.id, error: { code, message: e.message || String(e) } });
      });
  }
});
process.stdin.on('end', () => process.exit(0));

process.on('uncaughtException', (e) => {
  process.stderr.write(`[systemone-decision] uncaught: ${e.stack || e}\n`);
  // 记完日志必须退出：进程带未知状态继续跑，宿主 MCP 客户端会一直等那条永远不会到的响应，
  // 只能耗到自己的超时才发现出了问题——中间这段时间里会话是「假活」的。
  // stdio 模式下重启子进程是廉价且安全的（服务无状态，每次调用都是一次独立判定），
  // 退出码 1 让宿主看到明确失败，而不是一个静默卡住的会话。
  process.exit(1);
});
