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
// prune（2026-11-17 升级面，spec 2026-11-17-install-upgrade-0315 场景 E：显式才删）——--prune 时在
//   applyPlan 完成后于 init-engine 层组合（不进 apply.mjs）：孤儿候选 = 台账 files 键 − 当前种子清单键
//   − 钩子条目（识别口径：键 basename ∈ 已知钩子名单 ∪ hooksDir 前缀命中；识别不了的键按钩子处理
//   只报告不删——宁保留不删）。删除条件：盘上存在 && 盘上哈希（hashText 归一）== 台账哈希；mutable
//   条目（台账值 {mutable:true}）无哈希、用户改过、盘上缺失一律保留报告。真删连带清台账孤儿行（仅
//   被删键）与无主基线（pruneBaselines，keep=当前种子文件键集）；--prune --dry-run 只报告零写盘；
//   不带 --prune 永不删——行为与现状逐字节一致。
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
// 用法：node init-engine.mjs [--root <仓库根>] [--dry-run] [--force] [--prune]
// 测试：node test/init.test.mjs（旧契约回归）；node test/install.test.mjs（两段式 + 台账契约）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './paths.mjs';
import { buildPlan } from './install/plan.mjs';
import { applyPlan } from './install/apply.mjs';
import { GITIGNORE_BEGIN, GITIGNORE_END } from './install/plan.mjs';
import { readManifest, writeManifestAtomic, hashFile } from './install/manifest.mjs';
import { pruneBaselines } from './install/baseline.mjs';

export { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_ENTRIES } from './install/plan.mjs';

/**
 * 幂等初始化。root 为已解析的项目根；重复调用零改动（gitignore 标记块与台账内容一致时不写盘）。
 * options.dryRun 只裁决不写盘；options.force 覆盖用户改动；options.prune 显式清理孤儿（不带永不删）。
 * @returns {{created:string[], skipped:string[], warnings:string[], gitignore:string, hooksDir:(string|null),
 *            hooks:{installed:string[], skipped:string[]}, updated:string[], conflict:string[],
 *            merged:string[], adopted:number, dryRun:boolean,
 *            prune:{deleted:string[], kept:string[], baselines:string[]}|undefined}}
 *            prune 仅在 options.prune 时存在（dryRun 下 deleted/baselines 是「将删/将清」清点）。
 */
export function initEngine(root, options) {
  const opts = options || {};
  const plan = buildPlan(root);
  const report = applyPlan(plan, opts);
  if (opts.prune) pruneOrphans(root, plan, report, opts);
  return report;
}

// —— prune（场景 E：显式 --prune 才删；组合在 init-engine 层，apply.mjs 零改动）——
const PRUNE_HOOK_NAMES = new Set(['pre-commit', 'pre-push', 'post-commit', 'commit-msg']);

// 钩子键识别口径（spec 场景 E 写死）：键 basename ∈ 已知钩子名单 ∪ 解析后落在 hooksDir 前缀下，
// 二者任一即视为钩子——只报告不删。台账键可为 '../..' 形态（worktree / core.hooksPath）或跨盘
// 极端退化的绝对路径（plan.mjs buildPlan ⑤ 注）——仅前缀匹配会漏、漏网键进哈希通道即被删；
// basename 兜底保证真钩子永进不了删除通道。
function isHookLikeKey(root, key, hooksDir) {
  const segs = String(key).replace(/\\/g, '/').split('/');
  if (PRUNE_HOOK_NAMES.has(segs[segs.length - 1])) return true;
  if (hooksDir) {
    const abs = path.resolve(root, ...segs);
    const dir = hooksDir.endsWith(path.sep) ? hooksDir : `${hooksDir}${path.sep}`;
    if (abs === hooksDir || abs.startsWith(dir)) return true;
  }
  return false;
}

// 台账键 → 目标绝对路径（键是 posix 相对路径，同 plan/apply 的 targetRel 形态，可含 '..' 段）。
const pruneKeyAbs = (root, key) => path.resolve(root, ...String(key).replace(/\\/g, '/').split('/'));

// 孤儿清理：候选 = 台账 files 键 − 当前种子清单键 − 钩子条目；盘上哈希（hashFile 同 hashText 归一）
// == 台账哈希才删。mutable（{mutable:true} 无哈希）、用户改过、盘上缺失、钩子及识别不了的键一律
// 保留并报告。真删连带：清台账孤儿行（仅被删键，保留侧行——钩子/改过文件下轮裁决仍依赖台账）+
// pruneBaselines（keep=当前种子文件键集，钩子/gitignore 本就不在基线面）。dryRun 全程零写盘，
// deleted/baselines 降为「将删/将清」清点。
function pruneOrphans(root, plan, report, { dryRun }) {
  report.prune = { deleted: [], kept: [], baselines: [] };
  const manifest = readManifest(root);
  if (!manifest) return; // 无台账（未初始化 / 损坏领养前形态）→ 无孤儿可清
  const seedKeys = new Set(plan.entries.filter((e) => !e.dir && e.kind !== 'gitignore-block').map((e) => e.targetRel));
  const deletable = [];
  for (const [key, rec] of Object.entries(manifest.files)) {
    if (seedKeys.has(key)) continue; // 当前种子清单仍在 → 非孤儿
    if (isHookLikeKey(root, key, report.hooksDir)) {
      report.prune.kept.push(`${key}（钩子或不可识别条目——只报告不删）`);
      continue;
    }
    if (rec && typeof rec === 'object') { // { mutable: true } 运行时账本：存在即在位，无哈希可校验
      report.prune.kept.push(`${key}（mutable 运行时账本——无哈希可校验，保留）`);
      continue;
    }
    let curHash = null;
    try { curHash = hashFile(pruneKeyAbs(root, key)); } catch { /* 盘上缺失 */ }
    if (curHash === null) { report.prune.kept.push(`${key}（盘上缺失——仅清点不删）`); continue; }
    if (curHash !== rec) { report.prune.kept.push(`${key}（用户改过——哈希与台账不符，保留）`); continue; }
    deletable.push(key);
  }
  for (const key of deletable) {
    if (!dryRun) fs.rmSync(pruneKeyAbs(root, key), { force: true });
    report.prune.deleted.push(key);
  }
  const baselineKeep = plan.entries
    .filter((e) => !e.dir && e.kind !== 'gitignore-block' && e.kind !== 'githook')
    .map((e) => e.targetRel);
  if (dryRun) { report.prune.baselines = pruneBaselines(root, baselineKeep, { dryRun: true }); return; }
  if (deletable.length) {
    for (const key of deletable) delete manifest.files[key];
    writeManifestAtomic(root, manifest);
  }
  report.prune.baselines = pruneBaselines(root, baselineKeep);
}

export function formatReport(root, report) {
  const lines = [`初始化（ai-native-delivery engine）@ ${root}`];
  if (report.dryRun) lines.push('dry-run: 试运行——只裁决不写盘（文件与台账均未落）');
  for (const w of report.warnings) lines.push(`WARN: ${w}`);
  lines.push(`gitignore: ${report.gitignore}（标记块 ${GITIGNORE_BEGIN} … ${GITIGNORE_END}）`);
  if (report.created.length) lines.push(`新建 ${report.created.length} 项:\n  + ${report.created.join('\n  + ')}`);
  else lines.push('新建 0 项');
  if (report.updated.length) lines.push(`更新 ${report.updated.length} 项:\n  ~ ${report.updated.join('\n  ~ ')}`);
  if (report.merged.length) lines.push(`合并 ${report.merged.length} 项:\n  ≈ ${report.merged.join('\n  ≈ ')}`);
  if (report.conflict.length) lines.push(`冲突跳过 ${report.conflict.length} 项（--force 可覆盖）:\n  ! ${report.conflict.join('\n  ! ')}`);
  if (report.adopted) lines.push(`领养 ${report.adopted} 项（旧版安装无台账——现状哈希记入 .agents/install-manifest.json，未覆盖）`);
  if (report.skipped.length) lines.push(`跳过 ${report.skipped.length} 项:\n  = ${report.skipped.join('\n  = ')}`);
  if (report.hooks.installed.length) lines.push(`git hooks 安装（目录 ${report.hooksDir || '(未解析)'}）:\n  + ${report.hooks.installed.join('\n  + ')}`);
  for (const s of report.hooks.skipped) lines.push(`git hooks 跳过: ${s}`);
  if (report.prune) {
    const p = report.prune;
    const label = report.dryRun ? 'prune（dry-run 只报告不删）将删除' : 'prune 删除';
    if (p.deleted.length) lines.push(`${label} ${p.deleted.length} 项:\n  - ${p.deleted.join('\n  - ')}`);
    else lines.push(`${label} 0 项`);
    if (p.kept.length) lines.push(`prune 保留 ${p.kept.length} 项（改过/不可识别——不删）:\n  = ${p.kept.join('\n  = ')}`);
    if (p.baselines.length) lines.push(`prune ${report.dryRun ? 'dry-run 清点无主基线' : '连带清理无主基线'} ${p.baselines.length} 项:\n  - ${p.baselines.join('\n  - ')}`);
  }
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
  let prune = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootArg = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--force') force = true;
    else if (argv[i] === '--prune') prune = true;
  }
  try {
    const root = resolveRoot(rootArg);
    console.log(formatReport(root, initEngine(root, { dryRun, force, prune })));
  } catch (err) {
    if (err && err.code === 'BAD_ROOT') console.error(`init-engine: ${err.message}`);
    else console.error(`init-engine: 初始化失败——${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
