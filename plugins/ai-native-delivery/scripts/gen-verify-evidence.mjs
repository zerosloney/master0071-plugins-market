#!/usr/bin/env node
// gen-verify-evidence.mjs — 验证绿凭证摘要入库生成器（2026-10-09 AI-Native 架构审查 P2-3）
// 背景：verifications.jsonl 是 gitignore 的本地台账（24h 窗口、跨机不可见）——历史提交「当时验证过什么」
//   的机器事实只活在本地。本脚本把全绿行按 headShort 去重（同 SHA 取最新 ts）渲染进仓内
//   workflow/verify-evidence.md，使绿凭证成为随库持久、跨机可对质的生成物（全量台账仍留本地）。
// 语义：一行 = 「**验证时刻的工作树**（其基线提交 = 短 SHA，工作树可含未提交改动）过全量门禁全绿
//   （N 门 / 断言计数）」；非证据链签名——本地台账可伪造的诚实边界不变（check-loop 检查 15 头注释口径），
//   入库摘要只是把「曾有凭证」从易失升级为难失。
// 归因提醒（2026-10-10 实证）：短 SHA 只是**基线提交**，不等于被测内容。关单应「先提交、后跑门」，
//   否则绿行 SHA 指向未含本次改动的上一提交——同一 SHA 可能既有绿行（脏工作区跑）又有红记录。
// 追加保全（2026-10-10 复核 S2，用户裁定采纳）：已入仓的行不因本地台账缺失而被抹掉——台账 per-worktree
//   且 gitignore，整段重写会让跨机/换 worktree 的历史凭证消失。合并口径 = 仓内既有行 ∪ 本地台账绿行，
//   同 headShort 取更新 ts（平局取本地台账，保持「重跑刷新凭证」语义）。代价（已接受）：仓内错行不会被
//   重生成自动纠正——须人工改正；若本地台账仍持同一 SHA，重生成会按台账重写该行（须连同台账处理）。
// 时机：verify.mjs 全绿尾部自动重生成（2026-10-11 C4 事件原子化——检查 23 收敛硬门读本文件，滞后即误拦）
//   + 关单时随三件套同笔提交；CI 侧重生成于 CI 工作区、不回流本仓，无副作用；--check 只供本地自检。
// 用法：node .agents/scripts/gen-verify-evidence.mjs [--root <dir>] [--check]
// 测试：node .agents/scripts/gen-verify-evidence.test.mjs（fixture 注入 --root）
import fs from 'node:fs';
import path from 'node:path';
// 路径收口（2026-10-27 插件化迁移）：项目根 git root 锚定（paths.mjs 单源），非 git 环境回退插件根
//（源仓 SCRIPT_DIR/../.. 的引擎目录锚等位点）；--root 注入（verify.mjs 尾段 / 测试夹具）原样保留。
import { PLUGIN_ROOT, findProjectRoot } from './paths.mjs';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const ROOT = argOf('--root') || findProjectRoot() || PLUGIN_ROOT;
const LEDGER = path.join(ROOT, '.agents', 'verifications.jsonl');
const OUT = path.join(ROOT, 'workflow', 'verify-evidence.md');

const ROW_RE = /^\|\s*`([0-9a-f]{7,40})`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/;

/** 按本地台账条目渲染数据行 */
function renderRow(e) {
  const cnt = Number.isFinite(e.passed) ? `PASS ${e.passed} / FAIL ${e.failed ?? 0}` : '—';
  // scope 标记（verify-diet 2026-10-21 ②）：增量关单绿行末列自带面与基线——审计可对质「跳了哪些门」；
  // 门数列显示实跑数（如 10），与全量 16 行天然可辨。baseSource=evidence（verify-evidence-fallback
  // 2026-10-22）显式标注「基线取自仓库凭证而非本地台账」——诚实边界不降，来源可对质。
  const scopeNote = e.scope
    ? `scope=${e.scope.mode}(base=${e.scope.base}${e.scope.baseSource === 'evidence' ? ',src=evidence' : ''},skip=${(e.scope.skipped || []).length})`
    : '';
  // flaky 重跑绿（gate-health 2026-10-22）：末列标 `flaky=<门>`——首跑红、重跑绿的事实不丢。
  const flakyNote = Array.isArray(e.flaky) && e.flaky.length ? `flaky=${e.flaky.join('+')}` : '';
  // 分层跑（2026-10-23）：diff 档 engine-tests 用 --fast——末列标 `fast=engine-tests`，审计可对质。
  const fastNote = e.fastTests ? 'fast=engine-tests' : '';
  // envSkips（2026-10-27 anchor-envskip）：CI-only 门被 loud-skip 的绿行实跑门数 < 门表，
  // 但此前末列仍显示 `—`，外观与全量绿行无异（实测 11 条被下游当基线用了 20 次）。
  // 显式渲染跳过事实，使「该行没跑哪些门」在摘要面可见，且 parseEvidenceGreens 也会拒作全量锚。
  const envNote = Array.isArray(e.envSkips) && e.envSkips.length ? `skip-env=${e.envSkips.join('+')}` : '';
  return `| \`${e.headShort}\` | ${e.ts} | ${e.gates} | ${cnt} | ${[scopeNote, flakyNote, fastNote, envNote, e.runId].filter(Boolean).join(' ') || '—'} |`;
}

/**
 * 解析本文件既有数据行（追加保全用，2026-10-10 复核 S2）。
 * 只认形态完整的数据行；说明行 / 表头 / 注释一律忽略。读不到文件 = 无既有行。
 */
function parseCommittedRows() {
  const out = [];
  let disk = '';
  try { disk = fs.readFileSync(OUT, 'utf8'); } catch { return out; }
  for (const raw of disk.split(/\r?\n/)) {
    const m = raw.trim().match(ROW_RE);
    if (m) out.push({ headShort: m[1], ts: m[2].trim(), line: raw.trim() });
  }
  return out;
}

function render() {
  const rows = [];
  try {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.exitCode === 0 && e.suite === 'all-gates' && e.headShort) rows.push(e);
      } catch { /* 坏行跳过——台账是 append-only 事实流，不因单行格式失败中断 */ }
    }
  } catch { /* 无台账 = 空表（新装户/新 clone 首跑前） */ }
  // 行统一形态 { headShort, ts, line }。先放**仓内既有行**（追加保全），再叠加本地台账绿行。
  const bySha = new Map();
  for (const r of parseCommittedRows()) bySha.set(r.headShort, r);
  // 同 headShort 取更新 ts（重跑刷新凭证，不堆行）；平局取本地台账
  for (const e of rows) {
    const prev = bySha.get(e.headShort);
    if (!prev || String(e.ts) >= String(prev.ts)) bySha.set(e.headShort, { headShort: e.headShort, ts: String(e.ts), line: renderRow(e) });
  }
  const ordered = [...bySha.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const lines = [];
  lines.push('# 验证绿凭证摘要（生成物，勿手改）');
  lines.push('');
  lines.push('> 生成器 `node .agents/scripts/gen-verify-evidence.mjs`（verify.mjs 全绿尾部自动重生成，2026-10-11 C4 起；源 .agents/verifications.jsonl 为本地台账）。');
  lines.push('> 一行 = 验证时刻**工作树**过全量门禁全绿（短 SHA 为该时刻的**基线提交**，工作树可能含未提交改动——关单宜「先提交、后跑门」）；`计数` 为断言 PASS/FAIL（无汇总行时缺省）。末列 `scope=diff(base=…,skip=N)` 行为增量关单凭证（verify --scope：未触产品重门，实跑门数见门数列，口径见 verify-scope.mjs）；`src=evidence` 表示基线取自本文件（仓库凭证）而非本地台账；`flaky=<门>` 表示该门首跑红、隔离重跑绿（gate-health 2026-10-22）；`fast=engine-tests` 表示 diff 档 engine-tests 用了 --fast（2026-10-23 分层跑）；`skip-env=<门>` 表示本地 loud-skip 了 CI-only 门（2026-10-27 anchor-envskip）——带此前缀的行**不作全量锚**，与 scope/fast 同属裁剪凭证。非签名链——诚实边界同 check-loop 检查 15。');
  lines.push('> 行来源 = 本地台账绿行 ∪ 本文件既有行（**追加保全**：跨机 / 换 worktree 不失历史；代价：错行不会被重生成自动纠正，须人工改正后重跑）。');
  lines.push('');
  lines.push('| 提交(短SHA) | 时间(UTC) | 门数 | 断言计数 | runId |');
  lines.push('|---|---|---|---|---|');
  for (const e of ordered) lines.push(e.line);
  lines.push('');
  lines.push(`<!-- GENERATED:END — 共 ${ordered.length} 行；gen-verify-evidence.mjs 生成（既有行追加保全，勿手改） -->`);
  return lines.join('\n') + '\n';
}

const text = render();
if (argv.includes('--check')) {
  let disk = '';
  try { disk = fs.readFileSync(OUT, 'utf8'); } catch { /* 缺文件走漂移分支 */ }
  if (disk === text) { console.log('[verify-evidence] ✅ 与磁盘一致'); process.exit(0); }
  console.error('[verify-evidence] 漂移：本地台账有新绿行未入摘要——关单时跑 node .agents/scripts/gen-verify-evidence.mjs 并随同提交');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`✅ 已生成 ${path.relative(process.cwd(), OUT)}（绿凭证 ${text.split('\n').length - 8} 行）`);
