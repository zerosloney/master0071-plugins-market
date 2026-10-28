// paths.mjs — 引擎路径收口（2026-10-27 ai-native-delivery 插件化迁移新增；设计文档 §5）
// 职责：项目根解析（git root 锚定，不锚 cwd）/ 引擎数据根 / 台账根 / 配置目录 / 引擎脚本定位。
// 零依赖纯 Node，Windows 兼容（path.join，不硬拼正斜杠）。
// 架构决策（用户定案）：治理脚本是插件资产、留插件内随市场分发；用户项目侧只落数据
//（.agents/ 运行时 + workflow/ 台账），永不向项目复制脚本。凡「项目侧 vs 插件内」二选一的
// 定位一律**项目侧优先**：源仓形态自带脚本副本的项目与测试夹具（CHECK_LOOP_ROOT fixture 往
// <root>/.agents/scripts 落副本）行为不变，插件驱动的新项目回退插件内本体。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnGit } from './git-core.mjs';

// ── 插件内锚点（本文件落位即 <plugin>/scripts/，随安装缓存目录漂移，不作项目侧路径用）──
export const PLUGIN_SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(PLUGIN_SCRIPTS_DIR, '..');
export const PLUGIN_CONFIG_TEMPLATES_DIR = path.join(PLUGIN_ROOT, 'config-templates');

// ── 项目侧相对位（§5.2 项目级不变量：一律落使用项目的 git 仓库根，与源项目同名）──
export const ENGINE_DIR_REL = '.agents';   // 引擎数据根（运行时 + 项目侧治理配置）
export const WF_REL = 'workflow';          // 交付台账根（人类可读；check-loop kit 的 WF 单源）

export const engineDir = (root) => path.join(root, ENGINE_DIR_REL);
export const ledgerDir = (root) => path.join(root, WF_REL);

// resolveProjectRoot(startDir)：项目根解析**三态**（2026-10-27 插件化修复）。
//   status='ok'            → root = git 仓库根
//   status='not-a-repo'    → 当前目录不在 git 仓库内（合法形态，调用方按各自语义降级）
//   status='git-unavailable' → git 不可用 / git 拒绝工作（dubious ownership / 索引锁 / 仓库损坏…）
// 拆三态的原因：原先三态一律折叠为 null，「git 拒绝工作」与「不在 git 仓库内」不可区分——
//   物理闸门（pre-commit / pre-push）据此跳过扫描并 exit 0，等于在自身基础设施故障时**静默放行**，
//   且 stderr 给出误诊文案「不在 git 仓库内」（真实原因是 git 拒绝工作）。假绿比红危险。
export function resolveProjectRoot(startDir = process.cwd()) {
  const r = spawnGit(['rev-parse', '--show-toplevel'], startDir);
  if (r.error) {
    return { root: null, status: 'git-unavailable', detail: `git 进程不可用（${r.error.code || r.error.message}）` };
  }
  if (r.status === 0) {
    const top = String(r.stdout || '').trim();
    if (top) return { root: top, status: 'ok', detail: '' };
    return { root: null, status: 'not-a-repo', detail: 'git rev-parse --show-toplevel 无输出' };
  }
  const msg = String(r.stderr || '').trim();
  if (/not a git repository/i.test(msg)) {
    return { root: null, status: 'not-a-repo', detail: msg || '不在 git 仓库内' };
  }
  return { root: null, status: 'git-unavailable', detail: msg || `git rev-parse exit ${r.status}` };
}

// findProjectRoot(startDir)：git 仓库根锚定（rev-parse --show-toplevel），不锚 cwd——
// 嵌套目录调用不漂移。非 git 仓库返回 null，调用方按各自语义降级（kit：跳过扫描）。
// 需区分「非 git 仓」与「git 故障」的调用方请用 resolveProjectRoot。
export function findProjectRoot(startDir = process.cwd()) {
  return resolveProjectRoot(startDir).root;
}

// projectRoot(startDir)：脚本默认根的**单源锚定**（git root 优先，解析不到回退 startDir）。
// 为什么不让各脚本各自写 `findProjectRoot(process.cwd()) || process.cwd()`：锚定口径一旦分散，
// 漏一处就出现「在子目录调用 → 台账落进子目录」的漂移（实测 ledger-shards --append 曾落
// <repo>/sub/workflow/ 而仓库根 workflow/ 根本不存在，且输出只印相对路径，用户看不出落错位置）。
// 回退而非报错：非 git 目录是合法形态（就地操作），各调用方按各自语义降级，不在此处替它们改裁决。
export function projectRoot(startDir = process.cwd()) {
  return findProjectRoot(startDir) || startDir;
}

// ledgerRoot({ fixture, explicit, startDir })：审计账与凭证的**可写根**（2026-10-27 P0 修复）。
// 与 scriptPath/configDir 刻意不同：这里不回退 PLUGIN_ROOT。插件安装目录跨项目共享，
// 把 verifications.jsonl / workflow/verify-evidence.md 落进去，A 处跑出的绿凭证会被 B 处
// readEvidence 认成合法关单凭证（verify.mjs 的基线候选就按该路径读），且违反市场承诺
//「台账与三本审计账一律落使用项目仓库根，不进插件目录与用户目录」。
// fixture（CHECK_LOOP_ROOT）与 explicit（--root）是调用方显式交来的根，原样采信。
export function ledgerRoot({ fixture, explicit, startDir } = {}) {
  if (fixture) return { root: fixture, writable: true, status: 'fixture', detail: '' };
  if (explicit) return { root: path.resolve(explicit), writable: true, status: 'explicit', detail: '' };
  const r = resolveProjectRoot(startDir);
  if (r.root) return { root: r.root, writable: true, status: r.status, detail: r.detail };
  return { root: null, writable: false, status: r.status, detail: r.detail };
}

// ledgerRefusal(status, detail)：拒写台账时给用户的统一口径（含可执行的下一步）。
export const ledgerRefusal = (status, detail) =>
  `拒绝写台账：解析不到使用项目的 git 仓库根（${status === 'git-unavailable' ? 'git 不可用' : '当前目录不在 git 仓库内'}${detail ? `：${detail}` : ''}）。`
  + '台账与绿凭证只落使用项目的仓库根——插件安装目录跨项目共享，落进去会被别的项目当成关单证据。';

// configDir(root)：项目侧 .agents/config 优先，不存在回退插件内 config-templates
//（首次初始化的种子；check-loop 核心枚举 workflow-enums.txt 仍由 kit 显式走项目侧并
// fail-loud——fixture 契约「缺文件/缺键响亮出账」不因模板回退而静默）。
export function configDir(root) {
  const project = path.join(engineDir(root), 'config');
  if (fs.existsSync(project)) return project;
  return PLUGIN_CONFIG_TEMPLATES_DIR;
}

// scriptPath(root, name)：项目侧 .agents/scripts/<name> 优先（源仓形态 / 测试夹具副本），
// 回退插件内 <plugin>/scripts/<name>（脚本留插件内的架构决策落点）。
export function scriptPath(root, name) {
  const project = path.join(engineDir(root), 'scripts', name);
  if (fs.existsSync(project)) return project;
  return path.join(PLUGIN_SCRIPTS_DIR, name);
}

// commandsDir(root)：命令面目录，与 scriptPath 同口径（项目侧 .agents/commands/ 优先，
// 回退插件内 <plugin>/commands/）。命令面是「非标准部分」（客户端约定目录），插件化后随市场分发。
export function commandsDir(root) {
  const project = path.join(engineDir(root), 'commands');
  if (fs.existsSync(project)) return project;
  return path.join(PLUGIN_ROOT, 'commands');
}

// deploymentMode(root)：部署形态判别（2026-10-27 插件化修复：门禁自检类脚本据此选判据口径）。
//   'source-repo' —— 项目侧自带 .agents/scripts 脚本副本（源仓形态 / 测试夹具）；钩子挂 .githooks/
//                     + core.hooksPath，merge driver 与 .gitattributes 由项目侧维护。
//   'plugin'      —— 治理脚本留插件内（市场分发形态）；钩子由 init-engine 装到 git 默认钩子目录，
//                     项目侧只落数据（.agents/ 运行时 + workflow/ 台账）。
// 两种形态的钩子挂载面互斥：源仓形态的 core.hooksPath 会整体接管钩子查找（git 优先读它），
// 故插件形态绝不复用源仓形态的判据，也绝不能给出「设 core.hooksPath」的修复指引——
// 那会让 init-engine 装好的 .git/hooks 钩子静默失效（实测：钩子文件仍在但不再执行）。
export function deploymentMode(root) {
  return fs.existsSync(path.join(engineDir(root), 'scripts', 'check-loop.mjs')) ? 'source-repo' : 'plugin';
}

// gitHooksDir(root)：git 实际会执行钩子的目录（2026-10-27）。
//   core.hooksPath 已设置 → 该路径（相对路径相对仓库根）；
//   未设置              → git 默认钩子目录（`git rev-parse --git-path hooks`，对 worktree /
//                         submodule / 标准仓都准——worktree 下 .git 是文件，直接拼 .git/hooks 会错）。
// 解析不出（git 不可用 / 非 git 仓）返回 null，调用方按各自语义降级。
export function gitHooksDir(root) {
  const configured = spawnGit(['config', 'core.hooksPath'], root);
  if (configured && !configured.error && configured.status === 0) {
    const p = String(configured.stdout || '').trim();
    if (p) return path.isAbsolute(p) ? p : path.resolve(root, p);
  }
  const gp = spawnGit(['rev-parse', '--git-path', 'hooks'], root);
  if (gp && !gp.error && gp.status === 0) {
    const p = String(gp.stdout || '').trim();
    if (p) return path.isAbsolute(p) ? p : path.resolve(root, p);
  }
  return null;
}
