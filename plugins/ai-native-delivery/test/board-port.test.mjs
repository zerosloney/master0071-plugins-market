#!/usr/bin/env node
// board-port.test.mjs — 看板端口解析单源黑盒测试（2026-11 实时版新增）
// 断言：①显式 --port 绝对值优先 ②项目侧 engine.json options.boardPort 次之 ③缺配置/坏值回落基线
// ④坏值不毒死流程（非法端口号按基线处理）⑤seed 里的 options.boardPort 形如种子 engine.json。
// 零依赖，Node ≥ 18 直接运行：node test/board-port.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBoardPort, BASE_BOARD_PORT } from '../scripts/board-port.mjs';
import { PLUGIN_CONFIG_TEMPLATES_DIR } from '../scripts/paths.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRoot = (engineJson) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'board-port-test-'));
  if (engineJson !== undefined) {
    fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
    fs.writeFileSync(path.join(d, '.agents', 'config', 'engine.json'), engineJson, 'utf8');
  }
  return d;
};

// ① 显式端口优先（绝对值，不吃偏移）
{
  const root = mkRoot(JSON.stringify({ policyVersion: 16, options: { boardPort: 8999 } }));
  check('① 显式 --port 优先于 engine.json', resolveBoardPort({ explicit: '9100', root }) === 9100, `got ${resolveBoardPort({ explicit: '9100', root })}`);
  fs.rmSync(root, { recursive: true, force: true });
}
// ② engine.json options.boardPort
{
  const root = mkRoot(JSON.stringify({ policyVersion: 16, options: { boardPort: 8999 } }));
  check('② 缺显式时取 engine.json options.boardPort', resolveBoardPort({ root }) === 8999, `got ${resolveBoardPort({ root })}`);
  fs.rmSync(root, { recursive: true, force: true });
}
// ③ 缺配置 / 坏值 → 回落基线
{
  const root = mkRoot(undefined);
  check('③ 无 engine.json → 回落基线端口', resolveBoardPort({ root }) === BASE_BOARD_PORT, `got ${resolveBoardPort({ root })}`);
  fs.rmSync(root, { recursive: true, force: true });
  const bad = mkRoot('{ 这不是 JSON');
  check('③b 坏 engine.json → 回落基线（不毒死流程）', resolveBoardPort({ root: bad }) === BASE_BOARD_PORT, `got ${resolveBoardPort({ root: bad })}`);
  fs.rmSync(bad, { recursive: true, force: true });
}
// ④ 非法端口号（0 / 非数字）视为未给
{
  const root = mkRoot(JSON.stringify({ policyVersion: 16, options: { boardPort: 8999 } }));
  check('④ 非法显式端口按未给处理', resolveBoardPort({ explicit: 'abc', root }) === 8999 && resolveBoardPort({ explicit: '0', root }) === 8999,
    `abc=${resolveBoardPort({ explicit: 'abc', root })} zero=${resolveBoardPort({ explicit: '0', root })}`);
  fs.rmSync(root, { recursive: true, force: true });
}
// ⑤ 插件种子 engine.json 带 options.boardPort（装户侧可改端口的入口）
{
  const seed = JSON.parse(fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json'), 'utf8'));
  check('⑤ 种子 engine.json 含 options.boardPort', seed && seed.options && Number(seed.options.boardPort) === BASE_BOARD_PORT,
    JSON.stringify(seed && seed.options));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
