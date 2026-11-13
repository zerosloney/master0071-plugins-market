#!/usr/bin/env node
// install.test.mjs — plan/apply 两段式安装引擎 + sha256 安装台账可测化（2026-11 安装引擎重构）
// 黑盒：mkdtemp 临时 git 仓 spawn 真实 CLI（同 init.test.mjs 手法）。断言：
//       ①全新安装 → 台账生成且哈希可对上（CRLF 归一口径；钩子记渲染后正文；键一律 / 分隔；
//         gitignore 标记块不入账也不被写进块）；②重跑幂等（零 create/update/conflict，台账字节
//         不重写，全树快照零改动）；③模拟插件升版（临时副本插件树改种子——副本的 scripts 派生
//         自己的 PLUGIN_ROOT，正好构成"上游种子变更"）→ 命中 update 且台账随升版；④用户改已装
//         文件 → conflict skip 且内容与台账基线都不动；⑤--force 覆盖；⑥领养模式（正常安装后删
//         台账重跑）→ adopted 且用户改动不覆盖、现状哈希入账；⑦--dry-run 对已装/空仓项目零写盘
//        （跑前后全树快照比对，台账不落）；⑧config-templates/ci/ 不进种子（L-ci 模板是项目
//        适配参考件）+ 模板 YAML 静态夹具（零依赖子集解析）。
// 零依赖，Node ≥ 18 直接运行：node test/install.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT } from '../scripts/paths.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(TEST_DIR, '..', 'scripts', 'init-engine.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const PLUGIN = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'install-engine-'));
  spawnSync(GIT, ['init', '-q'], { cwd: d });
  return d;
};
const runCli = (root, extra = [], initPath = INIT) =>
  spawnSync(process.execPath, [initPath, '--root', root, ...extra], { encoding: 'utf8' });
const manifestOf = (root) => path.join(root, '.agents', 'install-manifest.json');
const readManifest = (root) => JSON.parse(fs.readFileSync(manifestOf(root), 'utf8'));

// 哈希口径与实现同源：CRLF→LF 归一后 sha256（黑盒复算，不 import 安装段内部函数）
const normHash = (p) => createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

// 快照：relPath → {dir, size, mtimeMs, hash}（目录只记 dir 标志）——init 不跑 git 命令，
// .git 除 hooks 外不被触碰，整树可比（含台账文件的 mtime，锁「零写盘」）。
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

// ---- ① 全新安装：台账生成、哈希可对上、键 posix、gitignore 双向隔离 ----
{
  const root = mkRepo();
  const r = runCli(root);
  check('① 首装 exit 0 且输出新建清单', r.status === 0 && /新建 \d+ 项/.test(r.stdout), `exit=${r.status} ${r.stderr}`);
  check('① 台账文件生成', fs.existsSync(manifestOf(root)));
  const m = readManifest(root);
  check('① 台账形状 plugin/version/files（plugin.json 单源）',
    m.plugin === PLUGIN.name && m.version === PLUGIN.version && m.files && typeof m.files === 'object', JSON.stringify({ plugin: m.plugin, version: m.version }));
  check('① 台账键一律 / 分隔（无反斜杠）', Object.keys(m.files).every((k) => !k.includes('\\')), Object.keys(m.files).filter((k) => k.includes('\\')).join(', '));
  check('① 种子件哈希可对上（CRLF 归一口径）',
    m.files['.agents/config/engine.json'] === normHash(path.join(root, '.agents', 'config', 'engine.json'))
    && m.files['.agents/settings.json'] === normHash(path.join(root, '.agents', 'settings.json')));
  // 运行时账本（workflow/ 骨架文档 + 三本审计账主账）：引擎与用户共同写入 → 台账只追踪存在性，
  // 不按哈希判定（自举实证：引擎重生成 INDEX/metrics 后 doctor 恒红、init 永远误判冲突）
  check('① 运行时账本只追踪存在性（mutable 标记）',
    m.files['workflow/INDEX.md'] && m.files['workflow/INDEX.md'].mutable === true
    && m.files['.agents/confirmations.jsonl'] && m.files['.agents/confirmations.jsonl'].mutable === true);
  check('① git hooks 记渲染后正文哈希',
    m.files['.git/hooks/pre-commit'] === normHash(path.join(root, '.git', 'hooks', 'pre-commit'))
    && m.files['.git/hooks/pre-push'] === normHash(path.join(root, '.git', 'hooks', 'pre-push')));
  // post-commit（2026-11-11 Dreaming 移植）：同一 githook kind 与占位符实化机制——台账记渲染后哈希；
  // 种子不含 @@ENGINE_SCRIPT@@ 也要能渲染（DREAM_SCRIPT 实化，无带引号遗留占位符）。
  check('① post-commit 安装且记渲染后正文哈希',
    m.files['.git/hooks/post-commit'] === normHash(path.join(root, '.git', 'hooks', 'post-commit')));
  const postBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'post-commit'), 'utf8');
  check('① post-commit 渲染：DREAM_SCRIPT 实化、无遗留可执行占位符、不依赖 ENGINE_SCRIPT',
    /const DREAM_SCRIPT = ".+dream-run\.mjs";/.test(postBody) && !/"@@[A-Z_]+@@"/.test(postBody) && !postBody.includes('ENGINE_SCRIPT'),
    postBody.split('\n').find((l) => l.includes('DREAM_SCRIPT =')) || postBody.slice(0, 200));
  // pre-commit / pre-push 新占位符实化（2026-11-12 接线收尾）：装出的钩子无带引号残留占位符；
  // DOC_BODY_DRIFT_SCRIPT / HOOK_WIRING_SCRIPT 实化路径有效（提取 JSON 字面量 → existsSync）。
  const hookScriptOf = (body, varName) => {
    const m = new RegExp('const ' + varName + ' = "((?:[^"\\\\]|\\\\.)*)"').exec(body);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  };
  const preCommitBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
  const driftScript = hookScriptOf(preCommitBody, 'DOC_BODY_DRIFT_SCRIPT');
  check('① pre-commit 渲染：无残留占位符，DOC_BODY_DRIFT_SCRIPT 实化为有效脚本路径',
    !/"@@[A-Z_]+@@"/.test(preCommitBody) && Boolean(driftScript) && fs.existsSync(driftScript)
    && driftScript.endsWith('check-doc-body-drift.mjs'),
    preCommitBody.split('\n').find((l) => l.includes('DOC_BODY_DRIFT_SCRIPT =')) || '未提取到 DOC_BODY_DRIFT_SCRIPT');
  const prePushBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-push'), 'utf8');
  const wiringScript = hookScriptOf(prePushBody, 'HOOK_WIRING_SCRIPT');
  check('① pre-push 渲染：无残留占位符，HOOK_WIRING_SCRIPT 实化为有效脚本路径',
    !/"@@[A-Z_]+@@"/.test(prePushBody) && Boolean(wiringScript) && fs.existsSync(wiringScript)
    && wiringScript.endsWith('check-hook-wiring.mjs'),
    prePushBody.split('\n').find((l) => l.includes('HOOK_WIRING_SCRIPT =')) || '未提取到 HOOK_WIRING_SCRIPT');
  // commit-msg（2026-11-12 L0/L1 快速道移植）：同一 githook kind 渲染——CONFIRM_ORDER_SCRIPT（gate 腿）
  // 与 PLAN_REF_SCRIPT（advisory 腿）实化为有效脚本路径，无带引号遗留占位符；SCOPE_RANGE_SCRIPT 同批。
  const commitMsgBody = fs.readFileSync(path.join(root, '.git', 'hooks', 'commit-msg'), 'utf8');
  const cmConfirm = hookScriptOf(commitMsgBody, 'CONFIRM_ORDER_SCRIPT');
  const cmPlanRef = hookScriptOf(commitMsgBody, 'PLAN_REF_SCRIPT');
  check('① commit-msg 安装且记渲染后正文哈希',
    m.files['.git/hooks/commit-msg'] === normHash(path.join(root, '.git', 'hooks', 'commit-msg')));
  check('① commit-msg 渲染：无残留占位符，CONFIRM_ORDER_SCRIPT / PLAN_REF_SCRIPT 实化为有效脚本路径',
    !/"@@[A-Z_]+@@"/.test(commitMsgBody) && Boolean(cmConfirm) && fs.existsSync(cmConfirm)
    && cmConfirm.endsWith('check-confirm-order.mjs')
    && Boolean(cmPlanRef) && fs.existsSync(cmPlanRef) && cmPlanRef.endsWith('check-commit-plan-ref.mjs'),
    commitMsgBody.split('\n').find((l) => l.includes('CONFIRM_ORDER_SCRIPT =')) || '未提取到 CONFIRM_ORDER_SCRIPT');
  const cmScopeRange = hookScriptOf(prePushBody, 'SCOPE_RANGE_SCRIPT');
  check('① pre-push 渲染：SCOPE_RANGE_SCRIPT 实化为有效脚本路径',
    Boolean(cmScopeRange) && fs.existsSync(cmScopeRange) && cmScopeRange.endsWith('check-scope-range.mjs'),
    prePushBody.split('\n').find((l) => l.includes('SCOPE_RANGE_SCRIPT =')) || '未提取到 SCOPE_RANGE_SCRIPT');
  // commit-msg-rules.json 种子安装进 .agents/config/（planSlugRe 短名边界模板单源；
  // exemptPrefix 含 git 自带 squash 模板首行——69ece3f46「squash 消息豁免」半件回补回归）。
  const rulesPath = path.join(root, '.agents', 'config', 'commit-msg-rules.json');
  let rules = null;
  try { rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')); } catch { /* 缺件/损坏 */ }
  check('① commit-msg-rules.json 安装进 .agents/config/ 且 planSlugRe 在场',
    Boolean(rules) && m.files['.agents/config/commit-msg-rules.json'] === normHash(rulesPath)
    && typeof rules.planSlugRe === 'string' && rules.planSlugRe.includes('<slug>'),
    `rules=${JSON.stringify(rules && { planSlugRe: rules.planSlugRe })}`);
  check('① 种子 exemptPrefix 豁免 git 自带 squash 模板首行（Squashed commit of the following:）',
    Boolean(rules) && new RegExp(rules.exemptPrefix).test('Squashed commit of the following:'),
    JSON.stringify(rules && rules.exemptPrefix));
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  check('① 台账文件不被写进 .gitignore 标记块（入库共享，同 lock 语义）', !gitignore.includes('install-manifest'), gitignore);
  check('① gitignore 标记块不入台账（块级合并不是整文件）', !Object.keys(m.files).some((k) => k.includes('.gitignore')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② 重跑幂等：零 create/update/conflict，台账字节不重写，全树快照零改动 ----
{
  const root = mkRepo();
  runCli(root);
  const mBytes = fs.readFileSync(manifestOf(root), 'utf8');
  const snap1 = snapshot(root);
  const r = runCli(root);
  const snap2 = snapshot(root);
  check('② 重跑 exit 0 且零新建', r.status === 0 && /新建 0 项/.test(r.stdout), `exit=${r.status} ${r.stderr}`);
  check('② 重跑零更新零冲突', !/更新 \d/.test(r.stdout) && !/冲突/.test(r.stdout), r.stdout);
  check('② 全树快照零改动（幂等）', snapDiff(snap1, snap2).length === 0, snapDiff(snap1, snap2).join(', '));
  check('② 台账字节不重写（内容一致不落盘）', fs.readFileSync(manifestOf(root), 'utf8') === mBytes);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 模拟插件升版：临时副本插件树改种子 → 重跑命中 update（台账随升版）----
// 副本手法：paths.mjs 的 PLUGIN_ROOT 从 import.meta.url 派生——副本的 init-engine 自带副本根，
// 改副本 config-templates 种子即构成「上游种子变更」，不触真实插件树（黑盒、可复现）。
{
  const tmpPlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'install-engine-copy-'));
  fs.cpSync(PLUGIN_ROOT, tmpPlugin, { recursive: true, filter: (src) => {
    const rel = path.relative(PLUGIN_ROOT, src);
    return !['test', 'mcp', '.git', '.codex-plugin', 'node_modules'].includes(rel.split(path.sep)[0]);
  } });
  const INIT_COPY = path.join(tmpPlugin, 'scripts', 'init-engine.mjs');
  const root = mkRepo();
  const a = runCli(root, [], INIT_COPY);
  check('③ 副本插件首装 exit 0', a.status === 0, `exit=${a.status} ${a.stderr}`);
  const seed = path.join(tmpPlugin, 'config-templates', 'principles.md');
  fs.writeFileSync(seed, `${fs.readFileSync(seed, 'utf8')}\n<!-- install-test 升版标记 -->\n`, 'utf8');
  const target = path.join(root, '.agents', 'config', 'principles.md');
  const r = runCli(root, [], INIT_COPY);
  check('③ 升版重跑 exit 0', r.status === 0, `exit=${r.status} ${r.stderr}`);
  check('③ 命中 update 且点名该文件（无冲突）', /更新 1 项/.test(r.stdout) && r.stdout.includes('.agents/config/principles.md') && !r.stdout.includes('冲突'), r.stdout);
  check('③ 目标文件已更新到新种子', fs.readFileSync(target, 'utf8').includes('升版标记'));
  check('③ 台账哈希随升版更新', readManifest(root).files['.agents/config/principles.md'] === normHash(seed));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmpPlugin, { recursive: true, force: true });
}

// ---- ④ 用户改已装文件 → conflict skip：内容不动、台账基线不动 ----
{
  const root = mkRepo();
  runCli(root);
  const target = path.join(root, '.agents', 'config', 'principles.md');
  fs.appendFileSync(target, '\n<!-- 用户自定义标记 -->\n');
  const before = fs.readFileSync(target, 'utf8');
  const mBefore = readManifest(root).files['.agents/config/principles.md'];
  const r = runCli(root);
  check('④ exit 0 且冲突点名该文件', r.status === 0 && /冲突跳过 \d+ 项/.test(r.stdout) && r.stdout.includes('principles.md'), `exit=${r.status} ${r.stderr}`);
  check('④ 用户改动不被覆盖', fs.readFileSync(target, 'utf8') === before);
  check('④ 台账基线不被冲突改写', readManifest(root).files['.agents/config/principles.md'] === mBefore);
  // ---- ⑤（续同一仓）--force 覆盖用户改动并回写台账 ----
  const seed = path.join(PLUGIN_ROOT, 'config-templates', 'principles.md');
  const r2 = runCli(root, ['--force']);
  check('⑤ --force exit 0 且覆盖点名该文件', r2.status === 0 && /--force/.test(r2.stdout) && r2.stdout.includes('principles.md'), `exit=${r2.status} ${r2.stderr}`);
  check('⑤ 文件被覆盖回种子原文', fs.readFileSync(target, 'utf8') === fs.readFileSync(seed, 'utf8'));
  check('⑤ 台账对齐种子哈希', readManifest(root).files['.agents/config/principles.md'] === normHash(seed));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥ 领养模式：正常安装后删台账重跑 → adopted，用户改动不覆盖、现状哈希入账 ----
{
  const root = mkRepo();
  runCli(root);
  const metrics = path.join(root, 'workflow', 'metrics.md');
  fs.appendFileSync(metrics, '\n<!-- 用户既有改动 -->\n');
  const userContent = fs.readFileSync(metrics, 'utf8');
  fs.rmSync(manifestOf(root));
  const r = runCli(root);
  check('⑥ exit 0 且领养计数非零', r.status === 0 && /领养 [1-9]\d* 项/.test(r.stdout), `exit=${r.status} ${r.stderr}`);
  check('⑥ 领养零新建（现状全保留）', /新建 0 项/.test(r.stdout), r.stdout);
  check('⑥ 用户改动不被覆盖', fs.readFileSync(metrics, 'utf8') === userContent);
  const m = readManifest(root);
  check('⑥ 用户改动的运行时账本按 mutable 入账（不按哈希判冲突）', m.files['workflow/metrics.md'] && m.files['workflow/metrics.md'].mutable === true);
  check('⑥ 未改动种子件现状入账', m.files['.agents/config/engine.json'] === normHash(path.join(root, '.agents', 'config', 'engine.json')));
  check('⑥ 已装钩子现状入账（不覆盖用户钩子）', m.files['.git/hooks/pre-commit'] === normHash(path.join(root, '.git', 'hooks', 'pre-commit')));
  check('⑥ 台账 plugin/version 回填', m.plugin === PLUGIN.name && m.version === PLUGIN.version);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥b 运行时账本被改写后重跑 init：走 mutable 通道（不报冲突、不覆盖内容）----
{
  const root = mkRepo();
  runCli(root);
  const metrics = path.join(root, 'workflow', 'metrics.md');
  fs.appendFileSync(metrics, '\n<!-- 引擎重生成后的内容 -->\n');
  const edited = fs.readFileSync(metrics, 'utf8');
  const r = runCli(root);
  const m = readManifest(root);
  check('⑥b 运行时账本改写后不报冲突', r.status === 0 && !/冲突/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('⑥b 运行时账本内容不被覆盖', fs.readFileSync(metrics, 'utf8') === edited);
  check('⑥b 台账仍按 mutable 追踪', m.files['workflow/metrics.md'] && m.files['workflow/metrics.md'].mutable === true);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ --dry-run 零写盘：已装仓（含用户改动）与空仓，跑前后全树快照比对 ----
{
  const root = mkRepo();
  runCli(root);
  fs.appendFileSync(path.join(root, '.agents', 'config', 'principles.md'), '\n<!-- 用户自定义标记 -->\n');
  runCli(root); // 冲突态落定（本轮零写盘）
  const snap1 = snapshot(root);
  const r = runCli(root, ['--dry-run']);
  const snap2 = snapshot(root);
  check('⑦ dry-run exit 0 且带试运行标记', r.status === 0 && /dry-run/.test(r.stdout), `exit=${r.status} ${r.stderr}`);
  check('⑦ dry-run 如实报冲突（不写盘也裁决）', /冲突跳过 \d+ 项/.test(r.stdout) && r.stdout.includes('principles.md'), r.stdout);
  check('⑦ dry-run 全树快照零改动（含台账 mtime）', snapDiff(snap1, snap2).length === 0, snapDiff(snap1, snap2).join(', '));

  const empty = mkRepo();
  const snap3 = snapshot(empty);
  const r2 = runCli(empty, ['--dry-run']);
  const snap4 = snapshot(empty);
  check('⑦b 空仓 dry-run exit 0 且报新建', r2.status === 0 && /新建 [1-9]\d* 项/.test(r2.stdout), `exit=${r2.status} ${r2.stderr}`);
  check('⑦b 空仓 dry-run 零写盘（含台账不落）', snapDiff(snap3, snap4).length === 0 && !fs.existsSync(manifestOf(empty)), snapDiff(snap3, snap4).join(', '));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
}

// ---- ⑧ config-templates/ci/ 不进种子：L-ci 模板是项目适配参考件，init 不装、台账不追平 ----
{
  const root = mkRepo();
  const r = runCli(root);
  check('⑧ 首装 exit 0', r.status === 0, `exit=${r.status} ${r.stderr}`);
  const configDir = path.join(root, '.agents', 'config');
  const entries = fs.readdirSync(configDir);
  check('⑧ 装出的 .agents/config/ 不含 ci/（模板随插件分发，非运行配置种子）',
    !entries.includes('ci') && !fs.existsSync(path.join(configDir, 'ci')), entries.join(', '));
  const m = readManifest(root);
  check('⑧ 安装台账无 .agents/config/ci/ 键（不被台账追平）',
    !Object.keys(m.files).some((k) => k.startsWith('.agents/config/ci/')),
    Object.keys(m.files).filter((k) => k.startsWith('.agents/config/ci/')).join(', '));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ ci 模板静态夹具：零依赖 YAML 子集解析（缩进/嵌套/块标量），模板必须可解析成预期结构 ----
// 只覆盖模板用到的构造（全行注释、嵌套映射、块序列、flow 序列、| 块标量、引号标量）——
// 缩进错位 / tab / 断键这类常见 YAML 语法损伤会让解析或结构断言变红。零依赖，不引第三方解析器。
{
  const tplPath = path.join(PLUGIN_ROOT, 'config-templates', 'ci', 'github-actions-verify.yml.template');
  check('⑨ ci 模板在位', fs.existsSync(tplPath));
  const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf8') : '';
  const parseYamlSubset = (text) => {
    if (/^\t/im.test(text)) throw new Error('缩进含 tab');
    const lines = text.split(/\r?\n/)
      .map((l, idx) => ({ text: l, no: idx + 1 }))
      .filter((l) => { const t = l.text.trim(); return t !== '' && !t.startsWith('#'); });
    let i = 0;
    const indentOf = (l) => l.text.match(/^ */)[0].length;
    const stripQuotes = (s) => {
      s = s.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
      return s;
    };
    const parseScalar = (s) => {
      s = s.trim();
      if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(stripQuotes).filter((x) => x !== '');
      return stripQuotes(s);
    };
    const parseMap = (indent) => {
      const obj = {};
      while (i < lines.length) {
        const cur = lines[i];
        const ci = indentOf(cur);
        if (ci < indent) break;
        if (ci > indent) throw new Error(`第 ${cur.no} 行缩进越级: ${cur.text.trim()}`);
        const m = cur.text.slice(indent).match(/^([^:]+):(?:[ ]+(.*))?$/);
        if (!m) throw new Error(`第 ${cur.no} 行不是 key: value 形态: ${cur.text.trim()}`);
        const key = m[1].trim();
        const rest = (m[2] || '').trim();
        i++;
        if (rest === '|' || rest === '|-') {
          const buf = [];
          while (i < lines.length && indentOf(lines[i]) > indent) { buf.push(lines[i].text.slice(indent + 2)); i++; }
          obj[key] = buf.join('\n');
        } else if (rest === '') {
          if (i < lines.length && indentOf(lines[i]) > indent) { obj[key] = parseBlock(indentOf(lines[i])); continue; }
          obj[key] = null;
        } else {
          obj[key] = parseScalar(rest);
        }
      }
      return obj;
    };
    const parseSeq = (indent) => {
      const seq = [];
      while (i < lines.length) {
        const cur = lines[i];
        const ci = indentOf(cur);
        if (ci < indent) break;
        if (ci > indent) throw new Error(`第 ${cur.no} 行缩进越级: ${cur.text.trim()}`);
        const m = cur.text.slice(indent).match(/^-(?:[ ]+(.*))?$/);
        if (!m) throw new Error(`第 ${cur.no} 行不是序列项: ${cur.text.trim()}`);
        const rest = (m[1] || '').trim();
        if (rest === '') { i++; seq.push(parseBlock(indent + 2)); continue; }
        // 行内首键当作虚位更深行（dash 缩进 + 2，标准两空格对齐），与其余更深层一起解析
        lines[i] = { text: ' '.repeat(ci + 2) + rest, no: cur.no };
        seq.push(parseBlock(ci + 2));
      }
      return seq;
    };
    const parseBlock = (indent) => (/^\s*- /.test(lines[i].text) ? parseSeq(indent) : parseMap(indent));
    const doc = parseBlock(indentOf(lines[0]));
    if (i !== lines.length) throw new Error(`第 ${lines[i].no} 行未被消费（缩进结构断裂）`);
    return doc;
  };
  let doc = null;
  let parseErr = '';
  try { doc = tpl ? parseYamlSubset(tpl) : null; } catch (e) { parseErr = e.message; }
  check('⑨ 模板可被零依赖 YAML 子集解析器完整解析（缩进/嵌套/块标量）', doc !== null, parseErr);
  if (doc) {
    const job = doc.jobs && doc.jobs.governance;
    const steps = job && job.steps;
    check('⑨ 结构完整：steps 含 check-loop / verify 无模型步（run 命令带 PLUGIN_ROOT 占位）',
      Array.isArray(steps)
      && steps.some((s) => typeof s.run === 'string' && s.run.includes('check-loop.mjs'))
      && steps.some((s) => typeof s.run === 'string' && s.run.includes('verify.mjs'))
      && steps.every((s) => typeof s !== 'string'),
      JSON.stringify(doc.jobs && Object.keys(doc.jobs)));
    const matrix = job && job.strategy && job.strategy.matrix;
    check('⑨ 双系统 matrix（ubuntu + windows）与 env.PLUGIN_ROOT 在场',
      Boolean(matrix) && Array.isArray(matrix.os) && matrix.os.includes('ubuntu-latest') && matrix.os.includes('windows-latest')
      && Boolean(doc.env) && typeof doc.env.PLUGIN_ROOT === 'string' && doc.env.PLUGIN_ROOT !== '');
  }
  // 护栏（全局约束机器化）：无盘符绝对路径、无密钥样例值、可选诊断步必须整段注释（无可执行模型调用行）
  check('⑨ 模板护栏：无绝对路径、无密钥样例值、claude -p 只存在于注释行',
    !/[A-Za-z]:[\\/]/.test(tpl)
    && !/ghp_|github_pat_|sk-[A-Za-z0-9]|AKIA|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/.test(tpl)
    && !/^(?!\s*#).*claude\s+-p/m.test(tpl));
}

// 汇总 + 退出码（同 init.test.mjs 口径：断言全挂必须让进程退出码变红）
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
