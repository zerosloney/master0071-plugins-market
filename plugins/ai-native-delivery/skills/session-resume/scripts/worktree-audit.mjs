#!/usr/bin/env node
// worktree-audit — 盘点 git worktree，分类 主区 / 活跃 / 可清理 / 失效。
// 默认只读（不删除、不清理、不 prune）；`--execute` 只删「可清理」（干净且已合入主分支），
// 失效走 `git worktree prune`；活跃/主区永不删。删除动作仍须显式 `--execute`。
// 用法：node .agents/skills/session-resume/scripts/worktree-audit.mjs [--root <dir>] [--json] [--execute]
// 判据：脏（含未跟踪）或未合入主分支 = 活跃；干净且已合入 = 可清理；目录缺失 / prunable = 失效。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const execute = argv.includes('--execute');
const root = path.resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : process.cwd());

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const out = (args, cwd) => {
  const r = git(args, cwd);
  return r.status === 0 ? r.stdout.trim() : null;
};

const porcelain = out(['worktree', 'list', '--porcelain'], root);
if (porcelain === null) {
  console.error('worktree-audit: 不是 git 仓库（或 git 不可用）');
  process.exit(2);
}

// 主分支锚：origin/main > main > master；都没有则不判「已合入」
const mainRef = ['origin/main', 'main', 'master'].find((ref) => git(['rev-parse', '--verify', '--quiet', ref], root).status === 0) || null;

const blocks = porcelain.split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/)).filter((ls) => ls.some((l) => l.startsWith('worktree ')));
const primary = (blocks[0] || []).find((l) => l.startsWith('worktree '))?.slice('worktree '.length) || '';

const rows = blocks.map((lines) => {
  const field = (name) => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) || '';
  const wt = field('worktree');
  const head = field('HEAD');
  const branchRef = field('branch');
  const prunable = field('prunable');
  const branch = branchRef ? branchRef.replace(/^refs\/heads\//, '') : '(detached)';
  const exists = fs.existsSync(wt);

  let dirty = null;
  let upstream = null;
  let ahead = null;
  let behind = null;
  let merged = null;
  let lastDate = null;

  if (exists) {
    dirty = (out(['status', '--porcelain', '-uall'], wt) || '') !== '';
    upstream = out(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wt);
    if (upstream) {
      const lr = out(['rev-list', '--left-right', '--count', '@{u}...HEAD'], wt);
      if (lr) { const [b, a] = lr.split(/\s+/).map(Number); behind = b; ahead = a; }
    }
    if (mainRef) merged = git(['merge-base', '--is-ancestor', 'HEAD', mainRef], wt).status === 0;
    lastDate = out(['log', '-1', '--format=%cs'], wt);
  }

  let kind;
  if (!exists || prunable) kind = '失效';
  else if (path.resolve(wt) === path.resolve(primary)) kind = '主区';
  else if (dirty) kind = '活跃(未提交)';
  else if (merged === false || (ahead !== null && ahead > 0)) kind = '活跃(未合并)';
  else if (merged === true) kind = '可清理';
  else kind = '未知';

  return { path: wt, branch, head, dirty, upstream, ahead, behind, merged, lastDate, kind, prunable };
});

if (asJson) {
  console.log(JSON.stringify({ mainRef, worktrees: rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => {
  const clip = (v) => ([...String(v)].length > n ? [...String(v)].slice(0, n - 1).join('') + '…' : String(v));
  const t = clip(s);
  const w = [...t].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return t + ' '.repeat(Math.max(0, n - w));
};

console.log(`主分支锚: ${mainRef || '（无）'}｜worktree ${rows.length} 个`);
console.log(`${pad('分类', 14)}${pad('分支', 34)}${pad('HEAD', 10)}${pad('领先/落后', 12)}${pad('最后提交', 12)}路径`);
for (const r of rows) {
  const ab = r.ahead === null ? '—' : `${r.ahead}/${r.behind}`;
  console.log(`${pad(r.kind, 14)}${pad(r.branch, 34)}${pad(r.head.slice(0, 8), 10)}${pad(ab, 12)}${pad(r.lastDate || '—', 12)}${r.path}`);
}

const stale = rows.filter((r) => r.kind === '可清理' || r.kind === '失效');
if (execute) {
  const removable = rows.filter((r) => r.kind === '可清理');
  const invalid = rows.filter((r) => r.kind === '失效');
  let removed = 0;
  for (const r of removable) {
    const res = git(['worktree', 'remove', r.path], root);
    if (res.status === 0) { console.log(`✅ 已删除 ${r.path}`); removed++; }
    else console.error(`❌ 删除失败 ${r.path}：${(res.stderr || '').trim()}`);
  }
  if (invalid.length) {
    const res = git(['worktree', 'prune'], root);
    if (res.status === 0) console.log(`✅ 已 prune ${invalid.length} 个失效 worktree`);
    else console.error(`❌ prune 失败：${(res.stderr || '').trim()}`);
  }
  console.log(`\n--execute：删除 ${removed} 个可清理 worktree；活跃/主区未动。`);
  process.exit(0);
}
console.log(`\n可清理/失效 ${stale.length} 个。默认只读；确认后加 --execute 删除（只删可清理，失效走 prune）：`);
for (const r of stale) console.log(`  git worktree remove ${r.kind === '失效' ? '--force ' : ''}"${r.path}"`);
