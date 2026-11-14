#!/usr/bin/env node
// worktree-ops 配置路径单测（白盒，直连 mcp/core.mjs）。
//
// smoke.mjs 是纯黑盒，配置读取路径的守卫与 saveConfig 的 round-trip 在黑盒下
// 无法稳定断言，这里直接对 loadConfig / saveConfig / configDir 做单测。另有两处
// core 单点修复（lastCommit 的 tab 截断、slug 的 Windows 保留设备名）也一并收在
// 本文件：范围内唯一允许新建的测试文件就是这里。测试自建临时目录，结束清理。
//
//   node test/config.mjs
//
// 退出码非 0 表示有断言失败。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configDir, effective, lastCommit, loadConfig, saveConfig, slug } from '../mcp/core.mjs';
import { mergedLabel } from '../mcp/tools.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n${title}`);

const sandbox = mkdtempSync(path.join(tmpdir(), 'worktree-ops-config-'));
const cfgFile = path.join(sandbox, 'config.json');
// loadConfig / saveConfig / configDir 的落盘目标由 configDir() 在调用时读该环境变量决定
process.env.WORKTREE_CONFIG_HOME = sandbox;
const writeCfg = (obj) => writeFileSync(cfgFile, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');

try {
  section('baseRef 空串与 branchPrefix 空串同待遇：上报 issue，不落盘');
  // 空 baseRef 到生效点（resolveBase 的 if (e.baseRef && ...)）会因 falsy 被当成未配置、
  // 静默走 auto，无任何 issue 提示——与 branchPrefix 空串的显式报错口径分裂。
  writeCfg({
    root: null,
    baseRef: '',
    branchPrefix: 'wb/',
    staleDays: 3,
    repos: { 'demo-repo': { baseRef: '' } },
  });
  const loaded = loadConfig();
  check(
    '顶层 baseRef 空串上报 issue（消息口径同 branchPrefix）',
    loaded.config.issues.some((m) => m === 'baseRef: expected a non-empty string, got ""'),
    JSON.stringify(loaded.config.issues),
  );
  check(
    'repo 级 baseRef 空串上报 issue（写法模仿 branchPrefix 守卫）',
    loaded.config.issues.some((m) => m === 'repos["demo-repo"].baseRef: expected a non-empty string, got ""'),
    JSON.stringify(loaded.config.issues),
  );
  check(
    '顶层 baseRef 空串不落盘：生效值回退默认 auto',
    loaded.config.baseRef === 'auto',
    `config.baseRef=${JSON.stringify(loaded.config.baseRef)}`,
  );
  check(
    'repo 级 baseRef 空串被剔除',
    loaded.config.repos['demo-repo'] && loaded.config.repos['demo-repo'].baseRef === undefined,
    JSON.stringify(loaded.config.repos['demo-repo']),
  );
  check(
    '空串 baseRef 不再透传到生效层（effective 回退 auto，不再静默）',
    effective(loaded.config, 'demo-repo').baseRef === 'auto',
    `effective.baseRef=${JSON.stringify(effective(loaded.config, 'demo-repo').baseRef)}`,
  );
  check(
    'branchPrefix 合法值不受影响（对照组：不误报、不误删）',
    loaded.config.branchPrefix === 'wb/' && !loaded.config.issues.some((m) => m.includes('branchPrefix')),
    `branchPrefix=${JSON.stringify(loaded.config.branchPrefix)}, issues=${JSON.stringify(loaded.config.issues)}`,
  );

  section('saveConfig round-trip：手写未知顶层键不丢');
  // body 曾只由固定四键 + repos 构成：用户自定义顶层键在任意一次配置写盘后无提示消失
  //（repos 内部未知字段反而保留）。写带自定义顶层键的配置，改一个无关字段后验证仍在。
  writeCfg({
    root: null,
    staleDays: 3,
    myCustom: { nested: true, note: 'keep me' },
    anotherTop: 'keep-me',
  });
  let saved = null;
  try {
    saved = saveConfig({ top: { staleDays: 7 } });
  } catch (err) {
    saved = err;
  }
  check(
    'saveConfig 本身成功',
    saved === cfgFile,
    saved instanceof Error ? saved.message : `returned ${saved}`,
  );
  const afterSave = JSON.parse(readFileSync(cfgFile, 'utf8'));
  check(
    '自定义顶层键对象原样保留',
    JSON.stringify(afterSave.myCustom) === JSON.stringify({ nested: true, note: 'keep me' }),
    JSON.stringify(afterSave.myCustom),
  );
  check(
    '自定义顶层键标量原样保留',
    afterSave.anotherTop === 'keep-me',
    JSON.stringify(afterSave.anotherTop),
  );
  check(
    '本次改动照常生效（staleDays 7）',
    afterSave.staleDays === 7,
    `staleDays=${JSON.stringify(afterSave.staleDays)}`,
  );
  check(
    '已知键不被未知键污染（root/repos 形态不变）',
    afterSave.root === null && afterSave.repos && typeof afterSave.repos === 'object' && !Array.isArray(afterSave.repos),
    JSON.stringify([afterSave.root, afterSave.repos]),
  );

  section('WORKTREE_CONFIG_HOME 相对路径忽略，回退默认位置');
  // 相对路径会按宿主启动 MCP 的 cwd 解析，配置位置随进程 cwd 漂移。与 WORKTREE_ROOT
  // 的同类守卫同口径：忽略这一层，回退默认位置。默认位置钉到沙箱（win32 走 APPDATA，
  // POSIX 走 XDG_CONFIG_HOME）让断言确定。
  const savedConfigHome = process.env.WORKTREE_CONFIG_HOME;
  const savedAppData = process.env.APPDATA;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.APPDATA = sandbox;
    process.env.XDG_CONFIG_HOME = sandbox;
    process.env.WORKTREE_CONFIG_HOME = path.join('rel-config-home', 'drift');
    const drifted = configDir();
    check(
      '相对路径 env 被忽略：仍落默认位置（沙箱下 worktree-ops）且为绝对路径',
      drifted === path.join(sandbox, 'worktree-ops') && path.isAbsolute(drifted),
      `configDir=${drifted}`,
    );
    process.env.WORKTREE_CONFIG_HOME = path.join(sandbox, 'abs-home');
    const absolute = configDir();
    check(
      '绝对路径 env 仍直接生效（对照组）',
      absolute === path.join(sandbox, 'abs-home'),
      `configDir=${absolute}`,
    );
  } finally {
    process.env.WORKTREE_CONFIG_HOME = savedConfigHome;
    process.env.APPDATA = savedAppData;
    process.env.XDG_CONFIG_HOME = savedXdg;
  }

  section('slug 不产出 Windows 保留设备名');
  // con/nul/aux/prn/com1-9/lpt1-9 作目录名时 git 建目录报晦涩 Win32 错：命中保留名
  //（大小写不敏感、全名匹配）即追加 -wt 后缀使名字合法。
  for (const name of ['con', 'CON', 'nul', 'Aux', 'prn', 'com1', 'Com4', 'lpt9']) {
    const s = slug(name);
    check(
      `保留设备名 ${JSON.stringify(name)} 追加后缀（不再命中保留名）`,
      /^[a-z0-9._-]+-wt$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(s),
      `slug=${s}`,
    );
  }
  for (const name of ['console', 'constant', 'com10', 'nulp', 'auxiliary']) {
    const s = slug(name);
    check(`普通名 ${JSON.stringify(name)} 不受影响（全名匹配不误伤）`, s === name, `slug=${s}`);
  }
  check('"." 仍走哈希兜底（原行为不变）', /^[0-9a-f]{8}$/.test(slug('.')), `slug=${slug('.')}`);
  check('空串仍走哈希兜底（原行为不变）', /^[0-9a-f]{8}$/.test(slug('')), `slug=${slug('')}`);
  check(
    '路径分隔与非法字符清洗不变',
    slug('feature/x') === 'feature-x' && slug('a  b') === 'a-b',
    `slug=${slug('feature/x')}`,
  );

  section('lastCommit 的 subject 含 tab 不截断（与批量版 lastCommits 同口径）');
  // 单条版曾对 split("\t") 直接解构：subject 自身含 tab 时后半段被丢。批量版早已是
  // rest.join("\t")。真实建仓库提交一个带 tab 的 subject 驱动该路径。
  const repoDir = path.join(sandbox, 'tab-repo');
  mkdirSync(repoDir, { recursive: true });
  const runGit = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  runGit(['init']);
  runGit(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fix: alpha\tbeta tail']);
  const commit = lastCommit(repoDir);
  check(
    'lastCommit 取到提交',
    commit !== null && typeof commit.sha === 'string' && commit.sha.length > 0,
    commit === null ? '(null)' : `sha=${commit.sha}`,
  );
  check(
    'subject 完整保留（split 不截断 tab 后半段）',
    commit !== null && commit.subject === 'fix: alpha\tbeta tail',
    commit === null ? '(null)' : `subject=${JSON.stringify(commit.subject)}`,
  );
  check(
    'subject 与批量版同口径（tab 原样在内）',
    commit !== null && commit.subject.includes('\t') && commit.subject.endsWith('beta tail'),
    commit === null ? '(null)' : `subject=${JSON.stringify(commit.subject)}`,
  );
  // ---- 面板评审 C-002/C-011（2026-11-14 pr-baf1e6e-753574e2）：__proto__ 键 round-trip ----
  // 动态 body[key]=value 走原型 setter：键静默丢弃 + body 原型被磁盘对象替换（违背「未知键
  // 原样保留」承诺）。修复后 defineProperty 恒建自有数据属性——键原样保留、原型不动。
  {
    // 对象字面量的 __proto__: 键是设原型不是建自有键（stringify 后文件里根本没有该键）——
    // 必须写原始 JSON 串，让 JSON.parse 建 __proto__ 自有数据属性（被测前提）。
    writeFileSync(cfgFile, '{"staleDays":3,"__proto__":{"injected":true},"customTop":"keep-me"}\n');
    saveConfig({ top: { staleDays: 7 } });
    const after = JSON.parse(readFileSync(cfgFile, 'utf8'));
    check(
      'C-002 __proto__ 顶层键 round-trip 原样保留（defineProperty 不走原型 setter）',
      Object.prototype.hasOwnProperty.call(after, '__proto__') && after.customTop === 'keep-me',
      JSON.stringify(Object.keys(after)),
    );
    check(
      'C-011 全局原型未受污染（saveConfig 后 Object.prototype 无 injected）',
      !Object.prototype.hasOwnProperty.call(Object.prototype, 'injected') && ({}).injected === undefined,
      '(global prototype integrity)',
    );
  }

  // ---- 面板评审 C-014（2026-11-14）：merge_back 计划行「合并状态未知」三态标签白盒锁 ----
  // e2e 的 null 通道在本机 git（porcelain 全零 sha + isAncestor 折叠 false）下不可构造——
  // smoke 只能钉可达口径，这里直连 mergedLabel 单源锁死 ? 口径（回退旧三元即红）。
  check(
    'C-014 mergedLabel 三态：null/undefined=?、true=yes、false=no',
    mergedLabel(null) === '?' && mergedLabel(undefined) === '?' && mergedLabel(true) === 'yes' && mergedLabel(false) === 'no',
    `null=${mergedLabel(null)} true=${mergedLabel(true)} false=${mergedLabel(false)}`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
