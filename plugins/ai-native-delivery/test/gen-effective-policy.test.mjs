#!/usr/bin/env node
// gen-effective-policy.test.mjs — 生效规则视图生成器 fixture 套件（2026-10-09 P2-5）
// 方法：临时根注入 engine.json（policyVersion 取值 / 缺失 / 非法三态），断言生成内容与 --check 语义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const SCRIPT = path.join(SCRIPT_DIR, '..', 'scripts', 'gen-effective-policy.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};
const mkfix = (policyVersion) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-policy-test-'));
  fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
  if (policyVersion !== undefined) fs.writeFileSync(path.join(d, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion }));
  return d;
};
const run = (root, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// 场景 1：v8 生成——当前版本行 + 全锚键行 + 升级锚「待升级」判定（用未来锚的 v8 语义不可注入，
//   改用真实 v8 的历史锚断言「已生效」与表结构；待升级分支由场景 4 钉住）
{
  const d = mkfix(8);
  const r = run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'effective-policy.md'), 'utf8');
  check('场景 1：v8 生成成功且含版本声明与锚键行',
    r.code === 0 && doc.includes('**policyVersion 8**') && doc.includes('`verifyHardSince`') && doc.includes('`bindingTs`'), r.out + doc);
}
// 场景 2：--check 一致 → 0；篡改磁盘 → 1；再生成 → 恢复 0
{
  const d = mkfix(8);
  run(d);
  check('场景 2a：生成后 --check 一致', run(d, '--check').code === 0);
  fs.appendFileSync(path.join(d, 'workflow', 'effective-policy.md', ), 'drift\n');
  const r2 = run(d, '--check');
  check('场景 2b：磁盘漂移 → --check exit 1 且含修法', r2.code === 1 && r2.out.includes('重生成'), r2.out);
  run(d);
  check('场景 2c：重生成后 --check 恢复 0', run(d, '--check').code === 0);
}
// 场景 2d/2e：行尾不算漂移，内容差仍算（2026-10-10 autocrlf 假红）
{
  const d = mkfix(8);
  run(d);
  const p = path.join(d, 'workflow', 'effective-policy.md');
  const lf = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, lf.replace(/\n/g, '\r\n'));
  check('场景 2d：CRLF 检出、内容相同 → --check 0', run(d, '--check').code === 0);
  fs.writeFileSync(p, lf.replace(/\n/g, '\r\n').replace('policyVersion', 'policyVerslon'));
  const r = run(d, '--check');
  check('场景 2e：CRLF 且内容漂移 → --check exit 1', r.code === 1 && r.out.includes('重生成'), r.out);
}
// 场景 2f：锚日翻转稳定性（2026-10-12 CI 生产事故钉：v12 两锚定 10-12，10-11 生成的视图在锚日当天
//   被 --check 按当日重渲染判「已生效」→ 与仓内「待升级」必差 → 每个未来日期锚都在锚日引爆）。
//   修法语义：--check 对磁盘自带「视图日期」重渲染——视图生成于 D1（昨日），次日（系统当日）--check
//   仍须一致。断言不依赖未来锚存在：视图日期行本身在旧实现下就会因当日重渲染而漂移。
{
  const d = mkfix(8);
  const d1 = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const gen = spawnSync(process.execPath, [SCRIPT, '--root', d], { encoding: 'utf8', env: { ...process.env, EFFECTIVE_POLICY_TODAY: d1 } });
  const doc = fs.readFileSync(path.join(d, 'workflow', 'effective-policy.md'), 'utf8');
  const chk = run(d, '--check'); // 不带 env——按系统当日跑，模拟「次日对账」
  check('场景 2f：视图日期 D1 生成的视图，次日 --check 仍一致（按磁盘视图日期重渲染，锚日不引爆）',
    gen.status === 0 && doc.includes(`视图日期 ${d1}`) && chk.code === 0,
    `gen=${gen.status} docViewDate=${(doc.match(/视图日期 (\S+)/) || [])[1]} check=${chk.code}\n${chk.out}`);
}

// 场景 3：非法版本号 → 回落 v1（渲染回落声明）；缺 engine.json → 同 v1
{
  const d = mkfix(99);
  const r = run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'effective-policy.md'), 'utf8');
  check('场景 3a：非法 policyVersion=99 → 回落 v1 且声明回落', r.code === 0 && doc.includes('**policyVersion 1**') && doc.includes('已回落'), doc);
  const d2 = mkfix(undefined);
  const doc2run = run(d2);
  const doc2 = fs.readFileSync(path.join(d2, 'workflow', 'effective-policy.md'), 'utf8');
  check('场景 3b：缺 engine.json → v1 基线', doc2run.code === 0 && doc2.includes('**policyVersion 1**'), doc2);
}
// 场景 4：待升级判定——v7 的 check14HardSince=2026-10-10 若在今天（运行日）之后须标「待升级」；
//   运行日本身 ≥ 2026-10-10 时该锚已生效，改断言不依赖墙钟：直接断言「待升级」与「已生效」两词之一在场且与锚序一致
{
  const d = mkfix(8);
  run(d);
  const doc = fs.readFileSync(path.join(d, 'workflow', 'effective-policy.md'), 'utf8');
  const m = /\| `check14HardSince` \| (\S+) \|/.exec(doc);
  const todayStr = new Date().toISOString().slice(0, 10);
  const expect = m && m[1] <= todayStr ? '已生效' : '待升级';
  check(`场景 4：升级锚按运行日判定（期望 ${expect}）`, doc.includes(`\`check14HardSince\` | ${m && m[1]} | 检查 14 | 同上——锚日起升 hard-block | hard | ${expect}`), doc);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
