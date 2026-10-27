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
  // 夹具：钩子 2、SECTIONS hard 1 + hygiene 1、台账 现役 2（均带机制类型标记）+ 已退役 1（含复评挂号称）、命令/技能/角色各 1
  // 台账状态列带 `[检出型]` / `[健康静默]` 标记是生产实态（2026-10-22 起 35/45 行带标记）——生成器须按
  // 剥离后的状态计数，否则写出「现役 0」（真实发生过的漂移）。
  fs.mkdirSync(path.join(root, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.githooks', 'pre-commit'), '');
  fs.writeFileSync(path.join(root, '.githooks', 'pre-push'), '');
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
  check('生成：钩子 2 个进表（pre-commit/pre-push）', text.includes('git 钩子 2 个') && text.includes('| pre-push |'));
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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
