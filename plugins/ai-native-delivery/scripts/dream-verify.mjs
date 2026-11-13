#!/usr/bin/env node
// dream-verify.mjs — dreaming 校错 pass：知识文档引用完整性对拍（2026-11-12，设计稿 G 系列步骤 C / G2）
// 定位：Dreaming 链（kb-search 命中遥测 → agg-kb-usage 冷聚合 → dream-run 只读审计）之外的「校错」面。
//   对照 Anthropic《The components of agent memory》Dreaming：错误记忆要拿 ground truth 离线校正——
//   本脚本只做**引用完整性**对拍：只标硬漂移（引用了不存在的东西）；语义真伪不判（离线无模型，
//   宁漏报不误报；语义校验留给会话内 agent 或未来带模型的定时任务——设计稿「明确不做」。
//   例外：--model 语义复评档（见下）把语义面作为 opt-in 显式开启，默认关、默认路径零模型）。
// 扫描闭集（保守）：
//   ① workflow/principles.md（∪ workflow/principles.d/*.md 分片，若在）
//   ② workflow/regression-checklist.md（∪ workflow/regression-checklist.d/*.md 分片，若在）
//   ③ workflow/specs|plans/ 中 frontmatter「状态:」为终态的存档件（终态词表 = doc/incident 终态并集，
//     check-doc-body-drift 同口径；_TEMPLATE.md 不扫；非终态不扫——在途稿的引用本就未落定）
// 规则型断言行判据（从权、成文；改口径先改这里再改头注）：行内含——
//   a. 仓内相对路径引用：token 以 workflow/ .agents/ wiki/ 三树前缀开头、末段带扩展名形态；
//     前邻为 / 或 \ 的（URL 内段、POSIX/Windows 绝对路径中段）不取——URL 与绝对路径整段跳过；
//     目录/前缀形态（token 以 . / - / / 结尾）不判——宁漏报不误报
//   b. sha256 指纹引用：64-hex token（前后非 hex 为界；前邻 / 的 URL 内段如 commits/<sha> 跳过）
// 对拍 ground truth：
//   路径引用 → 仓内路径存在（文件或目录）；workflow/ 件不在场时查 workflow/archive/** 基名——
//     同名件在归档即「被引文档在场」，不算硬漂移（archive-sweep 搬家不制造假漂移）；
//   指纹引用 → .agents/confirmations.jsonl ∪ .agents/confirmations.d/*.jsonl 原始行中的 64-hex
//     能对上（按原始行抽取，不依赖行 schema）；台账缺位或零指纹 → 指纹面整面跳过（没有
//     ground truth 就不出存疑，空台账零误报）。
// 输出：advisory 报告落 <root>/.agents/tmp/dream-verify-<date>.md（存疑注记清单：文档、行号、失效引用、
//   建议动作 复评/更新/删行——删除类动作仅建议，删除须用户单独指令）；不改任何源文档。
// --model 语义复评（2026-11-13，opt-in 默认关）：对扫描闭集里「规则型断言行」（scanLine 命中面：
//   仓内路径引用 + sha256 指纹引用，含已判硬漂移的存疑行）做语义对拍——每条独立打包 prompt
//   （文档路径 + 行内容 + 引用目标 + 可取得的 ground truth 摘录：在册确认行原文 / 在场证据文件头几行 /
//   缺失事实），要求回严格 JSON 三态（仍成立=引用虽断但结论仍有据 / 存疑=需人工核 / 失效=结论已无
//   支撑），结果进报告 E 段「语义复评（--model）」。护栏：逐条独立调用（不合并上下文防串扰）、一次
//   最多送评 20 条（超出截断并注明）、单条失败不阻塞其余；模型缺席/全部失败 → E 段单行
//   「语义复评不可用：<原因>」。advisory 语义不变：退出码与 A–D 段判定面不因模型升级改变（恒 0）。
//   模型调用经 scripts/model-call.mjs 单源（opt-in 项目自治面，门禁/CI/init 不接本面）。
// 用法：
//   node <插件根>/scripts/dream-verify.mjs                    # 默认根 = 项目 git 根 > cwd
//   node <插件根>/scripts/dream-verify.mjs --root <仓库根>    # 显式根
//   node <插件根>/scripts/dream-verify.mjs --model [--runner <cmd>]  # 语义复评档（默认 runner claude）
// 库面：runDreamVerify(root, { model, runner })（isMain 门惯例）——dream-run.mjs 进程内 import 复用
//   （避免重复扫描），其报告 D 段引用本结果；不带 model 选项时行为与报告逐字节同旧版。安全边界：
//   唯一写盘动作 = 报告本身（.agents/tmp/，gitignore 运行态），绝不落插件目录；退出码恒 0
//   （advisory 不拦流程；参数错误除外 exit 2）。
// 测试：node <插件根>/test/dream-verify.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findProjectRoot, projectRoot } from './paths.mjs';
import { callModel } from './model-call.mjs';

const ROOT = process.env.DREAM_VERIFY_ROOT || findProjectRoot() || projectRoot();

// 终态词表（workflow-enums.txt：doc.status.terminal ∪ incident.status.terminal，check-doc-body-drift 同口径）
const TERMINAL = new Set(['done', 'superseded', 'cancelled', 'closed', 'fixed']);

// 常驻规则档（主档 + 分片目录）；specs/plans 走「终态存档件」判据，另扫。
const STANDING_DOCS = [
  { main: 'workflow/principles.md', shards: 'workflow/principles.d' },
  { main: 'workflow/regression-checklist.md', shards: 'workflow/regression-checklist.d' },
];
const ARCHIVE_TYPES = ['specs', 'plans'];

// token 判据单点：仓内相对路径引用（前邻非路径字符——URL 内段 / 绝对路径中段天然不取）
const PATH_RE = /(^|[^A-Za-z0-9_.\-\\/])((?:workflow|\.agents|wiki)\/[A-Za-z0-9._\-/]+)/g;
// 指纹判据单点：sha256 64-hex，前后非 hex 为界
const FP_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g;

// scanLine(line)：规则型断言行判据——行内仓内路径引用 ∪ 64-hex 指纹引用，返回 [{kind, ref}]。
function scanLine(line) {
  const refs = [];
  for (const m of String(line).matchAll(PATH_RE)) {
    const raw = m[2];
    if (/[.\-/]$/.test(raw)) continue; // 目录/前缀形态（以 . - / 结尾）不判——宁漏报不误报
    const segs = raw.split('/');
    if (segs.some((s) => !s || s === '.' || s === '..')) continue;
    if (!/\.[A-Za-z0-9]+$/.test(segs[segs.length - 1])) continue; // 末段须带扩展名形态（文件引用）
    refs.push({ kind: 'path', ref: raw });
  }
  for (const m of String(line).matchAll(FP_RE)) {
    if (m.index > 0 && line[m.index - 1] === '/') continue; // URL 内段（如 commits/<sha>）跳过
    refs.push({ kind: 'fingerprint', ref: m[0].toLowerCase() });
  }
  return refs;
}

// fmStatusOf(lines)：frontmatter（首个 --- 块）内「状态:」值（check-doc-body-drift 同口径）
function fmStatusOf(lines) {
  if (!/^---\s*$/.test(lines[0] || '')) return '';
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return '';
    const m = lines[i].match(/^状态:\s*(\S+)/);
    if (m) return m[1];
  }
  return '';
}

// collectScanDocs(root)：扫描闭集文档，返回 [{rel, lines}]；读失败（竞态删除）按不在场跳过。
function collectScanDocs(root) {
  const docs = [];
  const push = (abs, rel) => {
    try { docs.push({ rel, lines: fs.readFileSync(abs, 'utf8').split(/\r?\n/) }); } catch { /* 竞态删除：跳过 */ }
  };
  for (const { main, shards } of STANDING_DOCS) {
    if (fs.existsSync(path.join(root, main))) push(path.join(root, main), main);
    let es = [];
    try { es = fs.readdirSync(path.join(root, shards)).sort(); } catch { /* 分片目录缺席常态 */ }
    for (const f of es) if (f.endsWith('.md')) push(path.join(root, shards, f), `${shards}/${f}`);
  }
  for (const type of ARCHIVE_TYPES) {
    let es = [];
    try { es = fs.readdirSync(path.join(root, 'workflow', type)).sort(); } catch { continue; }
    for (const f of es) {
      if (!f.endsWith('.md') || f === '_TEMPLATE.md') continue;
      const rel = `workflow/${type}/${f}`;
      let lines;
      try { lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/); } catch { continue; }
      if (!TERMINAL.has(fmStatusOf(lines))) continue; // 存档件判据：frontmatter 状态终态；非终态不扫
      docs.push({ rel, lines });
    }
  }
  return docs;
}

// collectLedgerFingerprints(root)：确认台账（主档 ∪ 分片）原始行中的 64-hex 集合——按原始行抽取
// 不依赖行 schema（字段改名不影响对拍）。present = 台账文件至少一份可读（报告交代用）；
// rows = 非空原始行（--model 语义复评的「对应确认行原文」ground truth 取材面，--model 才消费）。
function collectLedgerFingerprints(root) {
  const files = [path.join(root, '.agents', 'confirmations.jsonl')];
  try {
    for (const f of fs.readdirSync(path.join(root, '.agents', 'confirmations.d')).sort()) {
      if (f.endsWith('.jsonl')) files.push(path.join(root, '.agents', 'confirmations.d', f));
    }
  } catch { /* 分片目录缺席常态 */ }
  let present = false;
  const set = new Set();
  const rows = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    present = true;
    for (const line of text.split(/\r?\n/)) if (line.trim()) rows.push(line);
    for (const m of text.matchAll(FP_RE)) set.add(m[0].toLowerCase());
  }
  return { present, fingerprints: set, rows };
}

// collectArchiveBasenames(root)：workflow/archive/** 的 .md 基名集——终态件「被引文档在场」判据。
function collectArchiveBasenames(root) {
  const out = new Set();
  const walk = (dir) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.add(e.name);
    }
  };
  walk(path.join(root, 'workflow', 'archive'));
  return out;
}

// ---------- 对拍（root 可注入，测试复用）----------
// 返回 { date, root, scanned, ledger, findings, reportPath }；model:true 时另带 semantic（E 段数据源）。
// 唯一写盘 = 报告本身（写不进不拦面）。不带 model 选项时行为与报告逐字节同旧版（dream-run/MCP 兼容）。
export function runDreamVerify(root = ROOT, { model = false, runner } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const docs = collectScanDocs(root);
  const ledger = collectLedgerFingerprints(root);
  const archive = collectArchiveBasenames(root);
  const findings = [];
  const items = []; // 规则断言行清单（--model 语义复评送评面；默认档不消费）
  let scannedLines = 0;
  for (const d of docs) {
    for (let i = 0; i < d.lines.length; i++) {
      scannedLines++;
      for (const r of scanLine(d.lines[i])) {
        let status;
        let drift = false;
        if (r.kind === 'path') {
          if (fs.existsSync(path.join(root, ...r.ref.split('/')))) status = 'present';
          else if (r.ref.startsWith('workflow/') && archive.has(path.basename(r.ref))) status = 'archived'; // 已归档 = 在场
          else {
            status = 'missing';
            drift = true;
            findings.push({
              doc: d.rel, line: i + 1, kind: r.kind, ref: r.ref,
              advice: '路径不存在且归档无同名件——复评该行：更新为现路径或删行（删除须用户单独指令）',
            });
          }
        } else {
          if (ledger.fingerprints.size === 0) status = 'unmatched'; // 台账缺位/空 → 指纹面整面跳过（空台账零误报）
          else if (ledger.fingerprints.has(r.ref)) status = 'matched';
          else {
            status = 'unmatched';
            drift = true;
            findings.push({
              doc: d.rel, line: i + 1, kind: r.kind, ref: r.ref,
              advice: '指纹在确认台账（confirmations.jsonl ∪ 分片）对不上——复评来源：重录确认（confirm-doc）或删行（删除须用户单独指令）',
            });
          }
        }
        items.push({ doc: d.rel, line: i + 1, kind: r.kind, ref: r.ref, status, drift, lineText: d.lines[i] });
      }
    }
  }
  const result = {
    date, root,
    scanned: { docs: docs.length, lines: scannedLines, archiveDocs: archive.size },
    ledger: { present: ledger.present, fingerprints: ledger.fingerprints.size },
    findings,
    reportPath: '',
  };
  if (model) result.semantic = runSemanticReview({ root, items, ledger, runner });
  const target = path.join(root, '.agents', 'tmp', `dream-verify-${date}.md`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderVerifyReport(result), 'utf8');
    result.reportPath = target;
  } catch { /* 只读盘/竞态：报告写不进不拦面（advisory），findings 照常返回 */ }
  return result;
}

// ---------- --model 语义复评（opt-in；E 段数据源，CLI 与测试单源） ----------
// items = 扫描闭集 scanLine 命中面（{doc, line, kind, ref, status, drift, lineText}）——含确定性判据
// 已筛出的存疑行（drift=true 的硬漂移行）与其余含指纹/路径引用的规则断言行。逐条独立调用
// model-call.mjs 单源（不合并上下文防串扰）；一次最多 maxItems=20 条，超出截断（报告注明）。
// 三态判据（prompt 内成文）：仍成立=引用虽断但结论仍有据 / 存疑=需人工核 / 失效=结论已无支撑。
// 返回 { requested, sent, results, counts, unavailable }：
//   results[] = { doc, line, kind, ref, drift, verdict, reason, error }（error 非空 = 该条调用/解析失败）
//   counts = { still, doubt, invalid, failed }；unavailable = '' | 原因（模型缺席 / 送评条全部失败）
export function runSemanticReview({ root, items, ledger, runner, maxItems = 20 } = {}) {
  const requested = items.length;
  const sent = items.slice(0, maxItems);
  const results = [];
  let firstError = null;
  for (const item of sent) {
    const r = callModel({
      prompt: buildSemanticPrompt(item, semanticGroundTruth(root, item, ledger)),
      maxTurns: 1,
      ...(runner ? { runner } : {}),
    });
    if (!r.ok) {
      if (!firstError) firstError = r.error;
      results.push({ ...pick(item), verdict: '', reason: '', error: `${r.error.kind}:${r.error.code || '-'} ${r.error.message}` });
      continue;
    }
    const v = parseVerdict(r.json && r.json.result);
    if (!v) {
      results.push({ ...pick(item), verdict: '', reason: '', error: `non-json:VERDICT 回包非约定 JSON（缺 verdict 三态枚举或不可解析）` });
      continue;
    }
    results.push({ ...pick(item), verdict: v.verdict, reason: v.reason, error: '' });
  }
  const counts = { still: 0, doubt: 0, invalid: 0, failed: 0 };
  for (const r of results) {
    if (r.verdict === '仍成立') counts.still++;
    else if (r.verdict === '存疑') counts.doubt++;
    else if (r.verdict === '失效') counts.invalid++;
    else counts.failed++;
  }
  const failedAll = sent.length > 0 && counts.failed === sent.length;
  const unavailable = requested === 0 || !failedAll
    ? ''
    : firstError && firstError.code === 'RUNNER_NOT_FOUND'
      ? `模型缺席——${firstError.message}`
      : `送评 ${sent.length} 条全部调用失败（末次错误：${firstError ? `${firstError.kind}:${firstError.code || '-'} ${firstError.message}` : '未知'}）`;
  return { requested, sent: sent.length, results, counts, unavailable };
}

const pick = (item) => ({ doc: item.doc, line: item.line, kind: item.kind, ref: item.ref, drift: Boolean(item.drift) });

// parseVerdict(text)：模型正文（json.result 字符串）→ {verdict, reason}；容错 ``` 围栏与散文包裹，
// 从首个 {...} 提取；verdict 不在三态枚举内即判不可解析（宁失败不出假裁决）。
function parseVerdict(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const attempts = [s, (s.match(/\{[\s\S]*?\}/) || [])[0]].filter(Boolean);
  for (const a of attempts) {
    let obj = null;
    try { obj = JSON.parse(a); } catch { continue; }
    if (obj && typeof obj === 'object' && ['仍成立', '存疑', '失效'].includes(obj.verdict)) {
      return { verdict: obj.verdict, reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : '' };
    }
  }
  return null;
}

// semanticGroundTruth(root, item, ledger)：可取得的 ground truth 摘录（字符串数组）——
//   在场路径 → 文件头几行；在册指纹 → 对应确认行原文；缺失 → 缺失事实（引用目标不在场/指纹不在台账）。
function semanticGroundTruth(root, item, ledger) {
  const gt = [];
  if (item.kind === 'path') {
    if (item.status === 'present') {
      const abs = path.join(root, ...item.ref.split('/'));
      let head = '';
      try {
        const st = fs.statSync(abs);
        head = st.isDirectory()
          ? '（目录，在场）'
          : fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(0, 6)
            .map((l) => l.trim().slice(0, 160)).join(' ⏎ ') || '（空文件）';
      } catch { head = '（读取失败，按竞态处理）'; }
      gt.push(`引用目标在场。文件头几行：${head}`);
    } else if (item.status === 'archived') {
      gt.push('主路径不在场，但 workflow/archive/** 有同名归档件（对拍口径：被引文档视为在场）。');
    } else {
      gt.push('引用目标在仓内不存在，workflow/archive/** 归档也无同名件（确定性判据已判硬漂移）。');
    }
  } else if (item.status === 'matched') {
    const rows = ledger.rows.filter((l) => l.toLowerCase().includes(item.ref)).slice(0, 2)
      .map((l) => l.trim().slice(0, 240));
    gt.push(`指纹在确认台账有对应确认行原文：${rows.join(' ｜ ') || '（行级摘录不可得）'}`);
  } else {
    gt.push(ledger.present
      ? `指纹不在确认台账（台账在场，共 ${ledger.fingerprints.size} 个指纹值，无任何行含此指纹）${item.drift ? '——确定性判据已判硬漂移' : ''}。`
      : '确认台账缺位/空——指纹没有可对拍的 ground truth（对拍口径：空台账不出存疑）。');
  }
  return gt;
}

// buildSemanticPrompt(item, gt)：逐条打包 prompt（文档路径 + 行内容 + 引用目标 + ground truth）。
function buildSemanticPrompt(item, gt) {
  const kindLabel = item.kind === 'path' ? '仓内路径引用' : 'sha256 指纹引用';
  return `你在复核知识文档断言行的语义有效性（引用完整性校错后的语义复评，advisory）。只输出严格 JSON，不要输出任何其他文字：
{"verdict":"仍成立|存疑|失效","reason":"一句话"}
三态定义：仍成立=引用虽断但结论仍有据；存疑=需人工核；失效=结论已无支撑。

待评断言行：
- 文档：${item.doc} 第 ${item.line} 行
- 行内容：${String(item.lineText).trim().slice(0, 300)}
- 引用目标：${item.ref}（${kindLabel}${item.drift ? '；确定性判据已判该引用硬漂移' : ''}）
- 现状核对（ground truth）：
${gt.map((l) => `  - ${l}`).join('\n')}

判定该行断言在今天是否仍有依据，只回 JSON。`;
}

// ---------- 报告渲染（CLI 与 dream-run 单源） ----------
// result.semantic 在场（--model 档）才渲染 E 段与口径附注；缺省时输出与旧版逐字节一致。
export function renderVerifyReport(result, { generatedBy = 'dream-verify.mjs' } = {}) {
  const lines = [];
  lines.push(`# 引用完整性对拍报告 ${result.date}`);
  lines.push(`> 生成: node <插件根>/scripts/${generatedBy}（advisory 只读校错——不改任何源文档，不自动 commit / push；删除类动作仅建议，删除须用户单独指令）`);
  lines.push('> 口径：校错止于引用完整性，只标硬漂移（引用了不存在的东西）；语义真伪不判（离线无模型，宁漏报不误报）。');
  if (result.semantic) lines.push('> 本次带 --model 语义复评（opt-in 项目自治面，模型调用经 scripts/model-call.mjs 单源；advisory 语义不变——退出码与存疑注记判定面不受影响）。');
  lines.push('');
  const ledgerNote = result.ledger.present
    ? `在场（${result.ledger.fingerprints} 个指纹值）`
    : '缺位';
  lines.push(`扫描闭集 ${result.scanned.docs} 文档 / ${result.scanned.lines} 行（principles、regression-checklist 主档+分片、specs|plans 终态存档件）；归档基名 ${result.scanned.archiveDocs}；指纹台账 ${ledgerNote}${result.ledger.fingerprints === 0 ? '——指纹面整面跳过（空台账零误报）' : ''}。`);
  lines.push('');
  lines.push('## 存疑注记清单');
  lines.push('');
  if (result.findings.length === 0) lines.push('  无存疑注记（零误报基线：只报硬漂移）');
  else for (const f of result.findings) {
    lines.push(`  - ${f.doc}:${f.line}  ${f.kind === 'path' ? '引用失效' : '指纹未对上'}  ${f.ref}`);
    lines.push(`    → ${f.advice}`);
  }
  if (result.semantic) {
    const s = result.semantic;
    lines.push('');
    lines.push('## E. 语义复评（--model）');
    lines.push('');
    if (s.requested === 0) {
      lines.push('  语义复评无对象：扫描闭集没有规则型断言行（零引用行）。');
    } else if (s.unavailable) {
      lines.push(`  语义复评不可用：${s.unavailable}`);
    } else {
      lines.push('  三态：仍成立=引用虽断但结论仍有据 / 存疑=需人工核 / 失效=结论已无支撑。逐条独立调用（不合并上下文），一次最多送评 20 条。');
      lines.push('');
      for (const r of s.results) {
        lines.push(`  - ${r.doc}:${r.line}  ${r.kind === 'path' ? '路径引用' : '指纹引用'}  ${r.ref}${r.drift ? '（硬漂移）' : ''}`);
        lines.push(r.error ? `    → 调用失败：${r.error}` : `    → ${r.verdict}——${r.reason || '（无理由）'}`);
      }
      lines.push(`  汇总：仍成立 ${s.counts.still} / 存疑 ${s.counts.doubt} / 失效 ${s.counts.invalid} / 调用失败 ${s.counts.failed}（送评 ${s.sent} 条，候选 ${s.requested} 条${s.requested > s.sent ? '——超出 20 条上限已截断' : ''}）`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------- CLI（isMain 前置：被 dream-run / 测试 import 纯函数时本段不执行） ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  let root = '';
  let model = false;
  let runner = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = args[++i] ?? '';
    else if (a === '--model') model = true;
    else if (a === '--runner') runner = args[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node <插件根>/scripts/dream-verify.mjs [--root <仓库根>] [--model] [--runner <cmd>]
  --root <仓库根>   项目根（默认 = 项目 git 根 > cwd）；报告落 <root>/.agents/tmp/dream-verify-<date>.md
  --model           语义复评档（opt-in，默认关）：对扫描闭集规则断言行做模型语义对拍，结果进报告 E 段；
                    逐条独立调用、一次最多送评 20 条、单条失败不阻塞；advisory 语义不变（退出码恒 0）
  --runner <cmd>    --model 用的 runner（默认 claude；或环境变量 MODEL_CALL_RUNNER）
口径：知识文档引用完整性对拍（advisory）——只标硬漂移，语义真伪默认不判（--model 为 opt-in 例外）；
退出码恒 0（参数错误除外）。`);
      process.exit(0);
    } else {
      console.error(`未知选项: ${a}`);
      process.exit(2);
    }
  }
  const r = runDreamVerify(root ? path.resolve(root) : ROOT, model ? { model: true, ...(runner ? { runner } : {}) } : {});
  if (r.reportPath) console.log(`报告已写入 ${path.relative(r.root, r.reportPath) || r.reportPath}`);
  console.log(`（advisory 只读校错：扫描 ${r.scanned.docs} 文档 / ${r.scanned.lines} 行，存疑注记 ${r.findings.length} 处——复评/更新/删行走主智能体/用户，删除须用户单独指令）`);
  if (r.semantic) {
    const s = r.semantic;
    console.log(s.unavailable
      ? `（语义复评不可用：${s.unavailable}）`
      : `（语义复评：候选 ${s.requested} 条，送评 ${s.sent} 条——仍成立 ${s.counts.still} / 存疑 ${s.counts.doubt} / 失效 ${s.counts.invalid} / 调用失败 ${s.counts.failed}；advisory，裁决走主智能体/用户）`);
  }
}
