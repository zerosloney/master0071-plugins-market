#!/usr/bin/env node
// init-engine — 项目侧引擎初始化（设计文档 §5.2 初始化契约；可独立 CLI 跑、暴露 initEngine 库函数）
// 幂等契约：重复跑零改动（除 .gitignore 标记块的整块替换更新）；输出「新建/跳过」两类清单；
// 退出一律 0（文件系统错误除外）。已存在文件一律跳过不覆盖——项目改动不受初始化侵蚀。
// 落位（名字与源项目一致，§5.2 项目级不变量）：
//   .agents/            引擎运行时
//     config/           从 config-templates 全量种子（排除 githooks/ 与 settings.json——各有专位；
//                        亦排除 pipelines/——编排脚本有专位 .agents/pipelines/，见 ①b）
//     pipelines/        编排脚本种子（config-templates/pipelines/ → .agents/pipelines/；与
//                        workflows-check.mjs 扫描面、autonomous-run skill 路径约定同源）
//     settings.json     permissions 三清单种子（config-templates/settings.json）
//     confirmations.jsonl + confirmations.d/   确认账（入库；主账缺则建空文件）
//     cache/ loop/ notes/ board/ tmp/          本机运行时目录（cache/tmp 不入库）
//   workflow/           交付台账（人类可读，入库）
//     INDEX.md + plans/ specs/ intents/ incidents/ reviews.d/ delegations.d/ evidence/ archive/
//     papercuts.md delegations.md metrics.md regression-checklist.md（空骨架标题行）
//   .gitignore          标记注释块（BEGIN/END）内追加本机不入库项；已有标记块整块替换，其余原样
//   git 钩子目录        pre-commit / pre-push 安装（config-templates/githooks 种子，安装时把
//                       @@ENGINE_SCRIPT@@ 实化为 check-loop.mjs 绝对路径——项目侧 .agents/scripts
//                       优先回退插件内，paths.mjs scriptPath 同口径）；目录走 gitHooksDir()
//                       （core.hooksPath 优先，否则 git rev-parse --git-path hooks——worktree 下
//                       .git 是文件，拼 <root>/.git/hooks 会 ENOTDIR 崩）；已存在同名钩子跳过不覆盖
// 首行判断：项目 .agents/config/engine.json 的 policyVersion 与插件种子不同 → WARN 可升级但不自动覆盖。
// 用法：node init-engine.mjs [--root <仓库根>]（缺省用 git root 锚定的项目根）
// 测试：node test/init.test.mjs（幂等 / gitignore 块替换 / 已存在跳过 / 钩子不覆盖）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, engineDir, ledgerDir, PLUGIN_CONFIG_TEMPLATES_DIR, scriptPath, gitHooksDir } from './paths.mjs';

export const GITIGNORE_BEGIN = '# BEGIN ai-native-delivery engine';
export const GITIGNORE_END = '# END ai-native-delivery engine';
// 本机不入库项（§5.2 入库口径表：判定/验证流水与缓存是本机机器事实；本机环境与个人模型映射不入库）
export const GITIGNORE_ENTRIES = [
  '.agents/cache/',
  '.agents/judgments.jsonl',
  '.agents/verifications.jsonl',
  '.agents/tmp/',
  '.agents/config/model-roles.local.json',
  '.agents/notes/runtime-env.local.md',
];

const WORKFLOW_SUBDIRS = ['plans', 'specs', 'intents', 'incidents', 'reviews.d', 'delegations.d', 'evidence', 'archive'];
const WORKFLOW_DOCS = {
  'INDEX.md': '# workflow 索引 — 活跃层与档案\n\n> 初始化骨架（ai-native-delivery init-engine 生成）。活跃层表格可由 gen-workflow-index.mjs 重建；\n> 跨会话恢复优先用 MCP read_context（INDEX 头部 + 在途三件套 + 最近确认行）。\n',
  'papercuts.md': '# papercuts — 确认税与摩擦记录\n',
  'delegations.md': '# delegations — 委派记录\n',
  'metrics.md': '# metrics — 交付指标\n',
  'regression-checklist.md': '# regression-checklist — 回归清单\n',
};
const RUNTIME_DIRS = ['cache', 'loop', 'notes', 'board', 'tmp'];

function walkFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs));
  }
  return out.sort();
}

// config-templates → .agents/config 种子清单。排除：githooks/（.git/hooks 安装的模板源，非项目配置）、
// settings.json（项目侧专位在 .agents/settings.json，与 config/ 平级——§5.2 目录规范）、
// pipelines/（项目侧专位在 .agents/pipelines/——编排脚本落位口径，见下方 ①b）。
function configSeedFiles() {
  return walkFiles(PLUGIN_CONFIG_TEMPLATES_DIR)
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('githooks/') && rel !== 'settings.json' && !rel.startsWith('pipelines/'));
}

// ①b 编排脚本种子 → 项目侧 .agents/pipelines/（2026-10-27 插件化修复）。
// 落位口径单源：config-templates/pipelines/_TEMPLATE.md 头注声明「正式落位在项目侧 .agents/pipelines/」，
// workflows-check.mjs 的机器门扫描面也是 <root>/.agents/pipelines/，autonomous-run skill 引用同一路径。
// 修复前：本函数只排除了 githooks/ 与 settings.json，pipelines/ 随 config 全量种子落到
// .agents/config/pipelines/ —— 与三处声明的路径约定全部不符，且编排机器门扫 0 份文件恒报绿（假绿）。
function seedPipelines(root, report) {
  const src = path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'pipelines');
  if (!fs.existsSync(src)) return;
  const dest = path.join(engineDir(root), 'pipelines');
  for (const rel of walkFiles(src)) {
    const posix = rel.split(path.sep).join('/');
    const target = path.join(dest, ...posix.split('/'));
    if (fs.existsSync(target)) { report.skipped.push(`.agents/pipelines/${posix}（已存在）`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split(path.sep)), target);
    report.created.push(`.agents/pipelines/${posix}`);
  }
}

function seedGitignore(root, report) {
  const file = path.join(root, '.gitignore');
  const block = [...GITIGNORE_ENTRIES];
  const ensureNl = (s) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* 无文件 → 新建 */ }
  if (cur === null) {
    fs.writeFileSync(file, `${GITIGNORE_BEGIN}\n${block.join('\n')}\n${GITIGNORE_END}\n`, 'utf8');
    report.gitignore = 'created';
    return;
  }
  // 已有标记块 → 整块替换更新；其余部分（含行尾风格之外的内容）原样保留
  const m = /(#[^\n]*BEGIN ai-native-delivery engine[\s\S]*?#[^\n]*END ai-native-delivery engine[^\n]*)/.exec(cur);
  const replacement = `${GITIGNORE_BEGIN}\n${block.join('\n')}\n${GITIGNORE_END}`;
  const next = m ? cur.replace(m[0], replacement) : `${ensureNl(cur)}${replacement}\n`;
  if (next !== cur) {
    fs.writeFileSync(file, next, 'utf8');
    report.gitignore = m ? 'block-replaced' : 'appended';
  } else {
    report.gitignore = 'unchanged';
  }
}

// git hooks 安装：种子占位符 @@ENGINE_SCRIPT@@ / @@LANE@@ 在安装时实化。
// ENGINE_SCRIPT 用 JSON.stringify 生成字符串字面量——Windows 反斜杠路径在 JS 单引号串里是
// 转义雷（'\U' 会吞反斜杠），JSON 字面量转义是唯一稳妥写法。LANE：两钩子均走默认 hard 车道
//（§3.2 L-git：pre-commit / pre-push 都是 check-loop 硬门执法点；项目可改种子值换 --hygiene/--all）。
//
// 钩子目录解析（2026-10-27 插件化修复）：走 gitHooksDir()——core.hooksPath 已设置则以其为准
//（那才是 git 真正执行的目录），否则取 `git rev-parse --git-path hooks`（worktree / submodule /
// 标准仓都准）。修复前直接拼 <root>/.git/hooks：worktree 下 .git 是**文件**不是目录 → mkdir 抛
// ENOTDIR，整个初始化崩在最后一步（已落地的种子留在半途）。
function installHooks(root, report) {
  const hooksDir = gitHooksDir(root);
  report.hooksDir = hooksDir;
  if (!hooksDir) {
    report.hooks.skipped.push('git 钩子目录解析不出（非 git 仓库或 git 不可用）——git hooks 未安装');
    return;
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ['pre-commit', 'pre-push']) {
    const target = path.join(hooksDir, name);
    if (fs.existsSync(target)) {
      report.hooks.skipped.push(`${name}（已存在同名钩子——不覆盖用户钩子）`);
      continue;
    }
    let tpl = '';
    try { tpl = fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'githooks', name), 'utf8'); } catch { continue; }
    const engine = scriptPath(root, 'check-loop.mjs');
    // 占位符（带引号的整体字符串）全局替换为 JSON 字面量——JSON.stringify 的转义保证 Windows
    // 反斜杠路径在 JS 串里合法；种子未安装时占位串保持原样（语法仍合法，spawn 时 fail-closed）。
    // 种子头注的机制说明也提到 @@ENGINE_SCRIPT@@（散文，无引号），故匹配必须带引号整体替换。
    const body = tpl.replace(/\r\n/g, '\n') // CRLF 种子（core.autocrlf 检出）落盘前归一——钩子由 sh 启动，CRLF shebang 会断
      .replace(/"@@ENGINE_SCRIPT@@"/g, JSON.stringify(engine))
      .replace(/"@@LANE@@"/g, JSON.stringify(''));
    fs.writeFileSync(target, body, 'utf8');
    try { fs.chmodSync(target, 0o755); } catch { /* Windows 尽力而为（git 经 sh 启动钩子，不依赖执行位） */ }
    report.hooks.installed.push(`${name}（node ${engine}，hard 车道）→ ${target}`);
  }
}

/**
 * 幂等初始化。root 为已解析的项目根；重复调用零改动（gitignore 标记块内容一致时不写盘）。
 * @returns {{created:string[], skipped:string[], warnings:string[], gitignore:string, hooks:{installed:string[], skipped:string[]}}}
 */
export function initEngine(root) {
  const report = { created: [], skipped: [], warnings: [], gitignore: 'unchanged', hooksDir: null, hooks: { installed: [], skipped: [] } };
  const agents = engineDir(root);
  const wf = ledgerDir(root);

  // 首行判断：policyVersion 升级提示（不自动覆盖项目侧 engine.json）
  const seedEngine = JSON.parse(fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json'), 'utf8'));
  const projEngine = path.join(agents, 'config', 'engine.json');
  if (fs.existsSync(projEngine)) {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(projEngine, 'utf8')); } catch { /* 损坏交由种子守门（缺文件才补） */ }
    if (cur && Number(cur.policyVersion) !== Number(seedEngine.policyVersion)) {
      report.warnings.push(`项目 .agents/config/engine.json policyVersion=${cur.policyVersion} 与插件种子 ${seedEngine.policyVersion} 不同——可升级（手工对齐或删除该文件后重跑本脚本重新种子；初始化不自动覆盖）`);
    }
  }

  // ① .agents/config 全量种子（已存在跳过）
  fs.mkdirSync(agents, { recursive: true });
  for (const rel of configSeedFiles()) {
    const target = path.join(agents, 'config', ...rel.split('/'));
    if (fs.existsSync(target)) { report.skipped.push(`.agents/config/${rel}（已存在）`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, ...rel.split('/')), target);
    report.created.push(`.agents/config/${rel}`);
  }
  // ② settings.json（项目侧专位）+ 确认账 + 运行时目录
  const settingsTarget = path.join(agents, 'settings.json');
  if (fs.existsSync(settingsTarget)) report.skipped.push('.agents/settings.json（已存在）');
  else { fs.copyFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json'), settingsTarget); report.created.push('.agents/settings.json'); }

  const confirmMain = path.join(agents, 'confirmations.jsonl');
  if (fs.existsSync(confirmMain)) report.skipped.push('.agents/confirmations.jsonl（已存在）');
  else { fs.writeFileSync(confirmMain, '', 'utf8'); report.created.push('.agents/confirmations.jsonl'); }
  for (const dir of ['confirmations.d', ...RUNTIME_DIRS]) {
    const target = path.join(agents, dir);
    if (fs.existsSync(target)) { report.skipped.push(`.agents/${dir}/（已存在）`); continue; }
    fs.mkdirSync(target, { recursive: true });
    report.created.push(`.agents/${dir}/`);
  }

  // ③ workflow/ 台账骨架
  fs.mkdirSync(wf, { recursive: true });
  for (const dir of WORKFLOW_SUBDIRS) {
    const target = path.join(wf, dir);
    if (fs.existsSync(target)) { report.skipped.push(`workflow/${dir}/（已存在）`); continue; }
    fs.mkdirSync(target, { recursive: true });
    report.created.push(`workflow/${dir}/`);
  }
  for (const [name, skeleton] of Object.entries(WORKFLOW_DOCS)) {
    const target = path.join(wf, name);
    if (fs.existsSync(target)) { report.skipped.push(`workflow/${name}（已存在）`); continue; }
    fs.writeFileSync(target, skeleton, 'utf8');
    report.created.push(`workflow/${name}`);
  }

  // ④ .gitignore 标记块 + ⑤ git hooks
  seedGitignore(root, report);
  installHooks(root, report);
  // ⑥ 编排脚本种子 → .agents/pipelines/（落位口径单源，见 seedPipelines 注释）
  seedPipelines(root, report);
  return report;
}

export function formatReport(root, report) {
  const lines = [`初始化（ai-native-delivery engine）@ ${root}`];
  for (const w of report.warnings) lines.push(`WARN: ${w}`);
  lines.push(`gitignore: ${report.gitignore}（标记块 ${GITIGNORE_BEGIN} … ${GITIGNORE_END}）`);
  if (report.created.length) lines.push(`新建 ${report.created.length} 项:\n  + ${report.created.join('\n  + ')}`);
  else lines.push('新建 0 项');
  if (report.skipped.length) lines.push(`跳过 ${report.skipped.length} 项:\n  = ${report.skipped.join('\n  = ')}`);
  if (report.hooks.installed.length) lines.push(`git hooks 安装（目录 ${report.hooksDir || '(未解析)'}）:\n  + ${report.hooks.installed.join('\n  + ')}`);
  for (const s of report.hooks.skipped) lines.push(`git hooks 跳过: ${s}`);
  lines.push(`卸载说明: git hooks 落在 ${report.hooksDir || '.git/hooks/'}（不入版本库）——删除该目录下的 pre-commit 与 pre-push 即卸载；种子正文在插件 config-templates/githooks/。`);
  return lines.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('init-engine.mjs');
if (isMain) {
  const ri = process.argv.indexOf('--root');
  const root = ri >= 0 ? path.resolve(process.argv[ri + 1] || '') : findProjectRoot();
  if (!root) {
    console.error('init-engine: 无法定位项目根（当前目录不在 git 仓库内）——用 --root <仓库根> 显式指定');
    process.exit(1);
  }
  try {
    console.log(formatReport(root, initEngine(root)));
  } catch (err) {
    console.error(`init-engine: 初始化失败——${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
