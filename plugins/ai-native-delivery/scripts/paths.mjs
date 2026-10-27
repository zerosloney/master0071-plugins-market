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

// findProjectRoot(startDir)：git 仓库根锚定（rev-parse --show-toplevel），不锚 cwd——
// 嵌套目录调用不漂移。非 git 仓库返回 null，调用方按各自语义降级（kit：跳过扫描）。
export function findProjectRoot(startDir = process.cwd()) {
  const top = spawnGit(['rev-parse', '--show-toplevel'], startDir);
  if (top.error || top.status !== 0 || !String(top.stdout || '').trim()) return null;
  return top.stdout.trim();
}

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
