#!/usr/bin/env node
// closeout.test.mjs — L0–L3 单命令关单统一入口测试套件（2026-11-12 机制同步；自 closeout-l1.test.mjs 迁移 + 通用化扩展）
// A 段：parseArgs / fmOf / acceptanceOf / preflight 进程内断言（迁移自 closeout-l1 并按通用面改口径：
//       L2/L3 与 incidents 受理、终态 = 幂等重入不拒、级别缺失仍 fail-closed）。
// B 段：临时 git 仓黑盒——L0 幂等关单 / 终态重入跳过 / 外来暂存路径拒 / 禁 no-verify /
//       固定清单核对 / 归档重入（上次关单 ① 归档后 ④/⑤ 未走完的补完）。
// 完整立档车道执行链（confirm-doc 强门 → 归档 → 提交）由 test/e2e-fixture.mjs ⑦ 覆盖，此处不重复。
// 运行：node test/closeout.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, fmOf, acceptanceOf, preflight, candidatesFor } from '../scripts/closeout.mjs';

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

// ---- A1 parseArgs（双车道）----
{
  const a = parseArgs(['workflow/plans/x.md', '--delegated', '可以关单', '--root', 'E:/r']);
  check('A1 doc 车道三参齐解析', a.mode === 'doc' && a.doc === 'workflow/plans/x.md' && a.delegated === '可以关单' && a.root === 'E:/r' && !a.error, JSON.stringify(a));
  check('A1 缺文档 → error（提示 --l0 车道）', !!parseArgs(['--delegated', 'q']).error && /--l0/.test(parseArgs(['--delegated', 'q']).error));
  check('A1 --delegated 缺值 → error', !!parseArgs(['workflow/plans/x.md', '--delegated']).error);
  check('A1 未知参数 → error', !!parseArgs(['workflow/plans/x.md', '--wow']).error);
  check('A1 两份文档 → error', !!parseArgs(['a.md', 'b.md']).error);
  check('A1 --delegated= 等号形态', parseArgs(['x.md', '--delegated=原话']).delegated === '原话');
  const l0 = parseArgs(['--l0', '修文案错字', 'src/a.js', 'src/b.js']);
  check('A1 l0 车道：判据 + 产品文件', l0.mode === 'l0' && l0.l0 === '修文案错字' && l0.files.length === 2 && !l0.error, JSON.stringify(l0));
  check('A1 l0 空判据 → error（fail-closed）', !!(parseArgs(['--l0', '   ']).error || parseArgs(['--l0']).error));
  check('A1 l0 + --delegated 互斥 → error', !!parseArgs(['--l0', 'x', '--delegated', 'y']).error);
  check('A1 l0 产品文件超上限 → error', !!parseArgs(['--l0', 'x', '1', '2', '3', '4', '5', '6']).error);
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
  check('A3 L1+approved+全勾+有凭证 → ok', pf.ok === true && pf.problems.length === 0 && pf.checked === 2 && pf.terminal === false, JSON.stringify(pf));
}

// ---- A4 通用面：L2/L3 与 incidents 受理；draft / 级别缺失仍拒 ----
{
  const l2 = preflight({ rel: 'workflow/intents/x.md', text: PLAN_OK.replace('级别: L1', '级别: L2'), freshVerify: true });
  check('A4 L2 intent → 受理（通用关单面）', l2.ok === true, JSON.stringify(l2.problems));
  const inc = preflight({ rel: 'workflow/incidents/x.md', text: PLAN_OK.replace('状态: approved', '状态: fixed'), freshVerify: true });
  check('A4 incident(fixed) → 受理且不查验收节（三件套判据单源 confirm-doc）', inc.ok === true && inc.total === 0, JSON.stringify(inc.problems));
  const incOpen = preflight({ rel: 'workflow/incidents/x.md', text: PLAN_OK.replace('状态: approved', '状态: open'), freshVerify: true });
  check('A4 incident(open→fixed 第一跳) → 受理', incOpen.ok === true, JSON.stringify(incOpen.problems));
  const draft = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK, freshVerify: true }).ok
    ? preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('状态: approved', '状态: draft'), freshVerify: true })
    : null;
  check('A4 draft → 拒（须先过起草确认）', draft && !draft.ok && draft.problems.some((p) => p.includes('draft')), draft && JSON.stringify(draft.problems));
  check('A4 级别缺失也拒（fail-closed）', !preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('级别: L1\n', ''), freshVerify: true }).ok);
}

// ---- A5 路径受理面 ----
{
  check('A5 specs 路径受理', preflight({ rel: 'workflow/specs/x.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 模板不受理', !preflight({ rel: 'workflow/plans/_TEMPLATE.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 子目录路径不受理', !preflight({ rel: 'workflow/plans/sub/x.md', text: PLAN_OK, freshVerify: true }).ok);
  check('A5 workflow 外路径不受理', !preflight({ rel: 'docs/x.md', text: PLAN_OK, freshVerify: true }).ok);
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

// ---- A7 终态 = 幂等重入（沿源口径：终态跳过代录，不再拒）----
{
  for (const st of ['done', 'closed', 'cancelled', 'superseded']) {
    const pf = preflight({ rel: 'workflow/plans/x.md', text: PLAN_OK.replace('状态: approved', `状态: ${st}`), freshVerify: false });
    check(`A7 终态 ${st} → ok（terminal 标记，免勾验/免绿行检查）`, pf.ok === true && pf.terminal === true, JSON.stringify(pf));
  }
}

// ==== B 段：临时 git 仓黑盒 ====
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'closeout.mjs');
const SRC = fs.readFileSync(CLI, 'utf8').replace(/\r/g, '');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

const mkRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closeout-git-'));
  const g = (args) => {
    const r = spawnSync(GIT, args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture git 失败: git ${args.join(' ')}\n${r.stderr}`);
    return String(r.stdout || '').trim();
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  return { root, g };
};
const greenLine = () => `${JSON.stringify({ ts: new Date().toISOString(), exitCode: 0, suite: 'fixture' })}\n`;
const runCli = (args, root) => spawnSync(process.execPath, [CLI, ...args, '--root', root], { cwd: root, encoding: 'utf8' });
const commitSubjects = (root) => String(spawnSync(GIT, ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);

// ---- B1 candidatesFor 固定清单形状 ----
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'confirmations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'x.md'), PLAN_OK, 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'INDEX.md'), '# idx\n', 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.d', 'x.jsonl'), '{}\n', 'utf8');
  const cands = candidatesFor(root, 'workflow/plans/x.md');
  const expect = [
    'workflow/plans/x.md',
    'workflow/INDEX.md',
    'workflow/verify-evidence.md',
    '.agents/confirmations.d/x.jsonl',
    '.agents/confirmations.jsonl',
  ];
  check('B1 固定清单：文档 + 活跃原路径 + 固定面 + 分片 + 主账，无外来项',
    expect.every((p) => cands.includes(p)) && cands.length === expect.length, JSON.stringify(cands));
  // 归档目的地双侧枚举：同基名归档件在场时进清单（rename 检测关闭时旧路径删除态也要认）
  fs.mkdirSync(path.join(root, 'workflow', 'archive', '2026-11', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'archive', '2026-11', 'plans', 'x.md'), PLAN_OK, 'utf8');
  const cands2 = candidatesFor(root, 'workflow/plans/x.md');
  check('B1 固定清单：归档目的地入列（基名双侧）',
    cands2.includes('workflow/archive/2026-11/plans/x.md') && cands2.includes('workflow/plans/x.md'), JSON.stringify(cands2));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B2 L0 免立档关单 + 幂等重入 ----
{
  const { root, g } = mkRepo();
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n', 'utf8');
  fs.writeFileSync(path.join(root, 'a.js'), 'console.log(1)\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  fs.writeFileSync(path.join(root, 'a.js'), 'console.log(2)\n', 'utf8');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'), greenLine(), 'utf8');
  const r1 = runCli(['--l0', '修文案错字', 'a.js'], root);
  check('B2 L0 首跑 → exit 0（免立档跳过 ①）', r1.status === 0, `exit=${r1.status}\n${r1.stdout}${r1.stderr}`);
  check('B2 L0 输出报免立档跳过', /免立档/.test(r1.stdout), r1.stdout);
  const body = String(spawnSync(GIT, ['log', '-1', '--format=%B'], { cwd: root, encoding: 'utf8' }).stdout || '');
  check('B2 L0 提交消息体带行首 L0: 判据行（commit-msg 门放行判据）', /^L0: 修文案错字$/m.test(body), body);
  check('B2 L0 提交只含候选（a.js + INDEX）', (() => {
    const files = String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).sort();
    return JSON.stringify(files) === JSON.stringify(['a.js', 'workflow/INDEX.md']);
  })(), String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout));
  // 幂等重入：无暂存改动 → 跳过 commit，不产生第二笔关单提交
  const r2 = runCli(['--l0', '修文案错字', 'a.js'], root);
  check('B2 L0 重跑 → exit 0 且跳过 commit（幂等）', r2.status === 0 && /跳过 commit/.test(r2.stdout), `exit=${r2.status}\n${r2.stdout}${r2.stderr}`);
  check('B2 L0 重跑不产生第二笔提交', commitSubjects(root).filter((s) => s.includes('L0 极简道关单')).length === 1, commitSubjects(root).join(' | '));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B3 L0 缺 24h 绿行 → 预检拦 ----
{
  const { root, g } = mkRepo();
  fs.writeFileSync(path.join(root, 'a.js'), 'x\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const r = runCli(['--l0', '小改', 'a.js'], root);
  check('B3 L0 无 verify 绿行 → exit 2 且指 verify.mjs', r.status === 2 && /verify\.mjs/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B4 立档车道终态重入：已终态跳过 ①，剩余步骤补完 ----
{
  const { root, g } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'confirmations.d'), { recursive: true });
  const doneDoc = PLAN_OK.replace('状态: approved', '状态: done');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'x.md'), doneDoc, 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.d', 'x.jsonl'), '{}\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  // 上次关单留下的未提交残余：INDEX 重生成差异 + 分片新行
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.d', 'x.jsonl'), '{}\n{"tail":true}\n', 'utf8');
  const r = runCli(['workflow/plans/x.md'], root); // 无 --delegated：终态重入不需要代录
  check('B4 终态重入 → exit 0 且跳过 confirm-doc', r.status === 0 && /跳过 confirm-doc/.test(r.stdout), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('B4 关单提交落库且文档未被二次代录（状态仍 done）',
    /状态: done/.test(fs.readFileSync(path.join(root, 'workflow', 'plans', 'x.md'), 'utf8'))
    && commitSubjects(root).some((s) => s.includes('x 关单')), commitSubjects(root).join(' | '));
  check('B4 提交清单核对：分片 + INDEX 入库、无产品件夹带（文档已在 base 提交且无改动 → 不重复入库）', (() => {
    const files = String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).sort();
    return JSON.stringify(files) === JSON.stringify(['.agents/confirmations.d/x.jsonl', 'workflow/INDEX.md']);
  })(), String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B5 外来暂存路径拒（防夹带，步骤 ④）----
{
  const { root, g } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'x.md'), PLAN_OK.replace('状态: approved', '状态: done'), 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  fs.writeFileSync(path.join(root, 'unrelated.txt'), '别人在途的改动\n', 'utf8');
  g(['add', 'unrelated.txt']);
  const r = runCli(['workflow/plans/x.md'], root);
  check('B5 外来暂存路径 → exit 1 且点名「本序列之外的路径」', r.status === 1 && /本序列之外的路径/.test(r.stderr) && /unrelated\.txt/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  check('B5 拒提交（外来路径未被夹带入库）', commitSubjects(root).length === 1, commitSubjects(root).join(' | '));
  check('B5 恢复提示带重入命令', /重跑同一命令/.test(r.stderr), r.stderr);
  g(['reset', '-q', 'HEAD', '--', 'unrelated.txt']);
  const r2 = runCli(['workflow/plans/x.md'], root);
  check('B5 撤销外来路径后重跑 → exit 0（幂等补完）', r2.status === 0, `exit=${r2.status}\n${r2.stdout}${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B6 归档重入：① 已归档（git mv 搬家）而 ④/⑤ 未走完 → 按归档路径补完 ----
{
  const { root, g } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'archive', '2026-11', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'confirmations.d'), { recursive: true });
  const doneDoc = PLAN_OK.replace('状态: approved', '状态: done');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'x.md'), doneDoc, 'utf8');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  g(['mv', 'workflow/plans/x.md', 'workflow/archive/2026-11/plans/x.md']); // 模拟上次关单 ① 的归档搬家（已暂存）
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.d', 'x.jsonl'), '{}\n', 'utf8');
  const r = runCli(['workflow/plans/x.md'], root); // 活跃层原路径已不在
  check('B6 归档重入 → exit 0 且按归档路径重入', r.status === 0 && /按归档路径重入/.test(r.stdout), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('B6 归档件与分片一并入库（rename 双形态不误拒）', (() => {
    const files = String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).sort();
    return files.includes('workflow/archive/2026-11/plans/x.md') && files.includes('.agents/confirmations.d/x.jsonl');
  })(), String(spawnSync(GIT, ['show', '--name-only', '--format='], { cwd: root, encoding: 'utf8' }).stdout));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- B7 禁 --no-verify：提交调用面静态锁（提交一律 `git commit -m`，无绕过参数）----
{
  const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // 头注合法提及该词，只扫代码行
  check('B7 代码面无 --no-verify（绕过开关不进本入口）', !code.includes('--no-verify'), '');
  check('B7 提交调用字面 = git commit -m（无额外旗标）', SRC.includes("['commit', '-m', subject, ...bodyArgs]"), '');
  check('B7 bodyArgs 仅 L0 车道注入且为判据行（非旗标位）', /bodyArgs: \['-m', `L0: \$\{judgement\}`\]/.test(SRC), '');
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
