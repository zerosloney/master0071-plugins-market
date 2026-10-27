#!/usr/bin/env node
// init.test.mjs — init-engine 幂等初始化可测化（设计文档 §5.2 初始化契约 / §10.1）
// 断言：①临时 git 仓跑 init 两次——第二次零改动（目录快照逐文件比对：内容+大小+mtime）；
//       ②gitignore 标记块整块替换幂等（块外内容原样保留）；③已存在 config 跳过不覆盖 +
//       policyVersion 漂移 WARN；④已存在同名 git hook 跳过（不覆盖用户钩子）。
// 零依赖，Node ≥ 18 直接运行：node test/init.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initEngine, GITIGNORE_BEGIN, GITIGNORE_END } from '../scripts/init-engine.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(TEST_DIR, '..', 'scripts', 'init-engine.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'init-engine-'));
  spawnSync(GIT, ['init', '-q'], { cwd: d });
  return d;
};

// 快照：relPath → {dir, size, mtimeMs, hash}（目录只记 dir 标志）。init 不跑 git 命令，
// .git 除 hooks 外不被触碰，整树可比。
const snapshot = (root) => {
  const out = new Map();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        out.set(rel, { dir: true });
        stack.push(full);
      } else {
        const st = fs.statSync(full);
        const body = fs.readFileSync(full);
        out.set(rel, { dir: false, size: st.size, mtimeMs: st.mtimeMs, hash: `${body.length}:${createHash('sha1').update(body).digest('hex')}` });
      }
    }
  }
  return out;
};
const snapDiff = (a, b) => {
  const diffs = [];
  for (const [k, v] of a) if (JSON.stringify(v) !== JSON.stringify(b.get(k) ?? null)) diffs.push(`changed: ${k}`);
  for (const k of b.keys()) if (!a.has(k)) diffs.push(`added: ${k}`);
  return diffs;
};

// ---- ① 首跑 + 二跑幂等 ----
{
  const root = mkRepo();
  const r1 = initEngine(root);
  check('首跑有新建项', r1.created.length > 0, JSON.stringify(r1.created));
  check('首跑种子 .agents/config/engine.json', r1.created.some((c) => c === '.agents/config/engine.json'), JSON.stringify(r1.created));
  check('首跑种子 .agents/settings.json', r1.created.includes('.agents/settings.json'));
  check('首跑建确认主账与分片目录', r1.created.includes('.agents/confirmations.jsonl') && r1.created.includes('.agents/confirmations.d/'));
  check('首跑建 workflow 八子目录与 INDEX', r1.created.includes('workflow/INDEX.md') && r1.created.includes('workflow/archive/'));
  check('首跑安装两个 git hooks', r1.hooks.installed.length === 2, JSON.stringify(r1.hooks));
  check('首跑 .gitignore 标记块写入', r1.gitignore === 'created' && fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes(GITIGNORE_BEGIN));
  // 钩子已实化：占位符不存在，ENGINE_SCRIPT 是可解析的绝对路径
  const hookBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
  check('钩子占位符已被实化', !hookBody.includes('@@ENGINE_SCRIPT@@') && /const ENGINE_SCRIPT = ".+check-loop\.mjs";/.test(hookBody), hookBody.split('\n').find((l) => l.includes('ENGINE_SCRIPT =')));

  const snap1 = snapshot(root);
  const r2 = initEngine(root);
  const snap2 = snapshot(root);
  check('二跑零新建', r2.created.length === 0, JSON.stringify(r2.created));
  const diffs = snapDiff(snap1, snap2);
  check('二跑目录快照零改动（幂等）', diffs.length === 0, diffs.join(', '));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② gitignore 标记块替换（块外内容保留，替换幂等）----
{
  const root = mkRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), [
    'node_modules/',
    'dist/',
    `${GITIGNORE_BEGIN}`,
    '.agents/old-stale-entry/',
    `${GITIGNORE_END}`,
    'keep-me-custom.txt',
    '',
  ].join('\n'), 'utf8');
  const r1 = initEngine(root);
  check('已有标记块 → block-replaced', r1.gitignore === 'block-replaced', r1.gitignore);
  const body = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  check('块内旧条目被替换', !body.includes('.agents/old-stale-entry/'), body);
  check('块外内容原样保留', body.includes('node_modules/') && body.includes('dist/') && body.includes('keep-me-custom.txt'), body);
  check('块内含六条本机不入库项', ['.agents/cache/', '.agents/judgments.jsonl', '.agents/verifications.jsonl', '.agents/tmp/', '.agents/config/model-roles.local.json', '.agents/notes/runtime-env.local.md'].every((e) => body.includes(e)), body);

  const snap1 = snapshot(root);
  const r2 = initEngine(root);
  const snap2 = snapshot(root);
  check('块替换幂等（二跑 unchanged + 快照零改动）', r2.gitignore === 'unchanged' && snapDiff(snap1, snap2).length === 0, r2.gitignore);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 已存在 config 跳过 + policyVersion 漂移 WARN ----
{
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const custom = path.join(root, '.agents', 'config', 'engine.json');
  fs.writeFileSync(custom, JSON.stringify({ policyVersion: 13, note: '项目自定义' }), 'utf8');
  const r = initEngine(root);
  check('已存在 engine.json 不覆盖', fs.readFileSync(custom, 'utf8').includes('项目自定义'));
  check('已存在项出现在 skipped 清单', r.skipped.some((s) => s.includes('.agents/config/engine.json')), JSON.stringify(r.skipped));
  check('policyVersion 漂移 → WARN（不自动覆盖）', r.warnings.some((w) => w.includes('policyVersion') && w.includes('13')), JSON.stringify(r.warnings));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ 已存在同名 git hook 跳过 ----
{
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const userHook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(userHook, '#!/bin/sh\necho my-custom-hook\n', 'utf8');
  const r = initEngine(root);
  check('用户钩子不被覆盖', fs.readFileSync(userHook, 'utf8').includes('my-custom-hook'));
  check('同名钩子列入 skipped', r.hooks.skipped.some((s) => s.includes('pre-commit')), JSON.stringify(r.hooks.skipped));
  check('其余钩子照常安装', r.hooks.installed.length === 1 && r.hooks.installed[0].includes('pre-push'), JSON.stringify(r.hooks.installed));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ CLI 形态：exit 0 + 报告可读（双跑皆 0）----
{
  const root = mkRepo();
  const a = spawnSync(process.execPath, [INIT, '--root', root], { encoding: 'utf8' });
  check('CLI 首跑 exit 0 且输出新建清单', a.status === 0 && /新建 \d+ 项/.test(a.stdout), `exit=${a.status} ${a.stderr}`);
  const b = spawnSync(process.execPath, [INIT, '--root', root], { encoding: 'utf8' });
  check('CLI 二跑 exit 0 且零新建', b.status === 0 && /新建 0 项/.test(b.stdout), `exit=${b.status} stdout=${b.stdout}`);
  check('CLI 输出含卸载说明', /卸载说明/.test(b.stdout));
  fs.rmSync(root, { recursive: true, force: true });
}
