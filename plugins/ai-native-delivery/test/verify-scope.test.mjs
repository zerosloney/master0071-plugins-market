#!/usr/bin/env node
// verify-scope.mjs 的单元测试（纯逻辑，无 git 依赖——computeDiffScope 注入假 git）
// 断言：①classifyFace 面归口（前缀大小写不敏感 + 扩展名兜底 + 反斜杠归一 + 面外路径不误触 +
// 引擎自检面 verify-diet 二批 P0-1——engine-tests 只在 .agents/.githooks/package.json 触面时跑）；
// ②computeDiffScope 组装（基线 hint 祖先校验/回落、--no-renames 双源、untracked 第三源、fail-loud 三态）。
// 复核盲区钉死（2026-10-21）：untracked 逃逸、rename 源隐藏、case-only 前缀逃逸。
// 用法：node .agents/scripts/verify-scope.test.mjs
import { classifyFace, computeDiffScope, parseEvidenceGreens, PRODUCT_FACES, ENGINE_TEST_FACE } from '../scripts/verify-scope.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};
const GATE_FACES = [...PRODUCT_FACES, ENGINE_TEST_FACE];
const ALL_SKIP = GATE_FACES.flatMap((pf) => pf.gates);

// ---- ① classifyFace ----
{
  const r = classifyFace([]);
  check('空面：全跳（5 产品重门 + 引擎自检）', r.touched.size === 0 && JSON.stringify(r.skippedGateIds.sort()) === JSON.stringify([...ALL_SKIP].sort()) && ALL_SKIP.length === 6, JSON.stringify(r));
}
{
  const r = classifyFace(['backend/Controllers/X.cs']);
  check('backend/ 前缀 → backend 触、frontend 三门 + 引擎自检跳', r.touched.has('backend') && !r.touched.has('frontend')
    && JSON.stringify(r.skippedGateIds) === JSON.stringify(['frontend-lint', 'frontend-unit-test', 'frontend-build', 'engine-tests']), JSON.stringify(r));
}
{
  const r = classifyFace(['tests/App.Tests/Foo.cs']);
  check('tests/ 前缀归 backend 面', r.touched.has('backend') && r.skippedGateIds.length === 4, JSON.stringify(r));
}
{
  const r = classifyFace(['scripts/verify/backend/run-backend-tests.mjs']);
  check('scripts/verify/backend/ 前缀归 backend 面（门执行器自身改动不静默跳门，2026-10-24 复核 P1）',
    r.touched.has('backend') && r.skippedGateIds.length === 4, JSON.stringify(r));
}
{
  const r = classifyFace(['scripts/verify/business/verify-po-x.mjs', 'scripts/verify/e2e/harness.mjs']);
  check('scripts/verify/{business,e2e}/ 不驱动 backend 重门（2026-10-24 复核 m3 收窄）',
    !r.touched.has('backend') && r.skippedGateIds.includes('backend-build'), JSON.stringify(r));
}
{
  const r = classifyFace(['backend/中文目录/订单.cs', 'tests/中文/Foo.cs']);
  check('非 ASCII 路径仍归 backend 面（quotepath 面源前提）', r.touched.has('backend') && r.skippedGateIds.length === 4, JSON.stringify(r));
}
{
  const r = classifyFace(['App.sln', 'global.props']);
  check('根级 sln/props 扩展名兜底归 backend 面', r.touched.has('backend') && r.skippedGateIds.length === 4, JSON.stringify(r));
}
{
  const r = classifyFace(['frontend/src/views/a.vue', 'frontend\\package.json']);
  check('frontend/ 前缀（含反斜杠归一）→ frontend 触、backend 两门跳',
    r.touched.has('frontend') && JSON.stringify(r.skippedGateIds) === JSON.stringify(['backend-build', 'backend-test', 'engine-tests']), JSON.stringify(r));
}
{
  const r = classifyFace(['Frontend/x.vue', 'Backend/C.cs']);
  check('前缀大小写不敏感（case-only 改名不逃逸，复核 P2）', r.touched.has('frontend') && r.touched.has('backend') && JSON.stringify(r.skippedGateIds) === JSON.stringify(['engine-tests']), JSON.stringify(r));
}
{
  const r = classifyFace(['.agents/scripts/verify.mjs']);
  check('引擎代码路径触 engine-code 面（engine-tests 回列，verify-diet 二批 P0-1）',
    r.touched.has('engine-code') && r.matched.includes('.agents/scripts/verify.mjs')
    && JSON.stringify(r.skippedGateIds.sort()) === JSON.stringify([...PRODUCT_FACES.flatMap((pf) => pf.gates)].sort()), JSON.stringify(r));
}
{
  const r = classifyFace(['.githooks/pre-push', 'package.json']);
  check('.githooks/ 与根 package.json 归 engine-code 面（钩子源/npm test 接线）',
    r.touched.has('engine-code') && r.skippedGateIds.length === 5, JSON.stringify(r));
}
{
  const r = classifyFace(['workflow/plans/2026-10-21-x.md', 'README.md']);
  check('workflow/ 文档路径不触 engine-code 面（业务关单普触 workflow——进面则裁剪失效）',
    r.touched.size === 0 && r.matched.length === 0 && r.skippedGateIds.length === 6, JSON.stringify(r));
}
{
  const r = classifyFace(['wiki/采购指南.md', 'DatabaseSql/x.sql']);
  check('wiki 路径不进 matched（wiki 门恒跑，不按面裁剪）', !r.matched.includes('wiki/采购指南.md') && !r.touched.has('wiki'), JSON.stringify(r));
  check('.sql 后缀归 backend 面', r.touched.has('backend') && r.skippedGateIds.length === 4, JSON.stringify(r));
}
{
  const r = classifyFace(['backend/A.cs', 'frontend/B.vue', 'workflow/C.md']);
  check('双产品面齐触 → 产品门全回列（engine-tests 不触引擎面仍跳）', r.touched.size === 2 && JSON.stringify(r.skippedGateIds) === JSON.stringify(['engine-tests']), JSON.stringify(r));
}

// ---- ② computeDiffScope（假 git 注入）----
// 命令形态（verify-scope.mjs 实发）：rev-parse HEAD｜merge-base --is-ancestor <hint> HEAD｜
// merge-base origin/main HEAD｜rev-parse --short <base>｜-c core.quotepath=off diff --name-only
// --no-renames <range>｜-c core.quotepath=off ls-files --others --exclude-standard
const mkGit = (map) => (args) => {
  const key = args.join(' ');
  for (const [prefix, res] of map) {
    if (key.startsWith(prefix)) return res;
  }
  return { status: 1, stdout: '' };
};
{
  const git = mkGit([
    ['merge-base --is-ancestor', { status: 0, stdout: '' }],
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['rev-parse --short', { status: 0, stdout: 'abc1234\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames abc1234..ccccccc', { status: 0, stdout: 'backend/A.cs\nworkflow/x.md\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: '' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: '' }],
  ]);
  const s = computeDiffScope(git, 'abc1234');
  check('组装：台账基线 hint（祖先成立）优先于 origin/main', s.baseShort === 'abc1234' && s.baseSource === 'ledger', JSON.stringify(s));
  check('组装：committed+worktree 合并去重、backend 触、frontend 三门 + 引擎自检跳', s.fileCount === 2 && s.touched.has('backend')
    && JSON.stringify(s.skippedGateIds) === JSON.stringify(['frontend-lint', 'frontend-unit-test', 'frontend-build', 'engine-tests']), JSON.stringify(s));
}
{
  const git = mkGit([
    ['merge-base --is-ancestor', { status: 1, stdout: '' }],
    ['merge-base origin/main', { status: 0, stdout: 'bbbbbbb\n' }],
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['rev-parse --short', { status: 0, stdout: 'bbb1111\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames bbbbbbb..ccccccc', { status: 0, stdout: 'frontend/A.vue\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: 'frontend/B.vue\nbackend/C.cs\n' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: '' }],
  ]);
  const s = computeDiffScope(git, 'deadbeef');
  check('组装：hint 非祖先（rebase 残留）→ 回落 origin/main', s.baseShort === 'bbb1111' && s.baseSource === 'origin/main', JSON.stringify(s));
  check('组装：工作区源并入 + 去重（3 文件，双产品面触）', s.fileCount === 3 && s.touched.size === 2 && JSON.stringify(s.skippedGateIds) === JSON.stringify(['engine-tests']), JSON.stringify(s));
}
{
  const git = mkGit([
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['merge-base origin/main', { status: 0, stdout: 'bbbbbbb\n' }],
    ['rev-parse --short', { status: 0, stdout: 'bbb1111\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames bbbbbbb..ccccccc', { status: 0, stdout: 'workflow/a.md\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: '' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: 'backend/B_untracked.cs\n' }],
  ]);
  const s = computeDiffScope(git);
  check('组装：untracked 第三源入面（复核 P1——未 add 的后端文件不逃逸）',
    s.fileCount === 2 && s.touched.has('backend') && s.skippedGateIds.length === 4, JSON.stringify(s));
}
{
  const git = mkGit([
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['merge-base origin/main', { status: 0, stdout: 'bbbbbbb\n' }],
    ['rev-parse --short', { status: 0, stdout: 'bbb1111\n' }],
    // --no-renames 输出形态：rename 的源与目的地双双出现（默认 rename 检测只报目的地，隐藏产品源路径）
    ['-c core.quotepath=off diff --name-only --no-renames bbbbbbb..ccccccc', { status: 0, stdout: 'backend/A.cs\nworkflow/moved.md\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: '' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: '' }],
  ]);
  const s = computeDiffScope(git);
  check('组装：rename 源/目的地双双入面（复核 P1——backend 源删除可见）',
    s.touched.has('backend') && s.skippedGateIds.length === 4, JSON.stringify(s));
}
{
  let msg = '';
  try { computeDiffScope(mkGit([['rev-parse', { status: 128, stdout: '' }]])); } catch (e) { msg = e.message; }
  check('fail-loud：基线解析失败抛错（直出 stderr 拒增量）', msg.includes('基线'), msg);
}
{
  let msg = '';
  const git = mkGit([
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['merge-base origin/main', { status: 0, stdout: 'bbbbbbb\n' }],
    ['rev-parse --short', { status: 0, stdout: 'bbb1111\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames bbbbbbb..ccccccc', { status: 0, stdout: '' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: '' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: '' }],
  ]);
  try { computeDiffScope(git); } catch (e) { msg = e.message; }
  check('fail-loud：diff 面为空抛错（无增量依据）', msg.includes('diff 面为空'), msg);
}

// ---- ③ 仓库凭证解析（verify-evidence-fallback 2026-10-22）----
{
  const text = [
    '# 验证绿凭证摘要（生成物，勿手改）',
    '| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |',
    '|---|---|---|---|---|',
    '| `aaaaaaa` | 2026-10-22T10:00:00.000Z | 15 | PASS 100 / FAIL 0 | — |',
    '| `bbbbbbb` | 2026-10-22T11:00:00.000Z | 10 | PASS 90 / FAIL 0 | scope=diff(base=aaaaaaa,skip=6) |',
    '| `ccccccc` | 2026-10-22T12:00:00.000Z | 15 | PASS 110 / FAIL 0 | run-42 |',
    '| `eeeeeee` | 2026-10-22T12:30:00.000Z | 11 | PASS 80 / FAIL 0 | fast=engine-tests |',
    '| `ddddddd` | not-a-date | 15 | PASS 1 / FAIL 0 | — |',
    '<!-- GENERATED:END -->',
  ].join('\n');
  const rows = parseEvidenceGreens(text);
  check('凭证解析：只认全量行（scope/fast 行剔除、带 runId 的全量行保留、坏时间剔除）',
    rows.length === 2 && rows[0].headShort === 'aaaaaaa' && rows[1].headShort === 'ccccccc', JSON.stringify(rows));
  const latest = rows.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] || null;
  check('凭证解析：最新全量行按 ts 取首', latest !== null && latest.headShort === 'ccccccc', JSON.stringify(latest));
  check('凭证解析：空文本 / 无数据行 → 空数组', parseEvidenceGreens('').length === 0 && parseEvidenceGreens('| x | y |').length === 0);
}
{
  const git = mkGit([
    ['merge-base --is-ancestor', { status: 0, stdout: '' }],
    ['rev-parse HEAD', { status: 0, stdout: 'ccccccc\n' }],
    ['rev-parse --short', { status: 0, stdout: 'abc1234\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames abc1234..ccccccc', { status: 0, stdout: 'workflow/x.md\n' }],
    ['-c core.quotepath=off diff --name-only --no-renames HEAD', { status: 0, stdout: '' }],
    ['-c core.quotepath=off ls-files --others --exclude-standard', { status: 0, stdout: '' }],
  ]);
  const s = computeDiffScope(git, 'abc1234', 'evidence');
  check('组装：仓库凭证基线 → baseSource=evidence（来源可对质）',
    s.baseShort === 'abc1234' && s.baseSource === 'evidence', JSON.stringify(s));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
