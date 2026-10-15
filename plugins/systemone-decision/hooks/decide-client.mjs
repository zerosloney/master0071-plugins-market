// decide-client.mjs — 各 hook 共用的 SystemOne 请求客户端：配置解析 + 归一化 + 判定请求。
// 端点优先取 MCP 服务启动时落盘的共享配置（endpoint-config.mjs，含设置页变量的解析结果），
// 缺失/损坏回退环境变量；API Key 不在共享文件里，仍只从环境变量取。
// fail-open 契约在调用方：decide 抛错时调用方必须放行，绝不阻塞用户输入或工具调用。

import { readEndpointConfig } from '../endpoint-config.mjs';

export function config(env) {
  const timeoutRaw = Number(env.SYSTEMONE_TIMEOUT_MS);
  const shared = readEndpointConfig();
  const timeoutPreferred = shared?.timeoutMs ?? (Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 8000);
  return {
    apiKey: env.SYSTEMONE_API_KEY || env.UNISOUND_API_KEY || '',
    baseUrl: (shared?.baseUrl || env.SYSTEMONE_BASE_URL || 'https://maas-api.unisound.com/v1').replace(/\/+$/, ''),
    model: shared?.model || env.SYSTEMONE_MODEL || 'u2-decision',
    // 时间预算：请求默认 8s（用户可配至 12s）；hook 侧以共享 deadline 收缩（见
    // requirement-clarity.mjs / pretool-risk.mjs），stdin 耗时与请求总和不超过 handler 15s。
    // 实测真实接口延迟约 0.1s，8s 仍有 80 倍余量；hook 失败绝不阻塞用户输入。
    timeoutMs: Math.min(timeoutPreferred, 12000),
  };
}

export async function decide(state, cfg, questions, timeoutMsOverride) {
  // 调用方传入共享 deadline 的剩余预算时取二者较小值，请求不会越过 hook 的 handler 超时
  const timeoutMs =
    Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0 ? Math.min(cfg.timeoutMs, timeoutMsOverride) : cfg.timeoutMs;
  const res = await fetch(`${cfg.baseUrl}/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data && typeof data === 'object' && data.answers && typeof data.answers === 'object' ? data.answers : null;
}

// 归一化：字段缺失或题型不符一律返回 null，由调用方 fail-open
export function scoreOf(a) {
  if (!a || a.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  return {
    score: a.score,
    level: (a.legend || {})[String(Math.round(a.score))] || null,
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
  };
}

export function choiceOf(a) {
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
  return { value: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

export function noulOf(a) {
  const p = a && typeof a.noul === 'number' && Number.isFinite(a.noul) ? a.noul : null;
  return p === null ? null : { probability: p, confidence: Math.max(p, 1 - p) };
}
