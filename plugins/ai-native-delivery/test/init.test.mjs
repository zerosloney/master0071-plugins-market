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
import { PLUGIN_ROOT } from '../scripts/paths.mjs';

// 插件名（2026-11 市场审查 M12）：与实现同单源（plugin.json name）。自装判据锚插件名路径段，
// 不锚 basename(PLUGIN_ROOT)——宿主版本化缓存布局（<cache>/<市场>/<插件名>/<版本>/）下后者
// 是版本号，升版后旧钩子 baked 的旧版本目录按版本号切段永不命中，误判第三方。
const PLUGIN_NAME = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8')).name;

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
  // 机制台账首拷（2026-11 F4 步骤 A3）：mechanism-registry.md 随 config-templates 全量种子落
  // .agents/config/——init 首拷一次、之后项目自治（改行不受种子升版侵蚀），retire-watch / 检查 22
  // 的种子回退链（registryCandidates）只在装户未跑 init 时兜底。
  check('首跑种子 .agents/config/mechanism-registry.md（机制台账首拷）',
    r1.created.includes('.agents/config/mechanism-registry.md'), JSON.stringify(r1.created));
  check('首拷内容 = 插件种子原文（装户侧从种子起步）',
    fs.readFileSync(path.join(root, '.agents', 'config', 'mechanism-registry.md'), 'utf8')
      === fs.readFileSync(path.join(PLUGIN_ROOT, 'config-templates', 'mechanism-registry.md'), 'utf8'));
  // 带监测种子首拷（2026-11-12 设计稿 ai-native-closed-loop-and-memory 步骤 A）：bands.json 随
  // config-templates 通用复制机制自动落 .agents/config/（install/plan 无需专项条目——核实即此）。
  // 示范口径随种子起步、项目自调；check-bands.mjs 消费（缺文件 exit 0 不误报）。
  check('首跑种子 .agents/config/bands.json（带监测种子首拷）',
    r1.created.includes('.agents/config/bands.json'), JSON.stringify(r1.created));
  check('bands.json 首拷内容 = 插件种子原文',
    fs.readFileSync(path.join(root, '.agents', 'config', 'bands.json'), 'utf8')
      === fs.readFileSync(path.join(PLUGIN_ROOT, 'config-templates', 'bands.json'), 'utf8'));
  check('首跑种子 .agents/settings.json', r1.created.includes('.agents/settings.json'));
  check('首跑建确认主账与分片目录', r1.created.includes('.agents/confirmations.jsonl') && r1.created.includes('.agents/confirmations.d/'));
  check('首跑建 workflow 八子目录与 INDEX', r1.created.includes('workflow/INDEX.md') && r1.created.includes('workflow/archive/'));
  check('首跑安装四个 git hooks（pre-commit / pre-push / post-commit / commit-msg）', r1.hooks.installed.length === 4, JSON.stringify(r1.hooks));
  check('首跑 .gitignore 标记块写入', r1.gitignore === 'created' && fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes(GITIGNORE_BEGIN));
  // 钩子已实化：**带引号的可执行占位符**已被替换为可解析的绝对路径。
  // 注意：种子头注的散文里合法提到 @@ENGINE_SCRIPT@@（说明占位符语义），故断言只查带引号的可执行形式。
  const hookBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
  check('钩子占位符已被实化', !/const ENGINE_SCRIPT = "@@ENGINE_SCRIPT@@"/.test(hookBody)
    && /const ENGINE_SCRIPT = ".+check-loop\.mjs";/.test(hookBody), hookBody.split('\n').find((l) => l.includes('ENGINE_SCRIPT =')));
  // post-commit（2026-11-11 Dreaming 移植）：advisory 提醒腿——DREAM_SCRIPT 实化为 dream-run.mjs
  const postBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'post-commit'), 'utf8');
  check('post-commit 占位符实化为 dream-run.mjs（无带引号遗留占位符）',
    !/"@@[A-Z_]+@@"/.test(postBody) && /const DREAM_SCRIPT = ".+dream-run\.mjs";/.test(postBody), postBody.split('\n').find((l) => l.includes('DREAM_SCRIPT =')));
  // commit-msg（2026-11-12 L0/L1 快速道移植）：顺序门 gate 腿 + 任务短名 advisory 腿占位符实化
  const cmBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'commit-msg'), 'utf8');
  check('commit-msg 占位符实化为顺序门与短名脚本（无带引号遗留占位符）',
    !/"@@[A-Z_]+@@"/.test(cmBody)
    && /const CONFIRM_ORDER_SCRIPT = ".+check-confirm-order\.mjs";/.test(cmBody)
    && /const PLAN_REF_SCRIPT = ".+check-commit-plan-ref\.mjs";/.test(cmBody), cmBody.split('\n').find((l) => l.includes('CONFIRM_ORDER_SCRIPT =')));

  const snap1 = snapshot(root);
  const r2 = initEngine(root);
  const snap2 = snapshot(root);
  check('二跑零新建', r2.created.length === 0, JSON.stringify(r2.created));
  check('二跑 mechanism-registry.md 零新建（首拷幂等）',
    !r2.created.some((c) => c.includes('mechanism-registry')) && r2.skipped.some((c) => c.includes('mechanism-registry')),
    JSON.stringify({ created: r2.created, skipped: r2.skipped.filter((c) => c.includes('mechanism-registry')) }));
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
  check('块内含七条本机不入库项', ['.agents/cache/', '.agents/judgments.jsonl', '.agents/verifications.jsonl', '.agents/tmp/', '.agents/config/model-roles.local.json', '.agents/notes/runtime-env.local.md', 'workflow/**/*.lock'].every((e) => body.includes(e)), body);

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
  check('其余钩子照常安装（pre-push + post-commit + commit-msg）',
    r.hooks.installed.length === 3 && r.hooks.installed.some((s) => s.includes('pre-push')) && r.hooks.installed.some((s) => s.includes('post-commit')) && r.hooks.installed.some((s) => s.includes('commit-msg')), JSON.stringify(r.hooks.installed));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④b 本插件旧装钩子指向已失效的引擎脚本 → 覆盖刷新（2026-11-01；2026-11-05 改真实迁移形态；
//       2026-11 市场审查 M12 拆两形：自装判据锚 plugin.json 插件名路径段，不再锚 basename(PLUGIN_ROOT)）----
// 插件安装目录随宿主缓存**整体迁移/升版**：钩子里 baked 的是旧安装根的绝对路径——不在当前
// PLUGIN_ROOT 下，但路径含**插件名**的独立路径段。此时 commit 崩在 MODULE_NOT_FOUND，而钩子给出的
// 修复指引正是"重跑 init-engine"——"已存在即跳过"让该指引变成 no-op。自装判据若用当前根前缀
//（startsWith(PLUGIN_ROOT)），迁移后前缀恒 false → 判为第三方钩子 skip，正是本组用例锁定的死态；
// 若用 basename(PLUGIN_ROOT)，版本化缓存布局下它是当前版本号，升版后对旧版本目录恒不命中，同死态。
{
  const root = mkRepo();
  const pre = path.join(root, '.git', 'hooks', 'pre-commit');
  initEngine(root);
  const before = fs.readFileSync(pre, 'utf8');
  check('④b 前置：首装钩子里 baked 的是现存引擎脚本', before.includes('check-loop.mjs') && fs.existsSync(PLUGIN_ROOT), before.slice(0, 160));
  // 形态一「插件名路径段命中」：旧安装根含插件名的独立路径段（无版本段），不在当前 PLUGIN_ROOT 下且已不存在
  const stale = path.join(root, 'old-plugin-cache', PLUGIN_NAME, 'scripts', 'check-loop.mjs');
  const patched = before.replace(/(const\s+ENGINE_SCRIPT\s*=\s*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(stale)}`);
  fs.writeFileSync(pre, patched, 'utf8');
  const r = initEngine(root);
  const after = fs.readFileSync(pre, 'utf8');
  check('④b 插件名路径段命中：陈旧自装钩子被刷新（不再跳过）', r.hooks.installed.some((s) => s.includes('pre-commit')), JSON.stringify(r.hooks));
  check('④b 插件名路径段命中：刷新后 baked 路径回到现存脚本', !after.includes('old-plugin-cache') && after.includes('check-loop.mjs'), after.slice(0, 200));
  check('④b 插件名路径段命中：刷新原因写进 skipped（可审计）', r.hooks.skipped.some((s) => s.includes('覆盖刷新')), JSON.stringify(r.hooks.skipped));
  // 形态二「版本目录布局（旧版本号目录）升版形态」：宿主缓存 <cache>/<市场>/<插件名>/<版本>/，
  // 升版后旧钩子 baked 的是旧版本目录——判据须靠插件名段命中，而不是比对当前版本号
  const staleVer = path.join(root, 'host-cache', 'market', PLUGIN_NAME, '0.1.10', 'scripts', 'check-loop.mjs');
  const patchedVer = after.replace(/(const\s+ENGINE_SCRIPT\s*=\s*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(staleVer)}`);
  fs.writeFileSync(pre, patchedVer, 'utf8');
  const r2 = initEngine(root);
  const after2 = fs.readFileSync(pre, 'utf8');
  check('④b 版本目录布局升版形态：旧版本目录钩子被刷新（basename 版本号判据的死态）',
    r2.hooks.installed.some((s) => s.includes('pre-commit')), JSON.stringify(r2.hooks));
  check('④b 版本目录布局升版形态：刷新后 baked 路径回到现存脚本',
    !after2.includes('host-cache') && after2.includes('check-loop.mjs'), after2.slice(0, 200));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④c 反例：`-old` 后缀目录不是本插件路径形态 → 不误刷（2026-11-05）----
// 自装判据带分隔符边界（按分隔符切分后整段相等）：`ai-native-delivery-old` 这类后缀目录不算
// 本插件路径形态，其钩子（哪怕是失效的）仍按"别人装的钩子不覆盖"处理。
{
  const root = mkRepo();
  const pre = path.join(root, '.git', 'hooks', 'pre-commit');
  initEngine(root);
  const before = fs.readFileSync(pre, 'utf8');
  const staleOld = path.join(root, 'old-plugin-cache', `${PLUGIN_NAME}-old`, '0.1.10', 'scripts', 'check-loop.mjs');
  const patched = before.replace(/(const\s+ENGINE_SCRIPT\s*=\s*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(staleOld)}`);
  fs.writeFileSync(pre, patched, 'utf8');
  const r = initEngine(root);
  const after = fs.readFileSync(pre, 'utf8');
  check('④c `-old` 后缀目录钩子不误刷（保持不覆盖用户钩子语义）',
    after === patched && r.hooks.skipped.some((s) => s.includes('pre-commit') && s.includes('不覆盖')), JSON.stringify(r.hooks));
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

// ---- ⑥ 编排脚本种子落位（2026-10-27 插件化修复）：落 .agents/pipelines/，不落 .agents/config/pipelines/ ----
// 落位口径单源：_TEMPLATE.md 头注 + workflows-check.mjs 扫描面 + autonomous-run skill 三处同源；
// 修复前落 .agents/config/pipelines/，导致编排机器门扫 0 份文件恒报绿（假绿）。
{
  const root = mkRepo();
  const r = initEngine(root);
  check('⑥ 编排种子落 .agents/pipelines/', fs.existsSync(path.join(root, '.agents', 'pipelines', '_TEMPLATE.md'))
    && fs.existsSync(path.join(root, '.agents', 'pipelines', 'pipeline-closing.md')),
    JSON.stringify(r.created.filter((c) => c.includes('pipelines'))));
  check('⑥ 编排种子不在 .agents/config/pipelines/', !fs.existsSync(path.join(root, '.agents', 'config', 'pipelines')));
  check('⑥ 编排机器门扫得到编排脚本（不再 0 份恒绿）', (() => {
    const r2 = spawnSync(process.execPath, [path.join(TEST_DIR, '..', 'scripts', 'workflows-check.mjs'), '--root', root], { encoding: 'utf8' });
    return r2.status === 0 && /编排脚本 [1-9]/.test(r2.stdout || '');
  })());
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ worktree 内初始化不崩（2026-10-27 插件化修复）----
// worktree 下 .git 是**文件**不是目录：修复前直接拼 <root>/.git/hooks → mkdir 抛 ENOTDIR，整个初始化崩在最后一步。
{
  const main = mkRepo();
  spawnSync(GIT, ['config', 'user.email', 't@t'], { cwd: main });
  spawnSync(GIT, ['config', 'user.name', 't'], { cwd: main });
  spawnSync(GIT, ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
  const wt = path.join(path.dirname(main), `init-engine-wt-${path.basename(main)}`);
  const add = spawnSync(GIT, ['worktree', 'add', '-q', wt, '-b', 'feat'], { cwd: main, encoding: 'utf8' });
  if (add.status !== 0) {
    check('⑦ worktree 夹具创建（跳过：环境不支持）', true, add.stderr);
  } else {
    check('⑦ worktree 内 .git 是文件', !fs.statSync(path.join(wt, '.git')).isDirectory());
    const r = spawnSync(process.execPath, [INIT, '--root', wt], { encoding: 'utf8' });
    check('⑦ worktree 内 init exit 0（不 ENOTDIR 崩）', r.status === 0, `exit=${r.status} ${r.stderr}`);
    check('⑦ worktree 内种子落位完整', fs.existsSync(path.join(wt, '.agents', 'config', 'engine.json'))
      && fs.existsSync(path.join(wt, '.agents', 'pipelines', '_TEMPLATE.md')));
    // 钩子应落在 git 公共钩子目录（worktree 与主仓共享），而非 worktree/.git/hooks（不存在）
    const hooksPath = spawnSync(GIT, ['rev-parse', '--git-path', 'hooks'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
    const absHooks = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(wt, hooksPath);
    check('⑦ 钩子落 git 公共钩子目录', fs.existsSync(path.join(absHooks, 'pre-commit')), `hooks=${absHooks}`);
    spawnSync(GIT, ['worktree', 'remove', '--force', wt], { cwd: main });
  }
  fs.rmSync(main, { recursive: true, force: true });
}

// ---- ⑧ 项目 engine.json 缺 policyVersion → WARN 文案点名缺键而非 undefined（2026-11-05 市场审查）----
// Number(undefined)=NaN 恒 ≠ 种子版本，WARN 照触发——但旧文案打出 policyVersion=undefined，
// 把「键缺失」伪装成「版本号为 undefined」。policy.mjs 对缺键按 v1 基线执法，文案须与此对齐。
{
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const custom = path.join(root, '.agents', 'config', 'engine.json');
  fs.writeFileSync(custom, JSON.stringify({ convergenceCommands: [] }), 'utf8');
  const r = initEngine(root);
  const w = r.warnings.find((x) => x.includes('engine.json'));
  check('⑧ 缺 policyVersion → WARN 触发', Boolean(w), JSON.stringify(r.warnings));
  check('⑧ WARN 文案点名缺 policyVersion（不出现 undefined）', Boolean(w) && w.includes('缺 policyVersion') && !w.includes('undefined'), w);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ 钩子引擎脚本缺席 → fail-closed 不变、stderr 无 MODULE_NOT_FOUND 栈（2026-11-05 市场审查）----
// 旧模板先 spawn 再判缺席：node 先吐满屏 MODULE_NOT_FOUND 栈，修复指引淹没在噪音里。改为 spawn 前
// existsSync 预检——退出码与指引文本不变（fail-closed），只消噪音。pre-push 同模板，改一处即两处同款。
{
  const root = mkRepo();
  initEngine(root);
  const pre = path.join(root, '.git', 'hooks', 'pre-commit');
  const stale = path.join(root, 'gone', 'check-loop.mjs');
  const body = fs.readFileSync(pre, 'utf8').replace(/(const\s+ENGINE_SCRIPT\s*=\s*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(stale)}`);
  fs.writeFileSync(pre, body, 'utf8');
  const r = spawnSync(process.execPath, [pre], { encoding: 'utf8' });
  check('⑨ 钩子 fail-closed：exit 1 + 指引在 stderr', r.status === 1 && /无法启动闭环扫描/.test(r.stderr), `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
  check('⑨ stderr 无 MODULE_NOT_FOUND 栈噪音', !/MODULE_NOT_FOUND|Cannot find module/.test(r.stderr || ''), (r.stderr || '').slice(0, 200));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑩ 机制台账项目自治（2026-11 F4 步骤 A3）：项目侧已存在 registry → 不覆盖（与 engine.json 同口径）----
// init 只首拷一次；装户在种子上改的行（状态/最近触发/处置期限）不受插件升版侵蚀——这正是
// retire-watch / 检查 22 回退链「项目侧优先、种子仅兜底」的自治语义（设计稿开放问题 2 推荐语义）。
{
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const custom = path.join(root, '.agents', 'config', 'mechanism-registry.md');
  fs.writeFileSync(custom, '# 项目自治台账（不覆盖实证）\n', 'utf8');
  const r = initEngine(root);
  check('⑩ 项目侧已存在 mechanism-registry.md 不覆盖', fs.readFileSync(custom, 'utf8').includes('项目自治台账'));
  check('⑩ 已存在 registry 列入 skipped 清单', r.skipped.some((s) => s.includes('mechanism-registry')), JSON.stringify(r.skipped));
  fs.rmSync(root, { recursive: true, force: true });
}

// 汇总 + 退出码（2026-10-27 修复：本文件此前无汇总、无 process.exit——断言全挂也返回 0，CI 永不红）
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
