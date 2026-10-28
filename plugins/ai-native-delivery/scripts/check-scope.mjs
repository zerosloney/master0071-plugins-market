#!/usr/bin/env node
// check-scope.mjs — plan 改动面 ↔ git 变更双向对账（2026-10-09，/goal 控制改动范围边界）
// 用途：解析 plan「改动面 / 任务拆解 / 改动方案」节声明的文件清单，与 git 变更集对账——
//   越界件（改了未声明）= 范围蔓延信号；未落件（声明未改）= plan 滞后或改名信号。检查 8 的证据对账
//   只做单向交集（提交须触及至少一个声明文件），夹带 plan 外文件不报——本件补越界方向。
// 语义与红线：只读裁决（判红绿，不改任何状态——命名规约 check- 前缀）；默认 advisory（exit 0 出报告），
//   --strict 时越界件非空 exit 1（供门禁化调用方使用）；plan 不可读 exit 2（fail-loud，不静默放行）。
//   文件匹配沿检查 8 宽松规则（f===df / 后缀 / 双向 includes）——声明粒度粗（写目录或部分路径）不误报越界；
//   白名单豁免：workflow/ 台账（intents/specs/plans/incidents/INDEX）、.agents/confirmations.jsonl、
//   .agents/confirmations.d/ 分片、package-lock.json——闭环随行件不算越界。
// 测试：node <插件根>/test/check-scope.test.mjs（tmp git 仓 fixture：越界 / 未落 / 白名单 / strict / 无 plan）
// 用法：node <插件根>/scripts/check-scope.mjs workflow/plans/<name>.md [--base <sha>|--staged] [--strict] [--root <dir>]
//   默认比对工作区（含未跟踪，git status --porcelain 口径）；--base <sha> 比对 sha..HEAD 已提交变更；
//   --staged 仅比对暂存区。
// 沿革：2026-10-09 立档（缺口实证=检查 8 单向交集不拦夹带）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let planRel = '', base = '', staged = false, strict = false, rootArg = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--base') base = args[++i] || '';
  else if (a === '--staged') staged = true;
  else if (a === '--strict') strict = true;
  else if (a === '--root') rootArg = args[++i] || '';
  else if (!planRel && !a.startsWith('--')) planRel = a;
}
const ROOT = path.resolve(rootArg || process.cwd());
if (!planRel) { console.error('用法: node <插件根>/scripts/check-scope.mjs workflow/plans/<name>.md [--base <sha>|--staged] [--strict] [--root <dir>]'); process.exit(2); }
const planAbs = path.isAbsolute(planRel) ? planRel : path.join(ROOT, planRel);
if (!fs.existsSync(planAbs)) { console.error(`plan 不可读: ${planRel}`); process.exit(2); }

// 声明文件提取——与 check-loop 检查 8 同节同正则（改动面|任务拆解|改动方案），另加扩展名白名单
// （过滤 v1.2.2 之类版本号伪 token：无目录且扩展名不在清单内则弃）
const KNOWN_EXT = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.txt', '.cs', '.csproj', '.sln', '.vue', '.ps1', '.sh', '.yml', '.yaml', '.sql', '.cjs']);
const declared = [];
{
  const lines = fs.readFileSync(planAbs, 'utf8').split(/\r?\n/);
  let inSec = false;
  for (const line of lines) {
    if (/^##\s+(改动面|任务拆解|改动方案)/.test(line)) { inSec = true; continue; }
    if (inSec && /^##\s+/.test(line)) { inSec = false; continue; }
    if (!inSec) continue;
    const m = line.match(/([a-zA-Z0-9._\/\\-]+\.[a-zA-Z0-9]+)/);
    if (!m) continue;
    const tok = m[1].replace(/\\/g, '/');
    const ext = tok.slice(tok.lastIndexOf('.'));
    if (tok.includes('/') || KNOWN_EXT.has(ext.toLowerCase())) declared.push(tok);
  }
}

const git = (gitArgs, opts = {}) => spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
let changed = [];
if (base) {
  const r = git(['diff', '--name-only', `${base}..HEAD`]);
  if (r.status !== 0) { console.error(`git diff 失败: ${r.stderr}`); process.exit(2); }
  changed = r.stdout.split(/\r?\n/).filter(Boolean);
} else if (staged) {
  const r = git(['diff', '--name-only', '--cached']);
  if (r.status !== 0) { console.error(`git diff 失败: ${r.stderr}`); process.exit(2); }
  changed = r.stdout.split(/\r?\n/).filter(Boolean);
} else {
  // 工作区口径：status --porcelain -uall（含未跟踪且逐文件展开——默认折叠成 `?? dir/` 会把整个新目录误判越界）
  const r = git(['status', '--porcelain', '-uall']);
  if (r.status !== 0) { console.error(`git status 失败: ${r.stderr}`); process.exit(2); }
  changed = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const body = l.slice(3);
    const ren = body.match(/.* -> (.*)$/); // 重命名取新路径
    return (ren ? ren[1] : body).trim().replace(/^"(.*)"$/, '$1');
  });
}

const WHITELIST_RE = /^(?:workflow\/(?:intents|specs|plans|incidents)\/|workflow\/INDEX\.md$|\.agents\/confirmations\.jsonl$|\.agents\/confirmations\.d\/|package-lock\.json$)/;
const norm = (p) => p.replace(/\\/g, '/');
const matches = (f, df) => f === df || f.endsWith(`/${df}`) || f.includes(df) || df.includes(f);

const outOfScope = changed.filter((f) => !WHITELIST_RE.test(norm(f)) && !declared.some((df) => matches(norm(f), df)));
const notLanded = declared.filter((df) => !changed.some((f) => matches(norm(f), df)));

console.log(`▶ check-scope（plan 改动面 ↔ git 变更对账）: ${planRel}`);
console.log(`  声明 ${declared.length} ｜ 变更 ${changed.length}${base ? `（${base}..HEAD）` : staged ? '（staged）' : '（工作区）'}`);
if (outOfScope.length) {
  console.log('  越界件（改了未声明）:');
  outOfScope.forEach((f) => console.log(`    - ${f}`));
}
if (notLanded.length) {
  console.log('  未落件（声明未变更）:');
  notLanded.forEach((f) => console.log(`    - ${f}`));
}
if (!outOfScope.length && !notLanded.length) console.log('  双向对齐 ✅');
else if (!strict) console.log('  （advisory 报告——--strict 时越界件即 fail）');

if (strict && outOfScope.length) process.exit(1);
process.exit(0);
