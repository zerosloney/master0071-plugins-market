#!/usr/bin/env node
// check-commit-plan-ref.test.mjs — 提交消息任务短名校验（2026-11-12 判据移植，advisory 恒 exit 0）
// tmp git 仓 spawn 真实 CLI。断言：①唯一覆盖 plan 缺短名 → warn（exit 0）；②消息含短名 → ✅；
// ③多 plan 至少含其一；④skip 四态（合并 / L0 trailer / 无产品路径 / 无覆盖 plan）；
// ⑤planSlugRe 模板单源：项目侧 .agents/config/commit-msg-rules.json 覆盖内联默认（边界收紧生效）；
// ⑥插件种子 commit-msg-rules.json：exemptPrefix 含 git 自带 squash 模板首行（69ece3f46 squash 消息
//   豁免半件回补回归）+ planSlugRe 在场。
// 零依赖，Node ≥ 18 直接运行：node test/check-commit-plan-ref.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'check-commit-plan-ref.mjs');
const SEED_RULES = path.join(TEST_DIR, '..', 'config-templates', 'commit-msg-rules.json');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const SLUG = '2026-11-12-demo';
const mkRepo = ({ rules } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-'));
  const g = (...a) => spawnSync(GIT, ['-c', 'core.quotepath=off', ...a], { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'README.md'), '# base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  if (rules) {
    fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'config', 'commit-msg-rules.json'), JSON.stringify(rules));
  }
  return { root, g };
};
const stageProductWithPlan = (root, g, slug, product) => {
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', `${slug}.md`),
    `---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — ${slug}\n\n## 改动面\n- ${product}\n`);
  fs.mkdirSync(path.dirname(path.join(root, product)), { recursive: true });
  fs.writeFileSync(path.join(root, product), '// p\n');
  g('add', '-A');
};
const run = (root, msgBody) => {
  const msgFile = path.join(root, '.git', 'CPR_MSG');
  fs.mkdirSync(path.dirname(msgFile), { recursive: true });
  fs.writeFileSync(msgFile, msgBody);
  return spawnSync(process.execPath, [CLI, msgFile], { cwd: root, encoding: 'utf8' });
};

// ---- ① 唯一覆盖 plan 缺短名 → warn + exit 0（advisory 不阻断） ----
{
  const { root, g } = mkRepo();
  stageProductWithPlan(root, g, SLUG, 'backend/ref.cs');
  const r = run(root, 'feat: 没写短名的消息\n');
  check('① 唯一 plan 缺短名 → exit 0 + stderr warn（建议写法）',
    r.status === 0 && r.stderr.includes('任务短名') && r.stderr.includes(`「${SLUG}」`) && r.stderr.includes(`feat(${SLUG})`), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② 消息含短名（首行 / 正文均可）→ ✅ ----
{
  const { root, g } = mkRepo();
  stageProductWithPlan(root, g, SLUG, 'backend/ref.cs');
  const r1 = run(root, `feat(${SLUG}): 带短名的消息\n`);
  const r2 = run(root, `feat: 正文提及 ${SLUG}\n`);
  check('② 首行/正文含短名 → ✅ exit 0',
    r1.status === 0 && r1.stdout.includes(`「${SLUG}」`) && r2.status === 0 && r2.stdout.includes('✅'), `exits=${r1.status}/${r2.status}\n${r1.stdout}${r2.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 多 plan 覆盖：至少含其一 ----
{
  const { root, g } = mkRepo();
  stageProductWithPlan(root, g, SLUG, 'backend/ref.cs');
  const slug2 = '2026-11-12-second';
  fs.writeFileSync(path.join(root, 'workflow', 'plans', `${slug2}.md`),
    `---\n状态: approved\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — ${slug2}\n\n## 改动面\n- backend/ref2.cs\n`);
  fs.writeFileSync(path.join(root, 'backend', 'ref2.cs'), '// p2\n');
  g('add', '-A');
  const miss = run(root, 'feat: 两份都没提\n');
  check('③a 两份 plan 均未提及 → warn 至少含其一', miss.status === 0 && miss.stderr.includes('2 份 plan') && miss.stderr.includes('至少含其一'), `exit=${miss.status}\n${miss.stderr}`);
  const hit = run(root, `feat: 只提 ${slug2}\n`);
  check('③b 含其一 → ✅ + 未提及提示', hit.status === 0 && hit.stdout.includes('✅') && hit.stdout.includes('未提及'), `exit=${hit.status}\n${hit.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ skip 四态（各自独立夹具，互不污染暂存面） ----
{
  // ④a 合并形态
  const { root, g } = mkRepo();
  stageProductWithPlan(root, g, SLUG, 'backend/ref.cs');
  const mergeHead = path.resolve(root, g('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim());
  fs.writeFileSync(mergeHead, 'fixture\n');
  const rMerge = run(root, 'feat: 合并提交\n');
  check('④a 合并形态 → SKIP', rMerge.status === 0 && rMerge.stdout.includes('SKIP: 任务短名校验——合并'), `exit=${rMerge.status}\n${rMerge.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // ④b L0 trailer → SKIP（豁免 A 复用同判据；L0 不立 plan 即无短名可指）
  const { root, g } = mkRepo();
  stageProductWithPlan(root, g, SLUG, 'backend/ref.cs');
  const rL0 = run(root, 'feat: x\n\nL0: 修文案错字\n');
  check('④b L0 trailer → SKIP', rL0.status === 0 && rL0.stdout.includes('L0 极简道'), `exit=${rL0.status}\n${rL0.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // ④c 未暂存产品路径 → SKIP
  const { root } = mkRepo();
  const rNone = run(root, 'docs: 只改台账\n');
  check('④c 未暂存产品路径 → SKIP', rNone.status === 0 && rNone.stdout.includes('未暂存产品路径'), `exit=${rNone.status}\n${rNone.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // ④d 覆盖 plan 为零（draft plan 不算覆盖）→ SKIP
  const { root, g } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'draft.md'),
    '---\n状态: draft\n级别: L1\n日期: 2026-11-12\n模块: pipeline\n---\n# PLAN — draft\n\n## 改动面\n- backend/ref.cs\n');
  fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'ref.cs'), '// p\n');
  g('add', '-A');
  const rNoCover = run(root, 'feat: 只有 draft plan\n');
  check('④d 无覆盖 plan（draft 不算）→ SKIP', rNoCover.status === 0 && rNoCover.stdout.includes('无覆盖 plan'), `exit=${rNoCover.status}\n${rNoCover.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ planSlugRe 模板单源：项目侧 rules 覆盖内联默认 ----
{
  const { root, g } = mkRepo({ rules: { planSlugRe: '<slug>' } }); // 放宽为「任意位置子串命中」
  stageProductWithPlan(root, g, 'demo', 'backend/ref.cs');
  // 内联默认边界模板下 demo 嵌在 xdemo-y 内不命中；<slug> 直替换后命中 → 证 rules 文件被真实消费
  const r = run(root, 'feat: xdemo-y 嵌入\n');
  check('⑤ 项目侧 planSlugRe 覆盖内联默认（<slug> 直替换 → 嵌入命中）',
    r.status === 0 && r.stdout.includes('✅'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥ 插件种子 commit-msg-rules.json：squash 消息豁免半件（69ece3f46）回补回归 ----
{
  let rules = null;
  try { rules = JSON.parse(fs.readFileSync(SEED_RULES, 'utf8')); } catch { /* 种子损坏 */ }
  check('⑥a 种子 planSlugRe 在场（短名边界模板单源）',
    rules && typeof rules.planSlugRe === 'string' && rules.planSlugRe.includes('<slug>'), JSON.stringify(rules && rules.planSlugRe));
  const squashRe = rules ? new RegExp(rules.exemptPrefix) : null;
  check('⑥b 种子 exemptPrefix 豁免 git 自带 squash 模板首行（Squashed commit of the following:）',
    Boolean(squashRe) && squashRe.test('Squashed commit of the following:')
    && squashRe.test('Merge branch x') && squashRe.test('Revert "y"')
    && !squashRe.test('merged xxx') && !squashRe.test('feat: 常规提交'), JSON.stringify(rules && rules.exemptPrefix));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
