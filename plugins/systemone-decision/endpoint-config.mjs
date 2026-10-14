// endpoint-config.mjs — MCP 服务与需求预检 hook 的端点共享文件。
// 背景：hook 进程拿不到设置页注入的 SYSTEMONE_PLUGIN_* 变量（只有 MCP 服务进程有），
// 设置页切换供应商后 hook 仍打旧端点、失败后静默跳过。修复：MCP 服务每次启动把
// 「已解析」的端点（设置页 > 环境变量 > 默认的解析结果）落盘到插件根目录，hook 读
// 同一份文件，两个进程天然指向同一个端点。
// 只共享 baseUrl / model / timeoutMs 三项非敏感字段——API Key 绝不落盘，仍只走环境变量。
// 路径基于本文件解析（而不是 cwd）：hook 进程的 cwd 是会话工作区，不是插件目录。

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(PLUGIN_ROOT, '.endpoint.json');
const TMP = `${FILE}.tmp`;

/** best-effort 落盘：失败仅 stderr 告警（hook 回退环境变量），绝不影响服务启动。 */
export function writeEndpointConfig({ baseUrl, model, timeoutMs }) {
  try {
    writeFileSync(TMP, `${JSON.stringify({ baseUrl, model, timeoutMs }, null, 2)}\n`);
    renameSync(TMP, FILE); // 临时文件 + 原子替换，读方不会读到半截 JSON
  } catch (e) {
    try {
      unlinkSync(TMP);
    } catch {}
    process.stderr.write(`[systemone-decision] 端点配置落盘失败，预检 hook 将回退环境变量：${e.message}\n`);
  }
}

/** 读取共享端点：文件缺失/损坏或字段类型非法一律返回 null，调用方回退环境变量。 */
export function readEndpointConfig() {
  try {
    const cfg = JSON.parse(readFileSync(FILE, 'utf8'));
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
