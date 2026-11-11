#!/usr/bin/env node
// doctor.mjs — 安装自检（2026-11 doctor 工单新增；蓝本 agentic-flow-kit 的 doctor 模式）
// 动机：init-engine 装好的引擎面（台账 / git hooks / gitignore 标记块 / settings.json / engine.json）
//       会被用户或工具链事后改动，漂了才知道；doctor 把「装没装好、装完还在不在」收进一条命令的
//       体检报告。纯静态检查：不 spawn MCP、不跑门禁，只读文件系统与 git 路径查询（gitHooksDir）。
// 蓝图（agentic-flow-kit doctor 模式）：检查项数组 { ok, name, detail, fix }，逐项一行 `✓/✗ 名称 — 详情`，
//   ✗ 项下一行缩进给 `修复：<可直接复制执行的命令>`；检查项之间独立失败（一项 ✗ 不中断其余，
//   单项内部抛错只折损自己）；全部通过 exit 0，任一失败 exit 1。
// 检查面：
//   a 项目根             git 仓可用、root 可锚定（显式 --root 也须在 git 仓内）
//   b 安装台账           <root>/.agents/install-manifest.json 在位且可解析（缺失/损坏 → 重跑即领养）
//   c 已装文件与台账一致  逐文件核验（CRLF 归一 sha256，同安装段口径）：盘上缺失 / 内容不符分列
//   d git hooks          pre-commit / pre-push 在位，且渲染内容指向的 check-loop 脚本存在
//   e .gitignore 标记块  BEGIN/END 成对在位
//   f settings.json      在位、JSON 可解析，permissions.deny 含**文件级地板基线**：内置地板
//                       （hooks/pretool-risk.mjs BUILTIN，单源 import）∩ 插件种子 deny——种子自带的
//                       地板项被项目删掉即 ✗；种子未自带的条目（--no-verify 族）由 pretool-risk
//                       运行时并入 deny（loadLists 地板并集），不要求文件自带。文件缺失/损坏的 ✗
//                       文案照 pretool-risk 的回退语义（WARN + 内置地板继续执法）说明现状。
//   g engine.json        policyVersion 与插件种子一致；不一致即漂移——只给「手改对齐 / 确认保留」
//                       两个选项，不给强制命令（项目侧 engine.json 属项目自治，init 不自动覆盖）。
// 用法：node scripts/doctor.mjs [--root <仓库根>]（缺省 root 用 findProjectRoot() 锚定 git 仓库根）
// 测试：node test/doctor.test.mjs（黑盒：临时 git 仓 spawn 真实 CLI）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_CONFIG_TEMPLATES_DIR, engineDir, findProjectRoot, gitHooksDir, resolveProjectRoot } from './paths.mjs';
import { MANIFEST_FILENAME, manifestPath, readManifest, hashFile } from './install/manifest.mjs';
import { GITIGNORE_BEGIN, GITIGNORE_END } from './init-engine.mjs';
import { BUILTIN } from '../hooks/pretool-risk.mjs';

const DOCTOR_PATH = fileURLToPath(import.meta.url);
const HOOK_NAMES = ['pre-commit', 'pre-push'];
const INIT_ENGINE = path.join(path.dirname(DOCTOR_PATH), 'init-engine.mjs');

// initEngineCmd(root)：✗ 项统一指向的修复命令（单源）。重跑 init-engine 即领养 / update / conflict
// 通道自愈（见 install/apply.mjs 头注）；路径加引号——Windows 插件缓存目录常含空格，复制即用。
const initEngineCmd = (root) => `node "${INIT_ENGINE}" --root "${root}"`;

// normRule(s)：清单成员比对，与 pretool-risk 的 norm 同口径（小写 / 剥词元尾可执行后缀 / 空白归一）——
// 「地板项在不在 deny 里」的判定不能比执法端更严或更松。
const normRule = (s) => String(s).toLowerCase()
  .replace(/\.(exe|bat|cmd)(?=[\s;&|()]|$)/g, '')
  .replace(/\s+/g, ' ').trim();

// readJson(file)：读 + 解析，任何失败返回 null（doctor 只报状态不抛栈）。
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// capList(list)：清单拼进 detail 时截断——单检查项保持一行可读；全量清单修复后重跑自见分晓。
const capList = (list) => (list.length <= 8 ? list.join('、') : `${list.slice(0, 8).join('、')} 等 ${list.length} 项`);

// FLOOR_BASELINE：f 检查的文件级地板基线（模块级算一次，纯读插件种子）。种子 deny 不可读（插件
// 安装损坏）→ 退全量内置地板，方向 fail-safe（核验只会更严不会更松）。
const FLOOR_BASELINE = (() => {
  const seed = readJson(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json'));
  const seedDeny = seed && seed.permissions && typeof seed.permissions === 'object'
    && Array.isArray(seed.permissions.deny) ? seed.permissions.deny : null;
  if (seedDeny === null) return [...BUILTIN.deny];
  return BUILTIN.deny.filter((b) => seedDeny.some((d) => typeof d === 'string' && normRule(d) === normRule(b)));
})();

// bakedEngineScript(hookAbs)：钩子正文里实化的 ENGINE_SCRIPT 绝对路径（与 install/apply.mjs
// isStaleOwnHook 同一正则口径——只认带引号的 JS 字符串字面量）。读不出 / 无该行 → null。
function bakedEngineScript(hookAbs) {
  let body;
  try { body = fs.readFileSync(hookAbs, 'utf8'); } catch { return null; }
  const m = /const\s+ENGINE_SCRIPT\s*=\s*("(?:[^"\\]|\\.)*")/.exec(body);
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    return typeof p === 'string' ? p : null;
  } catch { return null; }
}

/**
 * runDoctor(root)：对已解析（或 null）的项目根跑全部检查项。检查项独立失败——单项内部抛错折损为
 * 该项 ✗（detail 带错误信息），不中断其余检查。
 * @param {string|null} root 项目根（git 仓库根）；null 时仅 a 报根解析失败，其余项报「无法检查」
 * @returns {{ok:boolean, checks:Array<{ok:boolean, name:string, detail:string, fix:string}>}}
 */
export function runDoctor(root) {
  const checks = [];
  const rootFix = `在 git 仓库内重跑：node "${DOCTOR_PATH}" --root <仓库根>`;
  // add(name, fn)：单项隔离执行——一项内部异常只折损自己，不让 doctor 整体崩（独立失败契约）。
  // fn 返回 null = 项目根未解析、本项无从查起 → 补「无法检查」的 ✗（检查名保持，exit 码仍红）。
  const add = (name, fn) => {
    try {
      const c = fn();
      checks.push(c || { ok: false, name, detail: '项目根未解析，无法检查', fix: rootFix });
    } catch (err) {
      checks.push({ ok: false, name, detail: `检查执行失败：${err && err.message ? err.message : err}`, fix: '' });
    }
  };

  // a 项目根
  add('项目根', () => {
    if (!root) {
      return { ok: false, name: '项目根', detail: '未解析到项目根（当前目录不在 git 仓库内）——后续检查无锚点', fix: rootFix };
    }
    const r = resolveProjectRoot(root);
    if (r.status !== 'ok') {
      const why = r.status === 'not-a-repo' ? '目录不在 git 仓库内' : `git 不可用：${r.detail}`;
      return { ok: false, name: '项目根', detail: `root 不可锚定为 git 仓库根（${why}）`, fix: rootFix };
    }
    return { ok: true, name: '项目根', detail: `git 仓库根锚定成功（${root}）`, fix: '' };
  });

  // b 安装台账 + c 已装文件与台账一致
  add('安装台账', () => {
    if (!root) return null;
    const onDisk = fs.existsSync(manifestPath(root));
    const manifest = readManifest(root);
    if (manifest) {
      return { ok: true, name: '安装台账', detail: `${MANIFEST_FILENAME} 在位且可解析（${Object.keys(manifest.files).length} 个文件记录）`, fix: '' };
    }
    return {
      ok: false, name: '安装台账',
      detail: onDisk
        ? `${MANIFEST_FILENAME} 损坏（JSON 不可解析或形状非法——安装段按缺失处理）`
        : `${MANIFEST_FILENAME} 缺失（旧版 init 过的项目重跑即领养：现状哈希全部记入新账，不覆盖任何文件）`,
      fix: `${initEngineCmd(root)}（重跑即领养）`,
    };
  });
  add('已装文件与台账一致', () => {
    if (!root) return null;
    const manifest = readManifest(root);
    if (!manifest) {
      return { ok: false, name: '已装文件与台账一致', detail: '安装台账缺失/损坏——无核验基线', fix: `${initEngineCmd(root)}（重跑即领养）` };
    }
    const missing = [];
    const modified = [];
    for (const [rel, hash] of Object.entries(manifest.files)) {
      const abs = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(abs)) missing.push(rel);
      else if (hashFile(abs) !== hash) modified.push(rel);
    }
    if (!missing.length && !modified.length) {
      return { ok: true, name: '已装文件与台账一致', detail: `已核验 ${Object.keys(manifest.files).length} 个文件，与台账哈希全部一致（CRLF 归一 sha256）`, fix: '' };
    }
    const parts = [];
    if (missing.length) parts.push(`盘上缺失 ${missing.length}：${capList(missing)}`);
    if (modified.length) parts.push(`内容与台账不符 ${modified.length}：${capList(modified)}`);
    return {
      ok: false, name: '已装文件与台账一致',
      detail: `${parts.join('；')}——缺失项重跑重建；改动项重跑走 update（基线未动）/ conflict（用户改过，--force 才覆盖）通道`,
      fix: initEngineCmd(root),
    };
  });

  // d git hooks
  add('git hooks', () => {
    if (!root) return null;
    const hooksDir = gitHooksDir(root);
    if (!hooksDir) {
      return { ok: false, name: 'git hooks', detail: '无法解析 git 钩子目录（git 不可用或非 git 仓库）', fix: initEngineCmd(root) };
    }
    const problems = [];
    for (const name of HOOK_NAMES) {
      const target = path.join(hooksDir, name);
      if (!fs.existsSync(target)) { problems.push(`${name} 缺失`); continue; }
      const engine = bakedEngineScript(target);
      if (!engine) problems.push(`${name} 读不出 ENGINE_SCRIPT 指向（疑似非本引擎钩子，不自动处置）`);
      else if (!fs.existsSync(engine)) problems.push(`${name} 指向的引擎脚本不存在：${engine}`);
    }
    if (problems.length) {
      return { ok: false, name: 'git hooks', detail: `${problems.join('；')}（钩子目录 ${hooksDir}）`, fix: initEngineCmd(root) };
    }
    return { ok: true, name: 'git hooks', detail: `pre-commit / pre-push 在位且引擎脚本指向有效（${hooksDir}）`, fix: '' };
  });

  // e .gitignore 标记块
  add('.gitignore 标记块', () => {
    if (!root) return null;
    let body = null;
    try { body = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { /* 无文件 → 缺失分支 */ }
    if (body === null) {
      return { ok: false, name: '.gitignore 标记块', detail: '.gitignore 不存在', fix: initEngineCmd(root) };
    }
    const begin = body.indexOf(GITIGNORE_BEGIN);
    const end = body.indexOf(GITIGNORE_END);
    if (begin !== -1 && end !== -1 && begin < end) {
      return { ok: true, name: '.gitignore 标记块', detail: `标记块成对在位（${GITIGNORE_BEGIN} … ${GITIGNORE_END}）`, fix: '' };
    }
    return {
      ok: false, name: '.gitignore 标记块',
      detail: begin !== -1 || end !== -1 ? '标记块 BEGIN/END 不成对（半块会让 init 的块级合并失准）' : '标记块缺失',
      fix: initEngineCmd(root),
    };
  });

  // f settings.json deny 地板
  add('settings.json deny 地板', () => {
    if (!root) return null;
    const settingsFile = path.join(engineDir(root), 'settings.json');
    let raw = null;
    try { raw = fs.readFileSync(settingsFile, 'utf8'); } catch { /* 缺失 → 回退分支 */ }
    if (raw === null) {
      return {
        ok: false, name: 'settings.json deny 地板',
        detail: `${settingsFile} 缺失——pretool-risk 清单回退插件种子（项目自定义 deny/ask 不生效；deny 内置地板仍由代码执法）`,
        fix: initEngineCmd(root),
      };
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 损坏 → 降级分支 */ }
    if (parsed === null || typeof parsed !== 'object') {
      return {
        ok: false, name: 'settings.json deny 地板',
        detail: 'JSON 不可解析——pretool-risk 按 WARN + 内置 deny 地板继续执法（fail-closed 回退，同其降级语义）',
        fix: `${initEngineCmd(root)} --force（损坏文件属用户改动，init 冲突跳过；--force 覆盖恢复种子）`,
      };
    }
    const p = parsed.permissions;
    if (!p || typeof p !== 'object' || !Array.isArray(p.deny)) {
      return {
        ok: false, name: 'settings.json deny 地板',
        detail: 'permissions.deny 缺失或非数组——pretool-risk 按内置地板执法（清单来源降级，同其回退语义）',
        fix: `${initEngineCmd(root)} --force（或手工补回 permissions.deny 数组）`,
      };
    }
    const missingFloor = FLOOR_BASELINE.filter((b) => !p.deny.some((d) => typeof d === 'string' && normRule(d) === normRule(b)));
    if (missingFloor.length) {
      return {
        ok: false, name: 'settings.json deny 地板',
        detail: `deny 删了种子自带的地板项：${capList(missingFloor)}——内置地板共 ${BUILTIN.deny.length} 条，其中 ${BUILTIN.deny.length - FLOOR_BASELINE.length} 条由 pretool-risk 运行时并入（不要求文件自带），文件级基线 ${FLOOR_BASELINE.length} 条不可缺`,
        fix: `${initEngineCmd(root)} --force（或手工把缺失地板项加回 deny 数组）`,
      };
    }
    return {
      ok: true, name: 'settings.json deny 地板',
      detail: `在位且可解析；deny ${p.deny.length} 条，文件级地板基线 ${FLOOR_BASELINE.length}/${FLOOR_BASELINE.length}（内置地板共 ${BUILTIN.deny.length} 条，其余由 pretool-risk 运行时并入）`,
      fix: '',
    };
  });

  // g engine.json policyVersion（漂移只提示，不给强制命令——项目自治）
  add('engine.json policyVersion', () => {
    if (!root) return null;
    const seedEngine = readJson(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json'));
    if (!seedEngine || seedEngine.policyVersion === undefined) {
      return { ok: false, name: 'engine.json policyVersion', detail: '插件种子 engine.json 不可读或缺 policyVersion（插件安装损坏）', fix: '重装插件' };
    }
    const seedV = seedEngine.policyVersion;
    const projFile = path.join(engineDir(root), 'config', 'engine.json');
    const proj = readJson(projFile);
    if (proj === null) {
      const broken = fs.existsSync(projFile);
      return {
        ok: false, name: 'engine.json policyVersion',
        detail: broken ? `JSON 不可解析，无法比对 policyVersion（插件种子 ${seedV}）` : `文件缺失（插件种子 policyVersion=${seedV}）`,
        fix: broken ? `${initEngineCmd(root)} --force（损坏文件 init 冲突跳过；--force 覆盖恢复种子）` : initEngineCmd(root),
      };
    }
    if (Number(proj.policyVersion) === Number(seedV)) {
      return { ok: true, name: 'engine.json policyVersion', detail: `policyVersion=${proj.policyVersion} 与插件种子一致`, fix: '' };
    }
    const projV = proj.policyVersion === undefined ? '缺 policyVersion（按 v1 基线）' : `policyVersion=${proj.policyVersion}`;
    return {
      ok: false, name: 'engine.json policyVersion',
      detail: `漂移：项目 ${projV}，插件种子 ${seedV}——项目侧 engine.json 属项目自治，init 不自动覆盖`,
      fix: `人工比对后二选一：① 手改项目文件 ${projFile} 的 policyVersion 对齐种子 ${seedV}；② 确认项目值是有意保留——不改，接受漂移提示`,
    };
  });

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * formatChecks(checks)：检查项 → 逐行文本。✓/✗ 名称 — 详情 一行；✗ 项下一行缩进「修复：…」。
 * @param {Array<{ok:boolean, name:string, detail:string, fix:string}>} checks
 * @returns {string}
 */
export function formatChecks(checks) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok && c.fix) lines.push(`    修复：${c.fix}`);
  }
  return lines.join('\n');
}

// ── CLI（isMain 前置：被测试 import 纯函数时本段不执行，对齐 gen-host-manifests 先例） ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootArg = argv[++i];
  }
  const root = rootArg ? path.resolve(rootArg) : findProjectRoot();
  const result = runDoctor(root);
  console.log(`doctor（ai-native-delivery engine）${root ? `@ ${root}` : '@（项目根未解析）'}`);
  console.log(formatChecks(result.checks));
  const failed = result.checks.filter((c) => !c.ok);
  if (result.ok) console.log(`\ndoctor: ${result.checks.length} 项检查全部通过`);
  else console.error(`\ndoctor: ${failed.length}/${result.checks.length} 项未通过——按各行「修复」处理后重跑自检`);
  process.exit(result.ok ? 0 : 1);
}
