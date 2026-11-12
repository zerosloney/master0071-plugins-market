#!/usr/bin/env node
// check-confirm-order.mjs — 先确认后改代码（判据移植 2026-11-12；源引擎 2026-11-03 建、2026-11-08
// 档 2-D 自 pre-commit 位移 commit-msg——pre-commit 时点读不到提交消息，豁免 A 的 L0 trailer 必须在
// 消息可见的时点执法；commit-msg 时点合并状态文件（MERGE_HEAD / SQUASH_MSG）已落盘）。
// 提交时刻的顺序信号：暂存了产品路径时，每条路径必须出现在「本次提交能看见」的
// workflow/plans 正文里，且该 plan 状态为 approved。
//   看得见 = 已暂存用暂存 blob；否则用 HEAD；都没有则用未跟踪的工作区文件。
//   done 的历史 plan 不算覆盖（否则旧 plan 里出现过的路径永远放行）；豁免 B（L1 单笔提交）：
//   覆盖性 plan 文件本身与产品路径同批暂存时 done 亦可（plan(done)+代码+确认分片+凭证一笔入库）。
//   draft 不算。工作区已改成 approved 但没暂存、HEAD 仍是 draft，也不算。
// 豁免 A（L0 极简道，提交时豁免通道）：消息体含非空 `L0: <判据>` 行（argv[2] = commit-msg 传入的
//   消息文件）且暂存产品文件 ≤5（L0_MAX）→ 放行，judgments 落账记 L0 观测计数；无消息文件参数时
//   豁免不生效（fail-closed）。设计定位：L0 只在提交时点给「≤5 产品文件 + 机器可 grep 判据行」的
//   小改免 intent/spec/plan 立档——不进 grade_task 两问定级、不动 lane-surfaces 闭集
//   （口径单源 commands/new-task.md §L0）。
// 合并 / squash / rebase / cherry-pick 跳过：那是在收已经写过的树，不在这里重判顺序。
//   合并的识别优先看 `--merge`，再看状态文件。
// 产品路径：产品面判据单源复用 verify-scope.mjs PRODUCT_FACES（backend / frontend 面匹配）——
//   与 verify 增量关单、本地门 lane 判据同一套口径，不另立一份业务路径清单。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEDGER_REL } from './judgment-ledger.mjs';
import { GIT } from './git-core.mjs';
import { PRODUCT_FACES } from './verify-scope.mjs';

// L0 极简道产品文件上限（档二放宽：3→5；口径单源 commands/new-task.md §L0）
// 2026-11-12 判据移植 export：check-scope-range 复用同一上限做推送级 L0 豁免（口径单源，不复制常量）。
export const L0_MAX = 5;

export function isProductPath(rel) {
  const f = String(rel).replace(/\\/g, '/');
  return PRODUCT_FACES.some((pf) => pf.match(f));
}

export function statusOf(text) {
  if (!text) return '';
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const m = fm[1].match(/^状态:\s*(\S+)/m);
  return m ? m[1].trim() : '';
}

// 覆盖性 plan 过滤（抽 export：check-commit-plan-ref 复用同判据——消息短名校验的覆盖集来源）。
// approved 照旧；done 仅当 plan 文件本身在同批暂存（豁免 B，L1 单笔提交）。
export function coveringDocs(docs, staged = new Set()) {
  return docs.filter((d) => d.text
    && (d.status === 'approved' || (d.status === 'done' && staged.has(d.rel))));
}

/** @param {string[]} paths @param {{rel:string,status:string,text:string}[]} docs @param {Set<string>} staged */
export function decide(paths, docs, staged = new Set()) {
  const covers = coveringDocs(docs, staged);
  const uncovered = paths.filter((p) => !covers.some((d) => d.text.includes(p)));
  return { uncovered };
}

function git(args, extra = {}) {
  return spawnSync(GIT, ['-c', 'core.quotepath=off', ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...extra,
  });
}

function gitText(args) {
  const r = git(args, { encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout || '') };
}

function gitPathExists(rel) {
  const r = gitText(['rev-parse', '--git-path', rel]);
  const p = r.status === 0 ? r.stdout.trim() : '';
  return Boolean(p && fs.existsSync(p));
}

function parseLs(stdout, kind) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1).replace(/\\/g, '/');
    const sha = kind === 'index' ? meta[1] : meta[2];
    if (sha && rel.endsWith('.md')) map.set(rel, sha);
  }
  return map;
}

function catBatch(shas) {
  const unique = [...new Set(shas)];
  const out = new Map();
  if (unique.length === 0) return out;
  const run = git(['cat-file', '--batch'], { input: Buffer.from(`${unique.join('\n')}\n`) });
  if (run.status !== 0 || !run.stdout) return out;
  const buf = run.stdout;
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const parts = buf.slice(off, nl).toString('utf8').split(' ');
    if (parts.length < 3 || parts[1] === 'missing') {
      off = nl + 1;
      continue;
    }
    const size = Number(parts[2]);
    const start = nl + 1;
    out.set(parts[0], buf.slice(start, start + size).toString('utf8'));
    off = start + size + 1;
  }
  return out;
}

function walkPlans(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(dir, ent.name).replace(/\\/g, '/');
    if (ent.isDirectory()) walkPlans(rel, acc);
    else if (ent.name.endsWith('.md')) acc.push(rel);
  }
  return acc;
}

function visibleDocs(stagedSet) {
  const indexMap = parseLs(gitText(['ls-files', '-s', '--', 'workflow/plans']).stdout, 'index');
  const headMap = parseLs(gitText(['ls-tree', '-r', 'HEAD', '--', 'workflow/plans']).stdout, 'head');
  const onDisk = walkPlans('workflow/plans', []);
  const wanted = new Map();
  const untracked = [];
  for (const rel of new Set([...indexMap.keys(), ...headMap.keys(), ...onDisk])) {
    if (!rel.startsWith('workflow/plans/')) continue;
    if (stagedSet.has(rel) && indexMap.has(rel)) wanted.set(rel, indexMap.get(rel));
    else if (headMap.has(rel)) wanted.set(rel, headMap.get(rel));
    else if (!headMap.has(rel) && !indexMap.has(rel)) untracked.push(rel);
  }
  const blobs = catBatch([...wanted.values()]);
  const docs = [];
  for (const [rel, sha] of wanted) {
    const text = blobs.get(sha);
    if (text == null) continue;
    docs.push({ rel, status: statusOf(text), text });
  }
  for (const rel of untracked) {
    let text = '';
    try { text = fs.readFileSync(rel, 'utf8'); } catch { continue; }
    docs.push({ rel, status: statusOf(text), text });
  }
  return { docs, onDisk };
}

function hints(uncovered, docs, onDisk) {
  const draftHits = [];
  const unstagedApproved = [];
  for (const rel of onDisk) {
    let text = '';
    try { text = fs.readFileSync(rel, 'utf8'); } catch { continue; }
    if (!uncovered.some((p) => text.includes(p))) continue;
    const st = statusOf(text);
    if (st === 'draft') draftHits.push(rel);
    if (st === 'approved') {
      const visible = docs.find((d) => d.rel === rel);
      if (!visible || visible.status !== 'approved') unstagedApproved.push(rel);
    }
  }
  return { draftHits, unstagedApproved };
}

// 豁免 A（L0 极简道）判据：消息体含非空 `L0: <判据>` 行（行首 L0:，机器可 grep）。
// 读不到消息文件 / 无该行 → 返回 null，豁免不生效（fail-closed）。
// 抽出文本版：check-scope-range 按提交消息（git show --format=%B）判同一判据，口径单源。
export function l0JudgementFromText(text) {
  const m = String(text || '').match(/^L0:[ \t]*(\S.*)$/m);
  return m ? m[1].trim() : null;
}

export function l0Judgement(msgFile) {
  if (!msgFile) return null;
  try {
    return l0JudgementFromText(fs.readFileSync(msgFile, 'utf8'));
  } catch { return null; }
}

// L0 放行落账：与 judgment-ledger recordRun 同行形（mode=commit-msg）；level=L0 为观测计数，
// 非 WARN/BLOCK，不影响退役判据的「连续 6 月 = 0」口径（那是针对 hard 拒绝计数的）。fail-open。
function recordL0(root, count, judgement) {
  try {
    if (process.env.CHECK_LOOP_ROOT || process.env.CHECK_LOOP_NO_LEDGER) return;
    const r = spawnSync(GIT, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const row = {
      ts: new Date().toISOString(),
      mode: 'commit-msg',
      rev: r.status === 0 ? String(r.stdout).trim() || null : null,
      blockers: 0,
      warnings: 0,
      rules: [{ rule: '先确认后改代码', level: 'L0', count, judgement }],
    };
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.appendFileSync(path.join(root, LEDGER_REL), `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error(`judgment-ledger: 落账失败（不阻断门禁）——${err.code || err.message}`);
  }
}

// 合并形态判定（抽 export：check-commit-plan-ref 复用——收树不重判，短名校验同样跳过）。
// `--merge` = pre-merge-commit 透传的「本次是合并自动提交」信号（该钩子时点 MERGE_HEAD
// 尚未落盘，实测只靠状态文件探测会漏判）；状态文件覆盖 squash/rebase/cherry-pick。
export function isMergeLike(argv = process.argv) {
  return argv.includes('--merge')
    || ['MERGE_HEAD', 'SQUASH_MSG', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'].some(gitPathExists);
}

// 暂存覆盖集采集（抽 export：check-commit-plan-ref 复用——同一批暂存、同一套「看得见」语义与
// 豁免 B 口径，判据单源不复制）。error='staged-unreadable' = 暂存列表读不到。
export function collectStagedCoverage() {
  const staged = gitText(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
  if (staged.status !== 0) return { error: 'staged-unreadable' };
  const stagedFiles = staged.stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  const products = stagedFiles.filter(isProductPath);
  const stagedSet = new Set(stagedFiles);
  // 豁免 B 的「同批暂存」只认新增/修改（ACMR）——同批删除中的 plan 不构成覆盖（C-002 整改：
  // 旧行为把 D 项计入覆盖集，删旧 plan 的提交可借其正文放行产品路径，超出「同批暂存一笔入库」意图）。
  // 第二次取数失败 → 空集 → 豁免 B 不生效（fail-closed）。
  const stagedAddedRaw = gitText(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  const stagedAdded = new Set((stagedAddedRaw.status === 0 ? stagedAddedRaw.stdout : '')
    .split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/')));
  const { docs, onDisk } = visibleDocs(stagedSet);
  return { stagedFiles, products, stagedSet, stagedAdded, docs, onDisk };
}

function main() {
  if (isMergeLike()) {
    console.log('SKIP: 先确认后改代码——合并(--merge)/squash/rebase/cherry-pick，不重判顺序');
    process.exit(0);
  }
  const msgFile = process.argv.slice(2).find((a) => a !== '--merge');
  const cov = collectStagedCoverage();
  if (cov.error) {
    console.error('check-confirm-order: 无法读取暂存列表，提交已阻止');
    process.exit(1);
  }
  const { products, stagedAdded, docs, onDisk } = cov;
  if (products.length === 0) {
    console.log('SKIP: 先确认后改代码——未暂存产品路径');
    process.exit(0);
  }

  const { uncovered } = decide(products, docs, stagedAdded);
  if (uncovered.length === 0) {
    console.log(`先确认后改代码：${products.length} 条产品路径已写在 approved plan 里（或覆盖 plan 与本批同暂存）`);
    process.exit(0);
  }
  const l0 = l0Judgement(msgFile);
  if (l0 && products.length <= L0_MAX) {
    console.log(`放行（豁免 A · L0 极简道）：${products.length} 条产品路径 ≤${L0_MAX}，消息判据「${l0}」；L0 计数已落账`);
    recordL0(process.cwd(), products.length, l0);
    process.exit(0);
  }
  const { draftHits, unstagedApproved } = hints(uncovered, docs, onDisk);
  const shown = uncovered.slice(0, 20);
  console.error('BLOCK: 先确认后改代码');
  console.error('以下暂存路径没有出现在状态为 approved 的 workflow/plans 正文中（done 历史 plan 不算；与产品同批暂存的 done plan 算）：');
  for (const p of shown) console.error(`- ${p}`);
  if (uncovered.length > shown.length) console.error(`- …另有 ${uncovered.length - shown.length} 条`);
  if (draftHits.length) {
    console.error('这些路径写在仍为 draft 的 plan 里，先 confirm-doc 收到 approved，再暂存代码：');
    for (const d of draftHits) console.error(`- ${d}`);
  }
  if (unstagedApproved.length) {
    console.error('这些 plan 工作区已是 approved，但本次提交看不见（未暂存，HEAD 仍不是 approved）：');
    for (const d of unstagedApproved) console.error(`- ${d}`);
  }
  console.error('把路径写进 plan，跑 confirm-doc.mjs 收到 approved，并让该 plan 进入本次提交（或已经在 HEAD 里是 approved）；');
  console.error(`产品 ≤${L0_MAX} 文件且未命中 L2/L3 的小改可走 L0 极简道：消息体加一行非空 \`L0: <判据>\`（见 commands/new-task.md §L0）。`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
