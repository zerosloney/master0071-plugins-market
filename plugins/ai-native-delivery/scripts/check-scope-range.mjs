#!/usr/bin/env node
// check-scope-range.mjs — 推送范围（old..new）级 plan 改动面对账（判据移植 2026-11-12，check-scope 的推送执法版）
// 用途：pre-push 对一次推送的整段 commit 范围对账——收集范围内新增/修改的 workflow/plans/*.md，
//   并集提取各 plan 声明文件（extractDeclared 与 check-scope.mjs 单源复用），与范围 diff 对账。
// 语义与红线：只读裁决（判红绿，不改任何状态）。
//   - 只判越界方向（改了未声明）= hard；未落件（声明未改）仅 advisory 打印——多任务合推时声明先行、
//     代码后推是合法节奏，硬判未落件必误报。
//   - L0 极简道豁免（提交时豁免通道的推送面）：提交消息含非空 `L0: <判据>` 行且该提交产品件 ≤L0_MAX(5) → 这些产品件
//     免声明（判据/上限单源复用 check-confirm-order.mjs，与 commit-msg 种子同一口径）。L0 本就不立 plan，
//     不豁免则「L0 改动 + 范围内 plan 变更」的推送恒被硬拦。豁免按提交粒度生效并打印明细（不静默）；
//     同一文件另有非 L0 提交改动时照旧计入越界；合并提交不适用。
//   - 范围内无 plan 新增/修改 → skip（exit 0）：该推送不携带新承诺，沿用提交时刻 check-confirm-order 执法。
//   - 盲面封堵：skip 前补 advisory——范围含产品面改动（判据单源复用 verify-scope.mjs
//     PRODUCT_FACES/classifyFace，再扣引擎面前缀）且无 intent/spec 立档变更 → 打警告，exit 码不变、--strict 不升硬。
//     事故线豁免（降级口径）：范围内有 incident 立档（非 INDEX 计数）变更 → 警告降级为提示——事故线合法无 plan。
//   - plan 在工作区不可读 → exit 2（fail-loud，不静默放行；推送范围内改过的 plan 应已在工作区）。
//   - old 全零（新分支首推）→ skip（exit 0）：范围判不出时不把整段历史误判越界。
//   - --strict 时越界件非空 exit 1；默认 advisory（exit 0 出报告）。
// 白名单与宽松匹配规则与 check-scope.mjs 单源（import 复用，不复制正则）。
// 用法：node <插件根>/scripts/check-scope-range.mjs <oldSha> <newSha> [--strict] [--root <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractDeclared, WHITELIST_RE, matches } from './check-scope.mjs';
import { classifyFace } from './verify-scope.mjs';
// L0 豁免判据与上限单源复用提交时刻门（commit-msg 种子 → check-confirm-order）：同一 `L0:` 行正则、
// 同一产品路径判据、同一 ≤5 上限——推送级只按提交消息复核，不另立一套口径。
import { L0_MAX, isProductPath, l0JudgementFromText } from './check-confirm-order.mjs';

const args = process.argv.slice(2);
let oldSha = '', newSha = '', strict = false, rootArg = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--strict') strict = true;
  else if (a === '--root') rootArg = args[++i] || '';
  else if (!oldSha && !a.startsWith('--')) oldSha = a;
  else if (!newSha && !a.startsWith('--')) newSha = a;
}
const ROOT = path.resolve(rootArg || process.cwd());
if (!oldSha || !newSha) { console.error('用法: node <插件根>/scripts/check-scope-range.mjs <oldSha> <newSha> [--strict] [--root <dir>]'); process.exit(2); }

const norm = (p) => p.replace(/\\/g, '/');

if (/^0+$/.test(oldSha)) {
  console.log('▶ check-scope-range：old 全零（新分支首推），范围判不出——skip');
  process.exit(0);
}

// 修（首父链）：`git diff old..new` 把 merge 带进来的目标分支整批变更也算「本范围改了」——
// 那些文件由目标分支侧的 plan 声明，本地范围里没有对应 plan → 恒判越界，合并后推不上去。
// 改为逐提交取改动：普通提交取 diff-tree 全量；合并提交取 combined diff（`-c`，只出「与所有父都不同」的
// 冲突解决件），被合入分支带来的文件天然不入集；合并中手工解冲突的文件仍会被计入。
const gitOut = (gitArgs) => spawnSync('git', ['-c', 'core.quotepath=off', ...gitArgs], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const revs = gitOut(['rev-list', '--first-parent', '--reverse', `${oldSha}..${newSha}`]);
if (revs.status !== 0) { console.error(`check-scope-range: git rev-list 失败: ${revs.stderr}`); process.exit(2); }
const changedSet = new Set();
// L0 极简道豁免（提交时豁免通道的推送面）：提交消息含非空 `L0: <判据>` 行、且该提交产品件 ≤L0_MAX → 这些产品件
// 免 plan 声明（L0 本就不立 plan，硬判越界会让「L0 + 范围内 plan 变更」的推送永远推不上去）。
// 只按提交粒度豁免：同一文件另有无 L0 判据的提交改动时，仍由那条提交计入越界对账（不整文件洗白）。
// 合并提交不适用（L0 是单笔改动形态；合并带来的文件本就由 combined diff 排除）。
const l0Exempt = [];
for (const sha of revs.stdout.split(/\r?\n/).filter(Boolean)) {
  const parents = gitOut(['rev-list', '--parents', '-n', '1', sha]).stdout.trim().split(/\s+/).slice(1);
  const dt = parents.length > 1
    ? gitOut(['diff-tree', '-c', '--no-commit-id', '--name-only', '--no-renames', '-r', sha])
    : gitOut(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', sha]);
  if (dt.status !== 0) { console.error(`check-scope-range: git diff-tree 失败（${sha}）: ${dt.stderr}`); process.exit(2); }
  const files = dt.stdout.split(/\r?\n/).map((l) => norm(l.trim())).filter(Boolean);
  const l0 = parents.length === 1 ? l0JudgementFromText(gitOut(['show', '-s', '--format=%B', sha]).stdout) : null;
  const products = files.filter(isProductPath);
  if (l0 && products.length > 0 && products.length <= L0_MAX) {
    l0Exempt.push({ sha, judgement: l0, files: products });
    for (const f of files) if (!isProductPath(f)) changedSet.add(f);
    continue;
  }
  for (const f of files) changedSet.add(f);
}
const changed = [...changedSet];

// 盲面封堵辅助判定（只服务下方 skip 路径的 advisory，不改越界对账）：
//   - 引擎面 = 引擎面豁免清单（.agents/、宿主适配目录、workflow 台账、wiki 知识文档）+ 根级引擎/宿主文件：
//     其变更不算产品面，纯引擎面推送不触警告。
//     PRODUCT_FACES 的后缀兜底（.cs/.sql 等）会把台账树内同类文件判进 backend 面——引擎面剔除优先，
//     防纯台账/wiki 推送误警。
//   - intent/spec 立档：workflow/{intents,specs} 下的 .md（INDEX 计数不算——目录索引维护不构成「有计划」）。
//   - incident 立档：workflow/incidents 下的 .md（INDEX 计数不算——防搭车豁免）。
const ENGINE_FACE_RE = /^(?:\.agents|\.zcode|\.githooks|\.opencode|\.trae|\.codebuddy|\.qwen|wiki|workflow)\//i;
const ENGINE_FILE_RE = /^(?:azure-pipelines\.yml|package\.json|package-lock\.json|AGENTS\.md)$/i;
const isIntentSpecDoc = (f) => /^workflow\/(?:intents|specs)\/.+\.md$/i.test(f) && !f.endsWith('/INDEX.md');
const isIncidentDoc = (f) => /^workflow\/incidents\/.+\.md$/i.test(f) && !f.endsWith('/INDEX.md');

// 范围内新增/修改的 plan（删除的 plan 不构成承诺来源；plans 目录外不看）
const plansInRange = changed.filter((f) => /^workflow\/plans\/.+\.md$/i.test(f) && !f.endsWith('/INDEX.md'));
if (!plansInRange.length) {
  console.log('▶ check-scope-range：推送范围无 plan 新增/修改——skip（提交时刻顺序门已执法）');
  // 盲面封堵：范围零 plan 变更 ≠ 范围无事——多提交无 plan 合推可整段夹带产品面改动（提交时刻
  // check-confirm-order 只看单条提交，原样静默 skip 即漏过）。只补 advisory：打印不拦截，exit 码不变，
  // --strict 不升硬（与既有「未落件仅 advisory」同级）。产品面判据单源复用 verify-scope.mjs
  // PRODUCT_FACES（backend/frontend 面 match，含 tests/ 与后缀兜底）。
  const productFace = classifyFace(changed).matched.filter((f) => !ENGINE_FACE_RE.test(f) && !ENGINE_FILE_RE.test(f));
  if (productFace.length && !changed.some(isIntentSpecDoc)) {
    if (changed.some(isIncidentDoc)) {
      // 事故线豁免（降级口径）：有 incident 立档 → 产品改动按事故线处理（合法无 plan），不要求回填
      // plan；降级为提示而非完全静默——立档与产品改动无关的搭车推送仍留观察面。
      console.log('⚠（降级）推送含产品面改动且范围内无 plan 变更——范围内有 incident 立档，按事故线豁免；advisory 不拦截');
    } else {
      console.log('⚠ 推送含产品面改动但范围内无 plan 变更——若属计划外改动请先回填 plan（事故线 incident 除外）；本警告 advisory，不拦截');
    }
    console.log(`  产品面件 ${productFace.length}：${productFace.join('、')}`);
  }
  process.exit(0);
}

const declared = [];
for (const rel of plansInRange) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    declared.push(...extractDeclared(abs, ROOT));
    continue;
  }
  // 归档回退：closeout 会把 plan 移入 workflow/archive/** 并从 live 路径删除，推送范围恰含归档提交时
  // live 路径与 HEAD 树都查不到（自举首推实证：关单推送被自己的门拦住）。注意最后触过该路径的提交
  // 恰是 rename 提交（旧路径已删）——遍历触过该路径的提交取第一个 show 成功的，落临时文件复用
  // extractDeclared 判据不另立。
  const show = (treePath) => spawnSync('git', ['-C', ROOT, 'show', treePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const log = spawnSync('git', ['-C', ROOT, 'log', '--format=%H', '--', rel], { encoding: 'utf8' });
  const shas = (log.stdout || '').split(/\r?\n/).filter(Boolean);
  let content = null;
  for (const h of shas) {
    const c = show(`${h}:${rel}`);
    if (c.status === 0 && c.stdout) { content = c; break; }
  }
  if (!content) {
    console.error(`check-scope-range: plan 不可读（live 与历史提交均未命中）: ${rel}`);
    process.exit(2);
  }
  const snap = path.join(os.tmpdir(), `scope-range-plan-${Date.now()}-${path.basename(rel)}`);
  fs.writeFileSync(snap, content.stdout, 'utf8');
  try { declared.push(...extractDeclared(snap, ROOT)); } finally { fs.rmSync(snap, { force: true }); }
}

const outOfScope = changed.filter((f) => !WHITELIST_RE.test(norm(f)) && !declared.some((df) => matches(norm(f), df)));
const notLanded = declared.filter((df) => !changed.some((f) => matches(norm(f), df)));

console.log(`▶ check-scope-range（推送范围 plan 改动面对账）: ${oldSha.slice(0, 8)}..${newSha.slice(0, 8)}`);
console.log(`  范围 plan ${plansInRange.length} 份（${plansInRange.join('、')}）｜ 声明 ${declared.length} ｜ 变更 ${changed.length}`);
if (l0Exempt.length) {
  console.log(`  L0 豁免（提交消息含 L0: 判据且产品件 ≤${L0_MAX}，免 plan 声明）:`);
  l0Exempt.forEach((e) => console.log(`    - ${e.sha.slice(0, 8)}「${e.judgement}」：${e.files.join('、')}`));
}
if (outOfScope.length) {
  console.log('  越界件（推送改了但范围内 plan 未声明）:');
  outOfScope.forEach((f) => console.log(`    - ${f}`));
}
if (notLanded.length) {
  console.log('  未落件（声明未变更，advisory——多任务合推不硬判）:');
  notLanded.forEach((f) => console.log(`    - ${f}`));
}
if (!outOfScope.length && !notLanded.length) console.log('  双向对齐 ✅');
else if (!outOfScope.length) console.log('  越界方向干净 ✅（未落件仅 advisory）');
else if (!strict) console.log('  （advisory 报告——--strict 时越界件即 fail）');

if (strict && outOfScope.length) process.exit(1);
process.exit(0);
