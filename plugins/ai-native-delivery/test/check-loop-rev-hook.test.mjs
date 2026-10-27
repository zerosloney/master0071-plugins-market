#!/usr/bin/env node
// check-loop-rev-hook.test.mjs — --rev 的 pre-push 钩子场景（stdin 引用行 / experiment 泳道 / main 硬拦）
// 2026-10-23 全量套件优化：从 rev-hook 再拆出 outside / tree 两片，三片并行。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkRepo, cleanup, outOf, Z, HOOK, LOOP, planBad } from './check-loop-rev-fixture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`); }
};

const { root, good, bad, planPath } = mkRepo();
try {
  // 钩子「无 stdin 行」场景扫工作区：先制造脏树（原单文件套件在 hook 段前已写 planBad）。
  fs.writeFileSync(planPath, planBad);
  if (!HOOK) console.log('SKIP pre-push 相关场景（未找到 _githooks / .githooks 下的 pre-push）');
  if (HOOK) {
    fs.mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
    const node = process.execPath.replace(/\\/g, '/');
    const loopSh = LOOP.replace(/\\/g, '/');
    // 桩：node 直转真 check-loop.mjs（钩子 2026-10-08 去 sh 化后调 node，cwd 即临时仓根 → ROOT 落在 fixture）
    fs.writeFileSync(
      path.join(root, '.agents', 'scripts', 'check-loop.mjs'),
      `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(loopSh)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`,
    );
    // 构建门桩（2026-10-15 构建门后移 pre-push）：零退出占位——本套件测 --rev 扫描面，不测构建触发
    fs.mkdirSync(path.join(root, '.agents', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'hooks', 'commit-check.cjs'), 'process.exit(0);\n');
    const hookPath = path.join(root, 'pre-push');
    fs.copyFileSync(HOOK, hookPath);
    const push = (input) => spawnSync(process.execPath, [hookPath], { cwd: root, input, encoding: 'utf8', timeout: 120000 });
    const onlyDelete = push(`refs/heads/old ${Z} refs/heads/old ${'b'.repeat(40)}\n`);
    check('stdin 只有删除行：不阻断', onlyDelete.status === 0, outOf(onlyDelete));
    const mixed = push(
      `refs/heads/old ${Z} refs/heads/old ${'b'.repeat(40)}\nrefs/heads/bad ${bad} refs/heads/bad ${Z}\n`,
    );
    check('删除行加断档 sha：整次失败', mixed.status !== 0 && outOf(mixed).includes('红线判低'), outOf(mixed));
    const empty = push('');
    check('没有 stdin 行：扫工作区，脏树被拦住', empty.status !== 0 && outOf(empty).includes('红线判低'), outOf(empty));
    const goodThenBad = push(
      `refs/heads/ok ${good} refs/heads/ok ${Z}\nrefs/heads/bad ${bad} refs/heads/bad ${Z}\n`,
    );
    check('stdin 先好后坏：整次失败', goodThenBad.status !== 0 && outOf(goodThenBad).includes('红线判低'), outOf(goodThenBad));

    // experiment 泳道 advisory + main 加固门（2026-09-30 hybrid-governance-explore-hardening）
    const laneAdv = push(`refs/heads/experiment/poc ${bad} refs/heads/experiment/poc ${Z}\n`);
    check('pre-push experiment/* 泳道：断档 sha 降级 advisory 不阻断', laneAdv.status === 0 && /advisory/.test(outOf(laneAdv)), outOf(laneAdv));
    const toMainBad = push(`refs/heads/main ${bad} refs/heads/main ${Z}\n`);
    check('pre-push 推 main：断档照拦（hard-block 语义不变）', toMainBad.status !== 0 && outOf(toMainBad).includes('红线判低'), outOf(toMainBad));
  }
} catch (e) {
  check('pre-push 仓库准备', false, e.stack || e.message);
} finally {
  cleanup(root);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
