#!/usr/bin/env node
// init-engine — 项目侧引擎初始化（设计文档 §5.2 初始化契约；可独立 CLI 跑、暴露 initEngine 库函数）
// 2026-11 安装引擎重构：plan/apply 两段式 + sha256 安装台账（<root>/.agents/install-manifest.json）。
//   plan（install/plan.mjs）  把全部落盘行为描述为纯数据计划条目（无写盘副作用）；
//   apply（install/apply.mjs）按台账裁决 create/update/conflict-skip/adopt 后落盘；
//   manifest（install/manifest.mjs）台账读写 + CRLF→LF 归一 sha256（种子源与落盘目标同一归一）。
// 幂等契约：重复跑零改动（台账内容不变不重写；gitignore 标记块内容一致时不写盘）；输出「新建/更新/
// 冲突跳过/跳过」清单；退出一律 0（文件系统错误除外）。台账语义同 lock 文件：入库共享，不进
// .gitignore 标记块。裁决口径（详见 install/apply.mjs 头注）：
//   目标不存在 → create；台账在 + 目标==台账 + 种子≠台账 → update（种子升级传播）；
//   台账在 + 目标≠台账（用户改过）→ conflict skip 不覆盖（--force 覆盖）；目标在但台账整个缺失
//   （旧版 init 过的项目）→ 领养：不覆盖任何文件，现状哈希全部记入新账。
// 落位（名字与源项目一致，§5.2 项目级不变量；种子清单与排除口径见 install/plan.mjs buildPlan）：
//   .agents/            引擎运行时（config/ 种子、pipelines/ 编排脚本、settings.json、确认账、运行时目录）
//   workflow/           交付台账（人类可读，入库；八子目录 + 五骨架文档）
//   .gitignore          标记注释块（BEGIN/END）内追加本机不入库项；已有标记块整块替换，其余原样
//   git 钩子目录        pre-commit / pre-push / post-commit / commit-msg 安装（占位符实化 + CRLF→LF +
//                       chmod，陈旧自装钩子覆盖刷新例外保留，见 install/apply.mjs；post-commit 为
//                       Dreaming advisory 提醒腿，exit 恒 0 不阻断；commit-msg 为先确认后改代码顺序门
//                       + 任务短名 advisory，2026-11-12 L0/L1 快速道移植）
// 首行判断：项目 .agents/config/engine.json 的 policyVersion 与插件种子不同 → WARN 可升级但不自动
// 覆盖项目改动（装户文件仍是种子原样时由台账 update 通道传播升版）。
// 用法：node init-engine.mjs [--root <仓库根>] [--dry-run] [--force]
// 测试：node test/init.test.mjs（旧契约回归）；node test/install.test.mjs（两段式 + 台账契约）
import path from 'node:path';
import { findProjectRoot } from './paths.mjs';
import { buildPlan } from './install/plan.mjs';
import { applyPlan } from './install/apply.mjs';
import { GITIGNORE_BEGIN, GITIGNORE_END } from './install/plan.mjs';

export { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_ENTRIES } from './install/plan.mjs';

/**
 * 幂等初始化。root 为已解析的项目根；重复调用零改动（gitignore 标记块与台账内容一致时不写盘）。
 * options.dryRun 只裁决不写盘；options.force 覆盖用户改动。
 * @returns {{created:string[], skipped:string[], warnings:string[], gitignore:string, hooksDir:(string|null),
 *            hooks:{installed:string[], skipped:string[]}, updated:string[], conflict:string[],
 *            adopted:number, dryRun:boolean}}
 */
export function initEngine(root, options) {
  return applyPlan(buildPlan(root), options);
}

export function formatReport(root, report) {
  const lines = [`初始化（ai-native-delivery engine）@ ${root}`];
  if (report.dryRun) lines.push('dry-run: 试运行——只裁决不写盘（文件与台账均未落）');
  for (const w of report.warnings) lines.push(`WARN: ${w}`);
  lines.push(`gitignore: ${report.gitignore}（标记块 ${GITIGNORE_BEGIN} … ${GITIGNORE_END}）`);
  if (report.created.length) lines.push(`新建 ${report.created.length} 项:\n  + ${report.created.join('\n  + ')}`);
  else lines.push('新建 0 项');
  if (report.updated.length) lines.push(`更新 ${report.updated.length} 项:\n  ~ ${report.updated.join('\n  ~ ')}`);
  if (report.conflict.length) lines.push(`冲突跳过 ${report.conflict.length} 项（--force 可覆盖）:\n  ! ${report.conflict.join('\n  ! ')}`);
  if (report.adopted) lines.push(`领养 ${report.adopted} 项（旧版安装无台账——现状哈希记入 .agents/install-manifest.json，未覆盖）`);
  if (report.skipped.length) lines.push(`跳过 ${report.skipped.length} 项:\n  = ${report.skipped.join('\n  = ')}`);
  if (report.hooks.installed.length) lines.push(`git hooks 安装（目录 ${report.hooksDir || '(未解析)'}）:\n  + ${report.hooks.installed.join('\n  + ')}`);
  for (const s of report.hooks.skipped) lines.push(`git hooks 跳过: ${s}`);
  lines.push(`卸载说明: git hooks 落在 ${report.hooksDir || '.git/hooks/'}（不入版本库）——删除该目录下的 pre-commit、pre-push、post-commit 与 commit-msg 即卸载；种子正文在插件 config-templates/githooks/。`);
  return lines.join('\n');
}

// resolveRoot(explicit)：CLI 根解析（--root 显式优先，缺省 git root 锚定）。失败抛 err.code='BAD_ROOT'，
// 由 CLI 层 catch 后 stderr + exit 1。
function resolveRoot(explicit) {
  const r = explicit ? path.resolve(explicit) : findProjectRoot();
  if (!r) {
    const err = new Error('无法定位项目根（当前目录不在 git 仓库内）——用 --root <仓库根> 显式指定');
    err.code = 'BAD_ROOT';
    throw err;
  }
  return r;
}

const isMain = process.argv[1] && process.argv[1].endsWith('init-engine.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  let rootArg = null;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootArg = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--force') force = true;
  }
  try {
    const root = resolveRoot(rootArg);
    console.log(formatReport(root, initEngine(root, { dryRun, force })));
  } catch (err) {
    if (err && err.code === 'BAD_ROOT') console.error(`init-engine: ${err.message}`);
    else console.error(`init-engine: 初始化失败——${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
