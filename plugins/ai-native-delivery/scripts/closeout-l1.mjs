#!/usr/bin/env node
// closeout-l1 — L1 关单一把编排（2026-10-15 减重手段④：记录性动作一把生成，判断留给人）
// 把 test.md §5 的 L1 关单链（预检 → confirm-doc 代录 → INDEX 重生成 → 提交清单）收进一条命令。
// 用法：node <插件根>/scripts/closeout-l1.mjs <workflow/plans/xxx.md>              # 预检模式：只查差距，不落任何状态
//       node <插件根>/scripts/closeout-l1.mjs <plan> --delegated "<用户对话原话>"   # 执行模式：预检过 → confirm-doc 代录 → 重生成 INDEX
//       （可加 --root <仓库根>；缺省 git toplevel，无 git 用 cwd）
// 边界（判据单源，本工具不复制强判断）：
//   - 证据格式 / approved 历史 / 测试绿硬门 = confirm-doc（stage-gates/policy 单源），本工具预检只是
//     提前暴露差距的 advisory 快筛；执行模式原样转发 confirm-doc，其拒绝即本命令拒绝。
//   - --delegated 调用纪律：AI 须先取得用户对话内明确放行（AGENTS.md 确认门条款），原话入账供对质。
//   - L2/L3 不受理（spec 收敛对账 + 独立复核是防御道本体，不做捷径）；incidents 不受理（两跳制）。
// 测试：node <插件根>/test/closeout-l1.test.mjs（parseArgs / preflight 纯函数进程内断言）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasFreshVerifyLine } from './policy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// parseArgs(argv)：{ plan, delegated, root } | { error }
export function parseArgs(argv = []) {
  const out = { plan: null, delegated: null, root: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delegated') {
      out.delegated = argv[++i];
      if (!out.delegated) out.error = '--delegated 须带「<用户对话原话>」参数';
    } else if (a.startsWith('--delegated=')) {
      out.delegated = a.slice('--delegated='.length);
    } else if (a === '--root') {
      out.root = argv[++i];
      if (!out.root) out.error = '--root 须带仓库根路径';
    } else if (!a.startsWith('--')) {
      if (out.plan) out.error = `只受理一份 plan（现已有 ${out.plan}）`;
      else out.plan = a;
    } else {
      out.error = `未知参数 ${a}`;
    }
  }
  if (!out.error && !out.plan) out.error = '用法：node <插件根>/scripts/closeout-l1.mjs <workflow/plans/xxx.md> [--delegated "<用户对话原话>"] [--root <仓库根>]';
  return out;
}

// frontmatter 平铺解析（key: value；本工具只消费 状态/级别 两个键）
export function fmOf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (!/^---\s*$/.test(lines[0] || '')) return {};
  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) break;
    const m = /^([^\s:]+):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

// acceptanceOf(text)：定位「## …验收标准…」节，统计勾选框条目。
// 返回 { found, total, unchecked: [条目文本] }；节内无任何勾选框条目 → found=true, total=0（判为异常）。
export function acceptanceOf(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && lines[i].includes('验收标准')) { start = i; break; }
    if (i > 0 && /^##\s/.test(lines[i]) && start >= 0) break; // 上一节结束仍无（不可达，防御）
  }
  if (start < 0) return { found: false, total: 0, unchecked: [] };
  const unchecked = [];
  let total = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // 节结束
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    total++;
    if (m[1] === ' ') unchecked.push(m[2].trim());
  }
  return { found: true, total, unchecked };
}

// preflight({ rel, text, freshVerify })：L1 关单前置快筛（advisory；强门在 confirm-doc）。
// 返回 { ok, problems: [], level, status, total, checked }。
export function preflight({ rel, text, freshVerify }) {
  const problems = [];
  if (!/^workflow\/plans\/[^/]+\.md$/.test(rel) || rel.includes('_TEMPLATE')) {
    problems.push(`路径须为 workflow/plans/ 直下文档（现「${rel}」）——L2/L3 intent/spec 与 incidents 不在本工具受理面`);
  }
  const fm = fmOf(text);
  const level = fm['级别'] || '';
  const status = fm['状态'] || '';
  if (level !== 'L1') {
    problems.push(`级别「${level || '缺失'}」≠ L1——L2/L3 关单走 .agents/commands/test.md 全流程（验收判据对账 + 独立复核），本工具只服务协作道 L1`);
  }
  if (status === 'done' || status === 'superseded' || status === 'cancelled') {
    problems.push(`状态已为终态「${status}」——本 plan 已收口，无需重复关单`);
  } else if (status !== 'approved') {
    problems.push(`状态「${status || '缺失'}」≠ approved——draft 须先过起草确认（confirm-doc approved），关单只受理 approved → done`);
  }
  const acc = acceptanceOf(text);
  if (!acc.found) {
    problems.push('未找到「## 验收标准」节——L1 plan 须有可勾验的验收标准（模板口径）');
  } else if (acc.total === 0) {
    problems.push('「验收标准」节内无勾选框条目（- [ ] / - [x]）——验收标准须逐条可勾验');
  } else if (acc.unchecked.length) {
    problems.push(`验收标准 ${acc.unchecked.length}/${acc.total} 条未勾验（勾验与补证据是判断动作，留在关单前完成）：`);
    for (const u of acc.unchecked) problems.push(`    - [ ] ${u}`);
  }
  if (!freshVerify) {
    problems.push('24h 内无 verify 绿行（.agents/verifications.jsonl）——先跑 node <插件根>/scripts/verify.mjs（全绿自动落绿凭证与 verify-evidence 摘要）');
  }
  return { ok: problems.length === 0, problems, level, status, total: acc.total, checked: acc.total - acc.unchecked.length };
}

function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

function freshVerifyOf(root) {
  try {
    const p = path.join(root, '.agents', 'verifications.jsonl');
    if (!fs.existsSync(p)) return false;
    return hasFreshVerifyLine(fs.readFileSync(p, 'utf8').split(/\r?\n/));
  } catch {
    return false;
  }
}

function findArchived(root, rel) {
  const base = path.basename(rel);
  for (const monthDir of fs.existsSync(path.join(root, 'workflow', 'archive'))
    ? fs.readdirSync(path.join(root, 'workflow', 'archive')) : []) {
    const cand = path.join('workflow', 'archive', monthDir, 'plans', base);
    if (fs.existsSync(path.join(root, cand))) return cand;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`closeout-l1: ${args.error}`);
    process.exit(2);
  }
  const root = path.resolve(args.root || gitRoot());
  const rel = path.relative(root, path.resolve(args.plan)).replace(/\\/g, '/');
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error(`closeout-l1: 文件不存在 ${rel}（相对仓库根 ${root}）`);
    process.exit(2);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const pf = preflight({ rel, text, freshVerify: freshVerifyOf(root) });

  console.log(`L1 关单预检｜${rel}`);
  console.log(`  级别 ${pf.level || '—'}｜状态 ${pf.status || '—'}｜验收 ${pf.checked}/${pf.total || 0} 勾验｜verify 绿行 ${pf.problems.some((p) => p.includes('verify')) ? '✗' : '✓(24h)'}`);
  if (!pf.ok) {
    console.error(`\n预检未过（${pf.problems.length} 项差距，逐条处理后再来）：`);
    for (const p of pf.problems) console.error(`  ✗ ${p}`);
    process.exit(2);
  }
  console.log('  预检通过。');

  if (!args.delegated) {
    console.log('\n下一步（执行关单，须先取得用户对话内明确放行）：');
    console.log(`  node <插件根>/scripts/closeout-l1.mjs ${rel} --delegated "<用户确认原话>"`);
    return;
  }

  // 执行模式：confirm-doc 原样转发（全部强门在彼处），随后重生成 INDEX。
  const cd = spawnSync(process.execPath, [
    path.join(SCRIPT_DIR, 'confirm-doc.mjs'), rel, '--delegated', args.delegated, '--root', root,
  ], { stdio: 'inherit' });
  if (cd.status !== 0) {
    console.error(`closeout-l1: confirm-doc 拒绝（exit ${cd.status}）——按上方提示修复后重试；本命令不做任何绕过。`);
    process.exit(cd.status === null ? 2 : cd.status);
  }
  const gi = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'gen-workflow-index.mjs')], { cwd: root, encoding: 'utf8' });
  if (gi.status !== 0) {
    console.error('closeout-l1: ⚠️ INDEX 重生成失败（确认已落账不可回滚；提交前须手动跑 node <插件根>/scripts/gen-workflow-index.mjs 修齐，否则索引漂移门会拦提交）');
  }

  // 汇总：关单后的落盘面与提交清单（归档 mv 时给出新路径）。
  const base = path.basename(rel);
  const archivedTo = fs.existsSync(abs) ? null : findArchived(root, rel);
  const shard = path.join('.agents', 'confirmations.d', `${base}.jsonl`);
  const adds = [
    archivedTo || rel,
    fs.existsSync(path.join(root, shard)) ? shard : '.agents/confirmations.jsonl',
    'workflow/INDEX.md',
  ];
  console.log(`\n关单完成：approved → done（台账已记 chat-delegated，原话入账供对质）`);
  if (archivedTo) console.log(`📦 已随确认滚动归档：${rel} → ${archivedTo}（家族原子，git mv 已暂存）`);
  console.log(`提交清单（git add）：
  ${adds.join('\n  ')}`);
  console.log(`建议提交说明：docs(workflow): 关单 ${base.replace(/\.md$/, '')}（L1 done）——用户对话内确认代录${archivedTo ? `，归档至 ${path.dirname(archivedTo)}/` : ''}`);
  console.log('提醒：本会话自做任务另记 workflow/delegations.md 并跑 agg-delegations.mjs（test.md §5.5）；verify-evidence.md 有改动时随同提交。');
}

const isMain = process.argv[1] && process.argv[1].endsWith('closeout-l1.mjs');
if (isMain) main();
