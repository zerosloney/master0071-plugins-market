#!/usr/bin/env node
// closeout.mjs — L0–L3 单命令关单统一入口（2026-11-12 机制同步；源 d71200b23 closeout.mjs 判据级适配，
// 自 closeout-l1.mjs 升级改名，单入口不并存）
// 把 skills/workflow-closeout §1–§5 的固定序列收成一次调用：
//   ① confirm-doc 落终态 → ② gen-workflow-index 重生成 → ③ git add 固定路径清单
//   → ④ 暂存区核对（外来暂存路径即拒，防夹带）→ ⑤ git commit（禁 --no-verify，钩子照常跑）。
// 车道两条：
//   L1–L3（立档）：node <插件根>/scripts/closeout.mjs <workflow/{intents,specs,plans,incidents}/x.md>
//                    --delegated "<用户对话原话>" [--msg "<提交主题>"] [--root <仓库根>] [--dry-run]
//     车道前置 = 沿 closeout-l1 既有预检（advisory 快筛，强门单源 confirm-doc）：
//     级别 L1/L2/L3、状态受理面（docs approved；incidents open→fixed / fixed→closed 两跳各跑一次）、
//     验收勾验逐条（incidents 无验收标准节，三件套判据单源 confirm-doc/stage-gates，此处不复读）、
//     24h verify 绿行（.agents/verifications.jsonl）。
//   L0（免立档，new-task.md §L0 语义）：node <插件根>/scripts/closeout.mjs --l0 "<为何够小的判据>"
//                    [产品文件…] [--msg "<提交主题>"] [--root <仓库根>] [--dry-run]
//     无文档无 ①（免立档关单）；24h 绿行前置同守；产品文件 ≤ L0_MAX（口径单源
//     check-confirm-order.L0_MAX）；提交消息体带行首 `L0: <判据>` 行（commit-msg 顺序门放行判据，
//     正则单源 l0JudgementFromText 同款）。
// 幂等 / 恢复（沿源）：任一步失败即停并报「从哪一步重入」；重跑同一命令，已完成的步骤幂等跳过——
//   已终态（done/closed/cancelled/superseded）跳过 ①，索引生成器幂等，无暂存改动跳过 ⑤。
// 安全边界（沿源）：⑤ 前核对暂存区只有候选路径——存在外来暂存路径即拒绝提交，不夹带用户其它在途
//   改动。候选清单含归档目的地：confirm-doc 关单即归档用 git mv 家族原子搬家，暂存区出现的是
//   workflow/archive/<月>/<类型>/<同名>.md（含同基名活跃层旧路径在 rename 检测关闭时的删除态）——
//   固定清单按基名双侧枚举，归档自己的动作不被护栏误拒。
// 用法示例（预检模式：不带 --delegated 只查差距不落态；执行模式原样转发 confirm-doc，其拒绝即本命令拒绝）。
// 测试：node <插件根>/test/closeout.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasFreshVerifyLine } from './policy.mjs';
import { L0_MAX, isProductPath, l0JudgementFromText } from './check-confirm-order.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const TERMINAL = ['done', 'closed', 'cancelled', 'superseded'];
const DOC_FAMILIES = 'intents|specs|plans|incidents';
const DOC_RE = new RegExp(`^workflow/(${DOC_FAMILIES})/[^/\\\\]+\\.md$`);

const USAGE = [
  '用法：node <插件根>/scripts/closeout.mjs <workflow/{intents,specs,plans,incidents}/x.md> --delegated "<用户对话原话>" [--msg "<主题>"] [--root <仓库根>] [--dry-run]',
  '      node <插件根>/scripts/closeout.mjs --l0 "<为何够小的判据>" [产品文件…] [--msg "<主题>"] [--root <仓库根>] [--dry-run]',
].join('\n');
const RECOVER = (retry) => `恢复：修掉报错原因后重跑同一命令（已完成的步骤幂等跳过）：${retry}`;

// parseArgs(argv)：L1–L3 → { mode:'doc', doc, delegated, msg, root, dryRun }
//                 L0    → { mode:'l0', l0, files:[], msg, root, dryRun } | { error }
export function parseArgs(argv = []) {
  const out = { mode: null, doc: null, l0: null, files: [], delegated: null, msg: null, root: null, dryRun: false, error: null };
  const val = (k, i) => (i + 1 < argv.length ? argv[i + 1] : undefined);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delegated' || a.startsWith('--delegated=')) {
      out.delegated = a.includes('=') ? a.slice('--delegated='.length) : val('--delegated', i);
      if (a === '--delegated') i++;
      if (!out.delegated) out.error = '--delegated 须带「<用户对话原话>」参数';
    } else if (a === '--l0' || a.startsWith('--l0=')) {
      out.mode = 'l0';
      out.l0 = a.includes('=') ? a.slice('--l0='.length) : val('--l0', i);
      if (a === '--l0') i++;
      if (!out.l0 || !out.l0.trim()) out.error = '--l0 须带非空判据（空判据行不豁免，fail-closed）';
    } else if (a === '--msg' || a.startsWith('--msg=')) {
      out.msg = a.includes('=') ? a.slice('--msg='.length) : val('--msg', i);
      if (a === '--msg') i++;
    } else if (a === '--root') {
      out.root = val('--root', i);
      i++;
      if (!out.root) out.error = '--root 须带仓库根路径';
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (!a.startsWith('--')) {
      out.files.push(a);
    } else {
      out.error = `未知参数 ${a}`;
    }
  }
  if (out.error) return out;
  if (out.mode === 'l0') {
    if (out.delegated !== null) out.error = '--l0 免立档关单不走代录（无 confirm-doc 跳），--delegated 不适用';
    if (out.files.length > L0_MAX) out.error = `L0 产品文件 ${out.files.length} 份 > 上限 ${L0_MAX}（口径单源 check-confirm-order.L0_MAX）——超限先过两问定级`;
    return out;
  }
  out.mode = 'doc';
  if (out.files.length !== 1) out.error = out.files.length ? `只受理一份文档（现 ${out.files.length} 份）` : '缺文档参数；L0 免立档关单用 --l0 "<判据>"';
  else out.doc = out.files[0].replace(/\\/g, '/');
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

// preflight({ rel, text, freshVerify })：立档车道（L1+）关单前置快筛（advisory；强门在 confirm-doc）。
// 返回 { ok, problems: [], level, status, terminal, total, checked }。
// 终态件（done/closed/cancelled/superseded）不再拒——通用关单的幂等重入口径（沿源）：终态跳过 ①，
// 剩余步骤照走（通常是补完上次失败的提交）。
export function preflight({ rel, text, freshVerify }) {
  const problems = [];
  const family = DOC_RE.test(rel) ? DOC_RE.exec(rel)[1] : null;
  const isIncident = family === 'incidents';
  if (!family || rel.includes('_TEMPLATE')) {
    problems.push(`路径须为 workflow/{intents,specs,plans,incidents}/ 直下文档（现「${rel}」）`);
  }
  const fm = fmOf(text);
  const level = fm['级别'] || '';
  const status = fm['状态'] || '';
  if (!['L1', 'L2', 'L3'].includes(level)) {
    problems.push(`级别「${level || '缺失'}」不在 L1/L2/L3 受理面——级别是风险泳道锚，缺失即 fail-closed`);
  }
  const acc = { found: false, total: 0, unchecked: [] };
  if (TERMINAL.includes(status)) {
    return { ok: true, problems, level, status, terminal: true, total: 0, checked: 0 };
  }
  const legalPrev = isIncident ? ['open', 'fixed'] : ['approved'];
  if (!legalPrev.includes(status)) {
    problems.push(isIncident
      ? `状态「${status || '缺失'}』不在 incident 两跳受理面（open→fixed 修复落地 / fixed→closed 关单）——draft/open 之前的状态先走 confirm-doc 合法跳转`
      : `状态「${status || '缺失'}」≠ approved——draft 须先过起草确认（confirm-doc approved），关单只受理 approved → done`);
  }
  if (!isIncident) {
    // 验收勾验（incidents 无验收标准节：三件套判据单源 confirm-doc/stage-gates，此处不复制）
    Object.assign(acc, acceptanceOf(text));
    if (!acc.found) {
      problems.push('未找到「## 验收标准」节——立档文档须有可勾验的验收标准（模板口径）');
    } else if (acc.total === 0) {
      problems.push('「验收标准」节内无勾选框条目（- [ ] / - [x]）——验收标准须逐条可勾验');
    } else if (acc.unchecked.length) {
      problems.push(`验收标准 ${acc.unchecked.length}/${acc.total} 条未勾验（勾验与补证据是判断动作，留在关单前完成）：`);
      for (const u of acc.unchecked) problems.push(`    - [ ] ${u}`);
    }
  }
  if (!freshVerify) {
    problems.push('24h 内无 verify 绿行（.agents/verifications.jsonl）——先跑 node <插件根>/scripts/verify.mjs（全绿自动落绿凭证与 verify-evidence 摘要）');
  }
  return { ok: problems.length === 0, problems, level, status, terminal: false, total: acc.total, checked: acc.total - acc.unchecked.length };
}

// 候选清单（⑤ 护栏与 ③ add 的同一份固定面；基名双侧枚举覆盖归档搬家）。
// 返回 posix 相对路径数组：被关文档 + 其活跃层原路径（恒含——rename 检测关闭时暂存区成对出现
// 「旧路径删除态 + 新路径新增态」）+ 同基名活跃层家族件 + 同基名归档目的地
// + workflow/INDEX.md + workflow/verify-evidence.md + 确认分片 + 确认主账。
export function candidatesFor(root, doc) {
  const base = path.basename(doc);
  const famOf = (DOC_RE.exec(doc) || [])[1];
  const out = [doc];
  if (famOf) out.push(`workflow/${famOf}/${base}`);
  for (const fam of ['intents', 'specs', 'plans', 'incidents']) {
    const p = `workflow/${fam}/${base}`;
    if (p !== doc && fs.existsSync(path.join(root, p))) out.push(p);
  }
  const archiveRoot = path.join(root, 'workflow', 'archive');
  let months = [];
  try { months = fs.readdirSync(archiveRoot); } catch { /* 无归档目录 = 无归档目的地 */ }
  for (const month of months) {
    for (const fam of ['intents', 'specs', 'plans', 'incidents']) {
      const p = `workflow/archive/${month}/${fam}/${base}`;
      if (fs.existsSync(path.join(root, p))) out.push(p);
    }
  }
  out.push('workflow/INDEX.md', 'workflow/verify-evidence.md');
  // 分片名 = 文档基名（去 .md，与 ledger-loader.writeConfirmation 同一口径）
  const shard = `.agents/confirmations.d/${path.basename(doc, '.md')}.jsonl`;
  if (fs.existsSync(path.join(root, shard))) out.push(shard);
  out.push('.agents/confirmations.jsonl');
  return [...new Set(out)];
}

function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

function freshVerifyOf(root) {
  try {
    const p = path.join(root, '.agents', 'verifications.jsonl');
    if (!fs.existsSync(p)) return false;
    // ctx 传 root（2026-11 续单）：绿行 head 字段的 git 锚核验环境——verify.mjs 自本版起落 head，
    // 裸调会把全部合法新绿凭证判不可信（预检恒拦——功能回归）。
    return hasFreshVerifyLine(fs.readFileSync(p, 'utf8').split(/\r?\n/), Date.now(), { cwd: root });
  } catch {
    return false;
  }
}

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}
function porcelain(args) {
  const r = git(args);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/)
    .map((l) => l.slice(3).split(' -> ').pop().trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter(Boolean);
}
// git diff --name-only 输出是纯路径（无 XY 前缀），不能走 porcelain 的 slice(3)。
function nameOnly(args) {
  const r = git(args);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/)
    .map((l) => l.trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter(Boolean);
}
function run(label, args, opts = {}) {
  const r = spawnSync(opts.cmd || process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    console.error(`❌ 步骤 ${label} 失败（exit ${r.status}）:\n${out}`);
    console.error(RECOVER(retryCmd));
    process.exit(r.status || 1);
  }
  if (out) console.log(out);
}

let retryCmd = ''; // 失败恢复提示的完整重入命令（main 里按车道拼好）

function statusOf(abs) {
  const nl = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  if (!/^---\s*$/.test(nl[0] || '')) return '';
  for (let i = 1; i < nl.length && !/^---\s*$/.test(nl[i]); i++) {
    const m = nl[i].match(/^状态:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`closeout: ${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const root = path.resolve(args.root || gitRoot());
  ROOT = root; // run/git/porcelain 闭包的 cwd（两车道各自解析根后立即锚定）

  // ── L0 免立档车道 ──────────────────────────────────────────────
  if (args.mode === 'l0') {
    const judgement = args.l0.trim();
    retryCmd = `node ${path.join(SCRIPT_DIR, 'closeout.mjs')} --l0 "${judgement}"${args.msg ? ` --msg "${args.msg}"` : ''} --root ${root}`;
    if (!l0JudgementFromText(`x\nL0: ${judgement}`)) {
      console.error('closeout: L0 判据为空——消息体行首 `L0: <判据>` 是 commit-msg 顺序门的放行判据（fail-closed）');
      process.exit(2);
    }
    const products = args.files.map((f) => f.replace(/\\/g, '/'));
    const overCap = products.filter((p) => isProductPath(p)).length;
    console.log(`[closeout] L0 免立档关单：产品文件 ${overCap.length ? `${overCap}/${products.length}` : products.length} 份（上限 ${L0_MAX}，commit-msg 门按暂存面复核）｜判据「${judgement}」`);
    if (!freshVerifyOf(root)) {
      console.error('closeout: 24h 内无 verify 绿行（.agents/verifications.jsonl）——L0 流程要求 verify --scope 绿后再单笔提交：先跑 node <插件根>/scripts/verify.mjs');
      process.exit(2);
    }
    return finish({
      root,
      candidates: [...products, 'workflow/INDEX.md', 'workflow/verify-evidence.md'],
      subject: args.msg || 'chore(l0): L0 极简道关单',
      bodyArgs: ['-m', `L0: ${judgement}`],
      dryRun: args.dryRun,
      intro: '[closeout] ① 免立档车道：跳过 confirm-doc（L0 不立档，无终态可落）',
    });
  }

  // ── L1–L3 立档车道 ──────────────────────────────────────────────
  let doc = args.doc;
  if (!DOC_RE.test(doc)) {
    console.error(`closeout: 文档路径不合法：${doc}\n${USAGE}`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(root, doc))) {
    // 幂等重入：上次关单 ① 已把文档随确认滚动归档（git mv 家族原子）而 ④/⑤ 未走完时，活跃层
    // 原路径已不在——按同基名归档目的地重入（终态跳过代录，剩余步骤补完）。
    const name = path.basename(doc);
    const fam = DOC_RE.exec(doc)[1];
    const archiveRoot = path.join(root, 'workflow', 'archive');
    let archived = null;
    try {
      for (const month of fs.readdirSync(archiveRoot)) {
        const p = `workflow/archive/${month}/${fam}/${name}`;
        if (fs.existsSync(path.join(root, p))) { archived = p; break; }
      }
    } catch { /* 无归档目录 */ }
    if (!archived) {
      console.error(`closeout: 文件不存在 ${doc}（相对仓库根 ${root}）`);
      process.exit(2);
    }
    console.log(`[closeout] 活跃层原路径已随上次关单归档，按归档路径重入：${doc} → ${archived}`);
    doc = archived;
  }
  const abs = path.join(root, doc);
  const base = path.basename(doc, '.md');
  retryCmd = `node ${path.join(SCRIPT_DIR, 'closeout.mjs')} ${doc} --delegated "<用户对话原话>"${args.msg ? ` --msg "${args.msg}"` : ''} --root ${root}`;

  // 车道前置：closeout-l1 既有预检（advisory 快筛；强门单源 confirm-doc，其拒绝即本命令拒绝）。
  const text = fs.readFileSync(abs, 'utf8');
  const pf = preflight({ rel: doc, text, freshVerify: freshVerifyOf(root) });
  console.log(`关单预检｜${doc}`);
  console.log(`  级别 ${pf.level || '—'}｜状态 ${pf.status || '—'}${pf.terminal ? '（终态·幂等重入）' : ''}｜验收 ${pf.terminal ? '—' : `${pf.checked}/${pf.total || 0} 勾验`}｜verify 绿行 ${pf.problems.some((p) => p.includes('verify')) ? '✗' : '✓(24h)'}`);
  if (!pf.ok) {
    console.error(`\n预检未过（${pf.problems.length} 项差距，逐条处理后再来）：`);
    for (const p of pf.problems) console.error(`  ✗ ${p}`);
    process.exit(2);
  }
  if (pf.terminal) {
    console.log('  预检通过（终态重入：① 将跳过代录）。');
  } else if (!args.delegated) {
    console.log('  预检通过。');
    console.log('\n下一步（执行关单，须先取得用户对话内明确放行）：');
    console.log(`  node ${path.join(SCRIPT_DIR, 'closeout.mjs')} ${doc} --delegated "<用户确认原话>"`);
    return;
  } else {
    console.log('  预检通过。');
  }

  return finish({
    root,
    doc,
    candidates: null, // ① 之后按归档实况计算（基名双侧枚举）
    subject: args.msg || `docs(workflow): ${base} 关单`,
    bodyArgs: [],
    delegated: args.delegated,
    dryRun: args.dryRun,
    intro: null,
  });
}

// 序列共用尾巴（①–⑤）：车道差异收在 candidates / ① 跳过 / 提交消息三处。
function finish({ root, doc = null, candidates, subject, bodyArgs, delegated = null, dryRun, intro }) {
  if (dryRun) console.log('[closeout] --dry-run：不落态、不写盘、不提交');
  if (intro) console.log(intro);

  // ① 代录终态（状态行只由 confirm-doc.mjs 改）；L0 免立档车道无此步。
  if (doc && !dryRun) {
    const st = statusOf(path.join(root, doc));
    const terminal = TERMINAL.includes(st);
    console.log(`[closeout] ${doc}：当前状态 ${st || '缺失'}${terminal ? '（终态，跳过代录·幂等重入）' : '（待代录）'}`);
    if (terminal) {
      console.log('[closeout] ① 已是终态，跳过 confirm-doc（幂等重入）');
    } else if (delegated === null) {
      console.error('closeout: 执行模式须 --delegated "<用户对话原话>"（代录使用用户对话里的原话）');
      process.exit(2);
    } else {
      run('① confirm-doc', [path.join(SCRIPT_DIR, 'confirm-doc.mjs'), doc, '--delegated', delegated, '--root', root]);
    }
  }

  // ② 索引（生成器按磁盘重写 GENERATED 区，幂等）
  if (!dryRun) run('② gen-workflow-index', [path.join(SCRIPT_DIR, 'gen-workflow-index.mjs')]);

  // 候选清单：立档车道在 ① 之后取（归档 git mv 家族原子已落盘，基名双侧枚举才齐）。
  const cands = candidates || candidatesFor(root, doc);

  // ③ git add 固定路径清单（只 add 有变更的候选）
  const changed = porcelain(['status', '--porcelain', '--', ...cands]);
  if (dryRun) {
    console.log(`[closeout] 候选路径变更：${changed.join('、') || '(无)'}`);
    console.log(`[closeout] 暂存区路径：${nameOnly(['diff', '--cached', '--name-only']).join('、') || '(无)'}`);
    console.log(`[closeout] 下一跳：${doc ? (TERMINAL.includes(statusOf(path.join(root, doc))) ? '⑤ 提交（① 已终态跳过）' : '① confirm-doc 代录（缺 --delegated）') : '③ git add + ⑤ 提交（消息体带 L0: 判据行）'}`);
    process.exit(0);
  }
  if (changed.length) run('③ git add', ['add', '--', ...changed], { cmd: 'git' });
  else console.log('[closeout] ③ 候选路径无变更，跳过 git add');

  // ④ 提交前安全边界（沿源）：暂存区若有候选清单之外的路径，拒绝提交（用户其它在途改动须自己提交）
  const staged = nameOnly(['diff', '--cached', '--name-only']);
  const foreign = staged.filter((p) => !cands.includes(p));
  if (foreign.length) {
    console.error(`❌ 步骤 ④ 拒绝提交：暂存区有本序列之外的路径（${foreign.slice(0, 5).join('、')}${foreign.length > 5 ? '…' : ''}）——不夹带其它在途改动`);
    console.error(`   先单独提交或撤销这些路径，再重跑（${doc && TERMINAL.includes(statusOf(path.join(root, doc))) ? '已终态，' : ''}重跑幂等跳过已完成的步骤）\n${RECOVER(retryCmd)}`);
    process.exit(1);
  }
  if (!staged.length) {
    console.log('[closeout] ⑤ 暂存区无改动（可能已提交），跳过 commit——关单完成');
    process.exit(0);
  }
  console.log(`[closeout] 待提交：${staged.join('、')}`);
  run('⑤ git commit', ['commit', '-m', subject, ...bodyArgs], { cmd: 'git' });
  console.log(`[closeout] ✅ 关单提交完成：${subject}`);
}

let ROOT = process.cwd(); // run/git/porcelain 闭包的 cwd（main 里按车道锚定，模块级先备初值）

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
