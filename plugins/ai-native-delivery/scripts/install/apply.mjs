// install/apply.mjs — 计划裁决与落盘（plan/apply 两段式的 apply 段；2026-11 安装引擎重构）
// 裁决六态（目标 = 条目落点；台账 = <root>/.agents/install-manifest.json 记的上次安装基线；
// 哈希一律 CRLF→LF 归一口径，见 manifest.mjs）：
//   目标不存在                                  → create（落盘并记账）
//   台账在 + 目标==台账 + 种子≠台账             → update（种子升级传播到未被动过的装户文件）
//   台账在 + 目标≠台账（用户改过）              → merged / conflict-skip / --force 覆盖（见下）
//   目标在但台账无此记录                        → 沿用旧语义 skip（不覆盖、不记账）
//   台账文件整个缺失（旧版 init 过的项目）      → 领养模式：不覆盖任何文件，现状哈希全部记入新账
// merged 出口（场景 B）：conflict 分支里、判 conflict-skip 之前，四条件齐备才试三方合并——
//   非 mutable + 非钩子条目 + 基线在场（readBaseline 非 null）+ 双方都改（目标≠台账 && 种子≠台账），
//   且 --force 优先于合并（显式整覆盖不试 merge）。git merge-file：base=基线正文、ours=盘上正文、
//   theirs=种子正文——clean → 落盘合并结果（LF）+ 台账记种子侧哈希 + 基线写新种子正文；
//   conflict（1–127）/ unavailable（git 缺席或异常）→ 降级回 conflict-skip（输出语义逐字节不变）。
// 基线判据：基线 = 「本机上一次由工具写入的种子正文」，故三条种子写盘路径（create / update /
//   merged-clean）后 writeBaseline 都写**种子正文**而非合并结果——用户在合并结果上的后续手改仍可
//   与下一轮种子演进再合并（kit baselineText 同款）；merged 的台账记种子侧哈希（e.hash，同
//   create/update；kit 判据「合并结果含用户内容，不刷新哈希」——若记合并结果哈希，下轮种子未变的
//   重跑会命中 update 通道整覆盖，用户合并内容即丢）。
// 旁路声明：钩子条目（applyHook 路径——正文烘焙本机插件路径，三方合并无意义且可产出指向失效
//   路径的合并钩子）与 mutable 条目（存在即在位语义）一律不进 merged 与基线通道。由分派结构
//   保证：applyFile 只收非钩子文件条目，mutable 在冲突裁决前先行返回。
// 迁移链接线（场景 C）：readManifest 之后、裁决之前跑 migrateManifest——旧台账（缺 schemaVersion
//   视作 0）迁到当前版本后再裁决；迁移只转内存对象，changed 且非 dryRun 时经末尾既有台账写入口
//   一并落盘（serializeManifest 比对 + writeManifestAtomic，不新增写入口）；迁移抛错（如
//   MANIFEST_SCHEMA 台账版本超前）原样上抛，由 CLI 层 catch 后非零退出，不吞。
// 例外面（语义平移自旧 init-engine）：
//   gitignore 标记块保留「整块替换/追加/unchanged」语义，不入账；
//   git hooks 保留「陈旧自装钩子覆盖刷新」例外，且先于台账裁决（钩子的用户面走 report.hooks，
//   updated/conflict 平铺清单只收非钩子文件——钩子活动在其专属报告面已全量可见）。
// dryRun：完整走一遍裁决与报告但零写盘（含台账与基线）。幂等：台账内容不变不重写（保住全树 mtime 快照比对）。
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from '../paths.mjs';
import { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_ENTRIES } from './plan.mjs';
import { manifestPath, readManifest, serializeManifest, writeManifestAtomic, hashFile, newManifest } from './manifest.mjs';
import { readBaseline, writeBaseline, mergeThreeWay } from './baseline.mjs';
import { migrateManifest } from './migrations.mjs';

// plan 条目 → 目标绝对路径（targetRel 是 posix 相对路径，'/ '分隔，可能含 '..' 段——钩子在根外时）
const targetAbs = (root, e) => path.join(root, ...e.targetRel.split('/'));

// 种子落盘：copy/settings/pipelines 原样字节拷贝（语义同旧 copyFileSync）；skeleton/runtime 空文件
// 写内联文本。写法按条目自带字段分派，不按 kind 再猜一遍。
function writeEntryContent(e, target) {
  if (e.srcAbs) fs.copyFileSync(e.srcAbs, target);
  else fs.writeFileSync(target, e.content, 'utf8');
}

// 种子正文（merged 的 theirs 与基线正文同源）：种子源文件读文本 / 内联条目取 content——
// 与 writeEntryContent 落盘的内容同源同键。
const seedText = (e) => (e.srcAbs ? fs.readFileSync(e.srcAbs, 'utf8') : e.content);

// 陈旧自装钩子判据（平移旧 installHooks，2026-11-05 迁移修复 / 2026-11 市场审查 M12 收紧）：
// 钩子里 baked 的是**插件安装目录的绝对路径**，而插件目录随宿主缓存迁移。迁移后旧钩子指向不存在
// 的脚本 → 每次 commit 崩在 MODULE_NOT_FOUND，而钩子自带的修复指引正是"重跑 init-engine"——
// "已存在即跳过"会让该指引变成 no-op。判「路径形态属于本插件」：resolve 后含**插件名**
//（plugin.json 单源，版本化缓存布局下 basename 是版本号，升版即失效）的**独立路径段**（按分隔符
// 切分后整段相等，`…-old` 后缀目录不误命中）且 baked 的引擎脚本已不存在 → 刷新；当前根前缀命中
// 是其子集，一并保留。读不出/解析不出 → 当作别人的钩子，不动。
function isStaleOwnHook(target, pluginName) {
  try {
    const cur = fs.readFileSync(target, 'utf8');
    const baked = /const\s+ENGINE_SCRIPT\s*=\s*("(?:[^"\\]|\\.)*")/.exec(cur);
    if (!baked) return false;
    const p = JSON.parse(baked[1]);
    return typeof p === 'string' && !fs.existsSync(p)
      && (p.startsWith(PLUGIN_ROOT) || path.resolve(p).split(/[\\/]/).includes(pluginName));
  } catch { return false; }
}

// 文件条目裁决（copy / settings / pipelines / runtime 空文件 / skeleton）。
function applyFile(root, e, report, manifest, adopt, force, dryRun) {
  const target = targetAbs(root, e);
  if (!fs.existsSync(target)) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeEntryContent(e, target);
      if (!e.mutable) writeBaseline(root, e.targetRel, seedText(e)); // 基线=种子正文（mutable 不入基线面）
    }
    manifest.files[e.targetRel] = e.mutable ? { mutable: true } : e.hash;
    report.created.push(e.targetRel);
    return;
  }
  // 运行时账本（workflow/ 骨架文档、三本审计账主账）：引擎与用户各自演进内容——存在即在位，
  // 不按哈希判「用户改过」，也不覆盖（首次安装已建；缺失才重建）。自举实证的真缺陷：
  // 引擎自己重生成 INDEX/metrics、追加 papercuts 后，台账按哈希比对必然失配 → doctor 恒红。
  if (e.mutable) {
    manifest.files[e.targetRel] = { mutable: true };
    report.skipped.push(`${e.targetRel}（运行时账本·引擎自有，不比对哈希）`);
    return;
  }
  const curHash = hashFile(target);
  const mHash = manifest.files[e.targetRel];
  // 领养（台账整个缺失）：现状哈希记为新基线，不覆盖。台账在但无此记录：沿用旧语义 skip（不记账）。
  if (adopt || mHash === undefined) {
    if (adopt) { manifest.files[e.targetRel] = e.mutable ? { mutable: true } : curHash; report.adopted++; }
    report.skipped.push(`${e.targetRel}（已存在）`);
    return;
  }
  if (curHash === mHash) {
    if (e.hash === mHash) { report.skipped.push(`${e.targetRel}（已存在）`); return; }
    // 台账基线未被动过、种子已升版 → 传播更新；基线随写（种子正文）
    if (!dryRun) {
      writeEntryContent(e, target);
      writeBaseline(root, e.targetRel, seedText(e));
    }
    manifest.files[e.targetRel] = e.hash;
    report.updated.push(`${e.targetRel}（种子已变更——覆盖更新）`);
    return;
  }
  // 现状 ≠ 台账基线 → 用户改过。merged 出口（场景 B）先于 conflict 判定，四条件见头注；
  // conflict（1–127，基线保留不动——下轮种子再演进可重试合并）与 unavailable（git 缺席或异常）
  // 都降级到下方 conflict-skip，输出语义逐字节不变。
  if (!force && e.hash !== mHash) {
    const base = readBaseline(root, e.targetRel);
    if (base !== null) {
      const merged = mergeThreeWay({ base, ours: fs.readFileSync(target, 'utf8'), theirs: seedText(e) });
      if (merged.status === 'clean') {
        if (!dryRun) {
          fs.writeFileSync(target, merged.text, 'utf8'); // 合并结果 LF（mergeThreeWay 三方 IO 已归一）
          writeBaseline(root, e.targetRel, seedText(e)); // 基线写新种子正文，不是合并结果
        }
        manifest.files[e.targetRel] = e.hash; // 种子侧哈希——判据见头注「合并结果含用户内容，不刷新哈希」
        report.merged.push(`${e.targetRel}（用户改动与种子升级并存——三方合并自动落盘）`);
        return;
      }
    }
  }
  if (force) {
    if (!dryRun) {
      writeEntryContent(e, target);
      writeBaseline(root, e.targetRel, seedText(e)); // --force 整覆盖写的也是种子正文，基线随写
    }
    manifest.files[e.targetRel] = e.hash;
    report.updated.push(`${e.targetRel}（--force 覆盖用户改动）`);
    return;
  }
  report.conflict.push(`${e.targetRel}（当前内容与安装台账不符——疑为用户改动，跳过不覆盖）`);
}

// 目录条目裁决（存在即跳过、缺则建——与旧逻辑一致，目录不入台账）。
function applyDir(root, e, report, dryRun) {
  const target = targetAbs(root, e);
  if (fs.existsSync(target)) { report.skipped.push(`${e.targetRel}（已存在）`); return; }
  if (!dryRun) fs.mkdirSync(target, { recursive: true });
  report.created.push(e.targetRel);
}

// gitignore 标记块（平移旧 seedGitignore）：无文件 → 新建；已有标记块 → 整块替换；无块 → 追加；
// 内容一致 → unchanged 不写盘。
// 幂等化（2026-11-20 判据移植，蓝本 agentic-flow-kit 053802e / issue #68，对应其 dedupeMergeBlock/
// blockBody/spliceBlock 三函数，按本插件单块结构适配）：①块外去重——装户在标记块以外已写的条目
//（trim 比对，标记行不参与）不再写进托管块；②块尾收敛——替换路径块体无尾换行，END 之后只剩换行串
//（或为空）时收敛为单个 eol，旧版 EOF 多空行产物本次升级收敛、此后逐字节稳定；③块体按文件既有 EOL
// 归一（含 \r\n → CRLF 否则 LF，蓝本 eolOf 判据）。无文件/无块路径既有语义不变（文件尾无换行补一个、
// 空文件直写），块外用户内容一律不动。
function applyGitignore(root, e, report, dryRun) {
  const file = targetAbs(root, e);
  const ensureNl = (s, nl) => (s === '' || s.endsWith(nl) ? s : `${s}${nl}`);
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* 无文件 → 新建 */ }
  if (cur === null) {
    if (!dryRun) fs.writeFileSync(file, `${GITIGNORE_BEGIN}\n${GITIGNORE_ENTRIES.join('\n')}\n${GITIGNORE_END}\n`, 'utf8');
    report.gitignore = 'created';
    return;
  }
  const m = /(#[^\n]*BEGIN ai-native-delivery engine[\s\S]*?#[^\n]*END ai-native-delivery engine[^\n]*)/.exec(cur);
  const eol = cur.includes('\r\n') ? '\r\n' : '\n'; // 蓝本 eolOf 判据：文件含 \r\n → CRLF，否则 LF
  // 块外行集合（标记块以外全部行，trim 后非空）：块体条目与之重复的不入块（蓝本 dedupeMergeBlock）
  const outside = m ? cur.slice(0, m.index) + cur.slice(m.index + m[0].length) : cur;
  const seen = new Set(outside.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const replacement = [GITIGNORE_BEGIN, ...GITIGNORE_ENTRIES.filter((line) => !seen.has(line.trim())), GITIGNORE_END].join(eol);
  let next;
  if (m) {
    // 替换路径（蓝本 spliceBlock）：块体无尾换行；END 后只剩换行串（或为空）→ 收敛为单个 eol
    let post = cur.slice(m.index + m[0].length);
    if (!post || /^(?:\r?\n)+$/.test(post)) post = eol;
    next = cur.slice(0, m.index) + replacement + post;
  } else {
    next = `${ensureNl(cur, eol)}${replacement}${eol}`; // 追加路径既有语义：文件尾无换行补一个
  }
  if (next !== cur) {
    if (!dryRun) fs.writeFileSync(file, next, 'utf8');
    report.gitignore = m ? 'block-replaced' : 'appended';
  } else {
    report.gitignore = 'unchanged';
  }
}

// git 钩子条目裁决。报告面沿用旧 installHooks 的消息格式（installed/skipped 文案逐字保留——
// 旧测试与外部指引按此文案断言）；台账记**渲染后**正文哈希。钩子条目旁路 merged 与基线通道
//（头注旁路声明）。
function applyHook(root, e, report, manifest, adopt, force, dryRun, pluginName) {
  const target = targetAbs(root, e);
  // 报告文案的车道标签：pre-commit / pre-push 是 check-loop 执法点（hard）；post-commit 是
  // Dreaming advisory 提醒腿（exit 恒 0 不阻断，2026-11-11 移植）——installed 文案随钩子如实标注。
  const lane = e.hookName === 'post-commit' ? 'advisory，exit 恒 0 不阻断' : 'hard 车道';
  const writeHook = () => {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.content, 'utf8');
      try { fs.chmodSync(target, 0o755); } catch { /* Windows 尽力而为（git 经 sh 启动钩子，不依赖执行位） */ }
    }
    manifest.files[e.targetRel] = e.hash;
    report.hooks.installed.push(`${e.hookName}（node ${e.enginePath}，${lane}）→ ${target}`);
  };
  if (!fs.existsSync(target)) { writeHook(); return; }
  // 领养：现状哈希记为新基线，不覆盖任何已有钩子（含陈旧自装钩子——领养模式下回退到
  // 「下轮按台账基线裁决」自愈：基线未动而渲染正文已变时走 update 刷新）。
  if (adopt) {
    manifest.files[e.targetRel] = hashFile(target);
    report.adopted++;
    report.hooks.skipped.push(`${e.hookName}（已存在同名钩子——不覆盖用户钩子）`);
    return;
  }
  // 陈旧自装钩子刷新例外：先于台账裁决（旧语义平移）——只刷「本插件装的、baked 引擎脚本已
  // 不存在」的那一类；不是本插件装的钩子保持"不覆盖用户钩子"的语义不变。
  if (isStaleOwnHook(target, pluginName)) {
    report.hooks.skipped.push(`${e.hookName}（本插件旧装钩子指向已不存在的引擎脚本——覆盖刷新）`);
    writeHook();
    return;
  }
  const mHash = manifest.files[e.targetRel];
  if (mHash === undefined) {
    // 钩子早于台账（旧版装的 / 别人装的）→ 现状 skip
    report.hooks.skipped.push(`${e.hookName}（已存在同名钩子——不覆盖用户钩子）`);
    return;
  }
  const curHash = hashFile(target);
  if (curHash === mHash) {
    if (e.hash === mHash) { report.hooks.skipped.push(`${e.hookName}（已存在同名钩子——不覆盖用户钩子）`); return; }
    writeHook(); // 台账基线未被动过、渲染正文已变（插件迁移 / 模板变更）→ 刷新
    return;
  }
  if (!force) { report.hooks.skipped.push(`${e.hookName}（已存在同名钩子——不覆盖用户钩子）`); return; }
  writeHook(); // 用户改过钩子，--force 才覆盖
}

/**
 * applyPlan(plan, { dryRun, force })：按台账裁决计划条目并落盘，返回报告。
 * @returns {{created:string[], skipped:string[], warnings:string[], gitignore:string, hooksDir:string|null,
 *            hooks:{installed:string[], skipped:string[]}, updated:string[], conflict:string[],
 *            merged:string[], adopted:number, dryRun:boolean}}
 */
export function applyPlan(plan, { dryRun = false, force = false } = {}) {
  const root = plan.root;
  const report = {
    created: [],
    skipped: [],
    warnings: [...(plan.warnings || [])],
    gitignore: 'unchanged',
    hooksDir: plan.hooksDir || null,
    hooks: { installed: [], skipped: [] },
    updated: [],
    conflict: [],
    merged: [],
    adopted: 0,
    dryRun: Boolean(dryRun),
  };
  let manifest = readManifest(root);
  const adopt = manifest === null; // 台账整个缺失（旧版 init 过的项目 / 损坏不可读）→ 领养模式
  if (adopt) {
    manifest = newManifest(plan.plugin.name, plan.plugin.version); // 构造即带 schemaVersion（首装无迁移可跑）
  } else {
    // 迁移链接线（场景 C）：裁决前把台账迁到当前版本（缺 schemaVersion 视作 0）。抛错原样上抛
    //（CLI 层 catch 后非零退出）；changed 且非 dryRun 时由下方既有台账写入口一并落盘。
    manifest = migrateManifest({ manifest }).manifest;
  }

  for (const e of plan.entries) {
    if (e.kind === 'gitignore-block') { applyGitignore(root, e, report, dryRun); continue; }
    if (e.kind === 'githook') { applyHook(root, e, report, manifest, adopt, force, dryRun, plan.plugin.name); continue; }
    if (e.dir) { applyDir(root, e, report, dryRun); continue; }
    applyFile(root, e, report, manifest, adopt, force, dryRun);
  }

  // 台账落盘（dryRun 零写盘；内容不变不重写——幂等契约要求全树快照零改动）。
  // 迁移 changed（旧台账补 schemaVersion）也走这一处比对落盘，不新增写入口。
  if (!dryRun) {
    const body = serializeManifest(manifest);
    let cur = null;
    try { cur = fs.readFileSync(manifestPath(root), 'utf8'); } catch { /* 缺文件 → 落新账 */ }
    if (body !== cur) writeManifestAtomic(root, manifest);
  }
  return report;
}
