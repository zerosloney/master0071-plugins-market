#!/usr/bin/env node
// rule-budget.test.mjs — 常驻面预算黑盒套件（2026-10-15 减重手段②随附：#count 条目数指令）
// 夹具：os.tmpdir 下临时目录（非 git 环境——脚本 git rev-parse 失败留在 fixture 目录，
// 字节口径回退工作区文件；与真实仓「索引/HEAD」口径的差异不影响指令语义判定）。
// 覆盖：字节超限/未超、#count 超限/压线、旧格式行不受 #count 影响、缺预算表 exit 0、
//       --staged 无 git（staged 空）时 #count 门跳过。
// 运行：node test/rule-budget.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rule-budget.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

function makeFixture({ budgets, dirs = {}, files = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-budget-'));
  if (budgets !== null) {
    fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'config', 'rule-budgets.txt'), budgets, 'utf8');
  }
  for (const [dir, names] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(root, dir, n), 'x\n', 'utf8');
  }
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content, 'utf8');
  }
  return root;
}

const run = (cwd, mode = '--all') => {
  const r = spawnSync(process.execPath, [SCRIPT, mode], { cwd, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout || '') };
};

let root;

// ---- T1 字节超限（旧格式语义不回归）----
root = makeFixture({
  budgets: 'AGENTS.md 10\n',
  files: { 'AGENTS.md': 'x'.repeat(50) },
});
{
  const r = run(root);
  check('T1 字节超限 exit 1 + 违例行', r.code === 1 && r.out.includes('常驻面超限：AGENTS.md') && r.out.includes('> 上限 10B'), JSON.stringify(r));
}

// ---- T2 字节未超 → 0 ----
root = makeFixture({
  budgets: 'AGENTS.md 100\n',
  files: { 'AGENTS.md': 'x'.repeat(50) },
});
check('T2 字节未超 exit 0', run(root).code === 0);

// ---- T3 #count 超限 ----
root = makeFixture({
  budgets: '.agents/scripts/check-loop-sections/ 2#count\n',
  dirs: { '.agents/scripts/check-loop-sections': ['s01-a.mjs', 's02-b.mjs', 's03-c.mjs'] },
});
{
  const r = run(root);
  check('T3 #count 超限 exit 1 + 条目数违例行 + 一进一出提示', r.code === 1 && r.out.includes('条目数') && r.out.includes('3 项 > 上限 2 项') && r.out.includes('一进一出'), JSON.stringify(r));
}

// ---- T4 #count 压线（= 上限）→ 0 ----
root = makeFixture({
  budgets: '.agents/scripts/check-loop-sections/ 3#count\n',
  dirs: { '.agents/scripts/check-loop-sections': ['s01-a.mjs', 's02-b.mjs', 's03-c.mjs'] },
});
check('T4 #count 压线 exit 0', run(root).code === 0);

// ---- T5 混合表：#count 行存在但未触其它字节条目 → 0（互不干扰）----
root = makeFixture({
  budgets: 'AGENTS.md 100\n.agents/scripts/check-loop-sections/ 3#count\n',
  files: { 'AGENTS.md': 'x'.repeat(50) },
  dirs: { '.agents/scripts/check-loop-sections': ['s01-a.mjs', 's02-b.mjs', 's03-c.mjs'] },
});
check('T5 混合表双通过 exit 0', run(root).code === 0);

// ---- T6 缺预算表 → exit 0（fixture 沙箱不拦，既有语义）----
root = makeFixture({ budgets: null });
check('T6 缺预算表 exit 0', run(root).code === 0);

// ---- T7 --staged 无 git（staged 空）：#count 门跳过不拦 ----
root = makeFixture({
  budgets: '.agents/scripts/check-loop-sections/ 2#count\n',
  dirs: { '.agents/scripts/check-loop-sections': ['s01-a.mjs', 's02-b.mjs', 's03-c.mjs'] },
});
{
  const r = run(root, '--staged');
  check('T7 --staged 无 git 环境跳过 #count 门 exit 0', r.code === 0, JSON.stringify(r));
}

// ---- T8 glob 形态 #count（* 后缀）也按条数执法 ----
root = makeFixture({
  budgets: '.agents/commands/*.md 2#count\n',
  dirs: { '.agents/commands': ['a.md', 'b.md', 'c.md', 'd.txt'] },
});
{
  const r = run(root);
  check('T8 glob #count 只数 *.md（3 项 > 2）exit 1', r.code === 1 && r.out.includes('3 项'), JSON.stringify(r));
}

// ---- T9 hard 车道有界（gate-health 2026-10-22）：check-loop-hard 5#count ----
root = makeFixture({
  budgets: 'check-loop-hard 5#count\n',
  files: {
    '.agents/scripts/check-loop.mjs': [
      'const SECTIONS = [',
      "  { lane: 'hard', run: a },",
      "  { lane: 'hygiene', run: b },",
      "  { lane: 'hard', run: c },",
      '];',
    ].join('\n'),
  },
});
{
  const r = run(root);
  check('T9 hard 段 2 ≤ 5 → exit 0', r.code === 0, JSON.stringify(r));
}
root = makeFixture({
  budgets: 'check-loop-hard 1#count\n',
  files: {
    '.agents/scripts/check-loop.mjs': "const SECTIONS = [{ lane: 'hard', run: a }, { lane: 'hard', run: b }];",
  },
});
{
  const r = run(root);
  check('T9 hard 段 2 > 1 → exit 1（新增 hard 须先退役一个）',
    r.code === 1 && r.out.includes('check-loop-hard 2 项 > 上限 1 项'), JSON.stringify(r));
}

// ---- T10 预算上限与内容同源（budget-index-source 2026-10-27）：预算表读索引，不读工作区 ----
// 语义：内容字节读索引（`:f`），上限也必须读索引——否则在工作区里未暂存地抬高上限即可放行。
// 夹具：提交时落一份 10B 上限的预算表（进 HEAD），随后在工作区改成 100B（不暂存），
// 再放 50B 内容。若预算只读工作区 → exit 0（漏洞）；读 HEAD/索引 → exit 1（正确）。
{
  const root = makeFixture({ budgets: 'AGENTS.md 10\n', files: { 'AGENTS.md': 'x'.repeat(50) } });
  const g = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  // 工作区放宽上限但不暂存
  fs.writeFileSync(path.join(root, '.agents', 'config', 'rule-budgets.txt'), 'AGENTS.md 100\n', 'utf8');
  const r = run(root);
  check('T10 工作区放宽上限未暂存 → 仍按索引上限判定 exit 1',
    r.code === 1 && r.out.includes('常驻面超限：AGENTS.md'),
    `exit=${r.code}\n${r.out}`);
  // 反证：把放宽后的上限也暂存 → 通过（一进一出流程本身不被拦）
  g(['add', '.agents/config/rule-budgets.txt']);
  const r2 = run(root);
  check('T10 上限与内容同为索引态 → exit 0（一进一出流程保留）',
    r2.code === 0, `exit=${r2.code}\n${r2.out}`);
}

// ---- T11 插件形态落位解析（2026-10-27 插件化修复）：项目侧无 .agents/scripts 时，
//      预算模式 `.agents/scripts/…` / `.agents/commands/…` 必须解析到**插件内**实际落位，
//      而不是解析到不存在的目录恒算 0（修复前棘轮恒过——恒为假绿）。
//      夹具：空项目（无 .agents/scripts）+ 预算表写死插件真实段数上下限。
{
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const realSections = fs.readdirSync(path.join(pluginRoot, 'scripts', 'check-loop-sections'))
    .filter((f) => f.endsWith('.mjs')).length;
  root = makeFixture({ budgets: `.agents/scripts/check-loop-sections/ ${realSections}#count\n` });
  const atLimit = run(root);
  check(`T11 插件形态：段数按插件真实落位计（${realSections} 段 = 上限 → exit 0）`,
    atLimit.code === 0 && !/条目数/.test(atLimit.out), JSON.stringify(atLimit));
  fs.rmSync(root, { recursive: true, force: true });

  root = makeFixture({ budgets: `.agents/scripts/check-loop-sections/ ${realSections - 1}#count\n` });
  const overLimit = run(root);
  check(`T11 插件形态：段数超上限即拦（${realSections} > ${realSections - 1} → exit 1）`,
    overLimit.code === 1 && /条目数/.test(overLimit.out), JSON.stringify(overLimit));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- T12 插件形态 hard 段棘轮：check-loop-hard 的段数读插件内 check-loop.mjs ----
{
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(pluginRoot, 'scripts', 'check-loop.mjs'), 'utf8');
  const realHard = (src.match(/\{\s*lane:\s*'hard'/g) || []).length;
  root = makeFixture({ budgets: `check-loop-hard ${realHard}#count\n` });
  const atLimit = run(root);
  check(`T12 插件形态：hard 段按插件真实落位计（${realHard} 段 = 上限 → exit 0）`,
    atLimit.code === 0, JSON.stringify(atLimit));
  fs.rmSync(root, { recursive: true, force: true });

  root = makeFixture({ budgets: `check-loop-hard ${realHard - 1}#count\n` });
  const overLimit = run(root);
  check(`T12 插件形态：hard 段超上限即拦（${realHard} > ${realHard - 1} → exit 1）`,
    overLimit.code === 1 && /check-loop-hard/.test(overLimit.out), JSON.stringify(overLimit));
  fs.rmSync(root, { recursive: true, force: true });
}

for (const d of fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('rule-budget-'))) {
  try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch { /* Windows 文件锁容忍 */ }
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
