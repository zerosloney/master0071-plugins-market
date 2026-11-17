#!/usr/bin/env node
// install-upgrade.test.mjs — 装户升级面正式测试全集（spec workflow/specs/2026-11-17-install-upgrade-0315.md
// 验收判据表 1–7 行 → A1..A6；0.3.15 基线三方合并 + manifest 迁移 + 漂移体检 + prune）
// 黑盒：mkdtemp 临时 git 仓 spawn 真实 CLI（同 install.test.mjs 手法）；种子升版用临时副本插件树改种子
//（副本 scripts 派生自己的 PLUGIN_ROOT，构成「上游种子变更」，同 install.test.mjs ③）。断言：
//   ① A1 merged：用户改+种子改+基线在场 → clean 三方合并落盘（LF）、报告「合并」清单、台账记种子侧哈希、
//      基线=新种子正文；二次跑（种子未变）合并内容不丢且台账字节/全树快照零改动；种子再演进 → 以基线为
//      base 重合并成功（三层内容并存）；
//   ② A2 降级：真冲突（双方同区域改）→ conflict-skip 输出与内容/台账/基线零变化；git 不可用（CHECK_LOOP_GIT
//      注入不存在路径——git-core 同款测试注入点，baseline.mjs 复用其 GIT 常量）→ unavailable 回退 skip 不炸；
//      --force 整覆盖且优先于合并（同几何本可 clean 合并）、覆盖后基线随写；
//   ③ A3 旁路：mutable 条目改写不报冲突、不写基线；用户改钩子 → 不覆盖语义不变；钩子/mutable 条目基线面零文件；
//   ④ A4 迁移：migrateManifest 单元三态（0→1 补 schemaVersion 且 files 原样 / 已是 1 changed=false /
//      schemaVersion:99 抛 MANIFEST_SCHEMA）；CLI 旧台账剥 schemaVersion → 一次性迁到 1、二跑字节逐字节不动；
//      CLI schemaVersion:99 → 非零退出且零落盘；首装台账即带 schemaVersion:1（列首键）且二跑字节不动；
//   ⑤ A5 幂等：全量 mtime/字节快照二次 init 零改动（含 .install-baseline/ 基线目录）；gitignore 标记块
//      基线条目幂等（重复 init 不重复追加）；
//   ⑥ A6a drift：六类各 fixture 断言分类与计数（含基线在场/无基线两标注）、mutable 恒 unchanged、
//      无台账 → 单行提示恒 exit 0、只读零写盘（全树快照）；
//   ⑦ A6b prune：孤儿哈希一致真删 + 台账行清 + 无主基线连清；改过/mutable/钩子（basename 与 hooksDir
//      前缀两口径）保留并报告；--prune --dry-run 零删；不带 --prune 零删除且输出无 prune 行。
// 零依赖，Node ≥ 18 直接运行：node test/install-upgrade.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT } from '../scripts/paths.mjs';
import { migrateManifest } from '../scripts/install/migrations.mjs';
import { CURRENT_SCHEMA_VERSION, newManifest } from '../scripts/install/manifest.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(TEST_DIR, '..', 'scripts', 'init-engine.mjs');
const DRIFT = path.join(TEST_DIR, '..', 'scripts', 'install-drift.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'install-upgrade-'));
  spawnSync(GIT, ['init', '-q'], { cwd: d });
  return d;
};
const runCli = (root, extra = [], initPath = INIT, env = undefined) =>
  spawnSync(process.execPath, [initPath, '--root', root, ...extra],
    env ? { encoding: 'utf8', env: { ...process.env, ...env } } : { encoding: 'utf8' });
const runDrift = (root) => spawnSync(process.execPath, [DRIFT, '--root', root], { encoding: 'utf8' });
const manifestOf = (root) => path.join(root, '.agents', 'install-manifest.json');
const readManifest = (root) => JSON.parse(fs.readFileSync(manifestOf(root), 'utf8'));

// 哈希口径与实现同源：CRLF→LF 归一后 sha256（黑盒复算，不 import 安装段内部函数——同 install.test.mjs）
const normHash = (p) => createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const hashStr = (s) => createHash('sha256').update(String(s).replace(/\r\n/g, '\n'), 'utf8').digest('hex');

// 快照：relPath → {dir, size, mtimeMs, hash}（同 install.test.mjs 口径——整树可比，含台账与基线的 mtime）
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

// 副本插件树（同 install.test.mjs ③ 手法）：probes 追加进副本 config-templates/ 的受控种子文件——
// buildPlan 全量走 config-templates → 追加文件即受控种子条目，内容与演进步进完全由测试把控。
const mkPluginCopy = (probes = {}) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-upgrade-copy-'));
  fs.cpSync(PLUGIN_ROOT, tmp, { recursive: true, filter: (src) => {
    const rel = path.relative(PLUGIN_ROOT, src);
    return !['test', 'mcp', '.git', '.codex-plugin', 'node_modules'].includes(rel.split(path.sep)[0]);
  } });
  for (const [name, body] of Object.entries(probes)) {
    fs.writeFileSync(path.join(tmp, 'config-templates', name), body, 'utf8');
  }
  return tmp;
};

// 基线面路径（黑盒复算：baseline.mjs baselinePath = <root>/.agents/.install-baseline/<targetRel>）
const baselineFile = (root, rel) => path.join(root, '.agents', '.install-baseline', ...String(rel).replace(/\\/g, '/').split('/'));
const listBaselineFiles = (root) => {
  const out = [];
  const base = path.join(root, '.agents', '.install-baseline');
  const walk = (abs) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
};

// 受控合并探针种子：用户改与种子演进落在相距 ≥3 行的异区域 → git merge-file 判 clean；
// A2 真冲突探针双方改同一行 → 判 conflict。几何即判据，注释不赘。
const PROBE = (name) => `# ${name}\nline-01\nline-02 alpha\nline-03 beta\nline-04 gamma\nline-05 delta\nline-06 tail\n`;
const CLEAN_SEED = PROBE('upgrade-clean');

// ---- ① A1 merged：clean 三方合并落盘 / 二次跑幂等 / 种子再演进重合并 ----
{
  const copy = mkPluginCopy({ 'upgrade-clean.md': CLEAN_SEED });
  const INIT_COPY = path.join(copy, 'scripts', 'init-engine.mjs');
  const seedFile = path.join(copy, 'config-templates', 'upgrade-clean.md');
  const root = mkRepo();
  const a = runCli(root, [], INIT_COPY);
  check('A1 前置：副本插件首装 exit 0', a.status === 0, `exit=${a.status} ${a.stderr}`);
  const target = path.join(root, '.agents', 'config', 'upgrade-clean.md');
  const v1 = fs.readFileSync(seedFile, 'utf8');
  check('A1 前置：首装落盘种子原文且基线=种子正文',
    fs.readFileSync(target, 'utf8') === v1
    && fs.readFileSync(baselineFile(root, '.agents/config/upgrade-clean.md'), 'utf8') === v1);
  // 用户改（line-02 区域）+ 种子升（line-05 区域）→ 异区域双改，merge-file clean
  fs.writeFileSync(target, v1.replace('line-02 alpha', 'line-02 alpha-user'), 'utf8');
  const v2 = v1.replace('line-05 delta', 'line-05 delta-v2');
  fs.writeFileSync(seedFile, v2, 'utf8');
  const r2 = runCli(root, [], INIT_COPY);
  const mergedBody = fs.readFileSync(target, 'utf8');
  check('A1 merged clean：exit 0 且报告「合并 1 项」点名该文件（三方合并自动落盘）',
    r2.status === 0 && /合并 1 项/.test(r2.stdout) && r2.stdout.includes('.agents/config/upgrade-clean.md') && r2.stdout.includes('三方合并'), `exit=${r2.status} ${r2.stdout} ${r2.stderr}`);
  check('A1 merged clean：合并结果同时含用户改动与种子升级', mergedBody.includes('alpha-user') && mergedBody.includes('delta-v2'), mergedBody);
  check('A1 merged clean：合并正文为 LF（merge 三方 IO 归一）', !mergedBody.includes('\r\n'));
  const mAfter = readManifest(root);
  check('A1 台账记种子侧哈希（非合并结果哈希——种子未变的重跑不得整覆盖用户合并内容）',
    mAfter.files['.agents/config/upgrade-clean.md'] === normHash(seedFile)
    && mAfter.files['.agents/config/upgrade-clean.md'] !== normHash(target),
    JSON.stringify({ ledger: mAfter.files['.agents/config/upgrade-clean.md'], seed: normHash(seedFile), disk: normHash(target) }));
  check('A1 基线写新种子正文（非合并结果——用户后续手改仍可与下轮演进再合并）',
    fs.readFileSync(baselineFile(root, '.agents/config/upgrade-clean.md'), 'utf8') === v2);
  // 二次跑（种子未变）：合并内容不丢、台账字节不动、全树零改动
  const bytes1 = fs.readFileSync(manifestOf(root), 'utf8');
  const snap1 = snapshot(root);
  const r3 = runCli(root, [], INIT_COPY);
  const snap2 = snapshot(root);
  check('A1 二次跑 exit 0', r3.status === 0, `exit=${r3.status} ${r3.stderr}`);
  check('A1 二次跑：合并内容不丢（用户改动仍在盘上）', fs.readFileSync(target, 'utf8') === mergedBody);
  check('A1 二次跑：台账字节不动', fs.readFileSync(manifestOf(root), 'utf8') === bytes1);
  check('A1 二次跑：全树快照零改动（含基线目录 mtime）', snapDiff(snap1, snap2).length === 0, snapDiff(snap1, snap2).join(', '));
  // 种子再演进（v3）：以基线（v2）为 base 重合并成功
  const v3 = `${v2}line-07 tail-v3\n`;
  fs.writeFileSync(seedFile, v3, 'utf8');
  const r4 = runCli(root, [], INIT_COPY);
  const merged3 = fs.readFileSync(target, 'utf8');
  check('A1 种子再演进：重合并 exit 0 且再次报告「合并 1 项」', r4.status === 0 && /合并 1 项/.test(r4.stdout), `exit=${r4.status} ${r4.stdout}`);
  check('A1 种子再演进：重合并结果三层并存（用户改动 + v2 + v3）', merged3.includes('alpha-user') && merged3.includes('delta-v2') && merged3.includes('tail-v3'), merged3);
  check('A1 种子再演进：台账对齐 v3 种子哈希、基线=v3 正文',
    readManifest(root).files['.agents/config/upgrade-clean.md'] === normHash(seedFile)
    && fs.readFileSync(baselineFile(root, '.agents/config/upgrade-clean.md'), 'utf8') === v3);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(copy, { recursive: true, force: true });
}

// ---- ② A2 降级：真冲突 conflict-skip / git 不可用 unavailable 回退 / --force 优先于合并 ----
{
  const copy = mkPluginCopy({
    'upgrade-conflict.md': PROBE('upgrade-conflict'),
    'upgrade-fallback.md': PROBE('upgrade-fallback'),
    'upgrade-force.md': PROBE('upgrade-force'),
  });
  const INIT_COPY = path.join(copy, 'scripts', 'init-engine.mjs');
  const seedOf = (name) => path.join(copy, 'config-templates', name);
  // —— 真冲突：双方同区域（同一行）改 → conflict → conflict-skip 语义与输出不变
  const rootC = mkRepo();
  runCli(rootC, [], INIT_COPY);
  const targetC = path.join(rootC, '.agents', 'config', 'upgrade-conflict.md');
  const v1c = fs.readFileSync(targetC, 'utf8');
  fs.writeFileSync(targetC, v1c.replace('line-03 beta', 'line-03 beta-user'), 'utf8');
  fs.writeFileSync(seedOf('upgrade-conflict.md'), v1c.replace('line-03 beta', 'line-03 beta-kit'), 'utf8');
  const beforeC = fs.readFileSync(targetC, 'utf8');
  const mBeforeC = readManifest(rootC).files['.agents/config/upgrade-conflict.md'];
  const baseBeforeC = fs.readFileSync(baselineFile(rootC, '.agents/config/upgrade-conflict.md'), 'utf8');
  const rc = runCli(rootC, [], INIT_COPY);
  check('A2 真冲突：exit 0 且冲突跳过点名该文件、无合并清单', rc.status === 0 && /冲突跳过 1 项/.test(rc.stdout) && rc.stdout.includes('upgrade-conflict.md') && !/合并 1 项/.test(rc.stdout), `exit=${rc.status} ${rc.stdout}`);
  check('A2 真冲突：用户改动不被覆盖（冲突标记不落盘）', fs.readFileSync(targetC, 'utf8') === beforeC);
  check('A2 真冲突：台账基线零变化', readManifest(rootC).files['.agents/config/upgrade-conflict.md'] === mBeforeC);
  check('A2 真冲突：基线保留不动（下轮种子演进可重试合并）', fs.readFileSync(baselineFile(rootC, '.agents/config/upgrade-conflict.md'), 'utf8') === baseBeforeC);
  fs.rmSync(rootC, { recursive: true, force: true });
  // —— git 不可用：CHECK_LOOP_GIT 注入不存在路径（git-core 同款注入点）→ merge unavailable → 回退 skip
  // 判据成立性：同几何在 git 可用时判 clean 合并（①已证），唯一差异是注入 → conflict-skip 即回退的直接证据。
  const rootU = mkRepo();
  runCli(rootU, [], INIT_COPY);
  const targetU = path.join(rootU, '.agents', 'config', 'upgrade-fallback.md');
  const v1u = fs.readFileSync(targetU, 'utf8');
  fs.writeFileSync(targetU, v1u.replace('line-02 alpha', 'line-02 alpha-user'), 'utf8');
  fs.writeFileSync(seedOf('upgrade-fallback.md'), v1u.replace('line-05 delta', 'line-05 delta-v2'), 'utf8');
  const beforeU = fs.readFileSync(targetU, 'utf8');
  const mBeforeU = readManifest(rootU).files['.agents/config/upgrade-fallback.md'];
  const ru = runCli(rootU, [], INIT_COPY, { CHECK_LOOP_GIT: path.join(rootU, 'defunct-git.exe') });
  check('A2 git 不可用：不炸不拦（exit 0）且回退冲突跳过', ru.status === 0 && /冲突跳过 1 项/.test(ru.stdout) && !/初始化失败/.test(ru.stderr), `exit=${ru.status} ${ru.stdout} ${ru.stderr}`);
  check('A2 git 不可用：内容与台账零变化', fs.readFileSync(targetU, 'utf8') === beforeU && readManifest(rootU).files['.agents/config/upgrade-fallback.md'] === mBeforeU);
  fs.rmSync(rootU, { recursive: true, force: true });
  // —— --force 整覆盖且优先于合并（同几何本可 clean 合并，覆盖即优先的证据），基线随写
  const rootF = mkRepo();
  runCli(rootF, [], INIT_COPY);
  const targetF = path.join(rootF, '.agents', 'config', 'upgrade-force.md');
  const v1f = fs.readFileSync(targetF, 'utf8');
  fs.writeFileSync(targetF, v1f.replace('line-02 alpha', 'line-02 alpha-user'), 'utf8');
  const v2f = v1f.replace('line-05 delta', 'line-05 delta-v2');
  fs.writeFileSync(seedOf('upgrade-force.md'), v2f, 'utf8');
  const rf = runCli(rootF, ['--force'], INIT_COPY);
  check('A2 --force：exit 0 且点名覆盖该文件、无合并清单', rf.status === 0 && /--force/.test(rf.stdout) && rf.stdout.includes('upgrade-force.md') && !/合并 1 项/.test(rf.stdout), `exit=${rf.status} ${rf.stdout}`);
  check('A2 --force：整覆盖回新种子原文（用户改动不保留——优先于合并）', fs.readFileSync(targetF, 'utf8') === v2f);
  check('A2 --force：台账对齐新种子哈希且基线随写（种子正文）',
    readManifest(rootF).files['.agents/config/upgrade-force.md'] === normHash(seedOf('upgrade-force.md'))
    && fs.readFileSync(baselineFile(rootF, '.agents/config/upgrade-force.md'), 'utf8') === v2f);
  fs.rmSync(rootF, { recursive: true, force: true });
  fs.rmSync(copy, { recursive: true, force: true });
}

// ---- ③ A3 旁路：mutable 条目与钩子条目均不进合并/基线通道 ----
{
  const root = mkRepo();
  runCli(root);
  // mutable 条目：改写不报冲突、不覆盖、不写基线（存在即在位语义）
  const metrics = path.join(root, 'workflow', 'metrics.md');
  fs.appendFileSync(metrics, '\n<!-- 引擎自有改写 -->\n');
  const edited = fs.readFileSync(metrics, 'utf8');
  const r = runCli(root);
  check('A3 mutable：改写后重跑不报冲突', r.status === 0 && !/冲突/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('A3 mutable：内容不被覆盖', fs.readFileSync(metrics, 'utf8') === edited);
  check('A3 mutable：台账仍按 mutable 追踪', readManifest(root).files['workflow/metrics.md'] && readManifest(root).files['workflow/metrics.md'].mutable === true);
  check('A3 mutable：不写基线（mutable 条目基线面零文件）', !fs.existsSync(baselineFile(root, 'workflow/metrics.md')) && !fs.existsSync(baselineFile(root, '.agents/confirmations.jsonl')));
  // 钩子条目：用户改钩子 → 不覆盖语义不变；基线面无钩子条目
  const pre = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.appendFileSync(pre, '\n# user hook note\n');
  const hookBefore = fs.readFileSync(pre, 'utf8');
  const mHookBefore = readManifest(root).files['.git/hooks/pre-commit'];
  const r2 = runCli(root);
  check('A3 钩子：用户改钩子不被覆盖（不覆盖语义不变）',
    fs.readFileSync(pre, 'utf8') === hookBefore && r2.status === 0 && r2.stdout.includes('pre-commit') && r2.stdout.includes('不覆盖用户钩子'),
    r2.stdout.split('\n').filter((l) => l.includes('hook') || l.includes('钩子')).join('\n'));
  check('A3 钩子：台账钩子基线不被改写', readManifest(root).files['.git/hooks/pre-commit'] === mHookBefore);
  const baselineKeys = listBaselineFiles(root);
  const mutableKeys = Object.entries(readManifest(root).files).filter(([, v]) => v !== null && typeof v === 'object').map(([k]) => k);
  check('A3 基线面：钩子条目零基线（.git/ 前缀零文件）', baselineKeys.length > 0 && baselineKeys.every((k) => !k.startsWith('.git/')), baselineKeys.join(', '));
  check('A3 基线面：mutable 条目零基线', mutableKeys.length > 0 && mutableKeys.every((k) => !baselineKeys.includes(k)), `mutable=${mutableKeys.join(', ')} baseline=${baselineKeys.join(', ')}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ A4 迁移：迁移链三态（单元）+ CLI 接线（一次性迁移写 / 超前拒绝 / 首装即带版本） ----
{
  // 单元：migrateManifest 三态
  check('A4 单元：CURRENT_SCHEMA_VERSION = 1', CURRENT_SCHEMA_VERSION === 1);
  check('A4 单元：newManifest 构造即带 schemaVersion（首装无迁移可跑）', newManifest('p', '1.0.0').schemaVersion === CURRENT_SCHEMA_VERSION);
  const v0 = { plugin: 'p', version: '0.9.0', files: { 'a.md': 'h-a', 'b/c.md': 'h-c' } };
  const m0 = migrateManifest({ manifest: v0 });
  check('A4 单元：旧台账（缺 schemaVersion 视作 0）迁到 1 且 files 原样（notes 出账）',
    m0.changed === true && m0.from === 0 && m0.to === 1 && m0.applied.length === 1 && m0.applied[0] === '0-1'
    && m0.manifest.schemaVersion === 1 && JSON.stringify(m0.manifest.files) === JSON.stringify(v0.files) && m0.notes.length > 0, JSON.stringify(m0));
  const v1 = { schemaVersion: 1, plugin: 'p', version: '1.0.0', files: { 'a.md': 'h-a' } };
  const m1 = migrateManifest({ manifest: v1 });
  check('A4 单元：已是 1 → changed=false 零迁移（框架按版本跳过）', m1.changed === false && m1.applied.length === 0 && JSON.stringify(m1.manifest) === JSON.stringify(v1), JSON.stringify(m1));
  let threw = null;
  try { migrateManifest({ manifest: { schemaVersion: 99, plugin: 'p', version: '9.9.9', files: {} } }); } catch (e) { threw = e; }
  check('A4 单元：schemaVersion 超前 → 抛 MANIFEST_SCHEMA（拒绝降级读，防新版台账被旧引擎静默改写）',
    Boolean(threw) && threw.code === 'MANIFEST_SCHEMA', threw && threw.message);
  // CLI：旧台账剥 schemaVersion → 一次性迁到 1（files 原样），二跑字节逐字节不动
  const root = mkRepo();
  runCli(root);
  const raw1 = fs.readFileSync(manifestOf(root), 'utf8');
  const files1 = JSON.parse(raw1).files;
  const stripped = JSON.parse(raw1);
  delete stripped.schemaVersion;
  const strippedRaw = `${JSON.stringify(stripped, null, 2)}\n`;
  fs.writeFileSync(manifestOf(root), strippedRaw, 'utf8');
  const r2 = runCli(root);
  const raw2 = fs.readFileSync(manifestOf(root), 'utf8');
  const m2 = JSON.parse(raw2);
  check('A4 CLI：剥 schemaVersion 后重跑 exit 0 且迁到 1', r2.status === 0 && m2.schemaVersion === 1, `exit=${r2.status} ${r2.stderr}`);
  check('A4 CLI：迁移只补元数据、files 逐键原样', JSON.stringify(m2.files) === JSON.stringify(files1));
  check('A4 CLI：迁移属一次性升级写（changed 才写——字节确已变化）', raw2 !== strippedRaw);
  const r3 = runCli(root);
  check('A4 CLI：二跑（已是 1）changed=false → 台账字节逐字节不动', r3.status === 0 && fs.readFileSync(manifestOf(root), 'utf8') === raw2);
  fs.rmSync(root, { recursive: true, force: true });
  // CLI：schemaVersion 99 → 上抛非零退出 + 零落盘（全链成功才写）
  const root99 = mkRepo();
  runCli(root99);
  const bad = JSON.parse(fs.readFileSync(manifestOf(root99), 'utf8'));
  bad.schemaVersion = 99;
  fs.writeFileSync(manifestOf(root99), `${JSON.stringify(bad, null, 2)}\n`, 'utf8');
  const snap99 = snapshot(root99);
  const r99 = runCli(root99);
  check('A4 CLI：schemaVersion:99 → 退出码非零（CLI 层 catch 上抛不吞）', r99.status !== 0 && /schemaVersion/.test(r99.stderr), `exit=${r99.status} ${r99.stderr}`);
  check('A4 CLI：迁移失败零落盘（全树快照零改动）', snapDiff(snap99, snapshot(root99)).length === 0, snapDiff(snap99, snapshot(root99)).join(', '));
  fs.rmSync(root99, { recursive: true, force: true });
  // 首装：台账即带 schemaVersion:1（列首键——序列化字节确定性）且二跑字节逐字节不动
  const fresh = mkRepo();
  runCli(fresh);
  const mfresh = readManifest(fresh);
  const rawFresh = fs.readFileSync(manifestOf(fresh), 'utf8');
  check('A4 首装：台账即带 schemaVersion:1 且列为首键（字节确定性）', mfresh.schemaVersion === 1 && Object.keys(mfresh)[0] === 'schemaVersion', raw1.slice(0, 80));
  const rfresh = runCli(fresh);
  check('A4 首装：二跑台账字节逐字节不动', rfresh.status === 0 && fs.readFileSync(manifestOf(fresh), 'utf8') === rawFresh);
  fs.rmSync(fresh, { recursive: true, force: true });
}

// ---- ⑤ A5 幂等：全量 mtime/字节快照二次 init 零改动（含基线目录）+ gitignore 基线条目幂等 ----
{
  const root = mkRepo();
  runCli(root);
  check('A5 前置：基线目录在场且非空（快照覆盖有意义）', listBaselineFiles(root).length > 0, listBaselineFiles(root).join(', '));
  const gitignorePath = path.join(root, '.gitignore');
  const git1 = fs.readFileSync(gitignorePath, 'utf8');
  check('A5 首装：gitignore 标记块含基线条目且恰一次',
    git1.includes('.agents/.install-baseline/') && (git1.match(/\.agents\/\.install-baseline\//g) || []).length === 1, git1);
  const snap1 = snapshot(root);
  const bytes1 = fs.readFileSync(manifestOf(root), 'utf8');
  const r = runCli(root);
  const snap2 = snapshot(root);
  const git2 = fs.readFileSync(gitignorePath, 'utf8');
  check('A5 二次 init exit 0', r.status === 0, `exit=${r.status} ${r.stderr}`);
  check('A5 全树 mtime/字节快照零改动（含 .install-baseline/ 基线目录）', snapDiff(snap1, snap2).length === 0, snapDiff(snap1, snap2).join(', '));
  check('A5 台账字节不动', fs.readFileSync(manifestOf(root), 'utf8') === bytes1);
  check('A5 gitignore 基线条目幂等（重复 init 不重复追加、字节不动）',
    git2 === git1 && (git2.match(/\.agents\/\.install-baseline\//g) || []).length === 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥ A6a drift：六类各 fixture 分类与计数 / mutable 恒 unchanged / 无台账单行提示 / 只读零写盘 ----
{
  const root = mkRepo();
  runCli(root);
  const m = readManifest(root);
  // 六类 fixtures（互不重叠的键面）：
  // user-modified：盘≠台账==种子
  fs.appendFileSync(path.join(root, '.agents', 'config', 'principles.md'), '\n<!-- 用户注 -->\n');
  // seed-updated：盘==台账≠种子（伪旧内容 + 台账同步改账）
  const oldBands = '# old bands content\n';
  fs.writeFileSync(path.join(root, '.agents', 'config', 'bands.json'), oldBands, 'utf8');
  m.files['.agents/config/bands.json'] = hashStr(oldBands);
  // merge-needed（基线在场）：盘≠台账≠种子，基线随首装留存
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), 'user modified engine body\n', 'utf8');
  m.files['.agents/config/engine.json'] = hashStr('user base engine\n');
  // merge-needed（无基线——首升兜底）：同上 + 删基线文件
  fs.writeFileSync(path.join(root, '.agents', 'config', 'mechanism-registry.md'), 'user modified registry\n', 'utf8');
  m.files['.agents/config/mechanism-registry.md'] = hashStr('user base registry\n');
  fs.rmSync(baselineFile(root, '.agents/config/mechanism-registry.md'), { force: true });
  // missing：台账有、盘上无
  fs.rmSync(path.join(root, '.agents', 'config', 'commit-msg-rules.json'), { force: true });
  // orphan：台账有、种子清单已无（盘上无文件也判 orphan——分类先于存在性）
  m.files['.agents/config/retired-legacy.md'] = hashStr('legacy\n');
  fs.writeFileSync(manifestOf(root), `${JSON.stringify(m, null, 2)}\n`, 'utf8');

  const DRIFT_CATS = ['unchanged', 'user-modified', 'seed-updated', 'merge-needed', 'orphan', 'missing'];
  const parseDriftOut = (out) => {
    const result = {};
    let cur = null;
    for (const line of out.split(/\r?\n/)) {
      const hm = /^([a-z-]+) (\d+) 项$/.exec(line);
      if (hm && DRIFT_CATS.includes(hm[1])) { cur = hm[1]; result[cur] = { count: Number(hm[2]), items: [] }; continue; }
      if (line.startsWith('漂移体检：')) { result.summary = line; cur = null; continue; }
      if (cur && line.startsWith('  ')) result[cur].items.push(line.slice(2));
    }
    return result;
  };
  const snapA = snapshot(root);
  const rd = runDrift(root);
  const snapB = snapshot(root);
  check('A6a drift exit 0', rd.status === 0, `exit=${rd.status} ${rd.stderr}`);
  check('A6a 只读零写盘（全树快照零改动，含台账 mtime）', snapDiff(snapA, snapB).length === 0, snapDiff(snapA, snapB).join(', '));
  const d = parseDriftOut(rd.stdout);
  check('A6a 六类小计行齐备且计数与明细一致', DRIFT_CATS.every((c) => d[c] && d[c].count === d[c].items.length), rd.stdout);
  const hasItem = (cat, frag) => d[cat] && d[cat].items.some((i) => i.startsWith(frag));
  check('A6a unchanged：未动种子件在册', hasItem('unchanged', '.agents/settings.json'));
  check('A6a mutable 恒 unchanged（存在即在位，不比对哈希）', hasItem('unchanged', 'workflow/INDEX.md') && hasItem('unchanged', '.agents/confirmations.jsonl'));
  check('A6a user-modified：用户改、种子未变 → principles.md 命中', hasItem('user-modified', '.agents/config/principles.md'));
  check('A6a seed-updated：盘==台账≠种子 → bands.json 命中', hasItem('seed-updated', '.agents/config/bands.json'));
  check('A6a merge-needed：双方都改 → engine.json 命中且标注「基线在场」', hasItem('merge-needed', '.agents/config/engine.json（基线在场）'));
  check('A6a merge-needed：无基线标注（首升兜底）→ mechanism-registry.md 命中', hasItem('merge-needed', '.agents/config/mechanism-registry.md（无基线（首升兜底））'));
  check('A6a orphan：台账有、种子已无 → retired-legacy.md 命中', hasItem('orphan', '.agents/config/retired-legacy.md'));
  check('A6a missing：台账有、盘上无 → commit-msg-rules.json 命中', hasItem('missing', '.agents/config/commit-msg-rules.json'));
  check('A6a 计数：五 fixture 类恰好命中（无多报无漏报）',
    d['user-modified'] && d['user-modified'].count === 1 && d['seed-updated'] && d['seed-updated'].count === 1
    && d['merge-needed'] && d['merge-needed'].count === 2 && d.orphan && d.orphan.count === 1 && d.missing && d.missing.count === 1,
    JSON.stringify(DRIFT_CATS.reduce((acc, c) => ({ ...acc, [c]: d[c] ? d[c].count : null }), {})));
  check('A6a 计数：unchanged 覆盖其余全部在册键（≥6：种子件 + mutable 件）', d.unchanged && d.unchanged.count >= 6, String(d.unchanged && d.unchanged.count));
  check('A6a 汇总行计数与各小计一致', Boolean(d.summary) && DRIFT_CATS.every((c) => {
    const mm = new RegExp(`${c} (\\d+)`).exec(d.summary);
    return mm && Number(mm[1]) === d[c].count;
  }), d.summary);

  // 无台账：单行提示恒 exit 0（未初始化不是漂移，不误报 orphan/missing）
  const bare = mkRepo();
  const rb = runDrift(bare);
  check('A6a 无台账：单行提示恒 exit 0', rb.status === 0 && rb.stdout.trim() === '无台账——先跑 init-engine', `exit=${rb.status} stdout=${rb.stdout} stderr=${rb.stderr}`);
  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ A6b prune：显式才删 / 哈希一致真删 / 保留面 / dry-run / 不带 --prune 零删除 ----
{
  const copy = mkPluginCopy({
    'prune-probe-a.md': '# prune-probe-a\nseed-body-a\n',
    'prune-probe-b.md': '# prune-probe-b\nseed-body-b\n',
  });
  const INIT_COPY = path.join(copy, 'scripts', 'init-engine.mjs');
  const root = mkRepo();
  runCli(root, [], INIT_COPY);
  const targetA = path.join(root, '.agents', 'config', 'prune-probe-a.md');
  const targetB = path.join(root, '.agents', 'config', 'prune-probe-b.md');
  check('A6b 前置：双 probe 落盘且基线留存',
    fs.existsSync(targetA) && fs.existsSync(targetB) && fs.existsSync(baselineFile(root, '.agents/config/prune-probe-a.md')));
  // 保留面 fixtures：probe-b 用户改（哈希失配）+ 手造 mutable 孤儿 + hooksDir 前缀口径键（basename 不在名单）
  fs.appendFileSync(targetB, '\nuser edit line\n');
  const m = readManifest(root);
  m.files['workflow/retired-ledger.md'] = { mutable: true };
  fs.writeFileSync(path.join(root, 'workflow', 'retired-ledger.md'), 'retired ledger body\n', 'utf8');
  m.files['.git/hooks/user-custom'] = hashStr('custom hook body\n');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'user-custom'), 'custom hook body\n', 'utf8');
  fs.writeFileSync(manifestOf(root), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  // 种子收窄（升版移除两个 probe）→ 双双成孤儿候选
  fs.rmSync(path.join(copy, 'config-templates', 'prune-probe-a.md'), { force: true });
  fs.rmSync(path.join(copy, 'config-templates', 'prune-probe-b.md'), { force: true });

  // 不带 --prune：永不删——零删除且输出无 prune 行
  const rPlain = runCli(root, [], INIT_COPY);
  check('A6b 不带 --prune：exit 0、零删除、输出无 prune 行', rPlain.status === 0 && !rPlain.stdout.includes('prune') && fs.existsSync(targetA), `exit=${rPlain.status} ${rPlain.stdout}`);

  // --prune --dry-run：只报告零写盘
  const rDry = runCli(root, ['--prune', '--dry-run'], INIT_COPY);
  check('A6b --prune --dry-run：报告「将删除」点名哈希一致孤儿（probe-a）', rDry.status === 0 && /将删除 1 项/.test(rDry.stdout) && rDry.stdout.includes('prune-probe-a.md'), rDry.stdout);
  check('A6b --prune --dry-run：零删（文件/台账行/基线全在）',
    fs.existsSync(targetA) && '.agents/config/prune-probe-a.md' in readManifest(root).files
    && fs.existsSync(baselineFile(root, '.agents/config/prune-probe-a.md')));
  check('A6b --prune --dry-run：保留清单点名改过/mutable/钩子（三面齐全）',
    rDry.stdout.includes('prune-probe-b.md（用户改过') && rDry.stdout.includes('retired-ledger.md（mutable 运行时账本')
    && rDry.stdout.includes('user-custom（钩子或不可识别条目'), rDry.stdout);
  check('A6b --prune --dry-run：无主基线 dry-run 清点（probe-a/probe-b 共 2）', /dry-run 清点无主基线 2 项/.test(rDry.stdout), rDry.stdout);

  // --prune 真删：孤儿哈希一致才删 + 台账行清 + 无主基线连清
  const rPrune = runCli(root, ['--prune'], INIT_COPY);
  check('A6b --prune 真删：exit 0 且「prune 删除 1 项」点名孤儿', rPrune.status === 0 && /prune 删除 1 项/.test(rPrune.stdout) && rPrune.stdout.includes('prune-probe-a.md'), rPrune.stdout);
  check('A6b --prune 真删：盘上文件已删', !fs.existsSync(targetA));
  check('A6b --prune 真删：台账孤儿行已清且保留侧行（probe-b/手造行原样）',
    !('.agents/config/prune-probe-a.md' in readManifest(root).files)
    && '.agents/config/prune-probe-b.md' in readManifest(root).files
    && 'workflow/retired-ledger.md' in readManifest(root).files
    && '.git/hooks/user-custom' in readManifest(root).files);
  check('A6b --prune 真删：无主基线连清（probe-a/probe-b 基线消失；仍种子在册的 principles 基线保留）',
    !fs.existsSync(baselineFile(root, '.agents/config/prune-probe-a.md'))
    && !fs.existsSync(baselineFile(root, '.agents/config/prune-probe-b.md'))
    && fs.existsSync(baselineFile(root, '.agents/config/principles.md')));
  check('A6b --prune 保留：改过/mutable/前缀口径钩子全保留且文件在盘（prune 保留 3 项）',
    fs.existsSync(targetB) && fs.readFileSync(targetB, 'utf8').includes('user edit line')
    && fs.existsSync(path.join(root, 'workflow', 'retired-ledger.md'))
    && fs.existsSync(path.join(root, '.git', 'hooks', 'user-custom'))
    && /prune 保留 3 项/.test(rPrune.stdout), rPrune.stdout);
  fs.rmSync(root, { recursive: true, force: true });

  // 钩子 basename 口径：git 不可用使钩子条目全部成孤儿候选 → 识别为钩子只报告不删（宁保留不删）
  const root2 = mkRepo();
  runCli(root2, [], INIT_COPY);
  const ru2 = runCli(root2, ['--prune'], INIT_COPY, { CHECK_LOOP_GIT: path.join(root2, 'defunct-git.exe') });
  check('A6b 钩子 basename 口径：git 不可用 → 钩子全成孤儿候选仍零删除（prune 删除 0 项 / 保留 4 项）',
    ru2.status === 0 && /prune 删除 0 项/.test(ru2.stdout) && /prune 保留 4 项/.test(ru2.stdout), ru2.stdout);
  check('A6b 钩子 basename 口径：四钩子键逐个点名（basename ∈ 钩子名单）',
    ['pre-commit', 'pre-push', 'post-commit', 'commit-msg'].every((h) => ru2.stdout.includes(`${h}（钩子或不可识别条目——只报告不删）`)), ru2.stdout);
  check('A6b 钩子 basename 口径：钩子文件在盘且台账键保留',
    ['.git/hooks/pre-commit', '.git/hooks/pre-push', '.git/hooks/post-commit', '.git/hooks/commit-msg'].every((k) => fs.existsSync(path.join(root2, ...k.split('/'))) && k in readManifest(root2).files));
  fs.rmSync(root2, { recursive: true, force: true });
  fs.rmSync(copy, { recursive: true, force: true });
}

// 汇总 + 退出码（同 init.test.mjs 口径：断言全挂必须让进程退出码变红）
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
