// decide-client.mjs — 各 hook 共用的 SystemOne 请求客户端：配置解析 + 归一化 + 判定请求。
// 端点优先取 MCP 服务启动时落盘的共享配置（endpoint-config.mjs，含设置页变量的解析结果），
// 缺失/损坏回退环境变量；API Key 不在共享文件里，仍只从环境变量取。
// fail-open 契约在调用方：decide 抛错时调用方必须放行，绝不阻塞用户输入或工具调用。

import { readEndpointConfig, isInsecureBaseUrl, endpointLabel } from '../endpoint-config.mjs';
import { cacheGet, cacheKey, cachePut } from './decision-cache.mjs';

export function config(env) {
  const timeoutRaw = Number(env.SYSTEMONE_TIMEOUT_MS);
  const shared = readEndpointConfig();
  const timeoutPreferred = shared?.timeoutMs ?? (Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 8000);
  return {
    apiKey: env.SYSTEMONE_API_KEY || env.UNISOUND_API_KEY || '',
    baseUrl: (shared?.baseUrl || env.SYSTEMONE_BASE_URL || 'https://maas-api.unisound.com/v1').replace(/\/+$/, ''),
    model: shared?.model || env.SYSTEMONE_MODEL || 'u2-decision',
    // 时间预算：优先用落盘的 timeoutMs（MCP 服务启动写入 .endpoint.json，默认 30000），
    // 无落盘时用环境变量、再缺省 8000；统一与 12000 硬上限取小。hook 侧再以共享 deadline
    // 收缩（见 hooks/hook-io.mjs），stdin 耗时与请求总和不超过 handler 15s。
    // 实测真实接口延迟约 0.1s；hook 失败绝不阻塞用户输入。
    timeoutMs: Math.min(timeoutPreferred, 12000),
  };
}

export async function decide(state, cfg, questions, timeoutMsOverride) {
  // 有意保留的双实现：本函数与 mcp/server.mjs 的 callSystemone() 是同一 SystemOne 协议的
  // 两份传输层（URL 拼 /systemone、Bearer 头、{model, state, questions} 请求体、insecure
  // 端点检查）——错误契约不同（这里抛错由调用方按 fail-open 契约放行；MCP 侧抛 ToolError
  // → isError 结果），抽共享模块的回归风险大于收益。改协议形状时必须两处同步，
  // 以 test/hook.smoke.mjs 与 test/smoke.mjs 为锚。
  // 调用方传入共享 deadline 的剩余预算时取二者较小值，请求不会越过 hook 的 handler 超时
  const timeoutMs =
    Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0 ? Math.min(cfg.timeoutMs, timeoutMsOverride) : cfg.timeoutMs;
  // 跨进程判定缓存（decision-cache.mjs）：相同「端点+模型+state+问题」在 TTL 内直接复用本地答案，
  // 免掉代理循环里反复执行的同一批命令、重发提示的远端往返；TTL=0 关闭，缓存不可用时退化为直连。
  const key = cacheKey(cfg, state, questions);
  const cached = cacheGet(key);
  if (cached) return cached;
  // 不安全端点（非 https 且非本机回环）拒绝携带 Bearer Key 外发；抛错由调用方按 fail-open 契约放行，
  // stderr 留一条便于诊断为什么预检/风险闸静默失效
  if (isInsecureBaseUrl(cfg.baseUrl)) {
    // 与 server.mjs 同口径：stderr 只留 scheme://host[:port]，不把含内嵌口令的完整 URL 写进日志
    process.stderr.write(`[systemone-decision] baseUrl ${endpointLabel(cfg.baseUrl)} 不是加密端点（https 或本机回环），拒绝携带 API Key 请求，本次判定跳过。\n`);
    throw new Error('insecure endpoint');
  }
  const res = await fetch(`${cfg.baseUrl}/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const answers = data && typeof data === 'object' && data.answers && typeof data.answers === 'object' ? data.answers : null;
  if (answers) cachePut(key, answers);
  return answers;
}

// score 分值是分级数组的 0 起下标，协议量表 2~255 级（mcp/question-types.mjs 的
// SCORE_MIN_LEVELS / SCORE_MAX_LEVELS，未导出且 mcp/* 不在本文件依赖内，本地镜像同口径，
// 改协议量表时与该文件两处同步），可解释的取整分值域即 [0, 254]。
const SCORE_SCALE_MAX_INDEX = 254;
// legend 文本进 permissionDecisionReason / 结论文案前的截断长度
const LEGEND_MAX_CHARS = 80;

// 归一化：字段缺失或题型不符一律返回 null，由调用方 fail-open
export function scoreOf(a) {
  if (!a || a.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  // 界外值不可解释，按「无法判断」处理（2026-11-05，与 noulOf 及 question-types.mjs 的越界归 null
  // 同口径）：旧实现只验有限性，`score: -5` 配 verdict=allow 会在 risk-gate 的门限比较里
  // 被当成最低风险放行——越界分值不是「更低的风险」，是端点给了不可解释的东西。
  const idx = Math.round(a.score);
  if (idx < 0 || idx > SCORE_SCALE_MAX_INDEX) return null;
  // legend 文本来自端点响应（共享文件在用户可写目录，值不可信），截断后再进理由文案，
  // 防一条超长等级名撑爆宿主的确认弹窗或日志
  const rawLevel = (a.legend || {})[String(idx)] || null;
  const level =
    typeof rawLevel === 'string' && rawLevel.length > LEGEND_MAX_CHARS ? rawLevel.slice(0, LEGEND_MAX_CHARS) : rawLevel;
  return {
    score: a.score,
    level,
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
  };
}

export function choiceOf(a) {
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
  return { value: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

export function noulOf(a) {
  const finite = a && typeof a.noul === 'number' && Number.isFinite(a.noul) ? a.noul : null;
  // 界外值不可解释，按「无法判断」处理（2026-10-29，与 question-types.mjs 的 noul 分支同口径）：
  // 旧实现让 `noul: 5` 通过，confidence 变成 5，阈值比较从此失效。
  const p = finite === null || finite < 0 || finite > 1 ? null : finite;
  return p === null ? null : { probability: p, confidence: Math.max(p, 1 - p) };
}
