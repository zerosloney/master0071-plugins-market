// ensure-board.mjs — 幂等拉起开发全景实时看板（2026-11 实时版新增）
// 语义：端口已在服务 → 复用并打印链接；否则后台拉起 board-server.mjs 并等就绪后打印链接。
// 刻意**不开浏览器**（宿主可能是无头环境/容器，且跨平台开浏览器差异大）——只打印可点链接。
// 用法：node scripts/ensure-board.mjs [--port <端口>] [--root <仓库根>]
// 退出码：0 就绪（复用或新起）；1 拉起失败（端口占用且非本服务 / 启动超时）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBoardPort } from './board-port.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PLUGIN_ROOT, 'scripts', 'board-server.mjs');

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root') || process.cwd());
const PORT = resolveBoardPort({ explicit: argOf('port'), root: ROOT });

/** 探活（不用全局 fetch：undici 连接池句柄会拖住退出，Windows 上强退触发 libuv 断言）。 */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && /"ok"\s*:\s*true/.test(body)));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 最新可用的 plan 文档（链接参数用）。 */
function latestPlanRel(root) {
  const dir = path.join(root, 'workflow', 'plans');
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = ents.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b.name)).mtimeMs - fs.statSync(path.join(dir, a.name)).mtimeMs);
  return `workflow/plans/${files[0].name}`;
}

/**
 * 幂等拉起看板。
 * @returns {Promise<{ok:boolean, port:number, url:string, reused:boolean, error?:string}>}
 */
export async function ensureBoard({ root = ROOT, port = PORT } = {}) {
  const p = port || resolveBoardPort({ root });
  const url = (rel) => `http://127.0.0.1:${p}/tour${rel ? `?file=${encodeURIComponent(rel)}` : ''}`;
  const rel = latestPlanRel(root);
  if (await probe(p)) return { ok: true, port: p, url: url(rel), reused: true };
  const child = spawn(process.execPath, [SERVER, '--port', String(p), '--root', root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probe(p)) return { ok: true, port: p, url: url(rel), reused: false };
  }
  return { ok: false, port: p, url: url(rel), reused: false, error: '看板启动超时（6s 内未就绪）——端口可能被别的服务占用' };
}

const isMain = (() => {
  try { return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const r = await ensureBoard({ root: ROOT, port: PORT });
  if (r.ok) {
    process.stdout.write(`${r.reused ? '看板已在运行' : '看板已拉起'}：${r.url}\n`);
    process.exit(0);
  }
  process.stderr.write(`[ensure-board] ${r.error}\n`);
  process.exit(1);
}
