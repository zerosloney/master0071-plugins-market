#!/usr/bin/env node
// check-pr-size.mjs — PR 体积预算（pstack 借鉴 2026-10-22）
// 目的：一个 PR 应装得下一次评审。超预算在**开 PR 前**拆，不在 diff 长出来之后拆。
// 口径：git diff --numstat -M <base>...<head>（三点 = merge-base，PR 的真实 diff）。
//   文件数 = 非免费文件数；新增行 = 非免费文件 added 之和（删除行免费，二进制免费）。
//   免费：lockfile / 生成物 / vendor / dist / *.min.* / *.map / *.snap / .gitattributes linguist-*。
// 预算：.agents/config/pr-budget.json（maxFiles 20 / maxLines 800）；env PR_MAX_FILES / PR_MAX_LINES 覆盖。
// 覆盖：PR_SIZE_OK=1 → exit 0（须在 PR body 的 Tradeoffs 写理由）。
// 退出：0 通过/覆盖；1 超限；2 用法/基线错误。
// 用法：node <插件根>/scripts/check-pr-size.mjs [--base <ref>] [--head <ref>] [--json]
// 测试：node <插件根>/test/check-pr-size.test.mjs（临时 git 仓，不触真实分支）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const asJson = argv.includes('--json');
const base = argOf('--base') || 'origin/main';
const head = argOf('--head') || 'HEAD';

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (root.status !== 0 || !root.stdout.trim()) {
  console.error('check-pr-size: 不在 git 仓库');
  process.exit(2);
}
process.chdir(root.stdout.trim());

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const verify = (ref) => git(['rev-parse', '--verify', `${ref}^{commit}`]);
if (verify(base).status !== 0) {
  console.error(`check-pr-size: 基线 ${base} 不存在（先 git fetch origin，或用 --base 指定）`);
  process.exit(2);
}
if (verify(head).status !== 0) {
  console.error(`check-pr-size: head ${head} 不存在`);
  process.exit(2);
}

const CONFIG = '.agents/config/pr-budget.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* 缺配置 = 默认预算 */ }
const DEFAULT_FREE = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json',
  '*.min.js', '*.min.css', '*.map', '*.snap',
  'dist/', 'build/', 'vendor/', 'node_modules/',
  'workflow/verify-evidence.md', 'workflow/INDEX.md', 'workflow/metrics.md', '.agents/notes/engine-map.md',
];
const maxFiles = Number(process.env.PR_MAX_FILES || cfg.maxFiles || 20);
const maxLines = Number(process.env.PR_MAX_LINES || cfg.maxLines || 800);
const freePatterns = Array.isArray(cfg.freePatterns) ? cfg.freePatterns : DEFAULT_FREE;

// .gitattributes 的 linguist-generated / linguist-vendored 也算免费（pstack 同口径）。
const linguist = (() => {
  try {
    return fs.readFileSync('.gitattributes', 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/))
      .filter((parts) => parts.slice(1).some((a) => /^linguist-(generated|vendored)(=true)?$/.test(a)))
      .map((parts) => parts[0]);
  } catch { return []; }
})();

const globMatch = (p, pat) => {
  const pp = String(pat).replace(/\\/g, '/');
  if (pp.endsWith('/')) return p.startsWith(pp) || p.includes(`/${pp}`);
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (!pp.includes('/')) {
    const re = new RegExp(`^${esc(pp).replace(/\*/g, '[^/]*').replace(/\?/g, '.')}$`);
    return re.test(p.split('/').pop());
  }
  const re = new RegExp(`^${esc(pp).replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.')}$`);
  return re.test(p);
};
const isFree = (p) => freePatterns.some((pat) => globMatch(p, pat)) || linguist.some((pat) => globMatch(p, pat));

const diff = git(['-c', 'core.quotepath=off', 'diff', '--numstat', '-M', `${base}...${head}`]);
if (diff.status !== 0) {
  console.error(`check-pr-size: git diff ${base}...${head} 失败`);
  process.exit(2);
}

let files = 0;
let added = 0;
const top = [];
for (const line of String(diff.stdout || '').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [a, , ...rest] = line.split('\t');
  const p = rest.join('\t').replace(/\\/g, '/');
  if (!p || isFree(p)) continue;
  if (a === '-') continue; // 二进制免费
  const n = Number(a);
  if (!Number.isFinite(n)) continue;
  files++;
  added += n;
  top.push([p, n]);
}
top.sort((x, y) => y[1] - x[1]);

const overFiles = files > maxFiles;
const overLines = added > maxLines;
const over = overFiles || overLines;
const override = process.env.PR_SIZE_OK === '1';

if (asJson) {
  console.log(JSON.stringify({ base, head, files, added, maxFiles, maxLines, over, override, top: top.slice(0, 5) }, null, 2));
  process.exit(over && !override ? 1 : 0);
}

const verdict = over ? (override ? '超限（已覆盖 PR_SIZE_OK=1）' : '超限') : '通过';
console.log(`PR 体积：${files} 文件 / ${added} 新增行（预算 ${maxFiles} / ${maxLines}）——${verdict}`);
if (over) {
  if (top.length) console.log(`  最大文件：${top.slice(0, 5).map(([p, n]) => `${p} +${n}`).join(' · ')}`);
  console.log('  拆分建议：删除/改名/移动单独一笔；脚手架与调用方分开；一个数据形状一个 PR；测试随代码走。');
  if (!override) console.log('  覆盖：PR_SIZE_OK=1（须在 PR body 的 Tradeoffs 写理由）');
}
process.exit(over && !override ? 1 : 0);
