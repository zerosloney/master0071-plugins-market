#!/usr/bin/env node
// workflows-check.test.mjs — 编排脚本 lint 测试（2026-09-25 workflows-linter）
// 方法：fixture 临时目录（.agents/pipelines/*.md + roles/ + steps/ 词表）调 lintWorkflows() 拿结构化结果，
//       不依赖真实仓库文件；末两个场景对真实仓库自扫做 baseline 断言。
// 判据：error 10 类各至少一场景命中；advisory 3 类各一场景；_ 前缀排除；真实仓库 0 error。
// 用法：node templates/_agents/scripts/workflows-check.test.mjs（npm test 随跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintWorkflows } from '../scripts/workflows-check.mjs'; // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const HEAD = '| id | after | role | step | task / params | files（授权） | accept（验收判据） | gate | retries |';
const SEP = '|----|-------|------|------|---------------|--------------|-------------------|------|---------|';

// mkfix：建临时根 + 词表（roles: implementer/reviewer；steps: deploy）+ 指定编排脚本集合
const mkfix = (scripts) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-lint-test-'));
  fs.mkdirSync(path.join(root, '.agents', 'pipelines', 'steps'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'roles'), { recursive: true });
  for (const r of ['implementer', 'independent-reviewer']) {
    fs.writeFileSync(path.join(root, '.agents', 'roles', `${r}.md`), `# ${r}\n`);
  }
  fs.writeFileSync(path.join(root, '.agents', 'pipelines', 'steps', 'deploy.md'), '# deploy\n');
  for (const [name, body] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(root, '.agents', 'pipelines', name), body);
  }
  return root;
};
const fm = (extra = '') => `---\nname: t\ndescription: t\n${extra}---\n\n# w\n\n`;

// ---- S1 全绿：双 role 并行 + 汇聚 gate → 0 error 0 warning ----
{
  const root = mkfix({
    'ok.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | implementer | — | 做 A | src/a/** | 测试过 | | 1 |\n' +
      '| b | — | implementer | — | 做 B | src/b/** | 构建过 | | 0 |\n' +
      '| g | a,b | — | — | — | — | — | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  check('S1 全绿（并行 role + 汇聚 gate）→ 0 error 0 warning',
    r.errorCount === 0 && r.warningCount === 0 && r.files.length === 1,
    JSON.stringify(r.files[0]));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S2 after 悬空引用 → E5 ----
{
  const root = mkfix({
    'dangling.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | ghost | — | — | — | — | — | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  check('S2 after 引用不存在 → E5',
    r.errorCount === 1 && r.files[0].errors[0].startsWith('E5') && r.files[0].errors[0].includes('ghost'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S3 after 成环 → E6 ----
{
  const root = mkfix({
    'cycle.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | b | — | — | — | — | — | npm test | |\n' +
      '| b | a | — | — | — | — | — | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  check('S3 after 依赖成环 → E6',
    r.errorCount === 1 && r.files[0].errors[0].startsWith('E6'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S4 未知 role → E7（词表只有 implementer / independent-reviewer）----
{
  const root = mkfix({
    'role.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | hacker | — | 做 A | src/** | 过 | | |\n',
  });
  const r = lintWorkflows({ root });
  check('S4 role 不在 .agents/roles/ → E7',
    r.errorCount === 1 && r.files[0].errors[0].startsWith('E7') && r.files[0].errors[0].includes('hacker'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S5 未知 step → E8（steps/ 只有 deploy）----
{
  const root = mkfix({
    'step.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | — | rollback | env=prod | | exit 0 | | 0 |\n',
  });
  const r = lintWorkflows({ root });
  check('S5 step 不在 steps/ → E8',
    r.errorCount === 1 && r.files[0].errors[0].startsWith('E8') && r.files[0].errors[0].includes('rollback'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S6 三形态全空 / 双填 → E9 ×2 ----
{
  const root = mkfix({
    'forms.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| nothing | — | — | — | 只有任务没有形态 | src/** | 过 | | |\n' +
      '| both | — | implementer | deploy | 形态双填 | src/** | 过 | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  const e9 = r.files[0].errors.filter((e) => e.startsWith('E9'));
  check('S6 三形态全空与双填 → E9 ×2',
    r.errorCount === 2 && e9.length === 2 && e9[0].includes('nothing') && e9[1].includes('both'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S7 retries 非法 / concurrency 非法 → E10 + E2 ----
{
  const root = mkfix({
    'nums.md': fm('concurrency: x\n') + HEAD + '\n' + SEP + '\n' +
      '| a | — | — | — | — | — | — | npm test | 重试 |\n',
  });
  const r = lintWorkflows({ root });
  const codes = r.files[0].errors.map((e) => (e.match(/^E\d+/) || [''])[0]);
  check('S7 retries 非数字 → E10 且 concurrency 非法 → E2',
    r.errorCount === 2 && codes.includes('E10') && codes.includes('E2'),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S8 gate 花括号展开 → W1（0 error，advisory）----
{
  const root = mkfix({
    'brace.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| g | — | — | — | — | — | — | node scripts/fill-{intent,plan}.test.mjs | |\n',
  });
  const r = lintWorkflows({ root });
  check('S8 gate 含 {a,b} 花括号展开 → W1 且不计 error',
    r.errorCount === 0 && r.warningCount === 1 && r.files[0].warnings[0].startsWith('W1'),
    JSON.stringify({ e: r.files[0].errors, w: r.files[0].warnings }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S9 授权文件交叉：无先序告警 / 有 after 先序不告警 ----
{
  const root = mkfix({
    'parallel-cross.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | implementer | — | 做 A | src/shared/** | 过 | | |\n' +
      '| b | — | implementer | — | 做 B | src/shared/** | 过 | | |\n',
    'ordered-ok.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | implementer | — | 做 A | src/shared/** | 过 | | |\n' +
      '| b | a | implementer | — | 做 B | src/shared/** | 过 | | |\n',
  });
  const r = lintWorkflows({ root });
  const cross = r.files.find((f) => f.file === 'parallel-cross.md');
  const ordered = r.files.find((f) => f.file === 'ordered-ok.md');
  check('S9 授权文件相同且无先序 → W2；有 after 先序 → 不告警',
    r.errorCount === 0 && cross.warnings.length === 1 && cross.warnings[0].startsWith('W2') && ordered.warnings.length === 0,
    JSON.stringify({ cross: cross.warnings, ordered: ordered.warnings }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S10 _ 前缀机制文档不进扫描面（内含坏表也不报）----
{
  const root = mkfix({
    '_TEMPLATE.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| bad | ghost | hacker | — | — | — | — | — | 重试 |\n',
  });
  const r = lintWorkflows({ root });
  check('S10 _TEMPLATE.md 排除（机制文档含示例表，不按可执行件校验）',
    r.files.length === 0 && r.errorCount === 0 && r.warningCount === 0,
    JSON.stringify(r.files.map((f) => f.file)));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S11 缺 frontmatter → E1；缺 stages 表 → E3 ----
{
  const root = mkfix({
    'nofm.md': '# 没有 frontmatter\n\n只有正文\n',
    'notable.md': fm() + '# 有 frontmatter 没有 stages 表\n',
  });
  const r = lintWorkflows({ root });
  const nofm = r.files.find((f) => f.file === 'nofm.md');
  const notable = r.files.find((f) => f.file === 'notable.md');
  check('S11 缺 frontmatter → E1 且缺表 → E3',
    nofm.errors.some((e) => e.startsWith('E1')) && notable.errors.some((e) => e.startsWith('E3')),
    JSON.stringify({ nofm: nofm.errors, notable: notable.errors }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S12 id 重复 → E4；id 空 → E4 ----
{
  const root = mkfix({
    'dup.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | — | — | — | — | — | npm test | |\n' +
      '| a | — | — | — | — | — | — | npm test | |\n' +
      '| — | — | — | — | 缺 id 行 | — | — | — | |\n',
  });
  const r = lintWorkflows({ root });
  const e4 = r.files[0].errors.filter((e) => e.startsWith('E4'));
  check('S12 id 重复与缺 id → E4 ×2',
    e4.length === 2 && e4.some((e) => e.includes('重复')) && e4.some((e) => e.includes('缺 id')),
    JSON.stringify(r.files[0].errors));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S13 step 引用 + gate + 空值规范（— / 空 retries / 空 gate）混排全绿 ----
{
  const root = mkfix({
    'mixed.md': fm('concurrency: 3\n') + HEAD + '\n' + SEP + '\n' +
      '| build | — | implementer | — | 构建 | src/** | 测试过 | | |\n' +
      '| verify | build | — | deploy | env=staging | | exit 0 | | 2 |\n' +
      '| final | verify | — | — | — | — | — | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  check('S13 step 行 / gate 行 / em-dash 空值 / concurrency=3 / retries=2 混排全绿',
    r.errorCount === 0 && r.warningCount === 0,
    JSON.stringify(r.files[0]));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S14 真实仓库自扫 baseline：0 error（_TEMPLATE 排除后三份可执行件全过）----
{
  // **本场景是包源仓库的 baseline 断言，装户环境应 SKIP**（2026-09-28 修正）：
  // 它上溯三级定位「真实仓库」，从 `templates/_agents/scripts/` 出发正确落在包源根；
  // 但从装户的 `.agents/scripts/` 出发会落到 `<install>/..`，扫不到可执行编排件 →
  // `files.length >= 3` 必假。首版没区分这两种上下文，导致**装户径下该套件恒红**——
  // 实测：CI 新增「shipped 套件」步骤后，`.agents/scripts/workflows-check.test.mjs`
  // 报 `FAIL S14（扫描面：）`（空扫描面），而包源侧同字节跑出 15/0。
  // 判据：扫不到任何可执行件 = 本环境不适用 → SKIP（沿 doctor.test.mjs 同口径）。
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const r = lintWorkflows({ root: ROOT });
  const names = r.files.map((f) => f.file).join('、');
  if (r.files.length === 0) {
    check('S14 真实仓库自扫 SKIP（本环境无 .agents/pipelines/ 可执行件——装户径，沿 doctor.test 同口径）', true);
  } else {
    check('S14 真实仓库 .agents/pipelines/ 自扫 0 error（扫描面：' + names + '）',
      r.errorCount === 0 && r.files.length >= 3,
      JSON.stringify(r.files.filter((f) => f.errors.length).map((f) => ({ f: f.file, e: f.errors }))));
  }
}

// ---- S14 human 确认门（第四形态）：单形态全绿 / 双填 E9 / ×retries W4 / 缺列兼容 ----
{
  const HEAD10 = '| id | after | role | step | task / params | files（授权） | accept（验收判据） | gate | human | retries |';
  const SEP10 = '|----|-------|------|------|---------------|--------------|-------------------|------|-------|---------|';
  const root = mkfix({
    'human-ok.md': fm() + HEAD10 + '\n' + SEP10 + '\n' +
      '| a | — | implementer | — | 做 A | src/a/** | 测试过 | | | 0 |\n' +
      '| ask | a | — | — | 用户确认可继续 | — | 一句「可以」 | | 用户确认 | |\n' +
      '| b | ask | — | — | — | — | — | npm test | | |\n',
    'human-bad.md': fm() + HEAD10 + '\n' + SEP10 + '\n' +
      '| both | — | — | — | 双填 | — | — | npm test | 用户确认 | |\n' +
      '| retry | — | — | — | 确认 | — | 一句可以 | | 用户确认 | 2 |\n',
    'no-human-col.md': fm() + HEAD + '\n' + SEP + '\n' +
      '| a | — | — | — | — | — | — | npm test | |\n',
  });
  const r = lintWorkflows({ root });
  const ok = r.files.find((f) => f.file === 'human-ok.md');
  const bad = r.files.find((f) => f.file === 'human-bad.md');
  const legacy = r.files.find((f) => f.file === 'no-human-col.md');
  check('S14 human 单形态 10 列全绿；human+gate 双填 E9；human×retries W4；9 列无 human 表全过',
    r.errorCount === 1
      && ok.errors.length === 0 && ok.warnings.length === 0
      && bad.errors.length === 1 && bad.errors[0].startsWith('E9') && bad.errors[0].includes('gate + human')
      && bad.warnings.length === 1 && bad.warnings[0].startsWith('W4')
      && legacy.errors.length === 0 && legacy.warnings.length === 0,
    JSON.stringify(r.files.map((f) => ({ f: f.file, e: f.errors, w: f.warnings }))));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
