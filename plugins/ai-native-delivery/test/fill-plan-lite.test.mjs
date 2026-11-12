#!/usr/bin/env node
// fill-plan-lite.test.mjs — fill-plan --lite 三节轻量骨架（2026-11-12 档二放宽判据移植）
// 断言：①renderPlan lite 三节（入口 / 改动方案 / 验证与验收（lite）），复用既有节不复制正文；
// ②缺省五节行为不变；③lite 对 L2/L3 不生效（FULL_SECTIONS 照旧）；④CLI --lite 落盘三节 + 提示行；
// ⑤CLI --lite × 非 L1 拒绝（exit 1）。
// 零依赖，Node ≥ 18 直接运行：node test/fill-plan-lite.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPlan } from '../scripts/fill-plan.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'fill-plan.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ---- ① lite 三节形状 ----
{
  const lite = renderPlan({ topic: 't', level: 'L1', lite: true });
  check('① lite 三节 = 入口 / 改动方案 / 验证与验收（lite）',
    JSON.stringify(lite.sections) === JSON.stringify(['入口', '改动方案', '验证与验收（lite）']), JSON.stringify(lite.sections));
  check('①b lite 正文无「约束与风险」「验证计划」「验收标准（可测试）」节，lite 节含静态门与检索提示',
    !/## 约束与风险/.test(lite.body) && !/## 验证计划/.test(lite.body) && !/## 验收标准（可测试）/.test(lite.body)
    && lite.body.includes('verify.mjs --scope') && lite.body.includes('kb-search')
    && lite.body.includes('约束与风险以一句话并入改动方案条目'), lite.body.slice(-600));
  check('①c frontmatter 级别仍 L1、确认与复核节保留',
    lite.frontmatter.includes('级别: L1') && lite.body.includes('## 确认与复核'));
}

// ---- ② 缺省五节不变 ----
{
  const full = renderPlan({ topic: 't', level: 'L1' });
  check('② 缺省 L1 仍五节（入口/改动方案/约束与风险/验证计划/验收标准）',
    JSON.stringify(full.sections) === JSON.stringify(['入口', '改动方案', '约束与风险', '验证计划', '验收标准（可测试）']), JSON.stringify(full.sections));
}

// ---- ③ lite 对 L2/L3 不生效 ----
{
  const l2 = renderPlan({ topic: 't', level: 'L2', lite: true });
  check('③ L2 + lite → 仍完整 4 节（lite 只对 L1 合法）',
    l2.sections.length === 4 && l2.sections[0] === '改动方案' && !l2.sections.includes('验证与验收（lite）'), JSON.stringify(l2.sections));
}

// ---- ④ CLI --lite：落盘三节 + 提示行 ----
{
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-')), 'lite.md');
  const r = spawnSync(process.execPath, [CLI, '--level', 'L1', '--lite', '--topic', 'lite 主题', '--output', out], { encoding: 'utf8' });
  const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  check('④ CLI --lite exit 0 + 提示「L1-lite 三节」', r.status === 0 && r.stdout.includes('L1-lite 三节'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('④b 落盘正文三节 + 确认与复核', ['## 入口', '## 改动方案', '## 验证与验收（lite）', '## 确认与复核'].every((h) => body.includes(h)), body.slice(0, 400));
}

// ---- ⑤ CLI --lite × 非 L1 → 拒绝 ----
{
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-')), 'l2.md');
  const r = spawnSync(process.execPath, [CLI, '--level', 'L2', '--lite', '--topic', 't', '--output', out], { encoding: 'utf8' });
  check('⑤ --lite × L2 → exit 1 且不给落盘', r.status === 1 && r.stderr.includes('--lite 仅支持 --level L1') && !fs.existsSync(out), `exit=${r.status}\n${r.stderr}`);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
