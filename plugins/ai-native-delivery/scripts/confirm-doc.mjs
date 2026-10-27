#!/usr/bin/env node
// confirm-doc — 用户确认门（2026-09-26 confirm-gate-machine；2026-09-27 confirm-gate-delegated 加委托代录形态；同日 gate-coverage 收 incidents；同日 closing-coverage 加放弃态 --to）
// 唯一确认入口：workflow/{intents,specs,plans} 文档（draft→approved 起草确认 / approved→done 关单确认）
//   与 workflow/incidents 文档（open→fixed 修复落地确认 / fixed→closed 关单确认——不支持 open→closed 单跳，
//   强制两跳留痕；2026-09-28 起 check-loop 15 对账）。放弃态走显式 `--to`（closing-coverage）：
//   --to cancelled 自 draft/approved/open/fixed（未确认过的东西谈不上被取代）；--to superseded 自
//   approved/done/fixed/closed（已确认/闭环的结论被新档取代）。check-loop 检查 15 按「确认指纹 + 台账配对」
//   对账（四终态另做内容绑定），无记录即 hard-block。
// 两形态：
//   ① TTY 模式（默认）：用户终端亲手运行、逐份过目全文、逐份键入「可以」——非交互环境直接拒绝
//     （AI 会话的 spawnSync 无 TTY，本形态在 AI 手里跑不起来）。
//   ② 委托代录模式（--delegated "<用户对话原话>"，2026-09-27）：用户已在对话中明确放行后，AI 代为
//     落态记账——免 TTY、免逐份问答，但台账行如实记 source:"chat-delegated" + quote:<原话>，
//     永不伪装 TTY 行。调用纪律（AI 须先取得用户对话内明确确认）由 AGENTS.md 确认门条款承载，
//     quote 原话入账供事后对质。
// 台账：.agents/confirmations.d/<doc 基名>.jsonl 分片（入 git、追加式；2026-10-12 起为默认写入口径，
//   --no-shard / CONFIRM_SHARDED=0 可回退主台账 .agents/confirmations.jsonl）——每行 {ts, doc, stage,
//   fingerprint(64位), prev, source:"tty"|"chat-delegated", quote?(仅委托行), batch, seq, of}。
//   分片按 doc 命名：跨端确认不同 doc 写不同文件，从根上消除「每合并必冲突 + 手工重建」；同一 doc 被
//   两端并发确认时由 .gitattributes 的 merge=jsonl-union 驱动取并集（本地须配 merge.jsonl-union.driver，
//   见 check-local-gates.mjs --fix）。读取侧（check-loop 15/19、stage-gates、gen-workflow-metrics 等）
//   经 ledger-loader 统一视图透明合并主台账 + 全部分片，写侧改动对它们无感。
//   batch/seq/of（batch-ledger-audit 新增，纯增字段、向后兼容、历史行不回填）：
//   记「本次进程调用落了几份态」这一**写入时确定已知的事实**——batch 为本次调用生成的短随机串
//   （无时间语义、无全局唯一要求，仅需单台账内不碰撞），seq 为该次调用内件序（从 1），of 为本次
//   调用总份数。check-loop 检查 15 的并录审计据此直读事实判定，不再从 quote 相等 + ts 接近反推
//   （旧判据可被「换 quote」平凡规避、且合规逐件复用同句必然误报——见同名 incident）。
// 指纹：内容 CRLF 归一 → 剔除「确认指纹:」行（防自引用）→ sha256；frontmatter 存前 16 位，台账存全量。
// 用法：node .agents/scripts/confirm-doc.mjs <workflow/intents|x.md> [<doc2>...] [--root <仓库根>]
//       node .agents/scripts/confirm-doc.mjs <doc...> --delegated "<用户对话原话>"（委托代录）
//       node .agents/scripts/confirm-doc.mjs <doc...> --delegated "<原话>" --batch（协作道批量：L1 多份一次代录）
//       node .agents/scripts/confirm-doc.mjs <doc...> --delegated "<原话>" --strict-quote（引文接地收硬：不成立即拒）
//       node .agents/scripts/confirm-doc.mjs <doc...> --to superseded|cancelled（放弃态：取代/取消，留指纹与台账）
//       node .agents/scripts/confirm-doc.mjs <doc...> --reconfirm --delegated "<原话>"（重新确认：approved 档承诺面
//         被改写后用户重新点头——不推进状态，只重录指纹 + 承诺面指纹；状态行仍由本脚本写，无需手改 frontmatter）
//       台账写入形态：默认分片 .agents/confirmations.d/<doc>.jsonl；--no-shard 或 CONFIRM_SHARDED=0 写主台账
//   多文档一次传入：TTY 模式天然逐份过目键入；--delegated 默认一次仅一份（2026-09-27
//   confirm-gate-one-per-call：多份并录曾系统性塌掉 build.md「逐件确认」三道门），L1 协作道可
//   `--batch` 多份一次代录（hybrid-governance-risk-lanes）：逐份读「级别」，L2/L3 逐份拒绝
//   （防御道不批量）；台账行带 `brief:true` 简洁审计标记（quote 原话仍入账供对质），check-loop 检查 15
//   并录审计对全行带标记的批次豁免「确认并录」告警。--auto 一次仍仅一份（自治放行不批量）。
// 逐阶段前置门（stage-gate-machine）：specs/plans 的 draft→approved 须同主题入口已确认
//   （plan 另须入口级别 L2/L3 时同名 spec 已确认；判定口径见 stage-gates.mjs）——未过拒绝落账：
//   不写盘、不 append 台账、该份计为「拒绝」，任一被拒进程 exit 2。
// 测试：node templates/_agents/scripts/confirm-doc.test.mjs（纯函数逐项 + 非 TTY spawn 拒绝断言 + 委托场景）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { confirmGateFor, doneGateFor, acceptanceEvidenceGate, laneOfDoc, specConfirmed, planConfirmedFor, reviewLineFor, commitmentFingerprint } from './stage-gates.mjs';
import { loadKitPolicy, hasFreshVerifyLine } from './policy.mjs';
import { groundQuote, resolveFamilyTexts, GROUND_ANCHOR_MIN } from './quote-grounding.mjs';

// hasFreshVerify(root)：读 <root>/.agents/verifications.jsonl 判 24h 窗口绿行（判定单源
// policy.hasFreshVerifyLine）。只读，台账缺失/不可读一律 false（=无凭证，advisory 层 fail-open）。
function hasFreshVerify(root) {
  try {
    const p = path.join(root, '.agents', 'verifications.jsonl');
    if (!fs.existsSync(p)) return false;
    return hasFreshVerifyLine(fs.readFileSync(p, 'utf8').split(/\r?\n/));
  } catch {
    return false;
  }
}

// computeFingerprint(text)：CRLF 归一 → 剔指纹行 → sha256 hex（64 位）
export function computeFingerprint(text) {
  const norm = String(text).replace(/\r\n/g, '\n').split('\n')
    .filter((l) => !/^确认指纹:/.test(l))
    .join('\n');
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

// nextStage(status)：唯一合法前向跳转（docs 两跳 + incidents 两跳）；其余（done/closed/superseded/cancelled/缺失）返回 null
export function nextStage(status) {
  if (status === 'draft') return 'approved';
  if (status === 'approved') return 'done';
  if (status === 'open') return 'fixed'; // incidents：修复落地确认（三件套全落地）
  if (status === 'fixed') return 'closed'; // incidents：关单确认（防复发验证已落地）
  return null;
}

// 放弃态跳转表（closing-coverage）：cancelled 自未确认/进行态，superseded 自已确认态——
// draft/open 未被确认过，谈不上「被取代」，只能 cancelled；终态间仅允许 done/closed→superseded（结论被新档取代），其余互跳拒绝
const CANCELLABLE = new Set(['draft', 'approved', 'open', 'fixed']);
const SUPERSEDABLE = new Set(['approved', 'done', 'fixed', 'closed']);
export const ABANDON_TARGETS = ['superseded', 'cancelled'];

// resolveTransition(status, to)：带 --to 目标的跳转裁决（pure）。to 为空 = 默认前向（nextStage）；
// to ∈ {superseded, cancelled} 按上表判合法性；其余值或非法组合返回 null
export function resolveTransition(status, to) {
  if (!to) return nextStage(status);
  if (to === 'cancelled') return CANCELLABLE.has(status) ? 'cancelled' : null;
  if (to === 'superseded') return SUPERSEDABLE.has(status) ? 'superseded' : null;
  return null;
}

// applyTransition(text, targetStage, fingerprint16)：frontmatter 内只改「状态:」行值 + 增/换「确认指纹:」行，
// 其余字节原样保留；无 frontmatter（首行非 ---）或未闭合 → 返回 null（调用方跳过不写）
export function applyTransition(text, targetStage, fingerprint16) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (!/^---\s*$/.test(lines[0] || '')) return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return null;
  let hasStatus = false;
  let hasFp = false;
  for (let i = 1; i < end; i++) {
    if (!hasStatus && /^状态:/.test(lines[i])) { lines[i] = `状态: ${targetStage}`; hasStatus = true; }
    else if (!hasFp && /^确认指纹:/.test(lines[i])) { lines[i] = `确认指纹: ${fingerprint16}`; hasFp = true; }
  }
  const fm = lines.slice(1, end);
  if (!hasStatus) fm.unshift(`状态: ${targetStage}`); // 防御：无状态键本应被 nextStage 拦，不至此
  if (!hasFp) fm.push(`确认指纹: ${fingerprint16}`);
  return [lines[0], ...fm, ...lines.slice(end)].join('\n');
}

import { writeConfirmation, loadAllConfirmations } from './ledger-loader.mjs';
import { delegationRowsOf, rowCovers } from './delegation-presence.mjs';

// appendLedger(root, entry, opts)：追加一行 JSON（默认写 .agents/confirmations.d/<doc>.jsonl 分片；
// opts.shard === false 或 CONFIRM_SHARDED=0 时写主台账 .agents/confirmations.jsonl）
export function appendLedger(root, entry, opts = {}) {
  const useShard = opts.shard !== undefined ? Boolean(opts.shard) : process.env.CONFIRM_SHARDED !== '0';
  return writeConfirmation(root, entry, { shard: useShard });
}

const DOC_RE = /^workflow\/(intents|specs|plans|incidents)\/[^/]+\.md$/;

// fmLevel(nl)：frontmatter「级别:」值（无 frontmatter / 无该键 → ''）——AI 自治门与协作道批量门共用
export function fmLevel(nl) {
  if (!/^---\s*$/.test(nl[0] || '')) return '';
  for (let i = 1; i < nl.length && !/^---\s*$/.test(nl[i]); i++) {
    const m = nl[i].match(/^级别:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return '';
}

const isMain = process.argv[1] && process.argv[1].endsWith('confirm-doc.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  let delegatedQuote = null; // null = TTY 模式；字符串 = 委托代录的用户对话原话
  let toTarget = null; // null = 默认前向跳转；superseded|cancelled = 放弃态显式目标
  let autoMode = false; // AI 自治模式（信任等级授权，2026-09-30 ai-autonomy-trust）
  let batchMode = false; // 协作道批量代录（--batch，2026-09-30 hybrid-governance-risk-lanes：仅 --delegated + L1）
  let strictQuote = false; // 引文接地收硬（--strict-quote）：接地不成立即拒绝落账（默认 advisory）
  let reconfirmMode = false; // 重新确认（--reconfirm）：approved 档承诺面被改写后用户重新点头——不推进状态，只重录指纹
  // 分片台账为默认写入口径（ledger-shard-default）：确认行进 .agents/confirmations.d/<doc 基名>.jsonl，
  // 跨端/跨 worktree 确认不同 doc 时写不同文件，从根上消除「每合并必冲突 + 手工重建仪式」；
  // 同一 doc 被两端并发确认时由 .gitattributes 的 merge=jsonl-union 驱动取并集。
  // 退出形态：--no-shard 或 CONFIRM_SHARDED=0 写主台账 .agents/confirmations.jsonl（批量归并/排障用）。
  let shardMode = process.env.CONFIRM_SHARDED !== '0';
  const docs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--delegated') delegatedQuote = argv[++i] ?? '';
    else if (argv[i] === '--to') toTarget = argv[++i] ?? '';
    else if (argv[i] === '--auto') autoMode = true;
    else if (argv[i] === '--batch') batchMode = true;
    else if (argv[i] === '--strict-quote') strictQuote = true;
    else if (argv[i] === '--reconfirm') reconfirmMode = true;
    else if (argv[i] === '--shard') shardMode = true;
    else if (argv[i] === '--no-shard') shardMode = false;
    else docs.push(argv[i].replace(/\\/g, '/'));
  }
  if (argv.includes('--shard') && argv.includes('--no-shard')) {
    console.error('用法：--shard 与 --no-shard 互斥——分片已是默认写入口径，显式回退主台账只需 --no-shard');
    process.exit(1);
  }
  if (toTarget !== null && !ABANDON_TARGETS.includes(toTarget)) {
    console.error(`用法：--to 仅接受 superseded|cancelled（现「${toTarget}」）——cancelled 自 draft/approved/open/fixed；superseded 自 approved/done/fixed/closed（未确认态只能 cancelled；终态间仅允许 done/closed→superseded）`);
    process.exit(1);
  }
  const delegated = delegatedQuote !== null;
  if (delegated && autoMode) {
    console.error('❌ --auto 与 --delegated 互斥：自治模式是用户预先授权的机器放行，委托代录是单次对话确认');
    process.exit(1);
  }
  if (reconfirmMode && toTarget) {
    console.error('❌ --reconfirm 与 --to 互斥：重新确认不推进状态（approved 仍为 approved），只重录指纹 + 承诺面指纹');
    process.exit(1);
  }
  if (reconfirmMode && !delegated) {
    console.error('❌ --reconfirm 须配 --delegated "<用户对话原话>"：重新确认是用户对改写后承诺的重新点头，不得静默发生');
    process.exit(1);
  }
  if (batchMode && autoMode) {
    console.error('❌ --batch 与 --auto 互斥：批量代录是协作道的对话委托形态，自治放行不批量（一次一份）');
    process.exit(1);
  }
  if (batchMode && toTarget) {
    console.error('❌ --batch 不支持 --to 放弃态——放弃须逐份显式确认，不批量');
    process.exit(1);
  }
  // AI 自治门（ai-autonomy-trust；hybrid-governance-explore-hardening 加隐式形态）：
  // 读 .agents/trust-mode.json。除显式 --auto 外，Trusted（level=2）下的非 TTY 单份调用在 TTY 门处
  // 免旗标自动转入本分支（见「Trusted 自动泳道」）——L1 门 / incidents 排除 / 逐阶段与 done 门照常执行。
  let trustConfig = null;
  if (autoMode) {
    try {
      trustConfig = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'trust-mode.json'), 'utf8'));
    } catch { trustConfig = { enabled: false, level: 0 }; }
    if (!trustConfig.enabled || ![1, 2].includes(trustConfig.level)) {
      console.error('❌ AI 自治未开启或等级非法（.agents/trust-mode.json enabled=false 或 level∉[1,2]）——跑 node .agents/scripts/trust-mode.mjs --enable --level <1|2> 开启');
      process.exit(1);
    }
    if (toTarget) {
      console.error('❌ AI 自治模式不支持 --to 放弃态（放弃态必须由用户显式确认）');
      process.exit(1);
    }
    if (docs.length > 1) {
      console.error('❌ AI 自治模式一次仅接受一份文档（与 --delegated 同口径，逐件放行）');
      process.exit(1);
    }
    console.error(`⚠️  AI 自治模式（Trust L${trustConfig.level}）：仅限 L1 文档；Level 1 只放行 draft→approved，Level 2 放行至 done`);
  }
  if (delegated && !String(delegatedQuote).trim()) {
    console.error('用法：--delegated 须带用户对话原话（node .agents/scripts/confirm-doc.mjs <doc...> --delegated "<用户原话>"）——原话入台账供事后对质，不可缺省');
    process.exit(1);
  }
  // TTY 门（仅 TTY 模式；先于文档参数校验）：AI 会话内非委托调用一律拒绝
  // CONFIRM_DOC_TEST_TTY：**仅测试用**逃生门——本测试环境无 TTY，而 TTY 多文档分支
  // （batch 相同 / seq 递增 / of=N）是并录审计的判别基础，必须可测（复核 P2-2）。
  // 双条件（check16-inline-debt）：须同时 NODE_ENV === 'test' 才放行——单看
  // 「TEST」字样的变量名不构成机器约束，AI 会话可能「顺手」在生产路径设置它绕过 TTY 门；
  // 加 NODE_ENV 双条件后，生产路径（不设 NODE_ENV=test）即便误设 CONFIRM_DOC_TEST_TTY 也不生效。
  // **信任边界声明（沿 check8-git-anchor 口径）**：本地信任边界内不可机器防——环境变量终究可被
  // 本机进程任意设置，刻意伪造 `NODE_ENV=test CONFIRM_DOC_TEST_TTY=1` 仍可绕过，与伪造 git 时间戳 /
  // 手改台账同属事后对质（git 历史与台账）兜底的范畴；此处只把「顺手设置单变量」的成本抬到
  // 「主动伪造双变量组合」，不宣称「通道已关闭」。
  // 两变量只影响 isTTY 判定，不改动任何落态/记账语义；生产路径不设置这两个变量。
  const ttyForced = process.env.CONFIRM_DOC_TEST_TTY === '1' && process.env.NODE_ENV === 'test';
  if (!delegated && !autoMode && !ttyForced && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    // Trusted 自动泳道（hybrid-governance-explore-hardening）：trust-mode.json 为 Trusted
    // （enabled 且 level=2）时，非 TTY 调用（AI 会话）对文档**免手工触发**（无需 --delegated 原话 /
    // --auto 旗标）自动转入 AI 自治放行——单份、非放弃态才可隐式（与 --auto 同口径，L1 门与
    // incidents 排除由主循环自治门照常执行）；不满足则维持原拒绝（fail-closed，Standard/Strict 不隐式）。
    let implicitTrust = null;
    try {
      implicitTrust = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'trust-mode.json'), 'utf8'));
    } catch { implicitTrust = { enabled: false, level: 0 }; }
    if (implicitTrust.enabled && implicitTrust.level === 2 && docs.length === 1 && !toTarget) {
      autoMode = true;
      trustConfig = implicitTrust; // 主循环自治门（L1 与 incidents 排除）直读本配置——顶部 if (autoMode) 块先于 TTY 门执行，须在此补装
      console.error('⚠️  Trusted 自动泳道（隐式）：单份 L1 文档按 AI 自治放行（Level 2 全闭环，台账 source=ai-auto-trust-L2）；L2/L3 与 incidents 仍须人工确认');
    } else {
      console.error('确认门须由用户在终端亲手运行（node .agents/scripts/confirm-doc.mjs <workflow/文档>...）——AI 会话内不可代确认；用户对话内明确确认后可用 --delegated "<用户原话>" 委托代录（台账如实记来源）');
      process.exit(1);
    }
  }
  if (!docs.length) {
    console.error('用法：node .agents/scripts/confirm-doc.mjs <workflow/intents|specs|plans/x.md> [...]  [--root <仓库根>] [--delegated "<用户原话>" [--batch]]');
    process.exit(1);
  }
  if (delegated) {
    console.error('⚠️  委托代录模式：确认语义 = 用户已在对话中明确放行；台账行将如实记 source=chat-delegated 与原话，不伪装 TTY 确认');
    console.error(`   用户原话：「${delegatedQuote}」`);
    // 单文档默认（confirm-gate-one-per-call）：delegated 没有TTY「逐份过目」的天然机制——
    // 多文档并录曾系统性塌掉三道阶段门（build.md「逐件确认不得并作一次」）。逐件调用：一次一份、
    // 每次带当次用户原话。TTY 形态不受限（用户亲手逐份过目键入，天然逐件）。
    // 协作道批量（hybrid-governance-risk-lanes）：L1 可 `--batch` 多份一次代录——
    // 逐份读「级别」，L2/L3 逐份拒绝（见主循环协作道门）；台账行带 brief:true，检查 15 据此豁免并录告警。
    if (docs.length > 1) {
      if (!batchMode) {
        console.error(`❌ --delegated 一次仅接受一份文档（现 ${docs.length} 份：${docs.join(' ')}）——逐件确认口径（build.md）：每份一次调用、每次带当次用户原话；L1 协作道批量可加 --batch`);
        process.exit(1);
      }
      console.error(`   批量代录（--batch）：${docs.length} 份，仅受理 L1（协作道，异步审计兜底）；L2/L3 逐份拒绝`);
    }
  }
  // 调用事实（batch-ledger-audit）：本次进程调用的批次标识与件序——
  // 供 check-loop 检查 15 的并录审计直读（替代「同 quote + ts 接近」的反推）。
  const batch = randomBytes(3).toString('hex');
  let seq = 1;
  // 应答来源（**仅测试用**注入，见 CONFIRM_DOC_TEST_ANSWERS）：TTY 多文档路径的 batch/seq/of 是并录
  // 审计的判别基础，必须可端到端验证；而 spawnSync 的管道 stdin 是「写完即关」，readline 会在第二个
  // question 注册前吞掉后续行、且 stdin 已 EOF → 第 2 份必然挂住（**不是无 TTY 的限制**，是管道 EOF；
  // 2026-09-28 复核 P2-2 更正：此前测试注释把根因误记为「管道输入不被逐次消费」）。
  // 故提供问答注入：按序取预置应答，绕开 stdin/EOF 时序，不改动任何落态与记账语义。
  const injected = process.env.CONFIRM_DOC_TEST_ANSWERS !== undefined
    ? String(process.env.CONFIRM_DOC_TEST_ANSWERS).split(',').map((s) => s.trim())
    : null;
  const rl = delegated || injected ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => {
    if (injected) {
      process.stdout.write(q);
      return res(injected.shift() ?? '');
    }
    return rl.question(q, res);
  });
  let confirmed = 0;
  let refused = 0; // 逐阶段前置门拒绝数（exit 2 信号；2026-09-30 stage-gate-machine）
  const famCache = new Map(); // 引文接地的同名家族正文缓存（一次调用内同一 doc 只读一次）
  for (const doc of docs) {
    if (!DOC_RE.test(doc)) {
      console.error(`跳过 ${doc}：路径须匹配 workflow/{intents,specs,plans,incidents}/<文件>.md`);
      continue;
    }
    const abs = path.join(root, doc);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch { console.error(`跳过 ${doc}：文件不可读`); continue; }
    // 状态键只在 frontmatter 区（首 --- 至闭合 ---）取——防正文误命中
    const nl = text.replace(/\r\n/g, '\n').split('\n');
    let st = '';
    if (/^---\s*$/.test(nl[0] || '')) {
      for (let i = 1; i < nl.length && !/^---\s*$/.test(nl[i]); i++) {
        const m = nl[i].match(/^状态:\s*(.*)$/);
        if (m) { st = m[1].trim(); break; }
      }
    }
    const target = resolveTransition(st, toTarget);
    const lvl = fmLevel(nl); // 级别（AI 自治门 / 协作道批量门共用；缺 = ''）
    // 泳道单源 laneOfDoc（2026-10-10 收敛系列 2 起级别单字段协议，原 risk_level 双字段退役，见机制
    // 台账）：suspect（缺失/非法）按 high——--auto 与 --batch 均不受理，须先补「级别」。
    const fmOf = (key) => {
      const m = nl.find((l) => l.startsWith(`${key}:`));
      return m ? m.slice(key.length + 1).trim() : '';
    };
    const lane = laneOfDoc(lvl);
    // 重新确认（--reconfirm，approved-content-binding 2026-10-27）：approved 档承诺面被改写后，
    // 用户重新点头的通道——不推进状态，只重录内容指纹 + 承诺面指纹。状态行仍由本脚本写（不需手改
    // frontmatter），台账追加一行 stage=approved（新指纹）→ 检查 15 的承诺面绑定以该行为准。
    if (reconfirmMode) {
      if (st !== 'approved') {
        console.error(`❌ ${doc} 未过重新确认前置：--reconfirm 仅受理当前状态为 approved 的文档（现「${st || '缺失'}」）`);
        console.error('   重新确认 = 承诺面被改写后用户重新点头；状态推进（draft→approved→done）走默认前向或 --to（本份未落账、未写盘）');
        refused++;
        continue;
      }
      if (!famCache.has(doc)) famCache.set(doc, resolveFamilyTexts(root, doc));
      const grounding = groundQuote({
        quote: delegatedQuote, docText: text, familyTexts: famCache.get(doc),
      });
      if (!grounding.ok) {
        const detail = `引文接地未成立（${grounding.reason}）：残余「${grounding.residual}」在 ${doc} 及同名家族里找不到落点（最长逐字锚点 ${grounding.anchor} 字 < ${GROUND_ANCHOR_MIN}）`;
        if (strictQuote) {
          console.error(`❌ ${doc} ${detail}`);
          console.error('   --strict-quote 已开启：本份未落账、未写盘——换一句能指涉该文档内容的原话，或去掉该开关走 advisory');
          refused++;
          continue;
        }
        console.error(`⚠️  ${doc} ${detail}——advisory 放行，台账行进记 quoteGrounding=${grounding.reason} 供事后对质`);
      }
      const rfp = computeFingerprint(text);
      const rcommit = commitmentFingerprint(text);
      const rtext = applyTransition(text, 'approved', rfp.slice(0, 16));
      if (!rtext) {
        console.error(`❌ ${doc} 重新确认失败：无 frontmatter（首行非 ---）——状态行只由本脚本写，不手改文件`);
        refused++;
        continue;
      }
      fs.writeFileSync(abs, rtext);
      appendLedger(root, {
        ts: new Date().toISOString(), doc, stage: 'approved', fingerprint: rfp, prev: st,
        commit: rcommit,
        source: 'chat-delegated', quote: String(delegatedQuote),
        quoteGrounding: grounding.reason,
        batch, seq, of: docs.length,
        reconfirm: true, // 重新确认标记（纯增字段、向后兼容）：区别于首次批准行
      }, { shard: shardMode });
      console.log(`✓ ${doc} 重新确认（状态仍为 approved；内容指纹 ${rfp.slice(0, 16)}，承诺面指纹 ${rcommit}）`);
      confirmed++;
      seq++;
      continue;
    }
    if (!target) {
      console.error(`跳过 ${doc}：当前状态「${st || '缺失'}」无合法跳转（前向：docs draft→approved / approved→done；incidents open→fixed / fixed→closed；放弃 --to：cancelled 自 draft/approved/open/fixed，superseded 自 approved/done/fixed/closed）`);
      continue;
    }
    // 逐阶段前置门（stage-gate-machine）：specs/plans 的 draft→approved 须前置已确认
    // （plan 另须入口级别 L2/L3 时同名 spec 已确认）——未过拒绝落账（不写盘、不 append 台账）。
    if (target === 'approved' && (doc.startsWith('workflow/specs/') || doc.startsWith('workflow/plans/'))) {
      const gate = confirmGateFor(root, doc);
      if (!gate.ok) {
        console.error(`❌ ${doc} 未过逐阶段前置门（stage-gates）：${gate.reason}`);
        console.error(`   ${gate.hint}（本份未落账、未写盘）`);
        refused++;
        continue;
      }
    }
    // done 前置门（confirm-gate-approved-history）：→done 须 git 历史已留 approved 态
    // （先 done 后提交 / 两跳同批提交 → 拒绝；防「确认态缺失」缺陷复发；判据单源见 stage-gates.doneGateFor）。
    if (target === 'done') {
      // L2/L3 intent 关单门（2026-10-21 P0-1 整改）：L2/L3 intent 置 done 须同名 spec 已确认。
      // 配对硬门已于 2026-10-21「门禁极小化第 1 批」降为 WARN（s01-pairing.mjs），
      // 「L2/L3 无 spec」遂失去唯一机器兜底（review.md P0 必拦项声明的兜底已名存实亡）——
      // 执法点前移到关单动作时刻（与 §14 approved 留痕降档同一思路：门退了，闭环不退）。
      if (doc.startsWith('workflow/intents/') && (lvl === 'L2' || lvl === 'L3')) {
        const base = path.basename(doc, '.md');
        const sp = specConfirmed(root, base);
        if (!sp.ok) {
          console.error(`❌ ${doc} 未过 L2/L3 intent 关单门（同名 spec 必确认）：${sp.reason}`);
          console.error('   先走 design.md 完成同名 spec 确认，再关本 intent（本份未落账、未写盘）');
          refused++;
          continue;
        }
        // 关单完成度（closeout-completeness 2026-10-24）：同名 plan 已确认 + 独立复核落盘行。
        // 此前两项只有 closeout skill §0 的流程内自核（s01 仅 WARN）——agent 跳过自核即可合规关单。
        const pl = planConfirmedFor(root, base);
        if (!pl.ok) {
          console.error(`❌ ${doc} 未过 L2/L3 intent 关单门（同名 plan 必已确认）：${pl.reason}`);
          console.error('   先走 build.md 完成同名 plan 并确认（approved），再关本 intent（本份未落账、未写盘）');
          refused++;
          continue;
        }
        const rv = reviewLineFor(root, base);
        if (!rv.ok) {
          console.error(`❌ ${doc} 未过 L2/L3 intent 关单门（独立复核缺失）：${rv.reason}`);
          console.error('   回 test.md §4 补独立复核，落盘行须含「复核上下文：<会话/子代理 id>」，再关（本份未落账、未写盘）');
          refused++;
          continue;
        }
      }
      const gate = doneGateFor(root, abs, doc);
      if (!gate.ok) {
        console.error(`❌ ${doc} 未过 done 前置门（approved 历史）：${gate.reason}`);
        console.error(`   ${gate.hint}（本份未落账、未写盘）`);
        refused++;
        continue;
      }
      // 关单格式门（done-evidence-gate）：关单是最后一次写入——验收节证据标注（intent /
      // 独立 L1 plan）与「验收判据」表（L2/L3 spec）须落账前就位，否则 s08/s23 关单后 hard 只能重确认返工
      // （判据单源见 stage-gates.acceptanceEvidenceGate）。
      const evGate = acceptanceEvidenceGate(root, abs, doc);
      if (!evGate.ok) {
        console.error(`❌ ${doc} 未过关单格式门：${evGate.reason}`);
        console.error(`   ${evGate.hint}（本份未落账、未写盘）`);
        refused++;
        continue;
      }
      // 委派台账在场门（2026-10-25 优化4：写入时拦截）：L2/L3 新需求族 →done 须已有 delegations
      // 台账行（委派表或自做表，「任务一句话」含文件名）。判据与检查 18 事后对账逐条一致（单源
      // delegation-presence.rowCovers）；豁免口径亦同检查 18：非 L2/L3（自做 L1 2026-10-21 起不记）、
      // 日期缺失/非法、日期 < delegationSince 锚前存量、同名 incident 在场（修复族——记法「修复类不记」）。
      // 此前该条件只在 check-loop --hygiene §18 事后 WARN——「该写而未写」漂移数月才可见，前移到
      // 关单动作时刻当场拦（与 §14 approved 留痕降档后执法点前移同一思路：门退了，闭环不退）。
      if ((lvl === 'L2' || lvl === 'L3')
        && (doc.startsWith('workflow/intents/') || doc.startsWith('workflow/specs/') || doc.startsWith('workflow/plans/'))) {
        const base = path.basename(doc, '.md');
        // 日期：frontmatter 优先，缺则回落文件名前缀——plan 无「日期」字段（fill-plan 不写、模板亦无），
        // 旧判据「无日期即整段跳过」使本门对绝大多数 L2/L3 plan 静默失效（2026-10-27 实证 57 份
        // 2026-10-06 锚后新建 L2/L3 文档因缺日期整体绕开本门）。沿检查 15 / 19 既有口径补文件名兜底。
        const dDate = fmOf('日期') || (/^\d{4}-\d{2}-\d{2}$/.test(base.slice(0, 10)) ? base.slice(0, 10) : '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(dDate)) {
          const since = loadKitPolicy(root).delegationSince;
          if (typeof since !== 'string' || dDate >= since) {
            if (!fs.existsSync(path.join(root, 'workflow', 'incidents', `${base}.md`))) {
              if (!rowCovers(delegationRowsOf(root), base, dDate)) {
                console.error(`❌ ${doc} 未过委派台账在场门：delegations 台账（主表∪分片）没有日期 ≥ ${dDate} 且含「${base}」的结果行`);
                console.error('   先落一行再关单（委派走「委派结果」节、自做走「自做任务结果」节，任务一句话含文件名）：');
                console.error('   node .agents/scripts/ledger-shards.mjs --append delegations --section <委派结果|自做任务结果> --row "| YYYY-MM-DD | … | 一次通过 | 备注 | 返工原因 |"');
                console.error('   （判据与检查 18 对账一致；修复族与锚前存量豁免，记法见 workflow/delegations.md 头部）（本份未落账、未写盘）');
                refused++;
                continue;
              }
            }
          }
        }
      }
      // 承诺面绑定门（approved-content-binding 2026-10-27）：approved→done 前，承诺面须与「用户点头
      // 那一刻」的承诺面一致——承诺（判据文本/红线/目标/改动方案）在确认后被改写而未重新点头，
      // 用户点头的就不是关单时兑现的那一份。归一掉关单期合法动作（勾验收/证据回填/确认结果/复核行），
      // 判据单源 = stage-gates.commitmentFingerprint。存量（本次上线前确认，台账无 commit 字段）不追溯。
      const apprRows = loadAllConfirmations(root)
        .filter((e) => e && e.doc === doc && e.stage === 'approved' && typeof e.commit === 'string');
      if (apprRows.length) {
        const fmFp = fmOf('确认指纹');
        const byFp = fmFp ? apprRows.filter((e) => typeof e.fingerprint === 'string' && e.fingerprint.startsWith(fmFp)) : [];
        const pool = byFp.length ? byFp : apprRows;
        const lastAppr = pool[pool.length - 1];
        const nowCommit = commitmentFingerprint(text);
        if (nowCommit !== lastAppr.commit) {
          console.error(`❌ ${doc} 未过承诺面绑定门：承诺面自 approved 确认后已被改写（承诺面指纹 ${lastAppr.commit} → ${nowCommit}）——用户点头的不是关单时兑现的那一份`);
          console.error('   ① 承诺确有变更 → 请用户重新点头后重录：node .agents/scripts/confirm-doc.mjs ' + doc + ' --reconfirm --delegated "<用户对话原话>"');
          console.error('   ② 仅勾验收/补证据/复核行改动 → 不应触发本门（归一口径有漏，请登记 papercut）');
          console.error('   （本份未落账、未写盘）');
          refused++;
          continue;
        }
      }
    }
    // 测试绿凭证前置（verify-evidence 立 advisory 灰度第一档；2026-10-09 AI-Native 架构审查
    // 升灰度第二档）：→done 且文档含「验收标准」节且 policy v5+（verifySince）→ 24h 窗口内须有
    // verifications.jsonl 绿行（判定单源 policy.hasFreshVerifyLine，夹具 testCmd 行不算）。
    // policy 带 verifyHardSince 锚且跳转日 ≥ 锚 → hard：无凭证即拒绝落账；锚日之前与缺键（v1–v7）
    // 逐字节维持原 advisory。CONFIRM_DOC_TEST_NOW 仅测试注入日期，生产不设=取当日。
    if (target === 'done') {
      const pol = loadKitPolicy(root);
      if (typeof pol.verifySince === 'string'
        && /^##\s*[^#]*验收标准/m.test(text) && !hasFreshVerify(root)) {
        const today = (process.env.CONFIRM_DOC_TEST_NOW || new Date().toISOString()).slice(0, 10);
        const hard = typeof pol.verifyHardSince === 'string' && today >= pol.verifyHardSince;
        console.error(`${hard ? '❌' : '⚠️'} ${doc} 置 done：24h 内无测试绿凭证（verifications.jsonl）——关单勾验的「测试绿」声明缺机器事实`);
        console.error(`   跑 node .agents/scripts/verify.mjs（全绿自动落账）后重新关单；本次${hard ? '拒绝落账、不改盘（hard，灰度第二档：policy v8 verifyHardSince）' : '不拦截（advisory，灰度第一档）'}`);
        if (hard) {
          refused++;
          continue;
        }
      }
    }
    // 活文档一致性前置门（2026-10-17 关单活文档门 A1）：docs→done / incidents→closed 关单时，回归
    // 清单引用的测试类/流程文档须仍存在（判定单源 check-regression-consistency.mjs）。独立复核反复
    // 抓到「清单残留旧口径」这类债（规格内断言失效、被删测试仍被引用），却只在复核阶段可见——前移
    // 到关单，让残留当场被拦，不进归档。弱档存在性（不猜语义）；tmp 脚本因易失只 advisory 不拦。
    if (target === 'done' || target === 'closed') {
      try {
        const { scanRegressionRefs } = await import('./check-regression-consistency.mjs');
        const rr = scanRegressionRefs(root);
        const dangling = [...rr.danglingClasses.map((c) => `测试类 ${c}`), ...rr.danglingDocs.map((d) => `流程文档 ${d}`)];
        if (dangling.length) {
          console.error(`❌ ${doc} 未过关单活文档一致性门：回归清单引用了不存在的资产（${dangling.length} 处）——`);
          for (const d of dangling.slice(0, 10)) console.error(`   - ${d}`);
          if (dangling.length > 10) console.error(`   … 另 ${dangling.length - 10} 处`);
          console.error('   处理：按回归清单维护规则 4 删除/改写过时条目，或恢复被误删的资产（本份未落账、未写盘）');
          refused++;
          continue;
        }
      } catch (err) {
        console.error(`⚠️  ${doc} 活文档一致性检查执行失败（${err.message}）——不拦截（fail-open），但须人工确认清单无残留`);
      }
    }
    const fp = computeFingerprint(text);
    // 承诺面指纹（approved-content-binding 2026-10-27）：与内容指纹并列落台账——内容指纹管「整篇逐字
    // 未变」，承诺面指纹管「承诺（判据/红线/目标/改动方案）未变」，后者容许关单期合法动作（勾验收、
    // 证据回填、确认结果/复核行）而拒承诺改写。判据单源 = stage-gates.commitmentFingerprint。
    const commitFp = commitmentFingerprint(text);
    // AI 自治放行分支（ai-autonomy-trust）：
    // ① 仅 L1（读 frontmatter「级别」，缺级别按不可自治处理——fail-closed）；
    // ② Level 1：仅 draft→approved；Level 2：draft→approved 与 approved→done；
    // ③ incidents 永不自治（open→fixed/fixed→closed 必须人工）。
    if (autoMode) {
      const isLowLevel = lane === 'low';
      const stageAllowed = trustConfig.level === 2
        ? (target === 'approved' || target === 'done')
        : target === 'approved';
      if (!isLowLevel || !stageAllowed || doc.startsWith('workflow/incidents/')) {
        console.error(`❌ ${doc} 未过 AI 自治门（级别「${lvl || '缺失'}」/ 泳道「${lane}」/ 目标态「${target}」/ 类型）：Level ${trustConfig.level} 仅授权泳道 low（intent 级别 L1；suspect 须先补「级别」）的 ${trustConfig.level === 2 ? 'approved/done' : 'approved'} 且不含 incidents`);
        refused++;
        continue;
      }
      fs.writeFileSync(abs, applyTransition(text, target, fp.slice(0, 16)));
      appendLedger(root, {
        ts: new Date().toISOString(), doc, stage: target, fingerprint: fp, prev: st,
        commit: commitFp,
        source: `ai-auto-trust-L${trustConfig.level}`, quote: `AI 自治放行 (Trust Level ${trustConfig.level})`,
        batch, seq, of: docs.length,
      }, { shard: shardMode });
      console.log(`✓ ${doc} ${st} → ${target}（指纹 ${fp.slice(0, 16)}，AI 自治已记账：source=ai-auto-trust-L${trustConfig.level}）`);
      confirmed++;
      seq++;
      continue;
    }
    if (delegated) {
      // 协作道门（hybrid-governance-risk-lanes；caliber-convergence 起单源泳道）：
      // --batch 批量仅受理泳道 low（intent 级别 L1；suspect 拒）——high/suspect 逐份拒绝落账；
      // 不带 --batch 的单份代录不限级别（既有口径不变）。
      const low = lane === 'low';
      if (batchMode && !low) {
        console.error(`❌ ${doc} 泳道「${lane}」（级别「${lvl || '缺失'}」）不在协作道——--batch 批量代录仅限级别 L1；suspect（级别缺失/非法）须先补级别，L2/L3 防御道须逐份确认（本份未落账、未写盘）`);
        refused++;
        continue;
      }
      // 引文接地校验（delegated-quote-grounding，2026-10-22）：quote 是「事后对质」的唯一证据，
      // 先判它对目标文档有没有指涉。判据与实测取舍见 quote-grounding.mjs 头注——中文口语是复述
      // 不是引用，词面判据无法在「误杀合规口语」与「放过误配」之间同时成立（K=8 误杀 L2/L3 17.9%，
      // 且对无关文档仍通过 71.2%），故**默认 advisory**（WARN + 台账行记 quoteGrounding），
      // 策略收硬走显式 --strict-quote。
      if (!famCache.has(doc)) famCache.set(doc, resolveFamilyTexts(root, doc));
      const grounding = groundQuote({
        quote: delegatedQuote, docText: text, familyTexts: famCache.get(doc),
      });
      if (!grounding.ok) {
        const detail = `引文接地未成立（${grounding.reason}）：残余「${grounding.residual}」在 ${doc} 及同名家族里找不到落点（最长逐字锚点 ${grounding.anchor} 字 < ${GROUND_ANCHOR_MIN}）`;
        if (strictQuote) {
          console.error(`❌ ${doc} ${detail}`);
          console.error('   --strict-quote 已开启：本份未落账、未写盘——换一句能指涉该文档内容的原话，或去掉该开关走 advisory');
          refused++;
          continue;
        }
        console.error(`⚠️  ${doc} ${detail}——advisory 放行，台账行进记 quoteGrounding=${grounding.reason} 供事后对质`);
      }
      fs.writeFileSync(abs, applyTransition(text, target, fp.slice(0, 16)));
      appendLedger(root, {
        ts: new Date().toISOString(), doc, stage: target, fingerprint: fp, prev: st,
        commit: commitFp,
        source: 'chat-delegated', quote: String(delegatedQuote),
        // 引文接地判据结果（delegated-quote-grounding）：verbatim/anchor/generic = 接地成立；
        // ungrounded = 找不到落点（默认仅 WARN，台账留痕供审计与趋势；--strict-quote 则上面已拒绝）
        quoteGrounding: grounding.reason,
        // 调用事实（batch-ledger-audit）：seq=本次调用内件序（从 1），of=本次调用总份数
        batch, seq, of: docs.length,
        // 简洁审计标记（hybrid-governance-risk-lanes）：L1 协作道行带 brief（quote 仍入账供对质），
        // 检查 15 并录审计对全 brief 批次豁免「确认并录」告警
        ...(low ? { brief: true } : {}),
      }, { shard: shardMode });
      console.log(low
        ? `✓ ${doc} ${st} → ${target} [${lvl} 协作道/异步审计]（指纹 ${fp.slice(0, 16)}）`
        : `✓ ${doc} ${st} → ${target}（指纹 ${fp.slice(0, 16)}，代录已记账：source=chat-delegated）`);
      confirmed++;
      seq++;
      continue;
    }
    console.log('\n'.repeat(3) + '='.repeat(72));
    console.log(`文档：${doc}    状态：${st} → ${target}    指纹：${fp.slice(0, 16)}`);
    console.log('='.repeat(72));
    console.log(text);
    console.log('='.repeat(72));
    const ans = (await ask(`键入"可以"确认本份（${st} → ${target}），其他任意输入跳过：`)).trim();
    if (ans !== '可以') {
      console.log(`× 已跳过 ${doc}（未落状态）`);
      continue;
    }
    fs.writeFileSync(abs, applyTransition(text, target, fp.slice(0, 16)));
    appendLedger(root, {
      ts: new Date().toISOString(), doc, stage: target, fingerprint: fp, prev: st,
      commit: commitFp,
      source: 'tty',
      batch, seq, of: docs.length, // 调用事实（形态无关：TTY 多文档天然逐件过目，of>1 不构成违规）
    }, { shard: shardMode });
    console.log(`✓ ${doc} → ${target}（指纹 ${fp.slice(0, 16)}，台账已记）`);
    confirmed++;
    seq++;
  }
  if (rl) rl.close();
  // --- 终态件滚动归档（archive-on-close）---
  // 关单即归档：本进程刚落终态的文档，其同名家族若已全终态且超窗、无活跃引用 → git mv 进
  // workflow/archive/<家族最晚终态月>/{类型}/。动机：archive-sweep 是手工工具、无人跑，活跃目录
  // 无限膨胀（实测 885 篇，其中 733 篇终态零引用）；挂进确认门后活跃目录恒定。
  // 判定单源 = archive-sweep.analyze（禁第二套口径）；归档单位 = 同名家族（check-loop 检查 1 的
  // 结构配对是家族双向在场审计，单篇归档会造配对断裂——首批 89 篇返工实证）。
  // 时序：**台账行已写、状态已落盘之后**才 mv——check-loop 检查 15 的内容绑定按台账 doc 路径读
  // 四目录直下文件，归档后该路径不在 docFiles() 扫描面内，绑定检查自然跳过（归档件不再受内容绑定
  // 约束，与既有 2026-09 批次同口径）。失败一律 fail-open：归档是卫生动作，不得回滚已完成的确认。
  // 启用条件：仓库已建立归档约定（workflow/archive/ 存在）——真实仓库有（2026-09 批次起），
  // 临时 fixture 无；避免测试夹具被静默搬走（也避免在未采纳归档的仓库里凭空造目录）。
  const archiveRoot = path.join(root, 'workflow', 'archive');
  // 特性分支默认不归档（2026-10-15）：分支上先关单再合并时，diff 只剩 archive/ 路径，
  // CI 泳道门只认 workflow/intents|incidents 活跃直路径，合法合并被拦。
  // main / master / develop 与游离 HEAD 维持关单即归档。CONFIRM_DOC_NO_ARCHIVE=1 仍强制关；
  // CONFIRM_DOC_ARCHIVE=1 可在特性分支强制归档。
  let featureHold = false;
  if (confirmed > 0 && !process.env.CONFIRM_DOC_NO_ARCHIVE && process.env.CONFIRM_DOC_ARCHIVE !== '1') {
    let branch = '';
    try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { branch = ''; }
    featureHold = !!branch && branch !== 'HEAD' && !['main', 'master', 'develop'].includes(branch);
    if (featureHold && fs.existsSync(archiveRoot)) {
      console.log(`📦 特性分支 ${branch} 不归档（合并前保持 workflow 活跃路径；main/develop 关单才归档）。CONFIRM_DOC_ARCHIVE=1 可强制`);
    }
  }
  if (confirmed > 0 && !process.env.CONFIRM_DOC_NO_ARCHIVE && !featureHold && fs.existsSync(archiveRoot)) {
    try {
      const { analyze, buildDocList, loadLastTouch, parseStatus, TERMINAL, ACTIVE } = await import('./archive-sweep.mjs');
      const { loadAllConfirmations } = await import('./ledger-loader.mjs');
      const ledgerTs = {};
      for (const e of loadAllConfirmations(root)) {
        if (TERMINAL.has(e.stage) && e.doc) {
          const d = (e.ts || '').slice(0, 10);
          if (d && (!ledgerTs[e.doc] || d > ledgerTs[e.doc])) ledgerTs[e.doc] = d;
        }
      }
      const allDocs = buildDocList(root);
      // 窗口口径：本次确认的文档**刚**落终态，其台账 ts = 今日 → 21 天窗口必然拦下（窗口的用途是
      // 「防归档仍在编辑的在途件」，而刚过确认门的终态件按定义已定稿，窗口对它冗余）。故对本进程
      // 确认过的家族用 windowDays=-1（判据 `floor((today-tTime)/864e5) <= windowDays` 恒 false = 窗口
      // 关闭；注意 0 不等于关闭——0 表示「同日也算未满窗」）；未涉及的家族不在此次归档范围（touched
      // 过滤），历史积压仍走 archive-sweep 手工批次 + 21 天窗口。
      const r = analyze({
        docs: allDocs,
        ledgerTs,
        lastTouch: loadLastTouch(root),
        activeTexts: allDocs.filter((d) => ACTIVE.has(parseStatus(d.text))).map((d) => d.text),
        windowDays: -1,
      });
      // 只归档「本次确认涉及的家族」——不越权清理历史积压（积压走 archive-sweep 手工批次）
      const touched = new Set(docs.map((d) => path.basename(d)));
      const mine = r.candidates.filter((x) => touched.has(x.file));
      if (mine.length) {
        for (const x of mine) {
          const destDir = path.join(root, 'workflow', 'archive', x.month, x.dir);
          fs.mkdirSync(destDir, { recursive: true });
          execFileSync('git', ['mv', x.rel, path.join('workflow', 'archive', x.month, x.dir, x.file)], { cwd: root });
        }
        const fams = new Set(mine.map((x) => x.file));
        console.log(`📦 归档 ${mine.length} 篇 / ${fams.size} 族 → workflow/archive/<终态月>/（家族原子；活跃目录不再累积终态件）`);
      }
    } catch (err) {
      console.error(`⚠️ 归档跳过（fail-open，不影响已完成的确认）：${err.message}`);
    }
  }
  console.log(`\n完成：确认 ${confirmed} 份 / 跳过 ${docs.length - confirmed - refused} 份 / 拒绝 ${refused} 份${delegated ? '（委托代录）' : ''}`);
  process.exit(refused ? 2 : 0);
}
export default { computeFingerprint, nextStage, applyTransition, appendLedger, fmLevel };
