#!/usr/bin/env node
// workbench-model.test.mjs — 交付工作台聚合模型测试（P1，2026-11-14）
// 手法：mkdtemp 临时 git 仓 + 夹具族（L2 活跃 / L1 draft / 归档 done / 面板族 + 确认账 + artifacts）
// 断言：①环节推导八键三态（intake/spec/plan/implement/verify/review/ship/closeout 逐型）②章聚合
// ③决策面（draft 待确认 / 面板未处置 / deferred 挂账 / recent / panels）④产品提交锚短名匹配
// ⑤非 git 仓退化（branch null、feed null、模型仍可建不崩）⑥纯函数边（checkboxOf 只数验收节 / runIdsOf 7 位段）。
// 零依赖，Node ≥ 18 直接运行：node test/workbench-model.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildWorkbench, checkboxOf, shortOf, runIdsOf, deriveStages, deriveChapters,
} from '../scripts/workbench-model.mjs';

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const PLAN = (status, level, extra = '') => [
  '---', `状态: ${status}`, `级别: ${level}`, '日期: 2026-11-14', '---',
  `# PLAN — ${extra || '测试'}`, '',
  '## 入口', '- 来源：测试', '- 目标：验证', '',
  '- [ ] 规则 / 契约变更 → 级别至少 L2', '- [ ] schema / 迁移 → L3', '',
  '## 改动方案', '- `src/app.js`：改一行', '',
  '## 验收标准（可测试）', ...(extra === 'partial' ? ['- [x] 其一', '- [ ] 其二'] : ['- [x] 全过']),
].join('\n');

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-model-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  return { d, g };
};

// ---- ⑥ 纯函数边 ----
{
  const planText = [
    '## 入口', '- [ ] 规则（模板常驻未勾，不进验收计数）', '',
    '## 验收标准（可测试）', '- [x] A', '- [ ] B', '- [x] C', '',
    '## 确认与复核', '- [x] 模板区勾选也不进计数',
  ].join('\n');
  const cb = checkboxOf(planText);
  check('checkboxOf 只数验收节（done=2 total=3，入口/确认节不稀释）', cb.done === 2 && cb.total === 3, JSON.stringify(cb));
  check('checkboxOf 无验收节 → 0/0', checkboxOf('# 无节\n- [x] x').total === 0);
  check('shortOf 去日期前缀', shortOf('2026-11-14-workbench-p1') === 'workbench-p1');
  check('shortOf 无日期前缀原样', shortOf('abc') === 'abc');
  check('runIdsOf 兼容 7 位段（git --short）', JSON.stringify(runIdsOf('pr-review `pr-baf1e6e-753574e2`')) === '["pr-baf1e6e-753574e2"]');
}

// ---- ①②④ 型族推导（git 夹具）----
{
  const { d, g } = mkRepo();
  const wr = (rel, text) => {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    return rel.replace(/\\/g, '/');
  };
  // 族 A：L2 活跃 + 产品提交锚（消息带短名）
  wr('workflow/intents/2026-11-01-l2-family.md', '---\n状态: approved\n---\n# INTENT — L2族\n');
  wr('workflow/specs/2026-11-01-l2-family.md', '---\n状态: approved\n---\n# SPEC — L2族\n');
  wr('workflow/plans/2026-11-01-l2-family.md', PLAN('approved', 'L2', 'partial'));
  wr('src/app.js', 'console.log(1)\n');
  g('add', '-A'); g('commit', '-qm', 'feat: l2-family 首产品提交');
  // 族 B：L1 draft（无产品提交）
  wr('workflow/plans/2026-11-02-l1-draft.md', PLAN('draft', 'L1'));
  // 族 C：归档 done（验收全勾）
  wr('workflow/archive/2026-10/plans/2026-10-31-archived.md', PLAN('done', 'L1'));
  // 面板族 D：台账行对象含 runId、族 plan 体引用同 runId
  wr('workflow/plans/2026-11-03-panel-family.md', PLAN('done', 'L1').replace('# PLAN — 测试', '# PLAN — 面板（run pr-deadbee-12345678 对 0.1.x）'));
  wr('workflow/reviews.d/2026-11.md', '# 台账\n\n| 日期 | 对象 | 复核员 | 意见数 | 采纳 | 拒绝 | 误报 | 备注 |\n|---|---|---|---|---|---|---|---|\n| 2026-11-03 | pr-review `pr-deadbee-12345678` | panel | 2 | 2 | 0 | 0 | ok |\n');
  // artifacts：1 条 deferred + 1 条未处置（P2：run 带 lenses/files 供执行视图计数）
  wr('workflow/reviews.d/artifacts/2026-11/pr-deadbee-12345678.json', JSON.stringify({
    schema: 1, run: { runId: 'pr-deadbee-12345678', lenses: ['correctness', 'security'], files: ['a.mjs', 'b.mjs'] }, writtenAt: '2026-11-03T00:00:00.000Z',
    findings: [
      { id: 'D-001', status: 'deferred' },
      { id: 'U-001' },
      { id: 'F-001', status: 'fixed' },
    ],
  }));
  // 门禁运行遥测（P2 执行视图）：一行全绿 + 一行含失败门
  wr('.agents/verifications.jsonl', [
    JSON.stringify({ ts: '2026-11-03T01:00:00.000Z', exitCode: 0, headShort: 'aaaa111', gates: [{ id: 'g1', exit: 0 }, { id: 'g2', exit: 0 }], totalMs: 100, wallMs: 90 }),
    JSON.stringify({ ts: '2026-11-03T02:00:00.000Z', exitCode: 1, headShort: 'bbbb222', gates: [{ id: 'g1', exit: 0 }, { id: 'g2', exit: 1 }], totalMs: 200, wallMs: 180 }),
  ].join('\n') + '\n');
  // 确认账
  wr('.agents/confirmations.d/2026-11-02-l1-draft.jsonl', JSON.stringify({ ts: '2026-11-02T01:00:00.000Z', doc: 'workflow/plans/2026-11-02-l1-draft.md', stage: 'draft', source: 'chat-delegated', quoteGrounding: 'verbatim' }) + '\n');
  g('add', '-A'); g('commit', '-qm', 'docs: 其余夹具');

  const m = buildWorkbench({ root: d, now: new Date('2026-11-14T08:00:00.000Z') });
  const by = (id) => m.deliveries.find((x) => x.id.endsWith(id));
  const st = (d0, key) => d0.stages.find((s) => s.key === key);

  const a = by('l2-family');
  check('L2 族八环节齐全', a && a.stages.length === 8 && ['intake','spec','plan','implement','verify','review','ship','closeout'].every((k) => st(a, k)));
  check('L2 intake done（intent 在场）', st(a, 'intake').state === 'done');
  check('L2 spec done（approved）', st(a, 'spec').state === 'done');
  check('L2 plan done（approved）', st(a, 'plan').state === 'done');
  check('L2 implement done（产品锚=提交消息短名匹配）', st(a, 'implement').state === 'done' && /产品提交锚/.test(st(a, 'implement').evidence), st(a, 'implement').evidence);
  check('L2 verify active（验收勾验 1/2）', st(a, 'verify').state === 'active' && st(a, 'verify').evidence.includes('1/2'), st(a, 'verify').evidence);
  check('L2 closeout active（活跃未归档）', st(a, 'closeout').state === 'active');
  check('L2 chapters：build=done、design=done、plan=done、test=active', a.chapters.plan.state === 'done' && a.chapters.design.state === 'done' && a.chapters.build.state === 'done' && a.chapters.test.state === 'active', JSON.stringify(a.chapters));

  const b = by('l1-draft');
  check('L1 draft：intake active（入口待确认）', st(b, 'intake').state === 'active');
  check('L1 draft：spec na（不走 spec）', st(b, 'spec').state === 'na' && st(b, 'spec').evidence.includes('L1'));
  check('L1 draft：plan active', st(b, 'plan').state === 'active');
  check('L1 draft：implement queued', st(b, 'implement').state === 'queued');
  check('L1 draft 进 pending（doc-confirm 带命令指引）', m.decisions.pending.some((p) => p.kind === 'doc-confirm' && p.label.includes('l1-draft') && /confirm-doc/.test(p.cmd)));

  const c = by('archived');
  check('归档 done：closeout done', st(c, 'closeout').state === 'done');
  check('归档 done：verify done（全勾）', st(c, 'verify').state === 'done' && /全勾/.test(st(c, 'verify').evidence));
  check('归档 done：状态 done（非 active）', c.status === 'done');

  const p = by('panel-family');
  check('面板族 review done（runId 交叉引用）', st(p, 'review').state === 'done' && st(p, 'review').evidence.includes('pr-deadbee'), st(p, 'review').evidence);

  check('pending 含面板未处置（1/3 无处置）', m.decisions.pending.some((x) => x.kind === 'panel-undisposed' && /1\/3/.test(x.detail)), JSON.stringify(m.decisions.pending.map((x) => x.kind)));
  check('pending 含 deferred 挂账（D-001）', m.decisions.pending.some((x) => x.kind === 'deferred-finding' && x.label.includes('D-001')));
  check('stats.deferredFindings = 1', m.stats.deferredFindings === 1);
  check('recent 确认账非空（source=chat-delegated）', m.decisions.recent.length >= 1 && m.decisions.recent[0].source === 'chat-delegated');
  check('panels 行级解析（对象含 runId、意见 2）', m.decisions.panels.some((r) => r.object.includes('pr-deadbee') && r.findings === 2));
  check('docs.confirmedAt 回填（l1-draft 有确认账行）', by('l1-draft').docs.some((x) => x.path.includes('l1-draft') && x.confirmedAt));
  check('stats.panelFindingsMonth 当月合计 = 2', m.stats.panelFindingsMonth === 2, String(m.stats.panelFindingsMonth));
  check('repo 面：branch 非 HEAD、head 非空', typeof m.repo.branch === 'string' && m.repo.branch !== 'HEAD' && !!m.repo.head);

  // ---- P2：执行运行流 + Git 只读面 ----
  const v = m.execution.verifications;
  check('P2 verifications 尾读倒序（最新在前）', v.length === 2 && v[0].ts > v[1].ts, JSON.stringify(v.map((x) => x.ts)));
  check('P2 verifications 映射（gateCount/failedGates/wallMs）', v[0].gateCount === 2 && JSON.stringify(v[0].failedGates) === '["g2"]' && v[0].exitCode === 1 && v[1].wallMs === 90 && JSON.stringify(v[1].failedGates) === '[]',
    JSON.stringify(v[0]));
  const pr = m.execution.panelRuns;
  check('P2 panelRuns 带 lenses/files 计数', pr.length === 1 && pr[0].runId === 'pr-deadbee-12345678' && pr[0].lenses === 2 && pr[0].files === 2 && pr[0].total === 3,
    JSON.stringify(pr[0] || {}));
  check('P2 panelRuns 不泄内部 deferredIds/file 键', pr[0] && !('deferredIds' in pr[0]) && !('file' in pr[0]));
  const gf = m.git;
  check('P2 git.branches 当前分支标记 + 最近提交', gf.branches.length >= 1 && gf.branches.some((b) => b.current && b.lastSubject), JSON.stringify(gf.branches[0] || {}));
  check('P2 git.commits 带短 SHA 与台账标记（首条=夹具 docs 提交 ledgerOnly）', gf.commits.length >= 2 && /^[0-9a-f]{7,}$/.test(gf.commits[0].short) && gf.commits[0].ledgerOnly === true,
    JSON.stringify(gf.commits[0] || {}));
  check('P2 git.commits 产品提交 ledgerOnly=false（feat 夹具在列）', gf.commits.some((c) => c.ledgerOnly === false));
  check('P2 git.dirtyFiles 干净仓为空数组不 capped', Array.isArray(gf.dirtyFiles) && gf.dirtyFiles.length === 0 && gf.dirtyFilesCapped === false);
}

// ---- ⑤ 非 git 仓退化 ----
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nogit-'));
  fs.mkdirSync(path.join(d, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workflow', 'plans', '2026-11-05-solo.md'), PLAN('approved', 'L1'), 'utf8');
  const m = buildWorkbench({ root: d });
  check('非 git 仓：branch null 退化', m.repo.branch === null);
  check('非 git 仓：模型仍可建（deliveries=1）', m.stats.deliveries === 1);
  check('非 git 仓：implement active（approved 无锚，不误报 done）', m.deliveries[0].stages.find((s) => s.key === 'implement').state === 'active');
  check('非 git 仓：execution/git 面退化不崩（verifications 空数组、branches 空、dirtyFiles null）',
    Array.isArray(m.execution.verifications) && m.execution.verifications.length === 0 && m.git.branches.length === 0 && m.git.commits.length === 0 && m.git.dirtyFiles === null,
    JSON.stringify({ v: m.execution.verifications.length, b: m.git.branches.length, c: m.git.commits.length, d: m.git.dirtyFiles }));
  fs.rmSync(d, { recursive: true, force: true });
}

// ---- deriveStages/deriveChapters 直连边 ----
{
  const stages = deriveStages({ stem: 'x', bodyText: '' }, { prodTs: null, shipTs: null, revs: 0 }, []);
  check('空族推导不崩（八键齐）', Object.keys(stages).length === 8 && STAGE_OK(stages));
  const ch = deriveChapters(stages);
  check('章聚合：四键齐', ['plan', 'design', 'build', 'test'].every((k) => ch[k]));
}
function STAGE_OK(stages) {
  return ['intake', 'spec', 'plan', 'implement', 'verify', 'review', 'ship', 'closeout'].every((k) => stages[k] && ['queued', 'active', 'done', 'na'].includes(stages[k].state));
}

console.log(fail === 0 ? `\n全部通过。（${pass}）` : `\n${fail} 项失败。`);
process.exit(fail === 0 ? 0 : 1);
