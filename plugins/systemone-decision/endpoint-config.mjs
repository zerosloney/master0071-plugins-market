// endpoint-config.mjs — MCP 服务与需求预检 hook 的端点共享文件。
// 背景：hook 进程拿不到设置页注入的 SYSTEMONE_PLUGIN_* 变量（只有 MCP 服务进程有），
// 设置页切换供应商后 hook 仍打旧端点、失败后静默跳过。修复：MCP 服务每次启动把
// 「已解析」的端点（设置页 > 环境变量 > 默认的解析结果）落盘到共享文件，hook 读
// 同一份文件，两个进程天然指向同一个端点。
// 只共享 baseUrl / model / timeoutMs 三项非敏感字段——API Key 绝不落盘，仍只走环境变量。
// 路径基于本文件解析（而不是 cwd）：hook 进程的 cwd 是会话工作区，不是插件目录。
//
// 落盘位置：Agent Plugins 规范给宿主提供 PLUGIN_DATA——「跨插件更新保留的可写数据目录」，
// 端点共享文件属于运行时状态，落在那里才能跨插件更新存活。Claude Code / ZCode 等
// 非 Agent Plugins 宿主不提供该变量，此时回退到插件根 .endpoint.json（旧行为）。
// 读时两处都看，PLUGIN_DATA 优先；写时只写 PLUGIN_DATA（存在时）并清掉遗留的旧文件，
// 避免同一份配置存在两个副本、日后回退到旧文件时读到过期端点。

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
// 旧位置：插件根 .endpoint.json。保留读取能力，兼容没有 PLUGIN_DATA 的宿主。
const LEGACY_FILE = path.join(PLUGIN_ROOT, '.endpoint.json');

const dataDir = process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim() !== '' ? process.env.PLUGIN_DATA : null;
const DATA_FILE = dataDir ? path.join(dataDir, 'endpoint.json') : null;

// 读：PLUGIN_DATA 优先，回退插件根旧文件。
const READ_CANDIDATES = DATA_FILE ? [DATA_FILE, LEGACY_FILE] : [LEGACY_FILE];

/** 读一处配置；文件缺失/损坏或字段类型非法一律返回 null，调用方回退环境变量。 */
function readOne(file) {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    const baseUrl = typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== '' ? cfg.baseUrl : null;
    const model = typeof cfg.model === 'string' && cfg.model.trim() !== '' ? cfg.model : null;
    const t = Number(cfg.timeoutMs);
    const timeoutMs = Number.isFinite(t) && t > 0 ? t : null;
    return baseUrl || model || timeoutMs ? { baseUrl, model, timeoutMs } : null;
  } catch {
    return null;
  }
}

/** best-effort 落盘：失败仅 stderr 告警（hook 回退环境变量），绝不影响服务启动。
 *  写 PLUGIN_DATA（存在时）优先；它不可写就退回插件根，两处都失败才告警。 */
export function writeEndpointConfig({ baseUrl, model, timeoutMs }) {
  const payload = `${JSON.stringify({ baseUrl, model, timeoutMs }, null, 2)}\n`;
  const targets = DATA_FILE ? [DATA_FILE, LEGACY_FILE] : [LEGACY_FILE];
  let lastErr = null;
  for (const file of targets) {
    const tmp = `${file}.tmp`;
    try {
      if (file === DATA_FILE) mkdirSync(dataDir, { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, file); // 临时文件 + 原子替换，读方不会读到半截 JSON
      // 写到 PLUGIN_DATA 后清掉插件根的旧文件：两份副本日后只回退到旧文件会读到过期端点。
      if (file === DATA_FILE) {
        try {
          unlinkSync(LEGACY_FILE);
        } catch {}
      }
      return;
    } catch (e) {
      lastErr = e;
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  process.stderr.write(`[systemone-decision] 端点配置落盘失败，预检 hook 将回退环境变量：${lastErr?.message}\n`);
}

/** 读取共享端点：文件缺失/损坏或字段类型非法一律返回 null，调用方回退环境变量。 */
export function readEndpointConfig() {
  for (const file of READ_CANDIDATES) {
    const cfg = readOne(file);
    if (cfg) return cfg;
  }
  return null;
}

/** baseUrl 是否为不安全端点：非 https 且非本机回环。这类端点携带 Bearer Key 等于明文外泄凭据，
 *  MCP 服务与 hook 在发请求前都应据此拒绝（共享文件落在用户可写目录，值不可信）。 */
export function isInsecureBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || /^https:\/\//i.test(baseUrl)) return false;
  return !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:\/]|$)/i.test(baseUrl);
}
