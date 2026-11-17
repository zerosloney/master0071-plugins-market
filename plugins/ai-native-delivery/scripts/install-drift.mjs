#!/usr/bin/env node
// install-drift.mjs — 装户漂移体检（只读；2026-11-17 install-upgrade 0.3.15 场景 D，
// 语义权威 workflow/specs/2026-11-17-install-upgrade-0315.md）
// 用途：对「安装台账 × 盘上现状 × 当前种子」三方做一次只读对账，把全部装户文件六类归类并出计数
//   汇总——升级前体检哪些文件会被 update / merge 波及，升级后核对残留漂移。恒 exit 0（advisory
//   只读，红不是它的职责；根解析失败 / 文件系统异常除外，stderr + exit 1）。零写盘声明：不落台账、
//   不落基线、不落任何临时文件。
// 六类语义（对 种子清单 ∪ 台账 files 逐键判定；台账 = .agents/install-manifest.json）：
//   unchanged     三方一致（盘上==台账==种子）；台账值 {mutable:true} 恒归 unchanged——存在即在位
//                 语义，不比对哈希（mutable 面的存在性核验归 doctor）；
//   user-modified 用户改过、种子未变（盘上≠台账==种子）——尊重用户改动，init-engine 不覆盖；
//   seed-updated  种子升了、盘上未动（盘上==台账≠种子）——重跑 init-engine 自动 update 传播；
//   merge-needed  双方都改（盘上≠台账≠种子）——升级时可试三方合并；本脚本只看基线在场与否
//                 （标注「基线在场」/「无基线（首升兜底）」），不真跑合并（合并裁决归 apply）；
//   orphan        台账有、种子清单已无——下轮 --prune 的候选（显式才删，钩子条目只报告）；
//   missing       台账有、盘上无——装户文件被删。
// 口径：哈希全部 CRLF→LF 归一 sha256（hashText/hashFile 同一归一，manifest.mjs 口径）；种子清单与
//   排除口径 buildPlan 单源——钩子条目按同规则比台账哈希（台账记渲染后正文），目录与 gitignore
//   标记块无哈希不入台账、不在体检面；git 不可用时钩子条目缺席，其台账键如实归 orphan。种子有、
//   台账未记账的键（插件升版新增种子、项目未重跑 init）归 seed-updated 并标注——重跑 init 落位，
//   处置动作与种子升级相同。
// 分工：drift 只看装户文件三态（台账 / 盘上 / 种子），不做门禁、不给修复命令；「装没装好、装完还在
//   不在」的执法核验归 doctor.mjs，行为级校验归 verify.mjs。
// 用法：node install-drift.mjs [--root <仓库根>]（根解析与 init-engine 同法：--root 显式优先，缺省
//   findProjectRoot 锚定 git 仓库根）
// 测试：node test/install-upgrade.test.mjs（drift 六类 + mutable 恒 unchanged + 无台账单行提示）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './paths.mjs';
import { buildPlan } from './install/plan.mjs';
import { readManifest, hashFile } from './install/manifest.mjs';
import { readBaseline } from './install/baseline.mjs';

// 六类固定出场顺序（小计行与汇总行的排列口径）。
const CATEGORIES = ['unchanged', 'user-modified', 'seed-updated', 'merge-needed', 'orphan', 'missing'];

const isMutableValue = (v) => v !== null && typeof v === 'object' && v.mutable === true;

// plan 条目 → 落点绝对路径（targetRel 是 posix 相对路径，'/ '分隔，钩子键可含 '..' 段——同 apply 口径）。
const targetAbs = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * collectDrift(root)：六类漂移分类（纯读，零写盘）。台账缺失/损坏（readManifest → null）返回 null，
 * CLI 层据此出单行提示——未初始化不是漂移，不误报 orphan/missing。
 * 种子清单取 buildPlan 条目中带哈希者（copy / settings / pipelines / skeleton / runtime 空文件 / 钩子）。
 * merge-needed 只看基线在场（readBaseline 非 null），不真跑合并。
 * @returns {{root:string, drift:{unchanged:string[], 'user-modified':string[], 'seed-updated':string[],
 *            'merge-needed':string[], orphan:string[], missing:string[]}}|null}
 *   明细为台账键形（posix 相对路径）；merge-needed / 种子未记账条目带中文标注后缀（同 apply 报告风格）。
 */
export function collectDrift(root) {
  const plan = buildPlan(root);
  const manifest = readManifest(root);
  if (manifest === null) return null;
  const seedMap = new Map();
  for (const e of plan.entries) {
    if (typeof e.hash !== 'string') continue; // 目录 / gitignore 标记块——不入台账，不在体检面
    seedMap.set(e.targetRel, e);
  }
  const drift = { unchanged: [], 'user-modified': [], 'seed-updated': [], 'merge-needed': [], orphan: [], missing: [] };
  for (const key of new Set([...seedMap.keys(), ...Object.keys(manifest.files)])) {
    const mVal = manifest.files[key];
    if (mVal === undefined) {
      // 种子有、台账未记账：插件升版新增种子、项目未重跑 init——重跑 init-engine 落位，归 seed-updated。
      drift['seed-updated'].push(`${key}（台账未记账——重跑 init-engine 落位）`);
      continue;
    }
    // mutable 恒 unchanged（存在即在位，不比对哈希）——前置旁路，先于 orphan/missing 判定（spec 场景 D）。
    if (isMutableValue(mVal)) { drift.unchanged.push(key); continue; }
    if (!seedMap.has(key)) { drift.orphan.push(key); continue; } // 台账有、种子清单已无
    const target = targetAbs(root, key);
    if (!fs.existsSync(target)) { drift.missing.push(key); continue; } // 台账有、盘上无
    const diskHash = hashFile(target);
    const seedHash = seedMap.get(key).hash;
    if (diskHash === mVal && seedHash === mVal) drift.unchanged.push(key);
    else if (diskHash !== mVal && seedHash === mVal) drift['user-modified'].push(key);
    else if (diskHash === mVal && seedHash !== mVal) drift['seed-updated'].push(key);
    else drift['merge-needed'].push(`${key}（${readBaseline(root, key) !== null ? '基线在场' : '无基线（首升兜底）'}）`);
  }
  for (const cat of CATEGORIES) drift[cat].sort();
  return { root, drift };
}

/**
 * formatDrift(root, drift)：报告排版——标题 + 每类一行小计 + 明细（相对路径缩进两格）+ 汇总行。
 */
export function formatDrift(root, drift) {
  const lines = [`漂移体检（ai-native-delivery engine）@ ${root}`];
  for (const cat of CATEGORIES) {
    lines.push(`${cat} ${drift[cat].length} 项`);
    for (const item of drift[cat]) lines.push(`  ${item}`);
  }
  lines.push(`漂移体检：unchanged ${drift.unchanged.length} / user-modified ${drift['user-modified'].length}`
    + ` / seed-updated ${drift['seed-updated'].length} / merge-needed ${drift['merge-needed'].length}`
    + ` / orphan ${drift.orphan.length} / missing ${drift.missing.length}`);
  return lines.join('\n');
}

// resolveRoot(explicit)：CLI 根解析（与 init-engine 同法）。失败抛 err.code='BAD_ROOT'，
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

const isMain = process.argv[1] && process.argv[1].endsWith('install-drift.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') rootArg = argv[++i];
  }
  try {
    const root = resolveRoot(rootArg);
    const collected = collectDrift(root);
    console.log(collected === null ? '无台账——先跑 init-engine' : formatDrift(root, collected.drift));
  } catch (err) {
    if (err && err.code === 'BAD_ROOT') console.error(`install-drift: ${err.message}`);
    else console.error(`install-drift: 体检失败——${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
