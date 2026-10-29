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
import { randomBytes } from 'node:crypto';

import {
  findProjectRoot,
  resolveProjectRoot,
  engineDir,
  ledgerDir,
  scriptPath,
  configDir,
  PLUGIN_CONFIG_TEMPLATES_DIR,
  PLUGIN_ROOT,
} from '../scripts/paths.mjs';
import { gradeTask } from '../scripts/grade-task.mjs';
import { readContext } from '../scripts/read-context.mjs';
import { computeFingerprint } from '../scripts/confirm-doc.mjs';
import { groundQuote, resolveDocText, resolveFamilyTexts } from '../scripts/quote-grounding.mjs';
import { readAllJudgments, retireCandidates, aggFromRows } from '../scripts/agg-judgments.mjs';

const SPAWN_TIMEOUT_MS = 120_000;   // 不变量前置等轻量子进程的墙钟上限
const OUTPUT_CLIP = 8 * 1024;       // verify_gate 回传 stdout/stderr 摘要的截断上限（防爆）

/** 工具级业务错误：message 原样作为 isError 文本回给客户端（带 hint，不 crash）。 */
export class ToolError extends Error {}

// 插件根守卫（2026-10-28，审计 P0）。
// 背景：本插件 mcp.json 声明 `"cwd": "${PLUGIN_ROOT}"`——按 Agent Plugins 规范，宿主会把 MCP
//   服务进程起在**插件安装目录**里。此时 findProjectRoot(process.cwd()) 解析出的是「插件自己所在
//   的那个 git 仓库」：它确实存在，却完全不是用户要操作的对象。实测后果（审计 P0-2）：update_ledger
//   把台账写进插件仓库、confirm 把 .agents/confirmations.jsonl 写进插件仓库（正是 paths.mjs 明令
//   禁止的「跨项目绿凭证互相污染」）、verify_gate 对插件仓库跑门禁——全程 initialized=true，无任何告警。
// 取舍：宁可硬失败，也不猜。落错仓库的写操作事后极难分辨（插件目录被别的项目一读就串味），
//   而一次明确报错只损失一次调用。
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

// canonicalPath(p)：比较用路径归一——解析真实路径（解符号链接、消除 Windows 短名/长名差异），
//   取不到时退回 resolve（路径不存在不是错误，不能因此判错归属）。
function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved).replace(/^\\\\\?\\/, '');
  } catch {
    return resolved;
  }
}

/** cwdInsidePluginRoot(cwd)：进程工作目录是否落在插件根内（宿主把服务起在插件安装目录的形态）。 */
export function cwdInsidePluginRoot(cwd = process.cwd()) {
  const root = canonicalPath(PLUGIN_ROOT);
  const target = canonicalPath(cwd);
  const r = CASE_INSENSITIVE_FS
    ? path.relative(root.toLowerCase(), target.toLowerCase())
    : path.relative(root, target);
  if (r === '') return true;                                   // 就是插件根本身
  if (path.isAbsolute(r)) return false;                        // 跨盘符 → 不在插件根内
  return !(r === '..' || r.startsWith(`..${path.sep}`));        // 以 .. 开头 → 在插件根之外
}

/**
 * 项目根解析：显式项目根优先；否则要求进程 cwd 不在插件根内。
 * 找不到 → 带 hint 的工具错误（isError 回客户端，不 crash）。
 */
export function requireRoot(explicitRoot) {
  // 显式项目根（调用方给的使用项目路径）：宿主把服务起在插件根时的唯一可靠出口。
  if (explicitRoot) {
    const r = resolveProjectRoot(explicitRoot);
    if (!r.root) {
      throw new ToolError(
        `显式项目根解析失败（${r.status}）：${explicitRoot}\n` +
        'hint: 请给使用项目的 git 仓库根（或其子目录）；台账与绿凭证只落使用项目的仓库根。',
      );
    }
    // 插件根守卫对**显式根**同样适用（2026-10-29 修复）：旧实现只在 cwd 分支检查，
    // 于是 `requireRoot('<插件安装目录>')` 一路放行。判据必须落在**入参路径**上：
    // resolveProjectRoot 取的是 git toplevel，而插件目录通常就在某个仓库（如本市场仓库）里，
    // 解析结果恰好是那个仓库根——只看解析结果永远看不出「用户指的是插件自己」。
    if (cwdInsidePluginRoot(explicitRoot) || cwdInsidePluginRoot(r.root)) {
      throw new ToolError(
        `显式项目根落在插件安装目录内（${r.root} ← PLUGIN_ROOT=${PLUGIN_ROOT}）——那是插件自己的位置，不是使用项目。\n` +
        'hint: 传使用项目自己的 git 仓库根；台账与绿凭证落进插件目录会被别的项目当成关单凭证。',
      );
    }
    return r.root;
  }
  if (cwdInsidePluginRoot()) {
    throw new ToolError(
      `MCP 服务进程的工作目录落在插件根内（${process.cwd()}）——那是插件的安装位置，不是你的项目。\n` +
      'hint: 请在调用工具时传入 root=<使用项目的 git 仓库根>，或把宿主启动本服务时的工作目录设为项目根；' +
      '不要让它解析到插件自己所在的仓库——台账与绿凭证落进插件目录会被别的项目当成关单凭证。',
    );
  }
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
  const root = requireRoot(args?.root);
  return ok(gradeTask(String(args.description ?? ''), root));
}

/* ----------------------------------------------------------- read_context */

export function toolReadContext(args = {}) {
  const root = requireRoot(args?.root);
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
  // 临时名带 pid + 随机后缀（口径同本仓 worktree-ops saveConfig / decision-cache）：
  // MCP 服务是长驻进程，两个并发的 update_ledger 追加同一台账时，固定 .tmp 名会互相
  // 截断对方的写入；短命 CLI 脚本（rewrite-file 等）单写者无此面，不在本次收口范围。
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp 可能尚未创建 */ }
    throw new ToolError(`写入失败：${target}（${err.message}）——原文件应保持原样，请核对后重试`);
  }
}

export function toolUpdateLedger(args) {
  const root = requireRoot(args?.root);
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
  // append：用 appendFileSync（O_APPEND）而不是 read→concat→writeAtomic（2026-10-29 市场审查修复）。
  // 旧实现是读-改-写且无锁：8 进程 × 20 次并发实测 3 轮分别丢 6/7/19 行，且**返回 written:true**——
  // 调用方拿到成功回执、台账里却没有那一行，事后对质时无从判断哪些确认丢失了；
  // 同轮还出现 3–5 次 `EPERM rename`（Windows 上两个进程同时 rename 到同一目标是竞争失败）。
  // appendFileSync 对 append-only 台账本就足够：单次 write 带 O_APPEND，内核保证每次写落在文件尾，
  // 不会互相覆盖。同文件 confirm() 路径一直这么做，注释里也写明了理由——这里只是把既有结论落地。
  // 代价：目标文件末尾若缺换行，无法再「先补换行再追加」（那需要一次读）。改用「检查末字节」也不
  // 原子，故按内容形态处理：追加行自带前导换行由调用方保证，否则这里只保证不粘连到半行——
  // 落单的追加内容一律以 '\n' 结尾，且**仅当**文件为空或已以换行结尾时才是新行；
  // 否则先在末尾补一个换行（单独一次 append，仍是 O_APPEND，不会覆盖任何已有内容）。
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = content.endsWith('\n') ? content : `${content}\n`;
  let needsLeadingNewline = false;
  try {
    const size = fs.statSync(target).size;
    if (size > 0) {
      const fd = fs.openSync(target, 'r');
      try {
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        needsLeadingNewline = buf[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    /* 文件不存在或读不到：直接追加即可（mkdir 已建目录） */
  }
  try {
    fs.appendFileSync(target, `${needsLeadingNewline ? '\n' : ''}${body}`, 'utf8');
  } catch (err) {
    throw new ToolError(`写入失败：${target}（${err.message}）——追加未完成，请核对后重试`);
  }
  return ok({ written: true, file: relPosix, mode, bytes: fs.statSync(target).size });
}

/* ---------------------------------------------------------------- confirm */

export function toolConfirm(args) {
  const root = requireRoot(args?.root);
  const task = String(args.task ?? '').trim();
  const decision = String(args.decision ?? '').trim();
  const evidence = String(args.evidence ?? '').trim();
  if (!task || !decision || !evidence) {
    throw new ToolError('`task` / `decision` / `evidence` 三参必填且非空——确认记录缺一项即失去对质面。');
  }
  // 引文接地（2026-10-28 第二轮市场审查）：此前 MCP confirm 的 evidence 是**自由作文**——文件侧
  // confirm-doc 早就用 quote-grounding.mjs 判「这句原话到底在指哪份文档」，MCP 面却什么都不查，
  // 于是同一信任边界两套口径（工具描述里那句"请带可对质的证据原文"只是提示，无机器牙齿）。
  // 现在复用同一模块、同一默认档：advisory（留痕不拦），因为该模块头注的实测表明中文口语是复述
  // 而非引用，词面判据硬拦会误杀大量合规放行（真文档通过 90.0%、无关文档也通过 71.2%）；
  // 只有**客观缺陷**才硬拦：目标文档在活跃目录与归档里都不存在（与 confirm-doc 同判据）。
  // strict_quote=true 由调用方显式收硬（策略选择，不是默认）。
  const docArg = typeof args.doc === 'string' ? args.doc.trim() : '';
  const strict = args.strict_quote === true;
  let docRel = '';
  let grounding = { ok: true, reason: 'unanchored', anchor: 0, residual: '' };
  if (docArg) {
    // 走 update_ledger 同一围栏：只接受 workflow/ 树内相对路径，绝对路径与 ../ 逃逸直接拒
    const { relPosix } = resolveLedgerTarget(root, docArg);
    docRel = relPosix;
    const resolved = resolveDocText(root, relPosix); // 活跃缺失 → 同名归档回落（归档不是失效）
    if (!resolved) {
      throw new ToolError(`\`doc\` 指向的台账文档不存在（活跃目录与 workflow/archive 都没有 ${relPosix}）`
        + '——引文无法对质一份不存在的文档，本次确认被拒（客观缺陷硬拦，非语义猜测）。');
    }
    grounding = groundQuote({
      quote: evidence,
      docText: resolved.text,
      familyTexts: resolveFamilyTexts(root, relPosix),
    });
    if (!grounding.ok && strict) {
      throw new ToolError(`引文接地不成立（strict_quote）：evidence 在 ${relPosix} 及其同名家族里`
        + `找不到 ≥8 字逐字锚点，残余「${grounding.residual.slice(0, 40)}」无落点。`
        + '确认须引用该文档的具体内容，或去掉 strict_quote 走 advisory（仍会留痕）。');
    }
  }
  // 指纹复用 confirm-doc.computeFingerprint（CRLF 归一 → 剔指纹行 → sha256 64 位 hex）——
  // 与 §15 确认指纹校验同构；指纹对象 = 本次记录的语义内容三元组。
  // kind:"task"（2026-10-27 confirm-task-row）：MCP confirm 是任务级确认记录（非 doc 绑定行），
  // 台账校验器 check-ledger-invariant.mjs 行级校验按该判别键分流——task 行只验五字段与指纹，
  // 不要求 doc/stage；无 kind 的存量行走原 doc 绑定校验（行为零变化）。
  const fingerprint = computeFingerprint(JSON.stringify({ task, decision, evidence }));
  const entry = {
    ts: new Date().toISOString(), kind: 'task', task, decision, evidence, fingerprint,
    ...(docRel ? { doc: docRel } : {}),
    quoteGrounding: grounding.reason, // unanchored / verbatim / anchor / generic / ungrounded
  };
  // 写前置（与 update_ledger 同口径）：先跑 check-ledger-invariant。此前 confirm 是 MCP 面唯一
  // 不过前置就落账的写点——台账若已带结构性违规，append 会把它进一步固化（2026-10-28 市场审查对齐）。
  // 注意：kind:"task" 行不带 doc/stage，进不了 §15 的文档配对集（VALID_STAGES 只认文档态），
  // 因此它无法用来伪造「某文档已确认/已关单」——这里补前置是为写入口径一致，不是堵伪造。
  const pre = ledgerInvariantPrecheck(root);
  if (!pre.passed) {
    return ok({ written: false, ledger: '.agents/confirmations.jsonl', reason: pre.reason });
  }
  const agents = engineDir(root);
  fs.mkdirSync(path.join(agents, 'confirmations.d'), { recursive: true });
  const ledger = path.join(agents, 'confirmations.jsonl');
  // 保持 appendFileSync（O_APPEND 原子追加），不改成 update_ledger 那种 read→concat→writeAtomic：
  // 对 append-only 台账，read-modify-write 的并发窗口会让后写者整体覆盖先写者而**丢行**，而丢行比
  // 半行更隐蔽（半行会被解析器当坏行跳过并出账）。append 语义在此更安全。
  fs.appendFileSync(ledger, `${JSON.stringify(entry)}\n`, 'utf8');
  const hint = docRel
    ? (grounding.ok ? '' : `⚠️ evidence 未在 ${docRel} 及其同名家族接地（记 quoteGrounding=ungrounded 供事后对质）；收硬请用 strict_quote:true`)
    : '提示：本次未带 doc，确认行只记 quoteGrounding=unanchored——绑定台账文档（doc 参数）才有可对质的引文接地面。';
  return ok({ written: true, ledger: '.agents/confirmations.jsonl', entry, ...(hint ? { hint } : {}) });
}

/* ------------------------------------------------------------ verify_gate */

const LANES = {
  hard: [],            // 默认车道（check-loop 不带 flag = hard 硬门）
  hygiene: ['--hygiene'],
  all: ['--all'],
};

export function toolVerifyGate(args) {
  const root = requireRoot(args?.root);
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

export function toolLedgerStats(args = {}) {
  const root = requireRoot(args?.root);
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

export function toolPolicyStatus(args = {}) {
  const root = requireRoot(args?.root);
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
