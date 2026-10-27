// check-script-coverage.test.mjs — 消费端脚本覆盖对账：直接/间接/豁免/缺失/豁免表非法
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCoverage } from '../scripts/check-script-coverage.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const makeRoot = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'script-coverage-test-'));
  fs.mkdirSync(path.join(tmp, '.agents', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.agents', 'config'), { recursive: true });
  for (const f of ['a.mjs', 'a.test.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs']) {
    fs.writeFileSync(path.join(tmp, '.agents', 'scripts', f), '', 'utf8');
  }
  return tmp;
};

const tmp = makeRoot();
try {
  fs.writeFileSync(path.join(tmp, '.agents', 'config', 'scripts-test-exempt.txt'), [
    '# 消费端豁免表',
    '',
    'exempt | .agents/scripts/b.mjs | CI-only installer, no local surface',
    'indirect | .agents/scripts/c.mjs | .agents/scripts/a.test.mjs | covered via a',
    'indirect | .agents/scripts/d.mjs | .agents/scripts/missing.test.mjs | broken pointer',
    'exempt | .agents/scripts/ghost.mjs | stale entry',
    'bogus | .agents/scripts/e.mjs | unknown mode',
    '',
  ].join('\n'), 'utf8');

  const r = scanCoverage(tmp);
  check('S1 计数：直接 1 / 间接 1 / 豁免 1 / 缺失 2', r.counts.direct === 1 && r.counts.indirect === 1
    && r.counts.exempt === 1 && r.counts.uncovered === 2 && r.counts.total === 5, JSON.stringify(r.counts));
  check('S2 缺失集合 = d/e（间接指向失效也计缺失）',
    r.uncovered.map((u) => u.path).sort().join(',') === '.agents/scripts/d.mjs,.agents/scripts/e.mjs',
    JSON.stringify(r.uncovered.map((u) => u.path)));
  check('S3 间接覆盖明细带测试路径与理由',
    r.rows.find((x) => x.path.endsWith('c.mjs')).detail.includes('a.test.mjs')
    && r.rows.find((x) => x.path.endsWith('c.mjs')).detail.includes('covered via a'));
  check('S4 豁免表非法项：间接测试缺失 / 未知模式 / stale 条目',
    r.malformed.some((m) => /间接测试不存在/.test(m))
    && r.malformed.some((m) => /未知模式/.test(m))
    && r.malformed.some((m) => /不存在的脚本/.test(m)), JSON.stringify(r.malformed));

  fs.rmSync(path.join(tmp, '.agents', 'config', 'scripts-test-exempt.txt'));
  const r2 = scanCoverage(tmp);
  check('S5 豁免表缺失 fail-loud 且全部计缺失',
    r2.malformed.some((m) => /豁免表缺失/.test(m)) && r2.counts.uncovered === 4, JSON.stringify(r2.counts));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
