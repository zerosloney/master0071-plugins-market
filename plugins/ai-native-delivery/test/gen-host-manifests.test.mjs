#!/usr/bin/env node
// gen-host-manifests.mjs 的单源生成器测试
// 断言：①--check 对当前树 exit 0；②纯函数 renderHostManifest 三宿主输出与磁盘垫片深度相等；
//       ③篡改检测——整树复制到临时目录跑 CLI（不碰真文件），改坏一份垫片 / 改 hooks.json 单源，
//         check 必红且点名漂移文件（hooks.json 改动只应红 codex——证明 codex hooks 段单源在 hooks.json）；
//       ④codex 垫片 hooks 段与 hooks/hooks.json 的 matcher/command/timeout 逐字段相等。
// 用法：node test/gen-host-manifests.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..');
const GEN = path.join(PLUGIN_ROOT, 'scripts', 'gen-host-manifests.mjs');
const HOST_IDS = ['zcode', 'codex', 'omp'];
const HOST_DIR = { zcode: '.zcode-plugin', codex: '.codex-plugin', omp: '.omp-plugin' };

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---- 场景 1：--check 对当前树 exit 0（漂移门常绿基线）----
{
  const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
  check('场景 1：--check 对当前树 exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
}

// ---- 场景 2：纯函数渲染 == 磁盘垫片（深度相等 + 归一行尾后逐字节相等）----
{
  const { renderHostManifest } = await import(pathToFileURL(GEN).href); // Windows 绝对路径须转 file:// URL
  for (const id of HOST_IDS) {
    const rel = path.join(HOST_DIR[id], 'plugin.json');
    const file = path.join(PLUGIN_ROOT, rel);
    const rendered = JSON.stringify(renderHostManifest(id), null, 2) + '\n';
    const diskRaw = fs.readFileSync(file, 'utf8');
    let ok = true;
    try { assert.deepStrictEqual(renderHostManifest(id), readJson(file)); } catch (e) { ok = false; check(`场景 2：renderHostManifest('${id}') 与磁盘深度相等`, false, String(e)); }
    check(`场景 2：renderHostManifest('${id}') 序列化与磁盘一致（\\r 归一）`,
      ok && rendered.replace(/\r/g, '') === diskRaw.replace(/\r/g, ''), `rel=${rel}`);
  }
}

// ---- 场景 3：篡改检测（临时目录整树复制，不改真文件）----
// 复制生成器运行所需的最小闭包：根清单 + hooks 单源 + 生成器两脚本 + 三份垫片。
// 在副本上跑**副本里的 CLI**（其插件根按脚本落位解析 → 临时根），真文件零触碰。
const mkcopy = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-host-manifests-test-'));
  const at = (...rel) => path.join(root, ...rel);
  fs.mkdirSync(at('scripts'), { recursive: true });
  fs.mkdirSync(at('hooks'), { recursive: true });
  for (const id of HOST_IDS) fs.mkdirSync(at(HOST_DIR[id]), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), at('plugin.json'));
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), at('hooks', 'hooks.json'));
  for (const s of ['hosts.mjs', 'gen-host-manifests.mjs']) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'scripts', s), at('scripts', s));
  }
  for (const id of HOST_IDS) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, HOST_DIR[id], 'plugin.json'), at(HOST_DIR[id], 'plugin.json'));
  }
  return { root, at };
};

{
  const { root, at } = mkcopy();
  const runCopy = (args = []) => spawnSync(process.execPath, [at('scripts', 'gen-host-manifests.mjs'), ...args], { encoding: 'utf8' });
  const ok = runCopy(['--check']);
  check('场景 3a：干净副本 --check exit 0', ok.status === 0, `exit=${ok.status}\n${ok.stdout}${ok.stderr}`);

  // 3b：改坏一份垫片（zcode version 漂移）→ exit 1 且点名该文件
  //（版本号从副本清单读，不硬编码——release bump 不该让本测试失效）
  const zc = at(HOST_DIR.zcode, 'plugin.json');
  const ver = JSON.parse(fs.readFileSync(zc, 'utf8')).version;
  fs.writeFileSync(zc, fs.readFileSync(zc, 'utf8').replace(`"${ver}"`, '"9.9.9"'), 'utf8');
  const drift = runCopy(['--check']);
  check('场景 3b：篡改 zcode 垫片 → --check exit 1（漂移即红）', drift.status === 1, `exit=${drift.status}\n${drift.stdout}${drift.stderr}`);
  check('场景 3b：漂移输出点名 .zcode-plugin/plugin.json', /\.zcode-plugin[\\/]plugin\.json/.test(drift.stderr), drift.stderr);
  check('场景 3b：--check 不写盘（副本垫片仍是 9.9.9）', fs.readFileSync(zc, 'utf8').includes('"9.9.9"'), '');

  // 3c：改 hooks.json 单源（timeout 15→7）→ 只有 codex 红（垫片 hooks 段单源在该文件的实证；
  //     zcode/omp 不含 hooks.json 内容，必须保持绿）
  fs.writeFileSync(zc, fs.readFileSync(zc, 'utf8').replace('"9.9.9"', `"${ver}"`), 'utf8');
  const hj = at('hooks', 'hooks.json');
  fs.writeFileSync(hj, fs.readFileSync(hj, 'utf8').replace('"timeout": 15', '"timeout": 7'), 'utf8');
  const hookDrift = runCopy(['--check']);
  check('场景 3c：改 hooks.json → --check exit 1', hookDrift.status === 1, `exit=${hookDrift.status}\n${hookDrift.stdout}${hookDrift.stderr}`);
  check('场景 3c：漂移只点名 .codex-plugin/plugin.json（单源传导面）',
    /\.codex-plugin[\\/]plugin\.json/.test(hookDrift.stderr) && !/\.zcode-plugin[\\/]plugin\.json/.test(hookDrift.stderr.replace(/✓[^\n]*/g, '')),
    hookDrift.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：codex hooks 段与 hooks/hooks.json 逐字段相等（matcher/command/timeout 无第二份拷贝）----
{
  const codex = readJson(path.join(PLUGIN_ROOT, HOST_DIR.codex, 'plugin.json'));
  const hooksJson = readJson(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'));
  const a = codex.hooks.hooks.PreToolUse[0];
  const b = hooksJson.hooks.PreToolUse[0];
  check('场景 4：PreToolUse 条目数一致', codex.hooks.hooks.PreToolUse.length === hooksJson.hooks.PreToolUse.length, '');
  check('场景 4：matcher 逐字相等', a.matcher === b.matcher, `${a.matcher}\n      vs ${b.matcher}`);
  check('场景 4：type/command/timeout 逐字段相等',
    a.hooks[0].type === b.hooks[0].type && a.hooks[0].command === b.hooks[0].command && a.hooks[0].timeout === b.hooks[0].timeout,
    `${JSON.stringify(a.hooks[0])} vs ${JSON.stringify(b.hooks[0])}`);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
