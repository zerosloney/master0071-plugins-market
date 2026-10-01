#!/usr/bin/env node
// systemone-decision MCP server — stdio JSON-RPC, zero dependencies, requires Node >= 18.
// 只注册 2 个工具，控制工具 schema 的上下文开销，场景全部来自 scenarios.mjs 场景库：
//   1. systemone_scenario — action: list / describe / run，覆盖全部内置场景
//   2. systemone_decide   — 直接提交自定义 questions 的低层入口
// 供应商配置见插件 README.md：SYSTEMONE_API_KEY / SYSTEMONE_BASE_URL / SYSTEMONE_MODEL / SYSTEMONE_TIMEOUT_MS。
// stdout 只输出 JSON-RPC 消息，诊断信息一律走 stderr。

import { findScenario, resolveScenarios } from './scenarios.mjs';
import {
  buildSummary,
  deriveFields,
  formatAnswerLines,
  normalizeAnswer,
  normalizeDecision,
  renderTemplate,
} from './format.mjs';

const SERVER_INFO = { name: 'systemone-decision', version: '0.4.4' };
const SUPPORTED_TYPES = ['choice', 'noul', 'score'];

// 场景库 = 内置 11 个 + 设置页/环境变量注入的自定义场景（同 id 覆盖内置）。
// 环境变量在进程启动时注入，改动设置后需重启宿主生效；非法自定义条目跳过并告警到 stderr。
const { scenarios: SCENARIOS, problems: scenarioProblems } = resolveScenarios(
  process.env.SYSTEMONE_PLUGIN_SCENARIOS || process.env.SYSTEMONE_SCENARIOS || ''
);
const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
for (const problem of scenarioProblems) {
  process.stderr.write(`[systemone-decision] ${problem}\n`);
}

class ToolError extends Error {}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
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

// ---------- 信任边界校验：发给外部 API 的请求体在此统一校验 ----------

function validateState(state) {
  if (state === null || (typeof state !== 'string' && typeof state !== 'object')) {
    throw new ToolError('state 必须是字符串、对象或数组');
  }
  if (typeof state === 'string' && state.trim() === '') {
    throw new ToolError('state 不能是空字符串');
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
  for (const [qid, q] of entries) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ToolError(`questions.${qid} 必须是对象`);
    }
    if (!SUPPORTED_TYPES.includes(q.type)) {
      throw new ToolError(`questions.${qid}.type 必须是 ${SUPPORTED_TYPES.join(' / ')}，收到: ${JSON.stringify(q.type)}`);
    }
    if (!isNonEmptyString(q.instructions)) {
      throw new ToolError(`questions.${qid}.instructions 必须是非空字符串`);
    }
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length === 0) {
        throw new ToolError(`questions.${qid}.criteria 必须是非空对象 {选项ID: 选项描述}`);
      }
      if (Object.keys(c).length > 255) {
        throw new ToolError(`questions.${qid}.criteria 选项数超过上限 255`);
      }
      for (const [k, v] of Object.entries(c)) {
        if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
          throw new ToolError(`questions.${qid}.criteria 每个选项的 ID 和描述必须是非空字符串`);
        }
      }
    }
    if (q.type === 'score') {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length === 0) {
        throw new ToolError(`questions.${qid}.criteria 必须是非空数组 [等级描述, ...]，索引即分值`);
      }
      if (c.length > 255) {
        throw new ToolError(`questions.${qid}.criteria 等级数超过上限 255`);
      }
      for (const v of c) {
        if (!isNonEmptyString(v)) {
          throw new ToolError(`questions.${qid}.criteria 的每个等级描述必须是非空字符串`);
        }
      }
    }
  }
}

// ---------- 供应商接入点：换厂商只改环境变量，不动这里 ----------

async function callSystemone(state, questions) {
  const cfg = config();
  if (!cfg.apiKey) {
    throw new ToolError(
      '缺少 API Key：请设置环境变量 SYSTEMONE_API_KEY（或 UNISOUND_API_KEY）后重启宿主。' +
        'Key 只能走环境变量（各宿主都没有安全的凭据存储），unisound 的 Key 在 https://maas.unisound.com/admin/project/api-key 管理。'
    );
  }
  const url = `${cfg.baseUrl}/systemone`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
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
      throw new ToolError(`systemone 请求超时（${cfg.timeoutMs}ms）：POST ${url}`);
    }
    throw new ToolError(`systemone 请求失败：POST ${url}，原因：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (/permission/i.test(text)) {
      hint =
        `。提示：Key 认证已通过，但没有 ${cfg.model} 模型权限——` +
        '请到 MaaS 控制台确认该 Key 所属项目已开通对应模型；' +
        '若是刚更换过 SYSTEMONE_API_KEY，注意运行中的进程持有启动时的环境变量快照，需重启宿主程序后生效';
    }
    throw new ToolError(`systemone HTTP ${res.status}：${snippet(text)}（POST ${url}）${hint}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ToolError(`systemone 响应不是合法 JSON：${snippet(text)}`);
  }
  if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
    throw new ToolError(`systemone 响应缺少 answers 字段：${snippet(text)}`);
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

function thresholdOf(args) {
  const raw = args.confidenceThreshold;
  // 空值一律回退默认，与 config() 把空串视为「未配置」同一套约定：
  // Number(null) 与 Number('') 都得 0，而 0 落在合法区间内，会把复核阈值静默关掉
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return 0.7;
  // 非数字非字符串（true / [] / {}）不参与强转——Number([]) 与 Number(false) 同样得 0
  const t = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
    throw new ToolError('confidenceThreshold 必须是 0~1 之间的数字');
  }
  return t;
}

// ---------- 决策执行（场景 run 与 systemone_decide 共用） ----------

/**
 * @param {unknown} state - 业务上下文
 * @param {object} questions - 问题定义（含本地展示字段 label，发送前剥离）
 * @param {number} threshold - 低置信度阈值
 * @param {object} [meta] - 场景元数据 { id, title, derive, recommendation }，自定义决策留空
 */
async function executeDecision(state, questions, threshold, meta = {}) {
  validateState(state);
  validateQuestions(questions);
  const request = {};
  for (const [qid, q] of Object.entries(questions)) {
    request[qid] = q.type === 'noul' ? { type: q.type, instructions: q.instructions } : { type: q.type, instructions: q.instructions, criteria: q.criteria };
  }
  const data = await callSystemone(state, request);

  const answers = {};
  const low = [];
  for (const [qid, q] of Object.entries(questions)) {
    const a = normalizeAnswer(q, data.answers[qid]);
    answers[qid] = a;
    if (!a.present) {
      low.push(qid); // 响应缺失该答案，视作无法判断
    } else if (a.confidence !== null && a.confidence < threshold) {
      low.push(qid);
    } else if (isBorderline(a, q, data.answers[qid])) {
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
  };
}

/**
 * 即使置信度达标也必须转人工复核的情形（question 为该题定义，判据以其为准；raw 为原始答案）：
 *   1. 判定值不可用——任一题型缺失或非法（choice 无选项、noul 无概率、score 无分值）。
 *      模型对结构性坏响应同样会给高 confidence，照单全收等于凭坏数据做决策。
 *   2. choice 返回 uncertain / unknown 哨兵值。
 *   3. noul 概率落在 0.45~0.55 模糊区间（正反两向都说不准）。
 *   4. choice 选中的选项不在判据表内——模型幻觉出的选项，confidence 可能很高，
 *      甚至根本没给（null），不能当作合法判定。
 *   5. score 分值取整后落在分级量表范围外——越界高分会被 deriveFields 钳成最高档，
 *      等于凭一个坏响应把工单升到最高优先级。
 */
function isBorderline(a, question, raw) {
  if (a.type === 'choice') {
    if (a.value === null || a.value === 'uncertain' || a.value === 'unknown') return true;
    const allowed = question?.criteria;
    if (allowed && !(a.value in allowed)) return true;
  }
  if (a.type === 'noul' && (a.probability === null || (a.probability > 0.45 && a.probability < 0.55))) return true;
  if (a.type === 'score') {
    if (a.value === null) return true;
    const levels = question?.criteria;
    // 用原始 score 取整，与 normalizeDecision / deriveFields 走同一个下标，
    // 避免 answers.value（保留 3 位小数）与 decision 取整结果在 .5 边界上不一致
    const idx = Math.round(Number(raw?.score));
    if (Array.isArray(levels) && (idx < 0 || idx >= levels.length)) return true;
  }
  return false;
}

// ---------- 场景调度：list / describe / run ----------

function listScenarios(keyword) {
  const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
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
    '',
    '用 action=describe 查看场景问题定义，用 action=run 执行决策。',
  ].join('\n');
  return { ok: true, action: 'list', count: items.length, scenarios: items, summary };
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
      const criteria =
        q.type === 'choice'
          ? Object.entries(q.criteria || {}).map(([k, v]) => `${k}=${v}`).join('；')
          : q.type === 'score'
            ? (q.criteria || []).map((v, i) => `${i}=${v}`).join('；')
            : '（0~1 概率）';
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
      if (question.type === 'choice') {
        if (typeof override.criteria !== 'object' || Array.isArray(override.criteria) || Object.keys(override.criteria).length === 0) {
          throw new ToolError(`params.${qid}.criteria（choice）必须是非空对象 {选项ID: 选项描述}`);
        }
        next.criteria = Object.fromEntries(Object.entries(override.criteria).map(([k, v]) => [String(k), String(v)]));
      } else if (question.type === 'score') {
        if (!Array.isArray(override.criteria) || override.criteria.length < 2) {
          throw new ToolError(`params.${qid}.criteria（score）至少需要 2 个等级描述`);
        }
        next.criteria = override.criteria.map((v) => String(v));
      } else {
        throw new ToolError(`params.${qid}.criteria：noul 问题没有 criteria`);
      }
    }
    if (override.addCriteria !== undefined) {
      if (question.type !== 'choice') {
        throw new ToolError(`params.${qid}.addCriteria 仅支持 choice 问题`);
      }
      if (typeof override.addCriteria !== 'object' || Array.isArray(override.addCriteria)) {
        throw new ToolError(`params.${qid}.addCriteria 必须是 {选项ID: 选项描述} 对象`);
      }
      next.criteria = { ...(next.criteria || {}), ...override.addCriteria };
    }
    merged[qid] = next;
  }
  return merged;
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
  return executeDecision(args.state, questions, thresholdOf(args), {
    id: scenario.id,
    title: scenario.title,
    derive: scenario.derive,
    recommendation: scenario.recommendation,
  });
}

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'systemone_scenario',
    description:
      'SystemOne 场景决策：把业务状态与预置的结构化问题一次性提交给决策模型，返回带概率分布的判定、' +
      '归一化决策（decision/labels/derived）与处置建议（recommendation）。action=list 列出场景，' +
      'action=describe 查看场景问题定义，action=run 执行决策。内置场景：customer_service 工单分流、' +
      'content_moderation 内容审核、agent_routing 智能体路由、result_verification 结果校验、' +
      'software_dev 软件开发任务判定（类型/复杂度/是否先探查代码库）、sales_lead 销售线索、' +
      'risk_control 金融风控、recruiting 招聘筛选、data_governance 数据打标归因、education 教育题目归类、' +
      'requirements 需求优先级。场景判据可用 params 按问题 id 覆盖（criteria 整体替换 / addCriteria 追加选项）。' +
      '还可用 SYSTEMONE_SCENARIOS 环境变量（部分宿主另有配置入口）追加自定义场景，action=list 可见全部。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'run'],
          description: 'list=列出场景；describe=查看场景问题定义；run=执行决策',
        },
        scenario: {
          type: 'string',
          description: '场景 id 或别名（describe/run 必填），如 customer_service / 工单分流 / software_dev',
        },
        state: {
          type: ['string', 'object', 'array'],
          description:
            '业务上下文（run 必填）：工单文本、任务描述、对话数组或结构化对象，非字符串会被序列化后送入模型',
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
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const action = args.action;
      if (action === 'list') return listScenarios(args.keyword);
      if (action === 'describe') return describeScenario(args.scenario);
      if (action === 'run') return runScenario(args);
      throw new ToolError('action 必须是 list / describe / run');
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
            '{type: "noul", instructions}（回答是/否类，返回 0~1 概率）| {type: "score", instructions, criteria: [等级描述...]}（索引即分值）',
        },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['state', 'questions'],
    },
    handler: async (args) => executeDecision(args.state, args.questions || {}, thresholdOf(args)),
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
      return {
        protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
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
        if (e instanceof ToolError) {
          return { content: [{ type: 'text', text: `工具 ${tool.name} 失败：${e.message}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `工具 ${tool.name} 异常：${e.message || e}` }], isError: true };
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
});
