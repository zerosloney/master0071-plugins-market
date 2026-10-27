#!/usr/bin/env node
// pipeline-run — 跨宿主全自动闭环执行器（pipeline-run；spec workflow/specs/2026-10-02-pipeline-run.md）
// 用途：把六阶段闭环的确定性部分代码化为状态机——start/next/status/watch/abort 五子命令；
//       AI 槽位经工单协议交宿主执行，人件门到点即停、next --delegated "<原话>" 逐份过 confirm-doc。
// 红线：绝不 spawn AI 会话 / 零依赖 / git 永不 --no-verify / 永不伪造原话 / 永不直改文档状态（唯一入口 confirm-doc）。
// 契约：工单协议 + run 事件流 schema 见 spec §功能行为（宿主面契约，变更须走变更流程）。
// 冻结（2026-10-21）：阶段机行为停在 2026-10-02 spec。现行交付走 .agents/commands/ 手动闭环。
// 与手册的已知分叉保持不动：修复类 L2/L3 不产 spec；复核工单不认「复核上下文」落盘行；
// L1 plan 工单的 relatedDocs 仍指向 build.md。恢复为驱动须单开一轮并改 pipeline-run.test.mjs。
// pipeline-run.md 不扩写。
// 存储：.agents/cache/pipeline-runs/<runId>.json（gitignored 缓存态，非权威——workflow/ 文档 + confirmations.jsonl 是唯一真相源）。
// 注入（测试钩子，spec §测试注入契约）：PIPELINE_RUN_ROOT（仓库根，默认 cwd）/
//       PIPELINE_RUN_BIN（门脚本目录，默认 <root>/.agents/scripts）/ PIPELINE_RUN_GIT_BIN（git 命令前缀，空格分隔，默认 "git"）/
//       PIPELINE_RUN_TODAY（文档日期锚定，默认当天——测试固定日期消除时钟依赖，2026-10-03 实证：测试硬编码日期跨日即红）。
//       npm 不直接调用——测试门统一走 verify.mjs（其内部自跑 npm test）。
// 用法：
//   node .agents/scripts/pipeline-run.mjs start "<需求原文>" [--hint "kind=require level=L1 module=wiki"]
//   node .agents/scripts/pipeline-run.mjs next [--run <id>] [--triage "kind=|level=|module=|topic="] [--delegated "<原话>"] [--files "a,b"]
//   node .agents/scripts/pipeline-run.mjs status [--run <id>] [--adopt] [--json]
//   node .agents/scripts/pipeline-run.mjs watch [--run <id>] [--interval 2]
//   node .agents/scripts/pipeline-run.mjs abort --run <id> [--to superseded|cancelled] [--delegated "<原话>"]
// 测试：node templates/_agents/scripts/pipeline-run.test.mjs（夹具假门 + 假 git，不触真实仓库）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const KINDS = ['require', 'fix', 'verify', 'review', 'deploy']; // 导出单源：check-loop §25 预判执法面 import，禁再造字面拷贝
const LEVELS = ['L1', 'L2', 'L3'];
const TERMINAL = ['done', 'superseded', 'cancelled', 'closed'];
const FIX_CAP = 3;
const GIT_NEVER_FLAGS = ['--no-verify', '-n']; // 不变量：任何 git 调用不得携带（防御性断言，正常路径不会拼出）

function fail(msg, code = 1) { console.error('❌ ' + msg); process.exit(code); }
const nowIso = () => new Date().toISOString();
const today = () => process.env.PIPELINE_RUN_TODAY || nowIso().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

// ── 环境解析（测试注入点） ─────────────────────────────────────────────
function ctxEnv(overrideRoot) {
  const root = path.resolve(overrideRoot || process.env.PIPELINE_RUN_ROOT || process.cwd());
  const bin = path.resolve(process.env.PIPELINE_RUN_BIN || path.join(root, '.agents', 'scripts'));
  const gitPrefix = (process.env.PIPELINE_RUN_GIT_BIN || 'git').split(/\s+/).filter(Boolean);
  return { root, bin, gitPrefix, runsDir: path.join(root, '.agents', 'cache', 'pipeline-runs') };
}

function moduleList(ctx) {
  try {
    return fs.readFileSync(path.join(ctx.root, '.agents', 'config', 'workflow-modules.txt'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return ['backend', 'frontend', 'ui', 'infra', 'integration', 'pipeline', 'wiki']; } // 夹具缺表时的回退默认（warning 由调用方打）
}

// ── run 文件（原子写；事件 append-only） ──────────────────────────────
function runFileOf(ctx, runId) { return path.join(ctx.runsDir, `${runId}.json`); }

function loadRun(ctx, runId) {
  const f = runFileOf(ctx, runId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function saveRun(ctx, run) {
  fs.mkdirSync(ctx.runsDir, { recursive: true });
  run.updatedAt = nowIso();
  const f = runFileOf(ctx, run.runId);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

function emit(run, ev) { run.events.push({ t: nowIso(), ...ev }); }

function latestRunId(ctx) {
  if (!fs.existsSync(ctx.runsDir)) return null;
  const ids = fs.readdirSync(ctx.runsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  for (let i = ids.length - 1; i >= 0; i--) {
    const r = loadRun(ctx, ids[i]);
    if (r && !['done', 'aborted'].includes(r.stopType)) return ids[i];
  }
  return ids[ids.length - 1] || null;
}

function newRunId(requirement) {
  const d = new Date();
  const ascii = (requirement.toLowerCase().match(/[a-z0-9]{2,}/g) || []).slice(0, 3).join('-') || 'task';
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${ascii}-${rand}`;
}

// ── 门执行（唯一子进程出口；记录真实退出码） ──────────────────────────
function runNode(ctx, run, script, args) {
  const scriptPath = path.join(ctx.bin, script);
  const cmd = `node .agents/scripts/${script} ${args.join(' ')}`;
  const t0 = Date.now();
  // PIPELINE_RUN_ID 注入（verify-evidence 复核 P2-1）：verify.mjs 绿行据此绑定 runId
  //（对质链与 run 事件流同源，docsCommit 格式已含同一 runId）——spec「pipeline-run 路径自动绑定」落点
  const p = spawnSync(process.execPath, [scriptPath, ...args], { cwd: ctx.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PIPELINE_RUN_ID: run.runId } });
  const ms = Date.now() - t0;
  const exit = p.status ?? 1;
  emit(run, { type: 'gate', cmd, exit, ms });
  return { exit, stdout: p.stdout || '', stderr: p.stderr || '' };
}

function runGit(ctx, run, args) {
  if (args.some((a) => GIT_NEVER_FLAGS.includes(a))) fail('不变量破坏：git 调用携带禁用旗标', 1);
  const cmd = `git ${args.join(' ')}`;
  const t0 = Date.now();
  const p = spawnSync(ctx.gitPrefix[0], [...ctx.gitPrefix.slice(1), ...args], { cwd: ctx.root, encoding: 'utf8', windowsHide: true });
  const ms = Date.now() - t0;
  const exit = p.status ?? 1;
  emit(run, { type: 'gate', cmd, exit, ms });
  return { exit, stdout: p.stdout || '', stderr: p.stderr || '' };
}

// ── 文档读取/校验 ──────────────────────────────────────────────────────
function readDoc(ctx, rel) {
  try { return fs.readFileSync(path.join(ctx.root, rel), 'utf8'); } catch { return null; }
}
function fmGet(text, key) {
  const m = text.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return m ? m.slice(key.length + 1).trim() : null;
}
function docState(ctx, rel) { const t = readDoc(ctx, rel); return t ? fmGet(t, '状态') : null; }

// 占位符判定（复核 P1-3 收窄，2026-10-02）：先剔除 code span（`…`）与引号串（"…"）——
// 正文合法的命令语法占位（如 `next --delegated "<原话>"`）几乎总在 code span 内，
// 模板实占位符（如 <为什么做；写明需求来源…>）从不包 code span；再匹配剩余裸尖括号。
export function placeholdersIn(text) {
  const stripped = String(text)
    .replace(/^```[\s\S]*?^```$/gm, '') // 复核 P2-B：跨行 code fence 整块剔除（围栏内命令示例占位不属模板占位符）
    .replace(/`[^`\n]*`/g, '')
    .replace(/"[^"\n]*"/g, '');
  const hits = [];
  for (const re of [/<[^>\n]{1,60}>/g, /YYYY-MM-DD 用户/g]) {
    let m; while ((m = re.exec(stripped))) hits.push(m[0]);
  }
  return [...new Set(hits)].slice(0, 5);
}

function sectionBody(text, title) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === `## ${title}` || l.trim() === `## ${title}（L1 微改动无实质内容可删本节，不硬填）` || l.trim().startsWith(`## ${title}`));
  if (i < 0) return null;
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n').trim();
}

export function validateDraftContent(text, kind, level) {
  const problems = [];
  if (!text) return ['文件不存在或为空'];
  const state = fmGet(text, '状态');
  if (!state) problems.push('frontmatter 缺「状态:」行');
  if (kind !== 'incident' && !fmGet(text, '级别')) problems.push('frontmatter 缺「级别:」行');
  const ph = placeholdersIn(text);
  if (ph.length) problems.push(`模板占位符残留：${ph.join('、')}`);
  const required = {
    intent: level === 'L1' ? ['背景与问题', '目标', '验收标准'] : ['背景与问题', '历史教训/防复发', '目标', '非目标', '约束', '验收标准'],
    spec: ['功能行为', '数据流', '系统改动', '约束遵守映射'],
    plan: level === 'L1' ? ['入口', '改动方案', '约束与风险', '验证计划', '验收标准'] : ['改动方案', '任务拆解', '执行顺序', '验证计划'],
    incident: ['时间线', '根因', '复盘三件套'],
  }[kind] || [];
  for (const sec of required) {
    const b = sectionBody(text, sec);
    if (b === null) { if (!(level === 'L1' && ['非目标', '约束', '任务拆解', '执行顺序'].includes(sec))) problems.push(`缺节：## ${sec}`); }
    else if (!b) problems.push(`节为空：## ${sec}`);
  }
  return problems;
}

export function closeoutComplete(text) {
  const body = sectionBody(text, '验收标准');
  if (body === null) return { ok: false, problems: ['缺「## 验收标准」节'] };
  const lines = body.split(/\r?\n/);
  const open = lines.filter((l) => /^\s*-\s\[\s\]\s/.test(l));
  // 复核 P2-6：证据冒号后须直接跟内容（非空白、非收括号）——「（证据：）」空值不算过
  const checkedNoEv = lines.filter((l) => /^\s*-\s\[x\]\s/.test(l) && !/证据[:：][^）\s]/.test(l));
  const problems = [];
  if (open.length) problems.push(`未勾验收 ${open.length} 条`);
  if (checkedNoEv.length) problems.push(`已勾缺证据 ${checkedNoEv.length} 条`);
  return { ok: problems.length === 0, problems };
}

function summarizeDoc(text) {
  const body = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('---') && !/^状态:|^级别:|^日期:|^模块:|^备注:|^risk_level:/.test(l));
  return body.slice(0, 3).join(' / ').slice(0, 200);
}

// ── 工单构建 ───────────────────────────────────────────────────────────
function wo(run, o) {
  const order = { id: (run.events.filter((e) => e.type === 'work-order').length + 1), ...o };
  return order;
}
function issueWO(ctx, run, order, nextStage) {
  run.workOrder = order;
  run.stopType = 'work-order';
  run.stage = nextStage;
  emit(run, { type: 'work-order', id: order.id, kind: order.kind });
  emit(run, { type: 'stop', stopType: 'work-order', workOrderId: order.id });
  saveRun(ctx, run);
  printRun(ctx, run);
  process.exit(0);
}
function stopConfirm(ctx, run, docRel, points, ledger) {
  run.workOrder = null;
  run.stopType = 'await-confirm';
  run.awaitConfirm = { doc: docRel, points, ledger: !!ledger };
  emit(run, { type: 'stop', stopType: 'await-confirm', doc: docRel });
  saveRun(ctx, run);
  printRun(ctx, run);
  process.exit(0);
}
function stopGateFail(ctx, run, stage, problems, exitHint) {
  run.workOrder = null;
  run.stopType = 'gate-fail';
  run.stage = stage;
  run.gateFail = { stage, problems };
  emit(run, { type: 'stop', stopType: 'gate-fail', stage });
  saveRun(ctx, run);
  printRun(ctx, run, problems);
  process.exit(2);
}
function stopDone(ctx, run) {
  run.workOrder = null;
  run.stopType = 'done';
  run.stage = 'done';
  emit(run, { type: 'done' });
  emit(run, { type: 'stop', stopType: 'done' });
  saveRun(ctx, run);
  printRun(ctx, run);
  process.exit(0);
}

// ── 输出（人类可读 + 机器标记） ────────────────────────────────────────
export function stageBar(run) {
  const s = run.stage;
  const mk = (name, pos) => (pos === 'cur' ? '[●' + name + ']' : pos === 'past' ? '[✓' + name + ']' : '[…' + name + ']');
  const seq = run.triage?.kind === 'verify' ? [['Verify', s === 'verify' || s === 'done']]
    : run.triage?.kind === 'review' ? [['Review', s === 'review-only' || s === 'done']]
      : run.triage?.kind === 'deploy' ? [['Checklist', ['deploy-check', 'deploy-prep'].includes(s)], ['Authorize', s === 'deploy-await' || s === 'done']]
        : [['Plan', (run.triage?.level === 'L1' && run.triage?.kind !== 'fix'
            ? ['plan-fill', 'plan-draft', 'plan-confirm', 'triage']
            : ['intent-fill', 'intent-draft', 'intent-confirm', 'incident-fill', 'incident-draft', 'incident-confirm', 'triage']).includes(s)],
          ['Design', ['spec-fill', 'spec-draft', 'spec-review', 'spec-confirm'].includes(s)],
          ['Build', (run.triage?.level === 'L1' && run.triage?.kind !== 'fix'
            ? ['changes-confirm', 'implement', 'fix', 'changes-verify']
            : ['plan-fill', 'plan-draft', 'plan-confirm', 'changes-confirm', 'implement', 'fix', 'changes-verify']).includes(s)],
          ['Test', ['verify', 'review', 'closeout', 'done-confirm', 'incident-fixed-confirm', 'incident-closed-confirm', 'direct-commit'].includes(s) || s === 'done']];
  const curIdx = seq.findIndex(([, cur]) => cur);
  return seq.map(([name], i) => mk(name, i < curIdx ? 'past' : i === curIdx ? 'cur' : 'future')).join(' ');
}

function printRun(ctx, run, problems) {
  const lv = run.triage ? ` ${run.triage.level}·${run.triage.kind}` : '';
  console.log(`\n▶ pipeline-run ${run.runId}${lv}  ${stageBar(run)}`);
  if (run.stopType === 'work-order' && run.workOrder) {
    const w = run.workOrder;
    console.log(`\n== 工单 #${w.id}（${w.kind}）${w.title} ==`);
    console.log(`目标：${w.goal}`);
    for (const s of w.instructions) console.log(`  ${s}`);
    if (w.context?.kbHits?.length) console.log(`查重命中：\n  ${w.context.kbHits.slice(0, 6).join('\n  ')}`);
    if (w.context?.stderrTail) console.log(`上次门失败输出（尾 20 行）：\n  ${w.context.stderrTail}`);
    console.log('约束：');
    for (const c of w.constraints) console.log(`  - ${c}`);
    console.log('验收（脚本机器校验）：');
    for (const a of w.acceptance) console.log(`  - ${a}`);
    console.log(`\n完成工单后回跑：node .agents/scripts/pipeline-run.mjs next${run.docs?.entry ? '' : ''}`);
  } else if (run.stopType === 'await-confirm' && run.awaitConfirm) {
    const c = run.awaitConfirm;
    console.log(`\n== 等待确认 ==${c.ledger ? `（文档：${c.doc}，将经 confirm-doc 代录入台账）` : '（对话级确认，记 run 事件不进台账）'}`);
    console.log(`要点：${c.points}`);
    console.log(`用户确认后回跑：next --delegated "<用户原话>"`);
  } else if (run.stopType === 'gate-fail') {
    console.log(`\n== 门拒绝（exit 2，不绕不吞——修复后原路重跑 next）==`);
    for (const p of problems || run.gateFail?.problems || []) console.log(`  - ${p}`);
  } else if (run.stopType === 'done') {
    console.log(`\n== 完成 ==`);
    const gates = run.events.filter((e) => e.type === 'gate');
    const fails = gates.filter((e) => e.exit !== 0).length;
    console.log(`  需求：${run.requirement}`);
    console.log(`  门执行 ${gates.length} 道（非零 ${fails}）；确认 ${run.events.filter((e) => e.type === 'confirm').length} 次；提交 ${run.events.filter((e) => e.type === 'commit').length} 笔`);
    for (const d of [run.docs?.entry, run.docs?.spec, run.docs?.plan].filter(Boolean)) console.log(`  文档：${d}（${docState(ctx, d) || '?'}）`);
  } else if (run.stopType === 'aborted') {
    console.log(`\n== 已放弃（${run.abort?.to || ''}）== ${run.abort?.note || ''}`);
  }
  const stopLine = run.stopType === 'work-order' ? `PIPELINE-STOP work-order ${run.runId} ${run.workOrder?.id}`
    : run.stopType === 'await-confirm' ? `PIPELINE-STOP await-confirm ${run.runId} ${run.awaitConfirm?.doc || ''}`
      : run.stopType === 'gate-fail' ? `PIPELINE-STOP gate-fail ${run.runId} ${run.stage}`
        : run.stopType === 'aborted' ? `PIPELINE-STOP aborted ${run.runId}`
          : `PIPELINE-STOP done ${run.runId}`;
  console.log(stopLine.trim());
}

// ── triage / 路径 ──────────────────────────────────────────────────────
export function parseKV(s) {
  const out = {};
  for (const part of String(s || '').split(/\s+/).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function validateTriage(ctx, kv) {
  const problems = [];
  if (!KINDS.includes(kv.kind)) problems.push(`kind 须为 ${KINDS.join('|')}`);
  if (!LEVELS.includes(kv.level)) problems.push(`level 须为 ${LEVELS.join('|')}`);
  const mods = moduleList(ctx);
  if (kv.module && !mods.includes(kv.module)) problems.push(`module 须在词表内：${mods.join('|')}`);
  if (kv.topic && !/^[a-z0-9][a-z0-9-]*$/.test(kv.topic)) problems.push('topic 须为英文 kebab-case');
  return problems;
}

// ── 状态机（next 的全部合法推进） ──────────────────────────────────────
function confirmGate(ctx, run, docRel, quote, to) {
  const args = [docRel];
  if (to) args.push('--to', to);
  if (quote) args.push('--delegated', quote);
  const r = runNode(ctx, run, 'confirm-doc.mjs', args);
  if (r.exit !== 0) {
    const tail = (r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
    return { ok: false, msg: `confirm-doc exit ${r.exit}：${tail}` };
  }
  emit(run, { type: 'confirm', doc: docRel, to: to || nextConfirmTarget(docState(ctx, docRel), docRel), source: quote ? 'chat-delegated' : 'tty', ...(quote ? { quote } : {}) });
  return { ok: true };
}
// 语义上 confirm-doc 自行决定目标态（approved/done/fixed/closed）；事件里记录结果态
function nextConfirmTarget(curState, docRel) { return curState || 'approved'; }

// （decouple-flow-kit）原 managedFaceCheck（提交集命中 kit.json managed 台账 / 包源
// templates/_agents/ 时自动跑 bin/flow-kit.mjs sync 刷台账）已随 kit 双源机制退役整段删除——
// 引擎配置（kit.json，2026-10-08 迁移为 .agents/config/engine.json）不再有 managed 字段、仓内无
// templates/ 包源，该函数在本仓恒早退返回空集。

function docsCommit(ctx, run, files, subject) {
  const commitFiles = [...new Set(files)];
  const add = runGit(ctx, run, ['add', ...commitFiles]);
  if (add.exit !== 0) return { ok: false, msg: `git add 失败：${add.stderr.slice(0, 200)}` };
  const c = runGit(ctx, run, ['commit', '-m', subject]);
  if (c.exit !== 0) return { ok: false, msg: `git commit 失败：${(c.stderr || c.stdout).split(/\r?\n/).filter(Boolean).slice(-4).join(' | ')}` };
  const sha = runGit(ctx, run, ['rev-parse', '--short', 'HEAD']);
  emit(run, { type: 'commit', sha: sha.stdout.trim(), subject });
  return { ok: true };
}

function changedFiles(ctx, run) {
  const r = runGit(ctx, run, ['status', '--porcelain', '-u']); // -u：展开 untracked 目录为逐文件（防「src/」折叠误报越权）
  if (r.exit !== 0) return null;
  const out = [];
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) {
      // 复核 P2-2：rename 行收录 old+new 两路径——旧路径的删除同样属改动面（防改名逃逸越权）
      for (const q of p.split(' -> ')) {
        const n = q.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
        if (n) out.push(n);
      }
      continue;
    }
    p = p.replace(/^"|"$/g, '').replace(/\\/g, '/');
    out.push(p);
  }
  return out;
}

// 脚本自身管理的运行态路径——confirm/gate/gen-index 副产物，不属宿主越权面（沙箱演练实证，2026-10-02）
const RUNTIME_OWNED = ['.agents/cache/', '.agents/confirmations.jsonl', '.agents/confirmations.d/', 'workflow/INDEX.md'];

function checkAuthorized(ctx, run, filesCsv) {
  const listed = String(filesCsv || '').split(/[,，]/).map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  if (!listed.length) return { ok: false, problems: ['须以 --files 回填本工单实际改动的文件清单（逗号分隔）'] };
  const changed = changedFiles(ctx, run);
  if (changed === null) return { ok: false, problems: ['git status 失败，无法核对改动面'] };
  const beyond = changed.filter((c) =>
    !listed.includes(c) && !RUNTIME_OWNED.some((ro) => (ro.endsWith('/') ? c.startsWith(ro) : c === ro)));
  if (beyond.length) return { ok: false, problems: [`git 改动超出回填清单（偏离即停）：${beyond.join('、')}`] };
  run.lastFiles = listed;
  return { ok: true };
}

// locateDeployTarget：deploy 对象定位——--triage topic 显式优先，否则取 workflow/{intents,incidents}
// 最新终态入口（文件名日期序）；同名 spec 存在才纳入（L1 无 spec 合法），plan 恒须同名在位。
function locateDeployTarget(ctx, run) {
  const all = [];
  for (const dir of ['intents', 'incidents']) {
    const d = path.join(ctx.root, 'workflow', dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue;
      const rel = `workflow/${dir}/${f}`;
      if (['done', 'closed'].includes(docState(ctx, rel))) all.push({ rel, base: f.replace(/\.md$/, '') });
    }
  }
  if (!all.length) return { entry: null };
  all.sort((a, b) => b.base.localeCompare(a.base));
  const topic = run.triage?.topic && run.triage.topic !== 'task' ? run.triage.topic : null;
  // 复核 P2-C 收紧：topic 须与去日期前缀后的主题段等值——子串匹配会误命中（topic=run 命中 pipeline-run）
  const hit = topic ? all.find((x) => x.base.replace(/^\d{4}-\d{2}-\d{2}-/, '') === topic) : all[0];
  if (!hit) return { entry: null };
  const specRel = `workflow/specs/${hit.base}.md`;
  return {
    entry: hit.rel,
    spec: fs.existsSync(path.join(ctx.root, specRel)) ? specRel : null,
    plan: `workflow/plans/${hit.base}.md`,
  };
}

function briefReq(run) { return run.requirement.replace(/\s+/g, ' ').slice(0, 40); }

function kbGate(ctx, run, types) {
  const words = (run.requirement.toLowerCase().match(/[a-z0-9]{2,}/g) || []).slice(0, 2);
  const kw = words.length ? words : [run.requirement.slice(0, 6)];
  const r = runNode(ctx, run, 'kb-search.mjs', [...kw, '--scope', 'workflow', '--type', types, '-n', '6']);
  const hits = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('📄')).slice(0, 6);
  return { exit: r.exit, hits };
}

function advance(ctx, run, opt) {
  const L = () => run.triage.level;
  const K = () => run.triage.kind;
  const entry = () => run.docs.entry;
  const topic = () => run.triage.topic;

  // 工单型停机点的复验（进入对应阶段时先校验上一工单产出）
  while (true) {
    const s = run.stage;

    if (s === 'triage') {
      if (!run.triage) {
        if (!opt.triage) {
          issueWO(ctx, run, wo(run, {
            kind: 'triage', title: '判级与分类', goal: '读需求与 new-task.md 判级闭集，输出 kind/level/module/topic',
            instructions: [
              '1. 读 .agents/commands/new-task.md §级别判断（L2 触达面闭集 / L1 默认档 / L3 结构面）',
              `2. 对需求定级：「${run.requirement}」${run.hint ? `（预判参考：${run.hint}）` : ''}`,
              '3. 回填：next --triage "kind=require|fix|verify|review|deploy level=L1-L3 module=<词表> topic=<英文kebab>"',
            ],
            context: { docPath: '.agents/commands/new-task.md', kbHits: [], stderrTail: '', relatedDocs: ['workflow/INDEX.md'] },
            constraints: ['判级就高不就低；勾红线必 L2+；module 取 .agents/config/workflow-modules.txt 词表'],
            acceptance: ['--triage 三值枚举合法（脚本校验）', '红线词命中而 level<L2 会打 warning（回填者负责就高）'],
          }), 'triage');
        }
        const kv = parseKV(opt.triage);
        const problems = validateTriage(ctx, kv);
        if (problems.length) stopGateFail(ctx, run, 'triage', problems);
        if (/红线|契约|schema|公共接口/.test(run.requirement) && LEVELS.indexOf(kv.level) < LEVELS.indexOf('L2')) {
          console.log('⚠️ warning：需求文本命中红线关键词而 level<L2——判级应就高（继续，但责任在回填者）');
        }
        run.triage = { kind: kv.kind, level: kv.level, module: kv.module || moduleList(ctx)[0], topic: kv.topic || 'task', decidedBy: run.hint ? 'hint+ai' : 'ai', decidedAt: nowIso() };
        emit(run, { type: 'triage', ...run.triage });
        run.docs = run.docs || { entry: null, spec: null, plan: null };
        // 路由
        run.stage = K() === 'verify' ? 'verify' : K() === 'review' ? 'review-only' : K() === 'deploy' ? 'deploy-check'
          : K() === 'fix' ? 'incident-fill' : (L() === 'L1' ? 'plan-fill' : 'intent-fill');
        continue;
      }
      run.stage = 'intent-fill'; continue;
    }

    if (s === 'intent-fill' || s === 'incident-fill') {
      const isInc = s === 'incident-fill';
      const rel = isInc ? `workflow/incidents/${today()}-${topic()}.md` : `workflow/intents/${today()}-${topic()}.md`;
      run.docs.entry = rel;
      const st = docState(ctx, rel);
      if (!st) {
        const kb = kbGate(ctx, run, isInc ? 'incidents,plans' : 'intents,specs,plans');
        run.lastKbHits = kb.hits;
        if (isInc) {
          // incident 无 fill-* 工具：从 _TEMPLATE.md 复制骨架（机器步骤，记事件）
          const tplPath = path.join(ctx.root, 'workflow', 'incidents', '_TEMPLATE.md');
          try {
            fs.copyFileSync(tplPath, path.join(ctx.root, rel));
            emit(run, { type: 'gate', cmd: `cp workflow/incidents/_TEMPLATE.md ${rel}`, exit: 0, ms: 0 });
          } catch (e) { stopGateFail(ctx, run, s, [`incident 模板复制失败：${e.message}`]); }
        } else {
          const r = runNode(ctx, run, 'fill-intent.mjs', ['--module', run.triage.module, '--level', L(), '--topic', topic(), '--output', rel, '--notes', `pipeline-run ${run.runId}`]);
          if (r.exit !== 0) stopGateFail(ctx, run, s, [`fill-intent exit ${r.exit}：${(r.stderr || r.stdout).split(/\r?\n/).slice(-3).join(' | ')}`]);
        }
      }
      run.stage = isInc ? 'incident-draft' : 'intent-draft';
      issueWO(ctx, run, wo(run, {
        kind: 'draft', title: `起草 ${isInc ? 'incident' : 'intent'}：${rel}`, goal: isInc ? '填实事故 4 节 + 复盘三件套' : `填实 intent 各节（${L()} 省节规则见模板注释）`,
        instructions: isInc ? [
          '1. 按模板填：时间线 / 根因 / 为什么没拦住 / 复盘三件套',
          '2. 先查同类：kb-search 命中已附（如有）',
          '3. 完成后回跑 next——脚本校验 frontmatter/节完整/占位符',
        ] : [
          '1. 骨架已由 fill-intent 生成，填实各节正文（背景/教训/目标/非目标/约束/验收）',
          '2. 验收标准逐条可测试（写不出判据=还没想清楚）',
          '3. 查重命中（如有）在「历史教训/防复发」节引用',
          '4. 完成后回跑 next——脚本校验 frontmatter/节完整/占位符',
        ],
        context: { docPath: rel, kbHits: run.lastKbHits || [], stderrTail: '', relatedDocs: ['.agents/commands/plan.md'] },
        constraints: ['只改该文档本身；命名英文 kebab-case；正文不写「状态：/级别：」行'],
        acceptance: ['frontmatter 键完整', '必填节非空（L1 省节合法）', '无模板占位符残留'],
      }), run.stage);
    }

    if (s === 'intent-draft' || s === 'incident-draft') {
      const kind = s === 'incident-draft' ? 'incident' : 'intent';
      const problems = validateDraftContent(readDoc(ctx, entry()), kind, L());
      if (problems.length) stopGateFail(ctx, run, s, problems);
      const text = readDoc(ctx, entry());
      run.stage = kind === 'incident' ? 'incident-confirm' : 'intent-confirm';
      stopConfirm(ctx, run, entry(), summarizeDoc(text), kind !== 'incident');
    }

    if (s === 'intent-confirm' || s === 'incident-confirm') {
      const ledger = s !== 'incident-confirm';
      if (!opt.delegated) stopConfirm(ctx, run, entry(), run.awaitConfirm?.points || summarizeDoc(readDoc(ctx, entry()) || ''), ledger);
      if (ledger) {
        const r = confirmGate(ctx, run, entry(), opt.delegated);
        if (!r.ok) stopGateFail(ctx, run, s, [r.msg]);
      } else {
        emit(run, { type: 'confirm', doc: entry(), to: 'draft-ok', source: 'conversation', quote: opt.delegated });
      }
      run.stage = L() === 'L1' || K() === 'fix' ? 'plan-fill' : 'spec-fill';
      continue;
    }

    if (s === 'spec-fill') {
      const rel = `workflow/specs/${today()}-${topic()}.md`;
      run.docs.spec = rel;
      if (!docState(ctx, rel)) {
        const r = runNode(ctx, run, 'fill-spec.mjs', ['--level', L(), '--topic', topic(), '--output', rel]);
        if (r.exit !== 0) stopGateFail(ctx, run, s, [`fill-spec exit ${r.exit}（G1 前置门或参数）：${(r.stderr || r.stdout).split(/\r?\n/).slice(-3).join(' | ')}`]);
      }
      run.stage = 'spec-draft';
      issueWO(ctx, run, wo(run, {
        kind: 'draft', title: `起草 spec：${rel}`, goal: '设计规格 4 节（功能行为/数据流/系统改动/约束遵守映射）',
        instructions: [
          '1. 骨架已由 fill-spec 生成，填实 4 节',
          '2. 约束遵守映射逐条对照根 AGENTS.md 红线，逐条回应',
          '3. 多方案取舍列选项交用户（spec 确认时定）',
          '4. 完成后回跑 next——脚本机器校验',
        ],
        context: { docPath: rel, kbHits: [], stderrTail: '', relatedDocs: ['.agents/commands/design.md'] },
        constraints: ['只改该文档；页面/交互形态禁止自行推定'],
        acceptance: ['4 节齐全非空', '无占位符残留'],
      }), 'spec-draft');
    }

    if (s === 'spec-draft') {
      const problems = validateDraftContent(readDoc(ctx, run.docs.spec), 'spec', L());
      if (problems.length) stopGateFail(ctx, run, s, problems);
      run.stage = L() === 'L3' ? 'spec-review' : 'spec-confirm';
      if (L() === 'L3') {
        issueWO(ctx, run, wo(run, {
          kind: 'review', title: `独立复核 spec：${run.docs.spec}`, goal: 'L3 强制：新上下文只读复核，结论写入 spec「确认与复核」节',
          instructions: [
            '1. 以独立视角读 spec 全文与入口 intent',
            '2. 找会破坏方案的缺口（问「什么会坏」而非「好不好」）',
            '3. 结论（P0/P1 清单或「无」）写入目标文档「## 确认与复核」节（无此节则在文末追加）',
            '4. 完成后回跑 next——脚本校验结论在节',
          ],
          context: { docPath: run.docs.spec, kbHits: [], stderrTail: '', relatedDocs: [] },
          constraints: ['只读复核 + 仅在 spec 确认与复核节追加结论；不改其他内容'],
          acceptance: ['spec「确认与复核」节含复核结论（P0/P1 或 无）'],
        }), 'spec-review');
      }
      stopConfirm(ctx, run, run.docs.spec, summarizeDoc(readDoc(ctx, run.docs.spec)), true);
    }

    if (s === 'spec-review') {
      const body = sectionBody(readDoc(ctx, run.docs.spec) || '', '确认与复核') || '';
      if (!(/P0\s*\/\s*P1/.test(body) || /P0/.test(body) || /P1/.test(body))) stopGateFail(ctx, run, s, ['spec「确认与复核」节缺复核结论（须含 P0/P1 清单或「无 P0/P1」）']);
      run.stage = 'spec-confirm';
      stopConfirm(ctx, run, run.docs.spec, summarizeDoc(readDoc(ctx, run.docs.spec)), true);
    }

    if (s === 'spec-confirm') {
      if (!opt.delegated) stopConfirm(ctx, run, run.docs.spec, run.awaitConfirm?.points || '', true);
      const r = confirmGate(ctx, run, run.docs.spec, opt.delegated);
      if (!r.ok) stopGateFail(ctx, run, s, [r.msg]);
      run.stage = 'plan-fill'; continue;
    }

    if (s === 'plan-fill') {
      const rel = `workflow/plans/${today()}-${topic()}.md`;
      run.docs.plan = rel;
      if (L() === 'L1' && K() !== 'fix') run.docs.entry = rel;
      if (!docState(ctx, rel)) {
        const r = runNode(ctx, run, 'fill-plan.mjs', ['--level', L(), '--topic', topic(), '--output', rel]);
        if (r.exit !== 0) stopGateFail(ctx, run, s, [`fill-plan exit ${r.exit}（G1 前置门或参数）：${(r.stderr || r.stdout).split(/\r?\n/).slice(-3).join(' | ')}`]);
      }
      run.stage = 'plan-draft';
      issueWO(ctx, run, wo(run, {
        kind: 'draft', title: `起草 plan：${rel}`, goal: `计划文档（${L() === 'L1' ? '入口/改动方案/约束与风险/验证计划/验收标准' : '完整 4 节：改动方案/任务拆解/执行顺序/验证计划'}）`,
        instructions: [
          '1. 骨架已由 fill-plan 生成，填实各节',
          '2. 改动方案逐文件列「做什么+判据」——后续 implement 工单的授权面以此为准',
          '3. 验证计划对齐入口验收标准',
          '4. 完成后回跑 next——脚本机器校验',
        ],
        context: { docPath: rel, kbHits: [], stderrTail: '', relatedDocs: ['.agents/commands/build.md'] },
        constraints: ['只改该文档'],
        acceptance: ['节齐全非空', '无占位符残留'],
      }), 'plan-draft');
    }

    if (s === 'plan-draft') {
      const problems = validateDraftContent(readDoc(ctx, run.docs.plan), 'plan', L());
      if (problems.length) stopGateFail(ctx, run, s, problems);
      run.stage = 'plan-confirm';
      stopConfirm(ctx, run, run.docs.plan, summarizeDoc(readDoc(ctx, run.docs.plan)), true);
    }

    if (s === 'plan-confirm') {
      if (!opt.delegated) stopConfirm(ctx, run, run.docs.plan, run.awaitConfirm?.points || '', true);
      const r = confirmGate(ctx, run, run.docs.plan, opt.delegated);
      if (!r.ok) stopGateFail(ctx, run, s, [r.msg]);
      // 批次一：入口(+spec)+plan 全 approved → 一笔 docs 提交（配对门要求树内成对）
      // L1 的 entry 就是 plan，去重后只提交一份。
      const files = [...new Set([entry(), run.docs.spec, run.docs.plan].filter(Boolean))];
      const batchLabel = K() === 'fix' ? 'incident+plan' : run.docs.spec ? '三件套' : 'plan';
      const subject = `docs(workflow): ${topic()} ${batchLabel} approved——${briefReq(run)}`;
      const c = docsCommit(ctx, run, files, subject);
      if (!c.ok) stopGateFail(ctx, run, s, [c.msg]);
      run.stage = 'changes-confirm';
      stopConfirm(ctx, run, run.docs.plan, (sectionBody(readDoc(ctx, run.docs.plan) || '', '改动方案') || '').split(/\r?\n/).slice(0, 5).join(' / ').slice(0, 200), false);
    }

    if (s === 'changes-confirm') {
      if (!opt.delegated) stopConfirm(ctx, run, run.awaitConfirm?.doc || '', run.awaitConfirm?.points || '', false);
      emit(run, { type: 'confirm', doc: '改动清单', to: 'ok', source: 'conversation', quote: opt.delegated });
      run.stage = 'implement';
      const planFiles = (readDoc(ctx, run.docs.plan).match(/[\w./-]+\.(?:mjs|md|json|txt|cjs|sh|yml|yaml)/g) || []);
      issueWO(ctx, run, wo(run, {
        kind: 'implement', title: `实现：${briefReq(run)}`, goal: '按 plan 改动方案实现 + 自验',
        instructions: [
          '1. 按 plan §改动方案逐文件实现（判据照条目）',
          '2. 自验：跑 plan §验证计划所列静态门命令',
          '3. 偏离即停：改公共接口/计划外文件/新依赖 → 不做，停机向用户上报',
          '4. 完成后回填改动文件清单：next --files "a.mjs,b.md"',
        ],
        context: { docPath: run.docs.plan, kbHits: [], stderrTail: '', relatedDocs: planFiles.slice(0, 8) },
        constraints: [`授权文件以 plan 改动方案为准；回填 --files 清单必须与 git status 实际改动一致（脚本核对）`],
        acceptance: ['git 改动 ⊆ 回填清单', '后续 verify 门（npm test + check-loop 经 verify.mjs）全绿'],
      }), 'implement');
    }

    if (s === 'implement' || s === 'fix') {
      if (!opt.files) { printRun(ctx, run); process.exit(0); } // 无 --files 重入：重发当前工单（run.workOrder 保留）
      const a = checkAuthorized(ctx, run, opt.files);
      if (!a.ok) stopGateFail(ctx, run, s, a.problems);
      run.stage = 'verify'; continue;
    }

    if (s === 'verify') {
      const r = runNode(ctx, run, 'verify.mjs', []);
      if (K() === 'verify') { // verify-only 短路径：不带修复环，绿即收、败即停
        if (r.exit === 0) stopDone(ctx, run);
        stopGateFail(ctx, run, s, ['verify 未过（verify-only 不带修复环——人工处理后重跑，或立正式任务走闭环）']);
      }
      if (r.exit === 0) {
        run.fixLoop = { count: 0, cap: FIX_CAP };
        // 代码提交（沙箱演练实证的缺口，2026-10-02）：verify 绿后、复核/关单前落一笔——
        // 文件集 = 当前非运行态、非 workflow 文档的改动（均已过 --files 授权核对）
        const codeFiles = (changedFiles(ctx, run) || []).filter((c) =>
          !RUNTIME_OWNED.some((ro) => (ro.endsWith('/') ? c.startsWith(ro) : c === ro)) && !c.startsWith('workflow/'));
        if (codeFiles.length) {
          const verb = K() === 'fix' ? 'fix' : 'feat';
          const c = docsCommit(ctx, run, codeFiles, `${verb}(${run.triage.module}): ${briefReq(run)}（pipeline-run ${run.runId}）`);
          if (!c.ok) stopGateFail(ctx, run, s, [c.msg]);
        }
        run.stage = (L() === 'L2' || L() === 'L3') ? 'review' : 'closeout'; continue;
      }
      run.fixLoop = run.fixLoop || { count: 0, cap: FIX_CAP };
      run.fixLoop.count += 1;
      const tail = (r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
      if (run.fixLoop.count >= run.fixLoop.cap) {
        stopGateFail(ctx, run, s, [`修复环超限（${run.fixLoop.cap} 次）——人工介入或 abort`]);
      }
      run.stage = 'fix';
      issueWO(ctx, run, wo(run, {
        kind: 'fix', title: `修复环 ${run.fixLoop.count}/${run.fixLoop.cap}：verify 未过`, goal: '按失败输出修复后回跑',
        instructions: [
          '1. 读下方「上次门失败输出」定位失败项',
          '2. 修复（授权面仍以 plan 为准，偏离即停）',
          '3. 完成后回填：next --files "…"（脚本重核对改动面并重跑 verify）',
        ],
        context: { docPath: run.docs.plan, kbHits: [], stderrTail: tail, relatedDocs: [] },
        constraints: ['不绕门不改门；不 --no-verify'],
        acceptance: ['git 改动 ⊆ 回填清单', 'verify.mjs 重跑全绿'],
      }), 'fix');
    }

    if (s === 'review') {
      const target = run.docs.spec || entry();
      const body = sectionBody(readDoc(ctx, target) || '', '确认与复核') || '';
      if (!(/P0\s*\/\s*P1/.test(body) || /P0/.test(body) || /P1/.test(body))) {
        issueWO(ctx, run, wo(run, {
          kind: 'review', title: `独立复核（L2/L3）：实现与文档对照`, goal: '读入口+spec+plan+diff，产出 P0/P1/P2 清单并把结论写入 spec「确认与复核」节',
          instructions: [
            '1. 独立读入口/spec/plan 与本次 diff（git diff + 相关文件）',
            '2. 逐项对照验收标准找缺口（file:line 证据）',
            '3. 结论写入目标文档「## 确认与复核」节（P0/P1 清单或「无」；无此节则在文末追加）',
            '4. 定性与合入时机由用户拍板——复核只交证据',
          ],
          context: { docPath: target, kbHits: [], stderrTail: '', relatedDocs: [entry(), run.docs.plan].filter(Boolean) },
          constraints: ['只读 + 仅在 spec 确认与复核节追加结论'],
          acceptance: ['spec「确认与复核」节含结论（P0/P1 或 无）'],
        }), 'review');
      }
      run.stage = K() === 'fix' ? 'closeout' : 'closeout';
      continue;
    }

    if (s === 'closeout') {
      if (K() !== 'fix') {
        const co = closeoutComplete(readDoc(ctx, entry()) || '');
        if (!co.ok) {
          issueWO(ctx, run, wo(run, {
            kind: 'closeout', title: `勾验收补证据：${entry()}`, goal: '关单前逐条勾验入口文档验收标准并补证据',
            instructions: [
              '1. 逐条核验「## 验收标准」：达成改 [x] 并补「（证据：<commit SHA/测试名/输出>）」',
              '2. 未达成的不得勾——如实留 [ ] 并在下方说明',
              '3. 完成后回跑 next（脚本校验全勾+证据在）',
            ],
            context: { docPath: entry(), kbHits: [], stderrTail: '', relatedDocs: [run.docs.plan].filter(Boolean) },
            constraints: ['只改入口文档验收节；证据须真实（SHA/用例名/命令输出）'],
            acceptance: ['验收行全 [x] 且每条含 证据：'],
          }), 'closeout');
        }
      }
      run.stage = K() === 'fix' ? 'incident-fixed-confirm' : 'done-confirm';
      stopConfirm(ctx, run, entry(), '关单确认（done）——逐份原话', true);
    }

    if (s === 'done-confirm' || s === 'incident-fixed-confirm' || s === 'incident-closed-confirm') {
      const finalize = () => {
        runNode(ctx, run, 'gen-workflow-index.mjs', []);
        const files = [...new Set([entry(), run.docs.spec, run.docs.plan].filter(Boolean))];
        const c = docsCommit(ctx, run, [...files, 'workflow/INDEX.md'], `docs(workflow): ${topic()} 关单——终态落定（pipeline-run ${run.runId}）`);
        if (!c.ok) stopGateFail(ctx, run, s, [c.msg]);
        stopDone(ctx, run);
      };
      const pendOf = () => {
        const pend = [];
        if (K() === 'fix') {
          const st = docState(ctx, entry());
          if (!['fixed', 'closed'].includes(st)) pend.push(entry());
          if (st === 'fixed') pend.push(entry()); // 两跳：fixed 之后还需 closed
          if (run.docs.plan && !TERMINAL.includes(docState(ctx, run.docs.plan))) pend.push(run.docs.plan);
        } else {
          for (const rel of [...new Set([entry(), run.docs.spec, run.docs.plan].filter(Boolean))]) {
            if (!TERMINAL.includes(docState(ctx, rel))) pend.push(rel);
          }
        }
        return pend;
      };
      const label = K() === 'fix' ? 'incident 两跳（open→fixed→closed）与 plan 关单' : 'done 关单';
      const pend0 = pendOf();
      if (!pend0.length) finalize();
      if (!opt.delegated) stopConfirm(ctx, run, pend0[0], `${label}——逐份原话，一次一份（余 ${pend0.length} 份）`, true);
      const r = confirmGate(ctx, run, pend0[0], opt.delegated);
      if (!r.ok) stopGateFail(ctx, run, s, [r.msg]);
      const rest = pendOf(); // 一次一份：确认成功即停机，下一份须新原话（confirm-gate-one-per-call 教训）
      if (!rest.length) finalize();
      stopConfirm(ctx, run, rest[0], `${label}——逐份原话，一次一份（余 ${rest.length} 份）`, true);
    }

    if (s === 'verify-only') { run.stage = 'verify'; continue; }
    if (s === 'review-only') {
      if (opt.done) stopDone(ctx, run); // 评审清单交付即收（宿主向用户汇报后回填 --done）
      issueWO(ctx, run, wo(run, {
        kind: 'review', title: '横切评审', goal: '按 .agents/commands/review.md 产出 P0/P1/P2 分级清单交用户定性',
        instructions: ['1. 读 review.md 与评审对象', '2. 机器兜底项先跑门，AI 自查项列清单', '3. 结论交用户定性与合入时机'],
        context: { docPath: '.agents/commands/review.md', kbHits: [], stderrTail: '', relatedDocs: [] },
        constraints: ['只读评审；定性归用户'],
        acceptance: ['清单产出（P0/P1/P2 分级）'],
      }), 'review-only');
    }

    if (s === 'deploy-check') {
      // 复核 P1-2 补实现（2026-10-02 用户拍板）：deploy-prep 工单 + 三件 done 机器校验（spec §功能行为 deploy-prep 变体）
      const target = locateDeployTarget(ctx, run);
      if (!target.entry) stopGateFail(ctx, run, s, ['找不到可上线的对象——workflow/{intents,incidents} 无终态（done/closed）入口；或以 --triage topic=<主题> 显式指定。注：deploy 面向 L2/L3 入口（deploy.md §2 配对检查口径），L1 plan 交付不走上线管线。']);
      run.deployTarget = target;
      issueWO(ctx, run, wo(run, {
        kind: 'deploy-prep', title: `上线清单核对：${target.entry}`, goal: '回归清单人工核对 + 三件同名 done 机器校验，全过到授权点',
        instructions: [
          '1. 核对 workflow/regression-checklist.md 回归必过条目（活文档）',
          '2. 抽查最近历史 incident 的防复发条目',
          '3. 完成后回跑 next——脚本机器校验：check-loop 门 + 三件同名 done',
          '4. 全过停授权点；打 tag 由宿主按 git 纪律执行（脚本不代办）',
        ],
        context: { docPath: 'workflow/regression-checklist.md', kbHits: [], stderrTail: '', relatedDocs: [target.entry, target.spec, target.plan].filter(Boolean) },
        constraints: ['只读核对；发现缺口停机上报，不带病上线'],
        acceptance: ['check-loop 门 exit 0（脚本执行）', '三件同名 done：入口+spec（如有）+plan 全终态（脚本执行）'],
      }), 'deploy-prep');
    }

    if (s === 'deploy-prep') {
      const t = run.deployTarget;
      const r = runNode(ctx, run, 'check-loop.mjs', []);
      if (r.exit !== 0) stopGateFail(ctx, run, s, ['check-loop 未过——文档闭环有断档，先补齐再谈上线']);
      const gaps = [];
      const entrySt = docState(ctx, t.entry);
      if (!['done', 'closed'].includes(entrySt)) gaps.push(`${t.entry}（${entrySt || '缺失'}——须 done/closed）`);
      if (t.spec) {
        const st = docState(ctx, t.spec);
        if (st !== 'done') gaps.push(`${t.spec}（${st || '缺失'}——须 done）`);
      }
      const planSt = docState(ctx, t.plan);
      if (planSt !== 'done') gaps.push(`${t.plan}（${planSt || '缺失'}——须 done）`);
      if (gaps.length) stopGateFail(ctx, run, s, [`三件同名 done 未满足（spec §校验规则 deploy-prep 行）：${gaps.join('；')}`]);
      run.stage = 'deploy-await';
      stopConfirm(ctx, run, '', `上线授权——对象 ${t.entry}（仅用户本人；tag 由宿主按 git 纪律执行，脚本不代办）`, false);
    }

    if (s === 'deploy-await') {
      if (!opt.delegated) stopConfirm(ctx, run, '', `上线授权——对象 ${run.deployTarget?.entry || ''}：用户明确说「上」后回跑 next --delegated "<原话>"；打 tag 由宿主执行`, false);
      emit(run, { type: 'confirm', doc: 'deploy', to: 'authorized', source: 'conversation', quote: opt.delegated });
      stopDone(ctx, run);
    }

    if (s === 'done') stopDone(ctx, run);
    fail(`未知阶段：${s}（run 文件可能损坏——status --adopt 重建，或删 run 重来）`, 1);
  }
}

// ── 子命令 ─────────────────────────────────────────────────────────────
const BOOL_FLAGS = new Set(['adopt', 'json', 'done']); // 复核 P2-5：布尔旗标不吞下一参
function parseArgs(argv) {
  const out = { cmd: argv[0], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) out[k] = true; else out[k] = argv[++i] ?? true;
    } else out.positional.push(a);
  }
  return out;
}

function resolveRun(ctx, a) {
  const id = a.run || latestRunId(ctx);
  if (!id) fail('无活跃 run——先 start "<需求原文>"');
  const run = loadRun(ctx, id);
  if (!run) fail(`run 文件不存在或损坏：${id}（status --adopt 可按文档现状重建）`);
  return run;
}

const isMain = process.argv[1] && process.argv[1].endsWith('pipeline-run.mjs');
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const ctx = ctxEnv();
  const cmd = a.cmd;

  if (cmd === 'start') {
    const req = a.positional[0];
    if (!req) fail('start 必填需求原文：start "<需求>" [--hint "kind=… level=… module=…"]');
    const runId = newRunId(req);
    const run = {
      runId, requirement: req, hint: a.hint || '', createdAt: nowIso(), updatedAt: nowIso(),
      triage: null, stage: 'triage', stopType: 'work-order', workOrder: null, awaitConfirm: null,
      fixLoop: { count: 0, cap: FIX_CAP }, docs: { entry: null, spec: null, plan: null },
      lastKbHits: [], lastFiles: [], events: [],
    };
    emit(run, { type: 'run-created', requirement: req });
    saveRun(ctx, run);
    advance(ctx, run, {}); // 首停机点 = triage 工单
  } else if (cmd === 'next') {
    const run = resolveRun(ctx, a);
    if (run.stopType === 'done' || run.stopType === 'aborted') { printRun(ctx, run); process.exit(0); }
    advance(ctx, run, { triage: typeof a.triage === 'string' ? a.triage : undefined, delegated: typeof a.delegated === 'string' ? a.delegated : undefined, files: typeof a.files === 'string' ? a.files : undefined, done: a.done === true });
  } else if (cmd === 'status') {
    if (a.adopt) { adoptRun(ctx, a); process.exit(0); }
    const run = resolveRun(ctx, a);
    if (a.json) { console.log(JSON.stringify(run, null, 2)); process.exit(0); }
    printRun(ctx, run);
    console.log(`\n事件流水（${run.events.length}）：`);
    for (const e of run.events) {
      const bits = [e.t.slice(11, 19), e.type];
      if (e.cmd) bits.push(`${e.cmd.slice(0, 70)}${e.exit !== 0 ? ` [exit ${e.exit}]` : ''}`);
      if (e.doc) bits.push(e.doc);
      if (e.quote) bits.push(`原话「${e.quote.slice(0, 30)}」`);
      if (e.subject) bits.push(e.subject.slice(0, 50));
      if (e.id) bits.push(`#${e.id}`);
      console.log('  ' + bits.join(' | '));
    }
    process.exit(0);
  } else if (cmd === 'watch') {
    const interval = Math.max(1, Number(a.interval) || 2);
    const render = () => {
      const id = a.run || latestRunId(ctx);
      console.log('\x1B[2J\x1B[H');
      if (!id) { console.log('无 run'); return; }
      const run = loadRun(ctx, id);
      if (!run) { console.log(`run ${id} 不存在`); return; }
      printRun(ctx, run);
      const recent = run.events.slice(-5);
      console.log('最近事件：');
      for (const e of recent) console.log(`  ${e.t.slice(11, 19)} ${e.type} ${e.cmd ? e.cmd.slice(0, 50) : ''} ${e.exit !== undefined && e.type === 'gate' ? `exit=${e.exit}` : ''}`);
      console.log(`（每 ${interval}s 刷新，Ctrl+C 退出）`);
    };
    render();
    setInterval(render, interval * 1000);
  } else if (cmd === 'abort') {
    if (!a.run) fail('abort 必填 --run <id>');
    const run = loadRun(ctx, a.run);
    if (!run) fail(`run 不存在：${a.run}`);
    const to = a.to === true ? 'cancelled' : (a.to || 'cancelled');
    if (!['superseded', 'cancelled'].includes(to)) fail('--to 须为 superseded|cancelled');
    const manual = [];
    const flipped = [];
    for (const rel of [run.docs?.entry, run.docs?.spec, run.docs?.plan].filter(Boolean)) {
      const st = docState(ctx, rel);
      if (['approved'].includes(st)) {
        const r = confirmGate(ctx, run, rel, typeof a.delegated === 'string' ? a.delegated : '', to);
        if (r.ok) flipped.push(rel); else manual.push(rel);
      }
    }
    if (flipped.length) {
      runNode(ctx, run, 'gen-workflow-index.mjs', []); // 复核 P2-3：提交前重生成，防陈旧索引入库
      const c = docsCommit(ctx, run, [...flipped, 'workflow/INDEX.md'], `docs(workflow): ${run.triage?.topic || 'task'} 放弃——${to}`);
      if (!c.ok) console.log('⚠️ 放弃态 docs 提交失败（可手工补交）');
    }
    run.stopType = 'aborted';
    run.abort = { to, note: manual.length ? `以下文档须用户终端亲跑 confirm-doc --to ${to}：${manual.join('、')}` : '' };
    emit(run, { type: 'abort', to });
    saveRun(ctx, run);
    printRun(ctx, run);
    process.exit(0);
  } else {
    fail(`未知命令：${cmd ?? ''}（start | next | status | watch | abort，用法见文件头注释）`);
  }
}

// ── adopt：run 文件丢失/损坏时按文档现状重建（尽力而为，非权威仲裁） ──
function adoptRun(ctx, a) {
  const id = a.run || latestRunId(ctx);
  if (!id) fail('无可 adopt 的 run id');
  const topic = (id.split('-').slice(2, -1).join('-')) || 'task';
  const find = (dir) => {
    const d = path.join(ctx.root, 'workflow', dir);
    if (!fs.existsSync(d)) return null;
    const hit = fs.readdirSync(d).map((f) => f.replace(/\.md$/, '')).filter((b) => b.includes(topic) && !b.startsWith('_'))
      .sort().pop();
    return hit ? `workflow/${dir}/${hit}.md` : null;
  };
  const entry = find('intents') || find('incidents');
  const spec = find('specs');
  const plan = find('plans');
  if (!entry && !plan) fail(`按 topic「${topic}」未找到任何 workflow 文档——无法重建`);
  const run = {
    runId: id, requirement: `(adopted ${nowIso()}——原需求原文已不可考，见 git 历史)`, hint: '', createdAt: nowIso(), updatedAt: nowIso(),
    triage: { kind: entry && entry.includes('incidents') ? 'fix' : 'require', level: 'L1', module: 'pipeline', topic, decidedBy: 'adopt', decidedAt: nowIso() },
    stage: 'adopted', stopType: 'work-order', workOrder: null, awaitConfirm: null, fixLoop: { count: 0, cap: FIX_CAP },
    docs: { entry, spec, plan }, lastKbHits: [], lastFiles: [], events: [{ t: nowIso(), type: 'adopt', entry, spec, plan }],
  };
  saveRun(ctx, run);
  console.log(`✅ 已重建 run ${id}（stage=adopted）——文档现状：`);
  for (const [k, rel] of Object.entries(run.docs)) if (rel) console.log(`  ${k}: ${rel}（${docState(ctx, rel) || '缺失'}）`);
  console.log('  提示：adopt 不推断断点位置——按文档现状人工续走（next 会按 stage 拒绝，请对照事件缺失情况手动接续或另起 run）');
}

export default { parseKV, validateDraftContent, closeoutComplete, placeholdersIn, stageBar };
