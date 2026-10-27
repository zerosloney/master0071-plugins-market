#!/usr/bin/env node
// closeout-l1.test.mjs — L1 关单编排纯函数套件（2026-10-15 减重手段④随附）
// parseArgs / fmOf / acceptanceOf / preflight 进程内断言：快筛差距逐项暴露、
// L2/L3 与终态件不受理、勾验缺一即拦、verify 凭证缺失即拦。
// 运行：node test/closeout-l1.test.mjs
import { parseArgs, fmOf, acceptanceOf, preflight } from '../scripts/closeout-l1.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const PLAN_OK = `---
状态: approved
级别: L1
模块: purchase
---
# PLAN — demo

## 改动方案

- 改 A

## 验收标准（可测试）

- [x] 判据一（证据：UI 实测 A1 PASS）
- [x] 判据二（证据：UT 用例名 demo_case）
`;

// ---- A1 parseArgs ----
{
  const a = parseArgs(['workflow/plans/x.md', '--delegated', '可以关单', '--root', 'E:/r']);
  check('A1 三参齐解析', a.plan === 'workflow/plans/x.md' && a.delegated === '可以关单' && a.root === 'E:/r' && !a.error, JSON.stringify(a));
  check('A1 缺 plan → error', !!parseArgs(['--delegated', 'q']).error);
  check('A1 --delegated 缺值 → error', !!parseArgs(['workflow/plans/x.md', '--delegated']).error);
  check('A1 未知参数 → error', !!parseArgs(['workflow/plans/x.md', '--wow']).error);
  check('A1 两份 plan → error', !!parseArgs(['a.md', 'b.md']).error);
  check('A1 --delegated= 等号形态', parseArgs(['x.md', '--delegated=原话']).delegated === '原话');
}

// ---- A2 fmOf / acceptanceOf ----
{
  const fm = fmOf(PLAN_OK);
  check('A2 frontmatter 状态/级别', fm['状态'] === 'approved' && fm['级别'] === 'L1' && fm['模块'] === 'purchase', JSON.stringify(fm));
  const acc = acceptanceOf(PLAN_OK);
  check('A2 验收节 2 条全勾', acc.found === true && acc.total === 2 && acc.unchecked.length === 0, JSON.stringify(acc));
  check('A2 无验收节 → found=false', acceptanceOf('# 无节文档\n\n- [ ] 孤儿勾选不算').found === false);
  const mixed = acceptanceOf('## 验收标准\n\n- [x] 甲\n- [ ] 乙待办\n- [X] 丙大写勾\n\n## 下一节\n\n- [ ] 节外不算\n');
  check('A2 未勾只数节内（乙），大写 X 认勾、节外不计', mixed.total === 3 && mixed.unchecked.length === 1 && mixed.unchecked[0] === '乙待办', JSON.stringify(mixed));
  check('A2 节在无勾选框条目 → total=0', acceptanceOf('## 验收标准\n\n纯文字段\n').total === 0);
}

// ---- A3 preflight 快乐路径 ----
{
  const pf = preflight({ rel: 'workflow/plans/2026-10-15-demo.md', text: PLAN_OK, freshVerify: true });
  check('A3 L1+approved+全勾+有凭证 → ok', pf.ok === true && pf.problems.length === 0 && pf.checked === 2, JSON.stringify(pf));
}

// ---- A4 级别/状态不受理 ----
{
  const l2 = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('级别: L1', '级别: L2'), freshVerify: true });
  check('A4 L2 → 拒并指回 test.md', !l2.ok && l2.problems.some((p) => p.includes('L2/L3') && p.includes('test.md')), JSON.stringify(l2.problems));
  const st = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK, freshVerify: true });
  const draft = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('状态: approved', '状态: draft'), freshVerify: true });
  check('A4 draft → 拒（须先过起草确认）', !draft.ok && draft.problems.some((p) => p.includes('draft')), JSON.stringify(draft.problems));
  const done = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('状态: approved', '状态: done'), freshVerify: true });
  check('A4 done → 拒（已收口）', !done.ok && done.problems.some((p) => p.includes('终态')), JSON.stringify(done.problems));
  check('A4 级别缺失也拒（fail-closed）', !preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('级别: L1\n', ''), freshVerify: true }).ok);
}

// ---- A5 路径受理面 ----
{
  check('A5 intents 路径不受理', !preflight({ rel: 'workflow/intents/x.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 incidents 路径不受理', !preflight({ rel: 'workflow/incidents/x.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 模板不受理', !preflight({ rel: 'workflow/plans/_TEMPLATE.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 子目录路径不受理', !preflight({ rel: 'workflow/plans/sub/x.md', text: PLAN_OK, freshVerify: true }).ok);
}

// ---- A6 勾验与凭证差距 ----
{
  const unchecked = preflight({
    rel: 'workflow/plans/x.md',
    text: PLAN_OK.replace('- [x] 判据二（证据：UT 用例名 demo_case）', '- [ ] 判据二'),
    freshVerify: true,
  });
  check('A6 未勾验逐条列出（计数行 + 条目行分项）', !unchecked.ok
    && unchecked.problems.some((p) => p.includes('1/2 条未勾验'))
    && unchecked.problems.some((p) => p.includes('判据二')), JSON.stringify(unchecked.problems));
  const noVerify = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK, freshVerify: false });
  check('A6 verify 凭证缺失 → 拦并指 verify.mjs', !noVerify.ok && noVerify.problems.some((p) => p.includes('verify.mjs')), JSON.stringify(noVerify.problems));
  const noAcc = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.split('## 验收标准')[0], freshVerify: true });
  check('A6 无验收节 → 拦', !noAcc.ok && noAcc.problems.some((p) => p.includes('验收标准')));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
