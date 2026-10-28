#!/usr/bin/env node
// warn-fold-plugin.test.mjs — 告警折叠在**插件形态**下的端到端锁（2026-10-28 市场审查补）
//
// 为什么单独要有这一套：warn-format.test.mjs（S1-S7）锁的是折叠**规则**（纯函数），但「插件用户
// 到底能不能享受到折叠」是另一件事——它取决于 check-loop.mjs 的 selfRun 开关。2026-10-28 之前的
// 判据写死 `ROOT/.agents/scripts/check-loop.mjs`，而插件形态下引擎脚本留在插件内、项目侧根本没有
// 这份副本 → 判据恒 false → 「门禁收敛批 2」整族降噪机制对插件用户永不触发。修复只改了判据
// （改走 scriptPath 回退），当时没有任何测试覆盖这条端到端路径，注释却写着「另由本文件锁住」——
// 即一条空承诺。这里把它兑现：规则正确 + 开关生效，缺一即红。
//
// 判据：① 插件形态夹具（项目侧无引擎副本）默认跑 → 同标签多条折成「×N 条同类」单行，
//         逐条明细完整落 tmp/check-loop-warn.log（折叠不得吞信息）；
//       ② 同夹具带 CHECK_LOOP_VERBOSE=1 → 不折叠，逐条行数与落盘行数一致；
//       ③ 夹具必须**真的**没有项目侧引擎副本（否则测的就不是插件形态，① 会假通过）。
// 零依赖，Node ≥ 18 直接运行：node test/warn-fold-plugin.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(TEST_DIR, '..');
const CHECK_LOOP = path.join(PLUGIN, 'scripts', 'check-loop.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'; // Windows spawn 不补 .exe 扩展名

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};

const { initEngine } = await import(pathToFileURL(path.join(PLUGIN, 'scripts', 'init-engine.mjs')).href);

const mkFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-fold-'));
  const git = (args) => spawnSync(GIT, args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  initEngine(root);
  return root;
};

const runLoop = (root, env = {}) => spawnSync(process.execPath, [CHECK_LOOP, '--all'], {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, CHECK_LOOP_ROOT: root, ...env },
});
const bulletLines = (s) => (s || '').split(/\r?\n/).filter((l) => l.startsWith('- ['));

const root = mkFixture();
try {
  // ③ 前提锚：插件形态 = 项目侧没有引擎脚本副本。旧判据正是把这条路径当成必要条件才恒 false 的。
  const projectCopy = path.join(root, '.agents', 'scripts', 'check-loop.mjs');
  check('夹具确为插件形态（项目侧无 check-loop.mjs 副本）', !fs.existsSync(projectCopy), projectCopy);

  fs.rmSync(path.join(root, 'tmp', 'check-loop-warn.log'), { force: true });
  const folded = runLoop(root);
  const foldLines = bulletLines(folded.stderr).filter((l) => /条同类/.test(l));
  check('默认档在插件形态下确实折叠（旧判据下这里恒 0 条——即修复本体）',
    folded.status === 0 && foldLines.length >= 1, `exit=${folded.status} 折叠行=${foldLines.length}`);
  check('折叠行给出明细位置（读者能找回逐条）',
    foldLines.length > 0 && foldLines.every((l) => /tmp\/check-loop-warn\.log/.test(l)), foldLines.join('\n'));

  const logFile = path.join(root, 'tmp', 'check-loop-warn.log');
  check('逐条明细完整落盘（折叠不吞信息）', fs.existsSync(logFile), logFile);
  const detail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  check('落盘行数 ≥ 折叠后的可见行数（说明合并掉的都是明细而非丢弃）',
    detail.length > bulletLines(folded.stderr).length,
    `明细 ${detail.length} 行 / 可见 ${bulletLines(folded.stderr).length} 行`);
  const merged = Number((/×(\d+) 条同类/.exec(foldLines[0] || '') || [])[1] || 0);
  check('折叠计数与明细里该标签的实际条数相符（计数不是装饰）',
    merged >= 2 && detail.filter((l) => l.includes(`[${/\[([^\]]*)\]/.exec(foldLines[0])?.[1] || ''}]`)).length === merged,
    `计数=${merged} 明细同标签=${detail.filter((l) => l.includes(`[${/\[([^\]]*)\]/.exec(foldLines[0])?.[1] || ''}]`)).length}｜${foldLines[0]}`);

  const verbose = runLoop(root, { CHECK_LOOP_VERBOSE: '1' });
  const vLines = bulletLines(verbose.stderr);
  check('CHECK_LOOP_VERBOSE=1 → 不折叠（逐条出口在插件形态同样可用）',
    verbose.status === 0 && !/条同类/.test(verbose.stderr || '') && vLines.length >= merged,
    `exit=${verbose.status} 逐条=${vLines.length} 折叠残留=${/条同类/.test(verbose.stderr || '')}`);
  check('两种形态的明细条数同源（折叠只是呈现层，不改判据）',
    vLines.length === detail.length, `逐条 ${vLines.length} vs 明细 ${detail.length}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
