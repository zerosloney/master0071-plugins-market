// ai-native-delivery MCP server — core layer.
//
// 项目根锚定、台账读写、门禁车道执行与策略可见性的实现内核（设计文档 §3.3 / §5.2）。
// 工具表（schema + 分派）在 tools.mjs，JSON-RPC framing 在 protocol.mjs。
// 硬边界：MCP 无自有存储——一切文件操作经 paths.mjs（git root 锚定）落在使用项目里；
// 逻辑优先包装已迁脚本（grade-task / read-context / check-loop / check-ledger-invariant /
// confirm-doc / agg-judgments），不在 MCP 里重造第二套口径。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  findProjectRoot,
  engineDir,
  ledgerDir,
  scriptPath,
  configDir,
  PLUGIN_CONFIG_TEMPLATES_DIR,
} from '../scripts/paths.mjs';
import { gradeTask } from '../scripts/grade-task.mjs';
import { readContext } from '../scripts/read-context.mjs';
import { computeFingerprint } from '../scripts/confirm-doc.mjs';
import { readAllJudgments, retireCandidates, aggFromRows } from '../scripts/agg-judgments.mjs';

const SPAWN_TIMEOUT_MS = 120_000;   // 不变量前置等轻量子进程的墙钟上限
const OUTPUT_CLIP = 8 * 1024;       // verify_gate 回传 stdout/stderr 摘要的截断上限（防爆）

/** 工具级业务错误：message 原样作为 isError 文本回给客户端（带 hint，不 crash）。 */
export class ToolError extends Error {}

/** 项目根解析：git root 锚定（不锚 cwd 语义见 paths.mjs）。找不到 → 带 hint 的工具错误。 */
export function requireRoot() {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    throw new ToolError(
      '无法定位项目根（当前工作目录不在 git 仓库内）。\n' +
      'hint: ai-native-delivery 的台账与审计账一律落使用项目的 git 仓库根（paths.mjs 锚定）；' +
      '请在项目目录内启动本服务，或先 git init。',
    );
  }
  return root;
}

const jsonText = (obj) => JSON.stringify(obj, null, 2);
const ok = (obj) => ({ content: [{ type: 'text', text: jsonText(obj) }] });

/** 头尾保留的截断：结论行多在尾部（check-loop 的 HARD-BLOCK 块在 stderr 末尾），只留头会截掉裁决。 */
function clip(text, limit = OUTPUT_CLIP) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.25);
  const tail = limit - head;
  return `${s.slice(0, head)}\n…（截断：共 ${s.length} 字符，仅保留头 ${head} + 尾 ${tail}）…\n${s.slice(-tail)}`;
}

function spawnNode(script, args, { cwd, timeout = SPAWN_TIMEOUT_MS } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    timeout,
  });
}

/* ------------------------------------------------------------ grade_task */

export function toolGradeTask(args) {
  const root = requireRoot();
  return ok(gradeTask(String(args.description ?? ''), root));
}

/* ----------------------------------------------------------- read_context */

export function toolReadContext() {
  const root = requireRoot();
  return ok(readContext(root));
}

/* ----------------------------------------------------------- update_ledger */

// 白名单：file 必须是 workflow/ 树内的相对路径——拒绝对路径、跨盘符、.. 逃逸与「workflow 本身」。
// 判定用 path.relative 的规范化结果而非字符串前缀（`workflow/../.agents/x` 这类形态逃不过 relative）。
export function resolveLedgerTarget(root, file) {
  if (typeof file !== 'string' || !file.trim()) throw new ToolError('`file` 必须是非空字符串（workflow/ 树内相对路径）。');
  if (path.isAbsolute(file)) throw new ToolError(`拒绝绝对路径 \`${file}\`——update_ledger 只接受 workflow/ 树内相对路径。`);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`路径逃逸被拒：\`${file}\` 解析到项目根之外（${target}）。`);
  }
  const relPosix = rel.split(path.sep).join('/');
  if (relPosix !== 'workflow' && !relPosix.startsWith('workflow/')) {
    throw new ToolError(`\`${file}\` 不在 workflow/ 树内（解析为 ${relPosix}）——update_ledger 的白名单只有交付台账树。`);
  }
  if (relPosix === 'workflow') throw new ToolError('`workflow` 本身是目录——请给具体文件路径。');
  return { target, relPosix };
}

// 写前置（轻量）：spawn check-ledger-invariant（该脚本无库函数可调——被 import 即全量执行并 exit，
// 只能子进程跑）。失败即拒写并回传原因；超时按拒绝处理（台账面 fail-closed）。
function ledgerInvariantPrecheck(root) {
  const r = spawnNode(scriptPath(root, 'check-ledger-invariant.mjs'), ['--root', root], { cwd: root });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { passed: false, reason: `check-ledger-invariant 超时（${SPAWN_TIMEOUT_MS}ms）——写操作被拒（台账面 fail-closed）。` };
  }
  if (r.status !== 0) {
    return { passed: false, reason: `check-ledger-invariant 前置未过（exit ${r.status ?? r.error?.code ?? 'null'}）：\n${clip(`${r.stderr || ''}${r.stdout || ''}`, 2048)}` };
  }
  return { passed: true };
}

// 原子写（2026-10-27 修复）：同目录临时文件 + rename——直接 writeFileSync 是「先截断后写」，
// 进程中途崩溃会留下半写台账（append 还要先读全量再整写，并发追加会互相覆盖）。
// 口径与仓内其余写点一致：compact-ledgers / git-merge-jsonl / pipeline-run / rewrite-file。
// 失败时原文件保持原样（tmp 清理），不吞错。
function writeAtomic(target, text) {
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp 可能尚未创建 */ }
    throw new ToolError(`写入失败：${target}（${err.message}）——原文件应保持原样，请核对后重试`);
  }
}

export function toolUpdateLedger(args) {
  const root = requireRoot();
  const mode = args.mode;
  if (mode !== 'create' && mode !== 'append') {
    throw new ToolError(`invalid mode \`${String(mode)}\`：只接受 "create" 或 "append"。`);
  }
  const { target, relPosix } = resolveLedgerTarget(root, args.file);
  const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
  if (!content) throw new ToolError('`content` 不能为空（要写入/追加的内容文本）。');

  const pre = ledgerInvariantPrecheck(root);
  if (!pre.passed) {
    return ok({ written: false, file: relPosix, mode, reason: pre.reason });
  }

  if (mode === 'create') {
    if (fs.existsSync(target)) {
      return ok({ written: false, file: relPosix, mode, reason: `文件已存在：${relPosix}——create 拒绝覆盖；要追加行请用 mode:"append"。` });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomic(target, content.endsWith('\n') ? content : `${content}\n`);
    return ok({ written: true, file: relPosix, mode, bytes: fs.statSync(target).size });
  }
  // append：追加行语义——目标缺行尾时先补换行，保证追加内容自成一行的原子性
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let prev = '';
  try { prev = fs.readFileSync(target, 'utf8'); } catch { /* 不存在则新建 */ }
  const joiner = prev === '' || prev.endsWith('\n') ? '' : '\n';
  writeAtomic(target, `${prev}${joiner}${content.endsWith('\n') ? content : `${content}\n`}`);
  return ok({ written: true, file: relPosix, mode, bytes: fs.statSync(target).size });
}

/* ---------------------------------------------------------------- confirm */

export function toolConfirm(args) {
  const root = requireRoot();
  const task = String(args.task ?? '').trim();
  const decision = String(args.decision ?? '').trim();
  const evidence = String(args.evidence ?? '').trim();
  if (!task || !decision || !evidence) {
    throw new ToolError('`task` / `decision` / `evidence` 三参必填且非空——确认记录缺一项即失去对质面。');
  }
  // 指纹复用 confirm-doc.computeFingerprint（CRLF 归一 → 剔指纹行 → sha256 64 位 hex）——
  // 与 §15 确认指纹校验同构；指纹对象 = 本次记录的语义内容三元组。
  // kind:"task"（2026-10-27 confirm-task-row）：MCP confirm 是任务级确认记录（非 doc 绑定行），
  // 台账校验器 check-ledger-invariant.mjs 行级校验按该判别键分流——task 行只验五字段与指纹，
  // 不要求 doc/stage；无 kind 的存量行走原 doc 绑定校验（行为零变化）。
  const fingerprint = computeFingerprint(JSON.stringify({ task, decision, evidence }));
  const entry = { ts: new Date().toISOString(), kind: 'task', task, decision, evidence, fingerprint };
  const agents = engineDir(root);
  fs.mkdirSync(path.join(agents, 'confirmations.d'), { recursive: true });
  const ledger = path.join(agents, 'confirmations.jsonl');
  fs.appendFileSync(ledger, `${JSON.stringify(entry)}\n`, 'utf8');
  return ok({ written: true, ledger: '.agents/confirmations.jsonl', entry });
}

/* ------------------------------------------------------------ verify_gate */

const LANES = {
  hard: [],            // 默认车道（check-loop 不带 flag = hard 硬门）
  hygiene: ['--hygiene'],
  all: ['--all'],
};

export function toolVerifyGate(args) {
  const root = requireRoot();
  const lane = args.lane === undefined || args.lane === null ? 'hard' : args.lane;
  if (!Object.prototype.hasOwnProperty.call(LANES, lane)) {
    throw new ToolError(`invalid lane \`${String(lane)}\`：只接受 "hard"（默认）、"hygiene"、"all"。`);
  }
  const script = scriptPath(root, 'check-loop.mjs');
  // 墙钟预算取 gate-budgets.json 的 fullMs（advisory 预算）+ 60s 收尾余量；读不到回退 300s
  let timeout = 300_000;
  try {
    const b = JSON.parse(fs.readFileSync(path.join(configDir(root), 'gate-budgets.json'), 'utf8'));
    if (Number.isFinite(b.fullMs) && b.fullMs > 0) timeout = b.fullMs + 60_000;
  } catch { /* 预算表不可读：回退默认 */ }
  const r = spawnNode(script, LANES[lane], { cwd: root, timeout });
  // 状态语义（2026-10-27 修复）：门禁有三种终态，**不得把「没跑完」与「跑过了」同形**——
  //   passed       = exit 0（跑完且通过）
  //   failed       = exit 非 0（跑完且有违例）
  //   not-executed = 超时 / spawn 失败（**没跑完**——状态未知≠通过）
  // 此前超时返回 exitCode:null + 空 stdout，调用方按「exitCode ≠ 1 即通过」解读会把
  // 「超时未完成」当成未检出违例；spawn 异常用 -1（不在仓内 0/1/2 约定内）。现统一 exit 2 + status 字段。
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return ok({
      lane, script, exitCode: 2, status: 'not-executed', timedOut: true, stdout: '',
      stderr: `check-loop 超过墙钟预算（${timeout}ms）被终止——**门未执行完**，不得当作通过（状态未知≠通过）`,
    });
  }
  if (r.error) {
    return ok({
      lane, script, exitCode: 2, status: 'not-executed', timedOut: false, stdout: '',
      stderr: `check-loop 启动失败（${r.error.code || r.error.message}）——**门未执行**，不得当作通过（状态未知≠通过）`,
    });
  }
  return ok({
    lane,
    script,
    exitCode: r.status === null ? 2 : r.status,
    status: r.status === 0 ? 'passed' : 'failed',
    timedOut: false,
    stdout: clip(r.stdout),
    stderr: clip(r.stderr),
  });
}

/* ----------------------------------------------------------- ledger_stats */

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of items) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        files += 1;
        try {
          const st = fs.statSync(full);
          bytes += st.size;
          newest = Math.max(newest, st.mtimeMs);
        } catch { /* 并发消失的文件不计 */ }
      }
    }
  }
  return { files, bytes, newest: newest || null };
}

const jsonlStats = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return { file: `.agents/${path.basename(file)}`, lines, bytes: fs.statSync(file).size };
  } catch {
    return { file: `.agents/${path.basename(file)}`, lines: null, bytes: null };
  }
};

export function toolLedgerStats() {
  const root = requireRoot();
  const wf = ledgerDir(root);
  const workflow = fs.existsSync(wf) ? walkStats(wf) : null;
  const agents = engineDir(root);
  const jsonlFiles = [];
  try {
    for (const f of fs.readdirSync(agents)) if (f.endsWith('.jsonl')) jsonlFiles.push(jsonlStats(path.join(agents, f)));
  } catch { /* .agents/ 不存在（未初始化） */ }
  const inv = spawnNode(scriptPath(root, 'check-ledger-invariant.mjs'), ['--root', root], { cwd: root });
  const invariant = {
    exitCode: inv.status,
    status: inv.status === 0 ? 'ok' : 'failed',
    output: clip(`${inv.stderr || ''}${inv.stdout || ''}`, 2048),
  };
  return ok({ workflow, agentsJsonl: jsonlFiles, invariant });
}

/* ----------------------------------------------------------- policy_status */

// 棘轮状态：rule-budgets.txt 的 <N>#count 条目 vs 实际——
//   .agents/scripts/check-loop-sections/ → 数段文件（插件内 scriptPath 解析，与 rule-budget.expand 同口径）
//   check-loop-hard → 数 check-loop.mjs SECTIONS 里 lane:'hard' 段（rule-budget.countHardSections 同一正则）
function ratchetStatus(root) {
  const budgetsFile = path.join(configDir(root), 'rule-budgets.txt');
  let text = '';
  try { text = fs.readFileSync(budgetsFile, 'utf8'); } catch {
    return { file: budgetsFile, entries: [], note: 'rule-budgets.txt 不可读——棘轮状态未知（fail-open）' };
  }
  const loopSrc = (() => { try { return fs.readFileSync(scriptPath(root, 'check-loop.mjs'), 'utf8'); } catch { return ''; } })();
  const sectionsDir = path.join(path.dirname(scriptPath(root, 'check-loop.mjs')), 'check-loop-sections');
  const sectionFiles = (() => {
    try { return fs.readdirSync(sectionsDir).filter((f) => f.endsWith('.mjs')).length; } catch { return 0; }
  })();
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const pat = line.slice(0, sp).trim();
    const lim = line.slice(sp + 1).trim();
    if (!pat || pat.startsWith('#')) continue;
    const m = /^(\d+)#count$/.exec(lim);
    if (!m) continue;
    if (pat === '.agents/scripts/check-loop-sections/') {
      entries.push({ name: 'check-loop-sections 段数棘轮', limit: Number(m[1]), actual: sectionFiles, ok: sectionFiles <= Number(m[1]) });
    } else if (pat === 'check-loop-hard') {
      const hard = (loopSrc.match(/\{\s*lane:\s*'hard'/g) || []).length;
      entries.push({ name: 'check-loop-hard 车道棘轮', limit: Number(m[1]), actual: hard, ok: hard <= Number(m[1]) });
    }
  }
  return { file: budgetsFile, entries };
}

export function toolPolicyStatus() {
  const root = requireRoot();
  // policyVersion：项目侧 engine.json 优先（清单单源），未初始化回退插件种子并如实标注来源
  let policy;
  const projEngine = path.join(engineDir(root), 'config', 'engine.json');
  const seedEngine = path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json');
  try {
    policy = { policyVersion: JSON.parse(fs.readFileSync(projEngine, 'utf8')).policyVersion, source: '.agents/config/engine.json（项目侧）' };
  } catch {
    try {
      policy = { policyVersion: JSON.parse(fs.readFileSync(seedEngine, 'utf8')).policyVersion, source: 'config-templates/engine.json（插件种子——项目侧未初始化或不可读）' };
    } catch {
      policy = { policyVersion: null, source: null };
    }
  }
  let gateBudgets = null;
  try { gateBudgets = JSON.parse(fs.readFileSync(path.join(configDir(root), 'gate-budgets.json'), 'utf8')); } catch { /* advisory 面 */ }

  // 退役候选（per-rule 聚合，复用 agg-judgments 库函数）：judgments.jsonl 在场才聚合。
  // 口径标注（任务定案的简化）：原判据「连续 6 个有数据月零命中」由 agg-judgments.retireCandidates
  // 给出；台账只记命中行，"全账零命中"规则不会出现在账内，因此窗口不满足时不产候选、只报数据月数——
  // 不伪造候选。输出保留 per-rule 全账命中总数（totals）供人工对账。
  let retire = null;
  const judgmentsFile = path.join(engineDir(root), 'judgments.jsonl');
  if (fs.existsSync(judgmentsFile)) {
    const read = readAllJudgments(root);
    const rc = retireCandidates(read.rows, 6);
    const totals = {};
    const { byMonth } = aggFromRows(read.rows);
    for (const ym of Object.keys(byMonth)) {
      for (const [rule, cell] of Object.entries(byMonth[ym].rules)) {
        const t = (totals[rule] ||= { WARN: 0, BLOCK: 0 });
        t.WARN += cell.WARN;
        t.BLOCK += cell.BLOCK;
      }
    }
    retire = {
      ledgerPresent: true,
      rows: read.localRows.length,
      dataMonths: rc.dataMonths,
      caliber: rc.sufficient
        ? `连续 ${rc.windowMonths} 个有数据月零命中（agg-judgments 判据，窗口 ${rc.windowFrom}..${rc.windowTo}）`
        : '数据月不足 6——不产候选（"全账零命中"简化口径下账内规则必有命中记录，零命中规则不在账内出现；口径如实标注，不伪造候选）',
      candidates: rc.candidates,
      totals,
    };
  } else {
    retire = { ledgerPresent: false, caliber: '.agents/judgments.jsonl 不存在（尚无 check-loop 真实运行记录）——退役候选无数据源' };
  }

  return ok({ policy, gateBudgets, retire, ratchet: ratchetStatus(root) });
}
