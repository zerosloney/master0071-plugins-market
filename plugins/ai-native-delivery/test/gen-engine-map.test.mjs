#!/usr/bin/env node
// gen-engine-map.mjs 的夹具测试（临时根生成 / --check 一致 / 漂移转红 三态）
// verify 门表经 spawn 真 verify.mjs --list（CHECK_LOOP_ROOT 指夹具根，GATES 仍为生产 19 门）。
// 用法：node .agents/scripts/gen-engine-map.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(SCRIPT_DIR, '..', 'scripts', 'gen-engine-map.mjs'); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-map-test-'));
try {
  // 夹具：钩子 2（2026-11 修复：落 **gitHooksDir 实化目录**——git 实际执行钩子的目录，与 init-engine
  // 安装位同源；不再落源仓形态的 <root>/.githooks——插件形态没有该目录，旧锚恒取空集 →「钩子 0 个」）、
  // SECTIONS hard 1 + hygiene 1、台账 现役 2（均带机制类型标记）+ 已退役 1（含复评挂号称）、命令/技能/角色各 1
  // 台账状态列带 `[检出型]` / `[健康静默]` 标记是生产实态（2026-10-22 起 35/45 行带标记）——生成器须按
  // 剥离后的状态计数，否则写出「现役 0」（真实发生过的漂移）。
  spawnSync('git', ['init', '-q'], { cwd: root });
  const gp = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' });
  const hooksRel = String(gp.stdout || '').trim();
  const hooksDir = path.isAbsolute(hooksRel) ? hooksRel : path.join(root, hooksRel);
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '');
  fs.writeFileSync(path.join(hooksDir, 'pre-push'), '');
  // git init 自带的样例钩子（*.sample，git 不执行）不得计入钩子数
  fs.writeFileSync(path.join(hooksDir, 'pre-commit.sample'), '');
  fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'scripts', 'check-loop.mjs'),
    "const SECTIONS = [\n  { lane: 'hard', run: s01_pairing },\n  { lane: 'hygiene', run: s18_delegations },\n];\n");
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'mechanism-registry.md'),
    '| 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |\n|---|---|---|---|---|---|---|\n| 甲门 | x | y | z | w | 现役 [检出型] | 复评 2027-01-21 |\n| 乙门 | x | y | z | w | 已退役 | — |\n| 丙门 | x | y | z | w | 现役 [健康静默] | — |\n');
  fs.mkdirSync(path.join(root, '.agents', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'commands', 'new-task.md'), 'x');
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'closeout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'closeout', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(root, '.agents', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'roles', 'implementer.md'), 'x');

  const run = (args) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });
  const g = run(['--root', root]);
  const mapPath = path.join(root, '.agents', 'notes', 'engine-map.md');
  const text = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : '';
  check('生成：exit 0 且落盘 engine-map.md', g.status === 0 && text.includes('# 引擎地图'), `${g.status}\n${g.stderr}`);
  check('生成：钩子 2 个进表（pre-commit/pre-push，gitHooksDir 实化取数 ≥1——修复前恒 0）', text.includes('git 钩子 2 个') && text.includes('| pre-push |'));
  check('生成：钩子计数排除 *.sample（git init 样例钩子不执行，不入计）', text.includes('git 钩子 2 个') && !/\.sample/.test(text), text.split('\n').filter((l) => l.includes('钩子') || l.includes('sample')).join('\n'));
  check('生成：verify 门表来自真 GATES（含 secrets-scan）', /## verify 门表（\d+ 门/.test(text) && text.includes('secrets-scan'), text.slice(0, 400));
  check('生成：SECTIONS 计数 hard 1 + hygiene 1 且段名在场', text.includes('= hard 1 + hygiene 1') && text.includes('s01_pairing'), text);
  check('生成：台账摘要 现役 2（带类型标记）/ 已退役 1 且复评挂号称', text.includes('现役 2 / 已退役 1 / 待退役 0') && text.includes('甲门(2027-01-21)'), text);
  check('生成：模型侧载体计数（命令 1 / 技能 1 / 角色 1）', text.includes('**命令** 1 篇') && text.includes('**技能** 1 个') && text.includes('**角色** 1 个'), text);

  const ok = run(['--root', root, '--check']);
  check('--check：生成后一致 → exit 0', ok.status === 0, `${ok.status}\n${ok.stdout}${ok.stderr}`);
  fs.appendFileSync(mapPath, '漂移行\n');
  const bad = run(['--root', root, '--check']);
  check('--check：漂移 → exit 1 并给重生成指引', bad.status === 1 && String(bad.stderr || '').includes('gen-engine-map'), `${bad.status}\n${bad.stderr}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ciSummary PR 独占判据（判据移植）：condition 含 PR 独占变量（PullRequestId / SourceCommitId）
// 且无直推臂的步不进直推列；TargetBranch 只是 PR 侧的臂，双向门不误标；直推列由 yml 字面谓词支撑
// （assertCiGrounding 在渲染后对 rows 断言，解析口径与渲染脱节即立红）。
{
  const ci = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-map-ci-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: ci });
    const gp = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ci, encoding: 'utf8' });
    const hooksRel = String(gp.stdout || '').trim();
    const hooksDir = path.isAbsolute(hooksRel) ? hooksRel : path.join(ci, hooksRel);
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '');
    fs.mkdirSync(path.join(ci, '.agents', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(ci, '.agents', 'scripts', 'check-loop.mjs'),
      "const SECTIONS = [\n  { lane: 'hard', run: s01_pairing },\n];\n");
    fs.writeFileSync(path.join(ci, 'azure-pipelines.yml'), [
      'trigger:',
      '  include:',
      '    - main',
      '    - develop',
      'steps:',
      '  - task: NodeTool@0',
      '    displayName: setup node',
      '  - task: CmdLine@1',
      '    displayName: verify full',
      '    condition: eq(variables[\'Build.SourceBranch\'], \'refs/heads/main\')',
      '    arguments: verify --full',
      '  - task: CmdLine@1',
      '    displayName: pr ledger gate',
      '    condition: and(succeeded(), ne(variables[\'System.PullRequest.PullRequestId\'], \'\'))',
      '    arguments: ledger gate',
      '  - task: CmdLine@1',
      '    displayName: two-way gate',
      '    condition: or(eq(variables[\'Build.SourceBranch\'], \'refs/heads/develop\'), ne(variables[\'System.PullRequest.TargetBranch\'], \'refs/heads/develop\'))',
      '    arguments: verify --mid',
      '',
    ].join('\n'));
    const runCi = (args) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });
    const gci = runCi(['--root', ci]);
    const mapCi = path.join(ci, '.agents', 'notes', 'engine-map.md');
    const textCi = fs.existsSync(mapCi) ? fs.readFileSync(mapCi, 'utf8') : '';
    const ciRow = textCi.split('\n').find((l) => l.includes('CI（azure-pipelines）')) || '';
    check('ciSummary：PR 独占步（PullRequestId 且无直推臂）不进任何直推列',
      gci.status === 0 && !ciRow.includes('ledger gate'), `${gci.status}\n${ciRow}`);
    check('ciSummary：直推字面谓词步进列（main 直推含 verify --full——接地②）',
      ciRow.includes('main 直推 = setup node + verify --full'), ciRow);
    check('ciSummary：双向门不误标（TargetBranch 非独占证据——develop 直推含 verify --mid）',
      ciRow.includes('develop 直推 = setup node + verify --mid'), ciRow);
    const okCi = runCi(['--root', ci, '--check']);
    check('ciSummary：--check 一致（接地断言不误伤正常解析）', okCi.status === 0, `${okCi.status}\n${okCi.stdout}${okCi.stderr}`);
  } finally {
    fs.rmSync(ci, { recursive: true, force: true });
  }
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
