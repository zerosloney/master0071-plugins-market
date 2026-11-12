#!/usr/bin/env node
// check-bands.test.mjs — 确定性带监测夹具测试（设计稿 ai-native-closed-loop-and-memory 步骤 A）
// 断言：①缺配置 exit 0 不误报（明确提示）；②坏配置 exit 2 fail-loud（JSON 损坏 / 结构非法两态）；
// ③verify-green 源夹具越带 → 输出含 tier 与建议指令（diagnose 只读白名单）+ 库结果 breach；
// ④带内 exit 0；⑤workflow-metrics 源越带 → tier=propose + PR 路由建议行 + 带内变体；
// ⑥样本不足 → 未判带不报错。CLI（--root + 退出码三态）与库导出（runBandCheck）双面覆盖。
// 配置一律拷**插件种子** bands.json 进夹具——种子结构与判据实现同场对账（种子漂移即红）。
// 用法：node test/check-bands.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBandCheck } from '../scripts/check-bands.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(TEST_DIR, '..', 'scripts', 'check-bands.mjs');
const SEED = path.join(TEST_DIR, '..', 'config-templates', 'bands.json');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const mkfix = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bands-fix-'));
  fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
  fs.mkdirSync(path.join(d, 'workflow'), { recursive: true });
  return d;
};
const w = (root, rel, content) => fs.writeFileSync(path.join(root, rel), content);
const seedConfig = (root) => fs.copyFileSync(SEED, path.join(root, '.agents', 'config', 'bands.json'));
const cli = (root) => spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
const outOf = (r) => `${r.stdout || ''}${r.stderr || ''}`;
// 验证行夹具（形态 = verify.mjs 落账：绿 = all-gates + exit 0；失败行 = 门 id + exitCode≠0）
const green = (i) => JSON.stringify({ ts: `2026-11-${String(i).padStart(2, '0')}T00:00:00.000Z`, exitCode: 0, suite: 'all-gates' });
const red = (i, suite) => JSON.stringify({ ts: `2026-11-${String(i).padStart(2, '0')}T00:00:00.000Z`, exitCode: 1, suite, note: 'exit 1' });
const metricsMd = (rows) => [
  '# workflow 规模与规则面月度快照', '',
  '## 闭环漏斗', '',
  '| 月份 | 收口 | 完整链 | 协议前 | 确认链一次通过 | 返工件 | 中位周期(天) | 台账行数 |',
  '|---|---|---|---|---|---|---|---|',
  ...rows, '',
].join('\n');

// ---- ① 缺配置：exit 0 不误报 + 明确提示 ----
{
  const T = mkfix();
  const r = cli(T);
  check('缺配置 → exit 0（不误报）', r.status === 0, `exit=${r.status}\n${outOf(r)}`);
  check('缺配置 → 明确提示 bands.json 缺席', outOf(r).includes('未配置带监测') && outOf(r).includes('bands.json'), outOf(r));
  const lib = runBandCheck(T);
  check('缺配置 → 库结果 configured:false / 零越带',
    lib.configured === false && lib.breachCount === 0 && lib.error === null, JSON.stringify(lib).slice(0, 200));
  fs.rmSync(T, { recursive: true, force: true });
}

// ---- ② 坏配置：exit 2 fail-loud（JSON 损坏 / 结构非法）----
{
  const T = mkfix();
  seedConfig(T);
  w(T, path.join('.agents', 'config', 'bands.json'), '{ not-json');
  const r = cli(T);
  check('JSON 损坏 → exit 2 且点名 bands.json',
    r.status === 2 && outOf(r).includes('bands.json') && outOf(r).includes('不可解析'), `exit=${r.status}\n${outOf(r)}`);
  fs.rmSync(T, { recursive: true, force: true });

  const T2 = mkfix();
  seedConfig(T2);
  const cfg = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  cfg.rules['bad-source'] = { metric: 'no-such-metric', k: 2, tier: 'log' }; // 规则引用未定义指标源
  w(T2, '.agents/config/bands.json', JSON.stringify(cfg, null, 2));
  const r2 = cli(T2);
  check('结构非法（规则引用未定义 metric）→ exit 2',
    r2.status === 2 && outOf(r2).includes('未在 metric 段定义'), `exit=${r2.status}\n${outOf(r2)}`);
  fs.rmSync(T2, { recursive: true, force: true });

  const T3 = mkfix();
  seedConfig(T3);
  const cfg3 = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  delete cfg3.tiers.propose.route; // propose 档缺路由字段
  w(T3, '.agents/config/bands.json', JSON.stringify(cfg3, null, 2));
  const r3 = cli(T3);
  check('结构非法（propose 缺 route）→ exit 2',
    r3.status === 2 && outOf(r3).includes('route'), `exit=${r3.status}\n${outOf(r3)}`);
  fs.rmSync(T3, { recursive: true, force: true });
}

// ---- ③④ verify-green 源：越带（tier + 建议指令）/ 带内（exit 0）----
{
  const T = mkfix();
  seedConfig(T);
  w(T, '.agents/verifications.jsonl', Array.from({ length: 10 }, (_, i) => green(i + 1)).join('\n') + '\n' + red(11, 'backend-test') + '\n');
  const r = cli(T);
  check('verify-green 越带 → exit 1', r.status === 1, `exit=${r.status}\n${outOf(r)}`);
  check('verify-green 越带 → 输出含 band 名 / tier=diagnose / 越带标记',
    outOf(r).includes('verify-fail-rate-2s') && outOf(r).includes('tier=diagnose') && outOf(r).includes('越带'), outOf(r));
  check('verify-green 越带 → 建议指令行（只读工具白名单 + 只打印不执行声明）',
    outOf(r).includes('建议指令') && outOf(r).includes('只读工具白名单') && outOf(r).includes('本检查只打印不执行'), outOf(r));
  check('verify-green 越带 → 当前值与基线带宽可见（σ=0 时偏离均值即越带）',
    outOf(r).includes('当前=0.0909') && outOf(r).includes('基线 μ=0 σ=0'), outOf(r));
  const lib = runBandCheck(T);
  check('库结果：band breach + tier 保留（结构化可断言）',
    lib.breachCount === 1 && lib.bands[0].status === 'breach' && lib.bands[0].tier === 'diagnose',
    JSON.stringify(lib.bands));
  fs.rmSync(T, { recursive: true, force: true });

  const T2 = mkfix();
  seedConfig(T2);
  w(T2, '.agents/verifications.jsonl', Array.from({ length: 12 }, (_, i) => green(i + 1)).join('\n') + '\n');
  const r2 = cli(T2);
  check('verify-green 带内（全绿史）→ exit 0 且不产建议指令行',
    r2.status === 0 && outOf(r2).includes('带内') && !outOf(r2).includes('建议指令（diagnose'), `exit=${r2.status}\n${outOf(r2)}`);
  fs.rmSync(T2, { recursive: true, force: true });
}

// ---- ⑤ workflow-metrics 源：越带（propose 路由建议）/ 带内变体 ----
{
  const T = mkfix();
  seedConfig(T);
  const base = ['| 2026-08 | 10 | 9 | 1 | 8 | 1 | 0.5 | 20 |', '| 2026-09 | 10 | 9 | 1 | 8 | 1 | 0.5 | 20 |', '| 2026-10 | 10 | 9 | 1 | 8 | 1 | 0.5 | 20 |'];
  w(T, 'workflow/metrics.md', metricsMd([...base, '| 2026-11 | 10 | 9 | 1 | 8 | 6 | 0.5 | 20 |']));
  const r = cli(T);
  check('workflow-metrics 越带 → exit 1 + tier=propose',
    r.status === 1 && outOf(r).includes('funnel-rework-2s') && outOf(r).includes('tier=propose'), `exit=${r.status}\n${outOf(r)}`);
  check('workflow-metrics 越带 → 建议指令含 PR 路由（propose 档）',
    outOf(r).includes('pull_request') && outOf(r).includes('建议指令'), outOf(r));
  fs.rmSync(T, { recursive: true, force: true });

  const T2 = mkfix();
  seedConfig(T2);
  w(T2, 'workflow/metrics.md', metricsMd([...base, '| 2026-11 | 10 | 9 | 1 | 8 | 1 | 0.5 | 20 |']));
  const r2 = cli(T2);
  check('workflow-metrics 带内 → exit 0', r2.status === 0 && outOf(r2).includes('funnel-rework-2s'), `exit=${r2.status}\n${outOf(r2)}`);
  fs.rmSync(T2, { recursive: true, force: true });

  const T3 = mkfix();
  seedConfig(T3);
  const r3 = cli(T3);
  check('metrics.md 缺失 → 未判带（源缺不报错）exit 0',
    r3.status === 0 && outOf(r3).includes('未判带') && outOf(r3).includes('源数据缺失'), `exit=${r3.status}\n${outOf(r3)}`);
  fs.rmSync(T3, { recursive: true, force: true });
}

// ---- ⑥ 样本不足：未判带不报错 ----
{
  const T = mkfix();
  seedConfig(T);
  w(T, '.agents/verifications.jsonl', [green(1), green(2)].join('\n') + '\n');
  const r = cli(T);
  check('基线样本不足 → 未判带 + exit 0（不误报）',
    r.status === 0 && outOf(r).includes('未判带') && outOf(r).includes('基线样本不足'), `exit=${r.status}\n${outOf(r)}`);
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
