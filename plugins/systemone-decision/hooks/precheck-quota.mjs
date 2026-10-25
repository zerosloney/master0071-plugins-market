// precheck-quota.mjs — 需求预检 hook 的开关与会话配额。
// SYSTEMONE_HOOK_PRECHECK（宿主注入走 SYSTEMONE_PLUGIN_HOOK_PRECHECK，优先）：
//   'on'（默认）  每条输入都做预检（既有行为）
//   'off'         完全关闭：hook 静默跳过，不发任何请求（比删 hooks.json 温和的开关）
//   'first:N'     每个会话只对前 N 条被判定输入做预检，用尽后静默跳过；裸数字 'N' 等同 'first:N'
// 配额按 hook 输入的 session_id 分桶计数，落盘在插件数据目录（PLUGIN_DATA 优先，回退插件根）的
// precheck-quota.json——hook 是短命进程，计数必须跨进程共享；宿主不传 session_id 时共用 'default' 桶。
// 契约与 decision-cache 同一套：文件缺失/损坏/不可写一律按「允许预检」处理（fail-open，
// 配额是节流手段不是安全边界），写入走临时文件 + rename 原子替换并带 Windows EPERM 有界重试。

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_NAME = 'precheck-quota.json';
const MAX_SESSIONS = 100; // 会话桶上限：写入时按最近使用保留，防长跑进程文件无界增长

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 解析开关配置。
 * @returns {{mode: 'on'} | {mode: 'off'} | {mode: 'first', n: number}}
 * 非法值告警到 stderr 后按默认 on 处理（与其他环境量「坏值不毒死流程」的口径一致）。
 */
export function precheckMode(env = process.env) {
  const raw = String(env.SYSTEMONE_PLUGIN_HOOK_PRECHECK || env.SYSTEMONE_HOOK_PRECHECK || '').trim().toLowerCase();
  if (raw === '' || raw === 'on' || raw === 'true') return { mode: 'on' };
  if (raw === 'off' || raw === 'none' || raw === 'false') return { mode: 'off' };
  const m = raw.match(/^(?:first[:=]?(\d+)|(\d+))$/);
  if (m) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isInteger(n) && n >= 0) return n === 0 ? { mode: 'off' } : { mode: 'first', n };
  }
  process.stderr.write(`[systemone-decision hook] SYSTEMONE_HOOK_PRECHECK 值 "${raw}" 无法识别（可用：on/off/first:N），按默认 on 处理\n`);
  return { mode: 'on' };
}

function quotaFile() {
  const dataDir = process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim() !== '' ? process.env.PLUGIN_DATA : null;
  return dataDir ? path.join(dataDir, FILE_NAME) : path.join(PLUGIN_ROOT, FILE_NAME);
}

/** 读取会话桶表；文件缺失/损坏/形状不对一律返回空表（= 不限额）。 */
function loadSessions(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
      return parsed.sessions;
    }
  } catch {
    // 首次运行或写者替换瞬间
  }
  return {};
}

function sessionKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : 'default';
}

/**
 * 该会话是否还允许做预检。仅 first 模式受限；任何读取失败都放行（fail-open）。
 * @returns {boolean}
 */
export function quotaAllows(mode, sessionId) {
  if (mode.mode !== 'first') return true;
  const entry = loadSessions(quotaFile())[sessionKey(sessionId)];
  return !(entry && typeof entry === 'object' && typeof entry.count === 'number' && entry.count >= mode.n);
}

/**
 * 记一次被判定输入：仅 first 模式写盘（on/off 模式是 no-op），best-effort 静默失败。
 * 在确认将要发出判定请求的路径上调用（寒暄/短输入/缺 Key 的捷径不计入）。
 */
export function bumpQuota(mode, sessionId) {
  if (mode.mode !== 'first') return;
  const file = quotaFile();
  const key = sessionKey(sessionId);
  const sessions = loadSessions(file);
  const prev = sessions[key];
  sessions[key] = { count: (prev && typeof prev.count === 'number' ? prev.count : 0) + 1, at: Date.now() };
  // 只保留最近使用的 MAX_SESSIONS 个桶：按 at 排序丢最旧，文件尺寸有界
  const kept = Object.entries(sessions)
    .filter(([, e]) => e && typeof e === 'object' && typeof e.count === 'number')
    .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
    .slice(-MAX_SESSIONS);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }));
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        if (attempt >= 5 || !e || (e.code !== 'EPERM' && e.code !== 'EBUSY')) {
          try {
            unlinkSync(tmp);
          } catch {}
          return;
        }
        sleepMs(25 * (attempt + 1));
      }
    }
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
