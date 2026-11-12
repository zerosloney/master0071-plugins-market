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
// 2026-11-12 判据移植：声明提取 / 白名单 / 匹配规则抽为共享导出（推送级对账 check-scope-range.mjs
//   复用，正则单源不复制第三份；本件 CLI 报告语义逐字节不变）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 挂起的 git/工具探测不再挂死门禁（2026-11-09 审查收口，对齐 git-core 超时先例）
import { GIT_TIMEOUT_MS } from './git-core.mjs';

// 声明文件提取——与 check-loop 检查 8 同节同正则（改动面|任务拆解|改动方案），另加扩展名白名单
// （过滤 v1.2.2 之类版本号伪 token：无目录且扩展名不在清单内则弃）
// 抽为导出函数：推送级对账 check-scope-range.mjs 复用，正则单源不复制第三份。
// 修（判据移植 4bbf75c3b）：①原先每行只取首个路径（`line.match`），一行并列两三个文件时后续文件
//   全成「未声明」——一行并列多文件的声明只认首个，其余假越界；②补扫「验证计划」节——新增测试
//   文件常只在该节点名，计划点名即算声明，产品面判据本身不放宽。
export const KNOWN_EXT = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.txt', '.cs', '.csproj', '.sln', '.vue', '.ps1', '.sh', '.yml', '.yaml', '.sql', '.cjs']);
export function extractDeclared(planAbs) {
  const declared = [];
  const lines = fs.readFileSync(planAbs, 'utf8').split(/\r?\n/);
  let inSec = false;
  for (const line of lines) {
    if (/^##\s+(改动面|任务拆解|改动方案|验证计划)/.test(line)) { inSec = true; continue; }
    if (inSec && /^##\s+/.test(line)) { inSec = false; continue; }
    if (!inSec) continue;
    for (const m of line.matchAll(/([a-zA-Z0-9._\/\\-]+\.[a-zA-Z0-9]+)/g)) {
      const tok = m[1].replace(/\\/g, '/');
      const ext = tok.slice(tok.lastIndexOf('.'));
      if (tok.includes('/') || KNOWN_EXT.has(ext.toLowerCase())) declared.push(tok);
    }
  }
  return declared;
}

// 白名单与宽松匹配规则同为共享常量（check-scope-range 复用，口径单源）
// 扩容（判据移植 4bbf75c3b，对齐引擎面豁免 / 台账豁免口径补三类非产品面）：
//   ① 引擎面：.agents/ 全部、.zcode/、.githooks/、宿主适配目录、azure-pipelines.yml、根 AGENTS.md；
//   ② 台账与凭证：workflow/ 根级台账、其 .d/ 月度分片、本机证据目录 workflow/evidence/；
//   ③ wiki 知识文档（内容调整同享豁免）。
// 产品面判据不变：改了未声明仍按调用方的 strict 语义执法。
export const WHITELIST_RE = /^(?:workflow\/(?:intents|specs|plans|incidents)\/|workflow\/INDEX\.md$|workflow\/[^/]+\.md$|workflow\/[^/]+\.d\/|workflow\/evidence\/|wiki\/|\.agents\/|\.zcode\/|\.githooks\/|\.opencode\/|\.trae\/|\.codebuddy\/|\.qwen\/|azure-pipelines\.yml$|AGENTS\.md$|package-lock\.json$)/;
export const matches = (f, df) => f === df || f.endsWith(`/${df}`) || f.includes(df) || df.includes(f);
const norm = (p) => p.replace(/\\/g, '/');

function main() {
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

  const declared = extractDeclared(planAbs);

  // git 调用统一注入 -c core.quotepath=off（对齐 verify-scope.mjs 同款参数；M2 事故同款）：
  // 默认 core.quotepath=true 的机器上非 ASCII 路径被引号+八进制转义（"workflow/incidents/\344\270\255..."）——
  // --base/--staged 分支本就不剥引号，白名单前缀失配 → 中文闭环随行件假越界（strict 假 fail）；报告路径亦不可读。
  const git = (gitArgs, opts = {}) => spawnSync('git', ['-c', 'core.quotepath=off', ...gitArgs], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...opts });
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
}

// 直接执行才跑 CLI；被 check-scope-range.mjs import 时只取共享函数/常量
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
