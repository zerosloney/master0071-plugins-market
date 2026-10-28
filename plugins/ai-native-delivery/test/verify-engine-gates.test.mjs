#!/usr/bin/env node
// verify-engine-gates.test.mjs — verify 引擎段适用性判据 + 「消费项目装上即红」回归（2026-10-28 审计 P0）
// 缺陷（审计实测）：engine-tests 门此前是 cmd:'npm test' + folder:'.' → 在**使用项目根**跑 npm test。
//   新装空仓没有 package.json → `npm error enoent Could not read package.json`；有 package.json 无 test
//   脚本 → `npm error Missing script: "test"`。两种都红，且因 fail-fast 中止其后 15 门
//   （check-loop / ledger-invariant / secrets-scan / frontend-* / backend-* 状态全未知）。
// 本套件锁三件事：
//   ① 引擎段每门都声明适用性判据（optional 或 requires）——结构不变量，verify 自身也会 exit 2 拦；
//   ② engine-tests 门在插件形态（项目侧无 .agents/scripts 副本）判「不适用」SKIP，不在用户项目里跑 npm test；
//      源仓形态（项目侧有引擎副本）仍执法——判据是判据，不是把门删了；
//   ③ 新装空仓跑 verify --full 不再出现 npm test 失败，且 fail-fast 不再在第 2 门中止。
// 零依赖，Node ≥ 18 直接运行：node test/verify-engine-gates.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATES, gateNotApplicable, engineGatesMissingAdaptation, gateAdaptationDeclared } from '../scripts/verify.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(TEST_DIR, '..', 'scripts', 'verify.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
};

// ---- 场景 1：结构不变量——引擎段每门都带 optional 或 requires ----
{
  const engineGates = GATES.filter((g) => g.cohort === 'engine');
  const missing = engineGatesMissingAdaptation(GATES);
  check('场景 1：引擎段全部声明适用性判据（optional 或 requires）',
    engineGates.length >= 13 && missing.length === 0,
    `引擎门 ${engineGates.length} 扇，缺判据：${JSON.stringify(missing)}`);

  // 反向断言：判据检查本身得能抓出违规门（否则这条不变量是装饰）
  check('场景 1：判据检查能抓出未声明的引擎门（反向断言）',
    JSON.stringify(engineGatesMissingAdaptation([{ id: 'x', cohort: 'engine' }])) === JSON.stringify(['x'])
      && JSON.stringify(engineGatesMissingAdaptation([{ id: 'y', cohort: 'product' }])) === '[]'
      && gateAdaptationDeclared({ optional: 'a.mjs' }) === true
      && gateAdaptationDeclared({ requires: 'a/b' }) === true
      && gateAdaptationDeclared({}) === false,
    'engineGatesMissingAdaptation / gateAdaptationDeclared 语义不符预期');
}

// ---- 场景 2：engine-tests 门在插件形态判不适用、源仓形态照常执法 ----
{
  const et = GATES.find((g) => g.id === 'engine-tests');
  check('场景 2：engine-tests 门存在且带适用性判据', Boolean(et && (et.optional || et.requires)), JSON.stringify(et));

  const pluginShape = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-eng-pluginfmt-'));
  const sourceShape = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-eng-sourcerepo-'));
  try {
    fs.mkdirSync(path.join(sourceShape, '.agents', 'scripts'), { recursive: true });
    check('场景 2：插件形态（无 .agents/scripts）→ 判不适用（SKIP，不在用户项目里跑 npm test）',
      et ? gateNotApplicable(et, pluginShape) === true : false, `root=${pluginShape}`);
    check('场景 2：源仓形态（有 .agents/scripts）→ 照常执法',
      et ? gateNotApplicable(et, sourceShape) === false : false, `root=${sourceShape}`);
  } finally {
    fs.rmSync(pluginShape, { recursive: true, force: true });
    fs.rmSync(sourceShape, { recursive: true, force: true });
  }
}

// ---- 场景 3：新装空仓跑 verify --full——不再因 npm test 门红，且 fail-fast 不再在第 2 门中止 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-eng-fresh-'));
  try {
    git(['init', '-q'], root);
    git(['config', 'user.email', 't@t'], root);
    git(['config', 'user.name', 't'], root);
    fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n', 'utf8');
    git(['add', '-A'], root);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], root);

    // --serial：门序确定，便于断言「中止点不在第 2 门」
    const r = spawnSync(process.execPath, [VERIFY, '--full', '--serial'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    check('场景 3：新装空仓 verify --full 不再出现 npm test 失败（enoent / Missing script）',
      !/npm error/i.test(out) && !/Missing script/i.test(out) && !/Could not read package\.json/i.test(out),
      out.slice(-1200));
    check('场景 3：engine-tests 门判「不适用」SKIP（显式出账，不进通过数）',
      /引擎脚本测试套件/.test(out) && /SKIP（不适用/.test(out), out.slice(-1200));
    check('场景 3：fail-fast 不再在第 2 门中止（其后的门照跑并出账）',
      /编排脚本检查 通过/.test(out) && /常驻面预算检查 通过/.test(out),
      out.slice(-1200));
    check('场景 3：engine-tests 门本身没红（无「❌ … 引擎脚本测试套件」）',
      !/❌[^\n]*引擎脚本测试套件/.test(out), out.slice(-1200));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
