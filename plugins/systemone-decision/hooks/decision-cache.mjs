// decision-cache.mjs — hook 侧判定答案的跨进程缓存。
// hook 是按事件拉起的短命进程，内存缓存跨进程无效；这里用「插件数据目录里的一个 JSON 文件」
// 做共享缓存：相同（端点 + 模型 + state + 问题）的判定在 TTL 内直接复用，省掉重复的远端往返，
// 典型收益是代理循环里反复执行的同一批命令、以及用户重发的同一提示。
// 契约：一切失败（文件缺失/损坏/不可写、TTL=0）都当作未命中，绝不影响 hook 的 fail-open 主流程；
// 写入走临时文件 + rename 原子替换，并发写者 last-writer-wins——丢的只是一次缓存机会，不是正确性。
// 位置解析与 endpoint-config.mjs 同一套：PLUGIN_DATA（存在时）优先，否则插件根；API Key 不参与缓存。

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_NAME = 'decision-cache.json';
const MAX_ENTRIES = 100;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 每次调用时读环境变量（而非模块加载时固化），测试与运行时调整立即生效。
// TTL 与 MCP 侧（mcp/server.mjs 的 CACHE_TTL_MS）同一个开关：宿主注入的
// SYSTEMONE_PLUGIN_CACHE_TTL_MS 优先（hook 进程通常拿不到它），常态走 SYSTEMONE_CACHE_TTL_MS，
// 默认 5 分钟；0 = 关闭（读写都跳过）。
export function hookCacheTtlMs() {
  const raw = Number(process.env.SYSTEMONE_PLUGIN_CACHE_TTL_MS || process.env.SYSTEMONE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000;
}

function cacheFile() {
  const dataDir = process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim() !== '' ? process.env.PLUGIN_DATA : null;
  return dataDir ? path.join(dataDir, FILE_NAME) : path.join(PLUGIN_ROOT, FILE_NAME);
}

/** 读取整份缓存条目表；文件不存在/损坏/形状不对一律返回空表（= 全部未命中）。 */
function loadEntries(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.entries &&
      typeof parsed.entries === 'object' &&
      !Array.isArray(parsed.entries)
    ) {
      return parsed.entries;
    }
  } catch {
    // 首次运行还没有文件；或读到了写者替换瞬间的半截内容
  }
  return {};
}

/** 缓存键：端点 + 模型 + state + 问题全量参与——换供应商/模型/判据后不会串答案。 */
export function cacheKey(cfg, state, questions) {
  return createHash('sha256')
    .update(JSON.stringify({ baseUrl: cfg.baseUrl, model: cfg.model, state, questions }))
    .digest('hex');
}

/** TTL 内命中返回缓存的 answers 对象，否则返回 null。绝不抛错。 */
export function cacheGet(key) {
  const ttl = hookCacheTtlMs();
  if (ttl <= 0) return null;
  const entry = loadEntries(cacheFile())[key];
  if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number') return null;
  if (Date.now() - entry.at >= ttl) return null; // 过期视为未命中，过期项由写路径统一清理
  return entry.answers && typeof entry.answers === 'object' ? entry.answers : null;
}

/** best-effort 写入：合并后淘汰过期项，仍超上限时按写入时间保留最新条目；失败静默返回。 */
export function cachePut(key, answers) {
  const ttl = hookCacheTtlMs();
  if (ttl <= 0 || !answers || typeof answers !== 'object') return;
  const file = cacheFile();
  const now = Date.now();
  const merged = loadEntries(file);
  merged[key] = { at: now, answers };
  const live = Object.entries(merged).filter(([, e]) => e && typeof e === 'object' && now - e.at < ttl);
  live.sort((a, b) => a[1].at - b[1].at); // 旧在前，超上限从头部丢弃
  const kept = live.slice(Math.max(0, live.length - MAX_ENTRIES));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(kept) }));
    // Windows 上目标文件正被并发读时 rename 可能 EPERM/EBUSY：有界重试，重试耗尽放弃本次写入
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
