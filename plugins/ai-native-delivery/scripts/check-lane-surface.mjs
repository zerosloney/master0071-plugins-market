#!/usr/bin/env node
// check-lane-surface.mjs — 泳道完整性门禁（pre-commit 增量 + CI diff 面；drift-hardening；
//   ai-native-review-p1：面清单分段（engine/product）+ 新增 --ci 模式，补「CI/PR 复跑面无对应检查」缺口）
// 检查 A「触达面判低」（pre-commit 增量）：暂存 diff 命中 L2 触达面（.agents/config/lane-surfaces.txt，
//   ERE 逐行；# 注释与空行忽略；文件缺失或清单为空 = 检查跳过，装户无感）时——
//   engine 段沿用活跃入口判据：
//     存在活跃 high（L2/L3；incident 的 fixed 仍算活跃）→ 放行
//     （归因歧义为已知边界：机器不猜「哪个入口在干这批改动」）；
//     活跃入口全为 L1（含级别缺失）→ hard 拦，点名最新 L1 入口 + 三选修法；
//     无任何活跃入口 → advisory（docs / bootstrap 豁免类改动的合法形态）。
//   product 段（2026-10-10）按路径归因，不因「任一活跃 high」放行全部命中：
//     每条产品路径放行当且仅当——
//     ① 暂存集含 L2/L3 intent 或 incident（状态不限，lane === high，_TEMPLATE 除外）——罩住本批全部产品命中；
//     ② 工作区 draft/approved 的 high intent，或 open 的 high incident，其家族正文写出该仓库相对路径。
//        家族 = 入口文件 + 同名 spec + 同名 plan。schema / 数据修复 SQL 写出批次目录即罩住该目录。
//     fixed incident 不罩产品面。有路径未被罩住 → hard 拦「产品契约面无活跃入口」。
//     三笔提交的代码笔靠 ②（正文里的路径）罩住，不要求协伴与代码同暂存。
//   活跃（engine 与「触达面判低」）= intents draft/approved + incidents open/fixed（incident≡intent 等价口径）
//   + 无同名 intent/incident 的 L1 plan（draft/approved；2026-10-10 plan 即入口）。有入口的 plan 不重复计入。
//   experiment/* 分支检查 A 降级 advisory（泳道哲学：PoC 免闭环纪律；转正加固门已于 2026-10-10 退役，见机制台账）。
//   合并进行中（MERGE_HEAD 在场，或 pre-merge-commit 显式传入 --merge）→ 检查 A 跳过
//   （合并提交不引入新首发改动，各笔已在自身提交时刻过门；
//   ai-native-review-p1：产品面登记后若不豁免会把每个合法 PR 的合并提交拦死。
//   2026-10-15：git merge 自动提交时 MERGE_HEAD 已不可靠，只认 --merge）。
// 检查 A'「CI diff 面」（--ci，ai-native-review-p1）：对 diff（基准→HEAD）命中 product 段的文件，
//   要求 diff 内**协伴** ≥1 份 L2/L3 workflow 入口文档（intents/incidents，状态不限——done 亦算：
//   PR/合并时刻三件套通常已关单，「活跃入口」判据在该时刻必然假阳性）。协伴路径**含归档件**
//   （workflow/archive/<批次>/intents|incidents/*.md，lane-surface-ci-archive）——关单即归档，
//   若只认活跃路径则合并提交（基准 HEAD^1 带入对侧已归档家族）必被误拦。engine 段 CI 不执法（仅 advisory）。
//   基准事实（一手事实原则，见下）按序取：
//     ① 显式 --base <rev>；
//     ② HEAD 为合并提交（≥2 父）→ HEAD^1（云端 PR 检出即服务端预合并形态；main 的 PR 完成推送同形态）；
//     ③ TF_BUILD 且 BUILD_SOURCEBRANCH 末段为 main → CI_PUSH_BEFORE（本次构建最老一笔的第一父，
//        同一次 push 的多笔都在 diff 内）；变量缺失或 diff 失败 → HEAD~1（仅核末笔，advisory 留痕）；
//     ④ 无基准事实 → advisory 跳过 exit 0（本地手跑请传 --base）。
//   ②③ 均不可得而 diff 又拿不到（--base 给坏 rev 等）→ fail-closed exit 1，禁静默空集放行。
//   检查 B 在 --ci 模式跳过（staged-intent 概念仅存在于提交时刻）。
//   先例边界更新：2026-10-01 版「CI / pre-push 复跑面无对应全量检查（树级反推违背判据原则）」自本版起失效——
//   本 CI 模式不做树级反推，判据是「diff 文件清单 + diff 内文档 frontmatter」两份一手事实。
//   标记是加固门覆盖率的前提且补写零成本——advisory 免的是纪律负担，不免标记本身。
// 判据原则（incidents/2026-09-28-batch-ledger-audit 教训）：只用一手事实——暂存/diff 文件清单、
//   当前分支名、工作区 frontmatter 字段；不用时间戳 / 字符串相等反推过程事实。
// 边界：git 调用一律 -c core.quotepath=off（非 ASCII 路径教训，先例见 papercuts 2026-09）；
//   frontmatter 读取容忍 CRLF（显式按 \r?\n 切分）；detached HEAD 分支不可判 → A 按 strict、
//   B 跳过（沿 pairing 门先例）；配置行正则语法错误 → fail-closed（防静默空洞）。
// 用法：node check-lane-surface.mjs [--merge] [--root <dir>] [--branch <名>] [--staged-file <清单文件>]
//       node check-lane-surface.mjs --ci [--base <基准rev>] [--root <dir>] [--ci-file <清单文件>]
//   （--root/--branch/--staged-file/--ci-file 为测试注入位；缺省自 git 发现。staged/ci-file 每行一个仓库相对路径）
// 退出码：0 放行（含 advisory）；1 阻断（stderr 出 [标签] 消息与修法）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { laneOfDoc } from './stage-gates.mjs';
import { loadKitPolicy } from './policy.mjs';

// 本次构建关联提交里时间最早的一笔。changes 为 CI 平台 changes API 的 JSON（{value:[]}）或数组。
// 缺 id、或任一笔没有 timestamp（无法判定谁更老）→ null，调用方退回 HEAD~1。
export function oldestChangeId(changes) {
  const list = Array.isArray(changes) ? changes : (changes && Array.isArray(changes.value) ? changes.value : []);
  const rows = list.filter((c) => c && /^[0-9a-f]{40}$/i.test(c.id || ''));
  if (!rows.length || rows.some((c) => typeof c.timestamp !== 'string' || !c.timestamp)) return null;
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  return rows[0].id;
}

// parentOf(id) 返回该提交的第一父（40 位 hex）。解析失败 → before: null，流水线不阻断。
export function ciPushBefore(changes, parentOf) {
  const id = oldestChangeId(changes);
  if (!id) return { before: null, reason: '关联提交为空，或缺少可排序的 timestamp / 合法 id' };
  let parent = '';
  try { parent = String(parentOf(id) || '').trim(); } catch { parent = ''; }
  if (!/^[0-9a-f]{40}$/i.test(parent)) return { before: null, reason: `提交 ${id} 的第一父不是 40 位 sha` };
  return { before: parent.toLowerCase(), reason: 'ok' };
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};

const gitRun = (cwd, gitArgs) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...gitArgs], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '') };
};
const gitOut = (cwd, gitArgs) => {
  const r = gitRun(cwd, gitArgs);
  return r.ok ? r.out : '';
};

const CI = argv.includes('--ci');
const FORCE_MERGE = argv.includes('--merge');
const ROOT = argOf('--root') || gitOut(process.cwd(), ['rev-parse', '--show-toplevel']).trim() || process.cwd();
// detached HEAD 时 abbrev-ref 返回 'HEAD' → 不匹配 experiment/* → A strict
const BRANCH = argOf('--branch') || gitOut(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const stagedArg = argOf('--staged-file');
const ciFileArg = argOf('--ci-file');
const baseArg = argOf('--base');

const isExperiment = /^experiment\//.test(BRANCH);
// 泳道协议锚（单源 policy.mjs）：无 engine.json 的测试夹具回落 v1（无键=双字段协议从未生效，单字段判）

// frontmatter 读取（CRLF 容忍；口径同 check-loop fmGet：--- 包夹、键行前缀匹配）
const fmOf = (file) => {
  const fm = {};
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return fm;
  }
  if (!/^---\s*$/.test(lines[0] || '')) return fm;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) break;
    const m = lines[i].match(/^([^:]+):\s*(.*)$/);
    if (m) fm[m[1].trim()] = m[2].trim();
  }
  return fm;
};

// workflow 入口文档的泳道。非 intents/incidents、或 _TEMPLATE → null。
// 泳道单源 laneOfDoc（级别单字段）。CI 协伴与产品面暂存协伴共用这一判据。
// 归档感知（lane-surface-ci-archive）：关单即归档是 sanctioned 生命周期终态，
//   归档件（workflow/archive/<批次>/intents|incidents/*.md）与活跃件同判 lane（级别照读归档文件）——
//   与 check-ledger-invariant 的 docExists、check-loop 配对门「归档件不触发」同口径。
//   修复动因：CI diff 面对合并提交取 HEAD^1，会把 develop 侧「已关单且已归档」家族的 schema SQL
//   带入 diff，原正则只认活跃路径 → 漏认协伴、把合法合并误拦。
const workflowDocLane = (rel) => {
  if (!/^workflow\/(?:archive\/[^/]+\/)?(intents|incidents)\/[^/]+\.md$/.test(rel) || path.basename(rel) === '_TEMPLATE.md') return null;
  const fm = fmOf(path.join(ROOT, rel));
  return laneOfDoc(fm['级别'] || '');
};

// 触达面配置：缺失/空 → []（检查 A 跳过）；语法错误 → fail-closed
// 段协议（ai-native-review-p1）：`## engine` / `## product` 行切换后续 ERE 的类别——
//   engine = 引擎/门禁自身面（无活跃入口 advisory）；product = 产品契约/schema 面
//   （暂存 L2/L3 协伴罩住本批；否则每条路径须写在 draft/approved high intent 或 open high incident
//   的家族正文里。CI 模式只执法 product 段，判据仍是 diff 内协伴）。
//   标记行出现前的 ERE 默认 engine（向后兼容装户既有清单）。
const SECTION_RE = /^##\s*(engine|product)\s*$/i;
const loadPatterns = () => {
  const file = path.join(ROOT, '.agents', 'config', 'lane-surfaces.txt');
  if (!fs.existsSync(file)) return [];
  const bad = [];
  let cls = 'engine';
  const pats = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && (!l.startsWith('#') || SECTION_RE.test(l))) // 段标记以 # 起头但须保留（先于注释过滤识别）
    .map((l) => {
      const sec = l.match(SECTION_RE);
      if (sec) { cls = sec[1].toLowerCase(); return null; }
      try {
        return { re: new RegExp(l), cls };
      } catch {
        bad.push(l);
        return null;
      }
    })
    .filter(Boolean);
  if (bad.length) {
    console.error(`泳道完整性${CI ? '（CI）' : '（增量）'}— BLOCK:\n  [面清单语法错误] .agents/config/lane-surfaces.txt 存在非法 ERE 行：${bad.join(' | ')}\n  修法：修正或删除该行后重试（fail-closed，防静默空洞）`);
    process.exit(1);
  }
  return pats;
};

// 活跃入口收集（incident≡intent 等价；日期键 intent=日期 / incident=发现）。
// 泳道单源 laneOfDoc（2026-10-10 收敛系列 2 起级别单字段协议，原 risk_level 双字段协议退役，
// 见机制台账）——suspect（缺失/非法）不计 high（不作豁免依据）、计入拦截集（消息给「补级别」指引）。
const ACTIVE = {
  intent: new Set(['draft', 'approved']),
  incident: new Set(['open', 'fixed']),
};
const collectActive = () => {
  const out = [];
  for (const [dir, kind, dateKey] of [['intents', 'intent', '日期'], ['incidents', 'incident', '发现']]) {
    const dirPath = path.join(ROOT, 'workflow', dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const f of fs.readdirSync(dirPath).sort()) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const fm = fmOf(path.join(dirPath, f));
      if (!ACTIVE[kind].has(fm['状态'] || '')) continue;
      const lane = laneOfDoc(fm['级别'] || '');
      out.push({ rel: `workflow/${dir}/${f}`, base: f.replace(/\.md$/, ''), level: fm['级别'] || '', lane, date: fm[dateKey] || '', status: fm['状态'] || '', kind });
    }
  }
  const planDir = path.join(ROOT, 'workflow', 'plans');
  if (fs.existsSync(planDir)) {
    for (const f of fs.readdirSync(planDir).sort()) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      if (fs.existsSync(path.join(ROOT, 'workflow', 'intents', f)) || fs.existsSync(path.join(ROOT, 'workflow', 'incidents', f))) continue;
      const fm = fmOf(path.join(planDir, f));
      if (fm['级别'] !== 'L1' || !ACTIVE.intent.has(fm['状态'] || '')) continue;
      const lane = laneOfDoc(fm['级别'] || '');
      out.push({ rel: `workflow/plans/${f}`, base: f.replace(/\.md$/, ''), level: 'L1', lane, date: fm['日期'] || '', status: fm['状态'] || '', kind: 'plan' });
    }
  }
  return out;
};

// 产品路径 p 被家族正文罩住：正文含仓库相对路径原文；schema / 数据修复 SQL 另认批次目录。
const BATCH_DIR = /^(wiki\/数据维护\/(?:schema变更|数据修复)\/[^/]+)\//;
const familyText = (entry) => {
  const rels = [entry.rel, `workflow/specs/${entry.base}.md`, `workflow/plans/${entry.base}.md`];
  let text = '';
  for (const rel of rels) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    text += `\n${fs.readFileSync(abs, 'utf8')}`;
  }
  return text;
};
const entryCoversProductPath = (text, hit) => {
  const norm = String(hit || '').split('\\').join('/');
  if (!norm) return false;
  if (text.includes(norm)) return true;
  const batch = norm.match(BATCH_DIR);
  return !!(batch && text.includes(batch[1]));
};

const blocks = [];
const advisories = [];
const patterns = loadPatterns();
const hitClass = (p) => {
  const hit = patterns.find((pt) => pt.re.test(p));
  return hit ? hit.cls : null;
};

// ============================ --ci 模式（CI diff 面，2026-10-09） ============================
if (CI) {
  // 基准事实解析（顺序见文件头 ①-④；无事实 → advisory 跳过，坏事实 → fail-closed）
  let FILES;
  let baseWhy = '';
  if (ciFileArg) {
    FILES = fs.readFileSync(ciFileArg, 'utf8').split(/\r?\n/).filter(Boolean);
    baseWhy = '--ci-file 注入（测试位）';
  } else {
    let base = '';
    if (baseArg) {
      base = baseArg;
      baseWhy = `显式 --base ${baseArg}`;
    } else {
      const rl = gitRun(ROOT, ['rev-list', '--parents', '-n', '1', 'HEAD']);
      if (!rl.ok) {
        console.error(`泳道完整性（CI）— advisory:\n  [跳过] 非 git 环境且未注入基准——本地手跑请传 --base <rev>\n`);
        process.exit(0);
      }
      const parents = rl.out.trim().split(/\s+/).filter(Boolean);
      if (parents.length >= 3) {
        base = 'HEAD^1';
        baseWhy = 'HEAD 为合并提交 → 对第一父基准（云端 PR 检出 / PR 完成推送形态）';
      } else if (process.env.TF_BUILD && /main$/.test(process.env.BUILD_SOURCEBRANCH || '')) {
        const before = (process.env.CI_PUSH_BEFORE || '').trim();
        const beforeOk = /^[0-9a-f]{40}$/i.test(before)
          && gitRun(ROOT, ['diff', '--name-only', `${before}..HEAD`]).ok;
        if (beforeOk) {
          base = before;
          baseWhy = 'TF_BUILD main 单亲推送 → CI_PUSH_BEFORE（本次构建最老一笔的第一父，同一次 push 的多笔都在 diff 内）';
        } else {
          if (before) advisories.push(`[CI]（advisory）CI_PUSH_BEFORE=${before} 不能作为 diff 基准，退回 HEAD~1（多提交直推仅核末笔）`);
          base = 'HEAD~1';
          baseWhy = 'TF_BUILD main 单亲推送 → HEAD~1（未得到可用的 CI_PUSH_BEFORE；多提交直推仅核末笔）';
        }
      }
    }
    if (!base) {
      console.error(`泳道完整性（CI）— advisory:\n  [跳过] 无 diff 基准事实（非合并提交、非 TF main 推送）——本地手跑请传 --base <rev>\n`);
      process.exit(0);
    }
    const d = gitRun(ROOT, ['diff', '--name-only', `${base}..HEAD`]);
    if (!d.ok) {
      console.error(`泳道完整性（CI）— BLOCK:\n  [基准不可解] git diff ${base}..HEAD 失败——fail-closed，禁静默空集放行\n  修法：确认基准 rev 存在（本地预检常用 --base origin/main 或 --base main）`);
      process.exit(1);
    }
    // 不设 --diff-filter：删除契约/schema 文件同样是触达面事件（与 pre-commit 的 ACMR 口径差异为有意为之）
    FILES = d.out.split(/\r?\n/).filter(Boolean);
    baseWhy = `${baseWhy}（diff ${base}..HEAD，${FILES.length} 文件）`;
  }

  const engineHits = FILES.filter((p) => hitClass(p) === 'engine');
  if (engineHits.length) {
    advisories.push(`[CI]（advisory）diff 命中引擎面（## engine 段，${engineHits.length} 文件）——CI 不拦引擎面；提交钩子已不跑本脚本`);
  }
  const productHits = FILES.filter((p) => hitClass(p) === 'product');
  if (productHits.length) {
    // 协伴判据：diff 内的入口文档（intents/incidents；状态不限——done 亦算，PR 时刻常已关单）
    const highDocs = FILES.filter((p) => workflowDocLane(p) === 'high');
    if (!highDocs.length) {
      blocks.push([
        `[CI·产品契约面无协伴入口] diff 命中产品 L2 触达面（## product 段），但 diff 内无任何 L2/L3 workflow 入口文档协伴：`,
        `  基准: ${baseWhy}`,
        `  命中: ${productHits.join(' ')}`,
        `  语义: 共享契约 / schema 面改动须随行携带 L2+ 入口（三件套随代码同一提交；状态不限——done 亦算）`,
        `  修法（二选一）: ① 补 L2/L3 intent/incident 入口并随本 diff 携带（.agents/commands/plan.md / maintain.md）`,
        `    ② 面清单误配则修 .agents/config/lane-surfaces.txt`,
      ].join('\n'));
    } else {
      console.error(`泳道完整性（CI）— info:\n  [CI·泳道] 产品面命中 ${productHits.length} 文件，协伴 L2+ 入口: ${highDocs.map((p) => path.basename(p)).join(' ')}\n`);
    }
  }
  for (const a of advisories) console.error(`泳道完整性（CI）— advisory:\n${a}\n`);
  if (blocks.length) {
    for (const b of blocks) console.error(`泳道完整性（CI）— BLOCK:\n${b}\n`);
    console.error('CI: 泳道完整性（diff 面）未通过——共享契约/schema 改动未携带 L2+ 入口文档');
    process.exit(1);
  }
  process.exit(0);
}

// ============================ pre-commit 增量模式（原路径） ============================
const STAGED = stagedArg
  ? fs.readFileSync(stagedArg, 'utf8').split(/\r?\n/).filter(Boolean)
  : gitOut(ROOT, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean);

// --- 检查 A：触达面判低 ---
const hits = patterns.length ? STAGED.filter((p) => patterns.some((pt) => pt.re.test(p))) : [];
if (hits.length) {
  const merging = FORCE_MERGE || gitRun(ROOT, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
  if (merging) {
    const why = FORCE_MERGE ? '--merge 显式标记' : 'MERGE_HEAD 在场';
    advisories.push(`[触达面判低]（advisory）合并进行中（${why}）——检查 A 跳过：合并提交不引入新首发改动，各笔已在自身提交时刻过门`);
  } else {
    const productHits = hits.filter((p) => hitClass(p) === 'product');
    const engineHits = hits.filter((p) => hitClass(p) === 'engine');
    const active = collectActive();
    // 产品面按路径归因。暂存的 L2/L3 协伴罩住本批全部产品命中。
    // 否则 draft/approved high intent 与 open high incident 只罩住家族正文写明的路径。
    // fixed incident 仍计入下方 engine 的活跃 high，但不罩产品面。
    if (productHits.length) {
      const stagedHigh = STAGED.some((p) => workflowDocLane(p) === 'high');
      const coverEntries = active.filter((e) =>
        (e.kind === 'intent' && e.lane === 'high')
        || (e.kind === 'incident' && e.status === 'open' && e.lane === 'high'));
      const texts = new Map(coverEntries.map((e) => [e.rel, familyText(e)]));
      const uncovered = stagedHigh
        ? []
        : productHits.filter((p) => !coverEntries.some((e) => entryCoversProductPath(texts.get(e.rel), p)));
      if (uncovered.length) {
        const text = [
          `[产品契约面无活跃入口] 暂存命中产品 L2 触达面（## product 段），但没有罩住这些路径的 L2/L3 入口：`,
          `  命中: ${uncovered.join(' ')}`,
          `  语义: 每条产品路径须由下列之一罩着——本次暂存的 L2/L3 intent 或 incident（状态不限，罩住本批全部产品命中）；或工作区 draft/approved 的 L2/L3 intent、open 的 L2/L3 incident，且入口或同名 spec/plan 正文写出该仓库相对路径（schema 与数据修复 SQL 写出批次目录即罩住该目录）。fixed 的 incident 不罩产品面`,
          `  修法（二选一）: ① 把仓库相对路径写入在途 L2/L3 的 intent、spec 或 plan（.agents/commands/plan.md / maintain.md），或把该入口放进本次暂存`,
          `    ② 面清单误配则修 .agents/config/lane-surfaces.txt`,
        ].join('\n');
        if (isExperiment) advisories.push(`（advisory·experiment 泳道，不阻断）\n${text}`);
        else blocks.push(text);
      }
    }
    if (engineHits.length) {
      const hasHigh = active.some((e) => e.lane === 'high');
      if (!hasHigh) {
        const low = active.filter((e) => e.lane !== 'high'); // low + suspect 均拦（suspect 不作豁免依据）
        if (low.length) {
          const newest = [...low].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.rel.localeCompare(a.rel))[0];
          // plan 形态不可原地升级别：L2/L3 plan 须先有同名 intent/incident + 确认 spec（stage-gates plan 门），
          // 且同名入口落地后该 plan 即退出活跃集（collectActive 不重复计）——出路是按 L2 流程立同名 intent+spec 接棒。
          // suspect 分支只可能是 intent/incident（plan 收集要求级别恰为 L1），故 suspect 文案无须分支。
          const fixVerb = newest.lane === 'suspect'
            ? '① 补该入口「级别」至合法的 L2/L3（现缺失/非法）并补同名 spec（.agents/commands/design.md）'
            : newest.kind === 'plan'
              ? '① 按 L2 流程立同名 intent（L2/L3）+ 同名 spec 接棒（.agents/commands/plan.md / design.md）——L1 plan 本身即入口、无需 spec，原地升 plan 级别会因缺同名入口被 stage-gates 拒'
              : '① 升级该入口「级别」至 L2/L3 并补同名 spec（.agents/commands/design.md）';
          const text = [
            `[触达面判低] 暂存命中 L2 触达面，但活跃入口无泳道 high（存在 low/suspect）：`,
            `  命中: ${engineHits.join(' ')}`,
            `  关联入口: ${newest.rel}（级别 ${newest.level || '缺失'}→ 泳道 ${newest.lane}${newest.date ? `，${newest.date}` : ''}；活跃非 high 共 ${low.length} 件）`,
            `  修法（三选一）: ${fixVerb}`,
            `    ② 该入口已完成则关单（done）或显式放弃（superseded/cancelled）——不留活跃残留`,
            `    ③ 面清单误配则修 .agents/config/lane-surfaces.txt`,
          ].join('\n');
          if (isExperiment) advisories.push(`（advisory·experiment 泳道，不阻断）\n${text}`);
          else blocks.push(text);
        } else {
          advisories.push(`[触达面判低]（advisory）暂存命中 L2 触达面（${engineHits.length} 个文件），但当前无任何活跃入口——若非 docs / bootstrap 豁免类改动（.agents/commands/new-task.md §intent 豁免），请先立入口文档`);
        }
      }
    }
  }
}

for (const a of advisories) console.error(`泳道完整性（增量）— advisory:\n${a}\n`);
if (blocks.length) {
  for (const b of blocks) console.error(`泳道完整性（增量）— BLOCK:\n${b}\n`);
  console.error('pre-commit: 泳道完整性未通过，提交已阻止（spec: workflow/specs/2026-10-01-drift-hardening.md）');
  process.exit(1);
}
process.exit(0);
}
