#!/usr/bin/env node
// check-loop-rev-tree.test.mjs — --rev --all 读被推送提交的树（预算 / 索引）
// 2026-10-23 全量套件优化：从 rev-hook 拆出，与 hook / outside 两片并行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup, loop, outOf, gitRun, ENUMS, SCRIPTS, intent, plan } from './check-loop-rev-fixture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`); }
};

const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-tree-'));
try {
  gitRun(tree, ['init', '-q']);
  fs.mkdirSync(path.join(tree, '.agents', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tree, '.agents', 'config'), { recursive: true });
  fs.copyFileSync(ENUMS, path.join(tree, '.agents', 'config', 'workflow-enums.txt'));
  fs.copyFileSync(path.join(SCRIPTS, 'gen-workflow-index.mjs'), path.join(tree, '.agents', 'scripts', 'gen-workflow-index.mjs'));
  fs.copyFileSync(path.join(SCRIPTS, 'workflow-enums.mjs'), path.join(tree, '.agents', 'scripts', 'workflow-enums.mjs'));
  fs.copyFileSync(path.join(SCRIPTS, 'rule-budget.mjs'), path.join(tree, '.agents', 'scripts', 'rule-budget.mjs'));
  // rule-budget.mjs import paths.mjs（→git-core.mjs）——依赖链一并拷入，否则门内执行失败（预算判定假红）
  fs.copyFileSync(path.join(SCRIPTS, 'paths.mjs'), path.join(tree, '.agents', 'scripts', 'paths.mjs'));
  fs.copyFileSync(path.join(SCRIPTS, 'git-core.mjs'), path.join(tree, '.agents', 'scripts', 'git-core.mjs'));
  fs.writeFileSync(path.join(tree, '.agents', 'config', 'rule-budgets.txt'), 'big.txt 10\n');
  fs.writeFileSync(path.join(tree, 'big.txt'), 'ok\n');
  for (const sub of ['intents', 'specs', 'plans', 'incidents']) {
    fs.mkdirSync(path.join(tree, 'workflow', sub), { recursive: true });
  }
  fs.writeFileSync(path.join(tree, 'workflow', 'intents', '2026-09-01-ok.md'), intent);
  fs.writeFileSync(path.join(tree, 'workflow', 'plans', '2026-09-01-ok.md'), plan);
  const gen = spawnSync(process.execPath, [path.join(tree, '.agents', 'scripts', 'gen-workflow-index.mjs')], { cwd: tree, encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(outOf(gen));
  gitRun(tree, ['add', '--', '.']);
  gitRun(tree, ['commit', '-q', '-m', 'aligned']);
  const indexPath = path.join(tree, 'workflow', 'INDEX.md');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  if (!indexBefore.includes('☑1/1')) throw new Error('INDEX 里没有 ☑1/1，无法制造漂移');
  fs.writeFileSync(indexPath, indexBefore.replace('☑1/1', '☑0/1'));
  gitRun(tree, ['add', '--', '.']);
  gitRun(tree, ['commit', '-q', '-m', 'drift']);
  const drift = gitRun(tree, ['rev-parse', 'HEAD']);
  const drifted = loop(tree, ['--rev', drift, '--all']);
  // s06 INDEX hygiene 检查已随 44390bde 按段预算退役（增量硬校验保留在提交钩子 commit-check）——
  // --rev --all 对损坏 INDEX 不再报「索引漂移」，此处钉住退役后行为防复活误报
  check('被推送提交索引损坏：--rev --all 不报索引漂移（s06 已退役，硬校验在提交钩子）', !outOf(drifted).includes('索引漂移'), outOf(drifted));
  fs.writeFileSync(path.join(tree, 'big.txt'), 'x'.repeat(100));
  const restored = spawnSync(process.execPath, [path.join(tree, '.agents', 'scripts', 'gen-workflow-index.mjs')], { cwd: tree, encoding: 'utf8' });
  if (restored.status !== 0) throw new Error(outOf(restored));
  gitRun(tree, ['add', '--', '.']);
  gitRun(tree, ['commit', '-q', '-m', 'fat']);
  const fat = gitRun(tree, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(tree, 'big.txt'), 'ok\n');
  gitRun(tree, ['add', '--', '.']);
  gitRun(tree, ['commit', '-q', '-m', 'slim']);
  const atFat = loop(tree, ['--rev', fat, '--all']);
  const atSlim = loop(tree, ['--all']);
  check('预算只在被推送提交里超限：--rev --all 报 100B', outOf(atFat).includes('常驻面超限') && outOf(atFat).includes('100B'), outOf(atFat));
  check('工作区预算未超限：--all 不报常驻面超限，也不报索引漂移',
    !outOf(atSlim).includes('常驻面超限') && !outOf(atSlim).includes('索引漂移'), outOf(atSlim));
} catch (e) {
  check('树内预算/索引仓库准备', false, e.stack || e.message);
} finally {
  cleanup(tree);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
