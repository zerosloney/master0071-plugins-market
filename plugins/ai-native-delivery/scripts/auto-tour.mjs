// auto-tour.mjs — 一键打开开发全景实时看板（2026-11 实时版新增）
// 语义：幂等拉起看板（端口已在跑就复用）并打印实时链接；**失败不阻断**（恒 exit 0，错误进 stderr）。
// 刻意不开浏览器（无头环境友好）——链接可直接点开。
// 用法：node scripts/auto-tour.mjs [--port <端口>] [--root <仓库根>]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBoard } from './ensure-board.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root') || process.cwd());

const r = await ensureBoard({ root: ROOT, port: Number(argOf('port')) || undefined });
if (r.ok) {
  process.stdout.write(`开发全景（实时）：${r.url}\n`);
} else {
  process.stderr.write(`[auto-tour] ${r.error}\n`);
}
process.exit(0);
