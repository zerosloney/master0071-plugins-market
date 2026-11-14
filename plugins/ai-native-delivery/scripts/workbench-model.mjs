#!/usr/bin/env node
// workbench-model.mjs — 交付工作台聚合模型（P1，2026-11-14）
// 用途：board-server GET /api/workbench 的模型单源——把本仓治理数据面聚合成三视图（概览/交付流/决策中心）
//   可消费的形状：交付（= plan 族）× 八章环节三态推导 + 决策面（待裁决/近期确认/面板台账）+ repo 面。
// 数据面（全只读，零写）：
//   workflow/{intents,specs,plans}/**.md + workflow/archive/<月>/{intents,specs,plans}/**.md（族发现与 frontmatter）
//   .agents/confirmations.d/*.jsonl（确认账分片）｜ workflow/reviews.d/*.md（复核台账行级）+ artifacts/<月>/*.json（面板 run）
//   git log 单次 feed（产品提交锚 / 发版锚 / 修订计数——口径同 gen-workflow-metrics 返工代理段）+ git status
// 环节推导口径（三态 queued/active/done + na，每态 evidence 如实展示推导依据，推不出不硬造）：
//   单源 = workflow/plans/2026-11-14-workbench-p1.md「契约」节；改口径先改该节再同步本文件。
// 失败退化纪律：非 git 仓 / 数据面缺失 → 对应字段 null / 空数组，不崩、不误报（对齐 metrics-core 观测面退化）。
// 用法（可独立冒烟）：node scripts/workbench-model.mjs [--root <仓库根>] → 模型 JSON 打 stdout
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GIT_TIMEOUT_MS } from './git-core.mjs';

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

export const STAGE_KEYS = ['intake', 'spec', 'plan', 'implement', 'verify', 'review', 'ship', 'closeout'];
export const STAGE_NAMES = { intake: '意图', spec: '设计', plan: '计划', implement: '实现', verify: '代码审查', review: '独立复核', ship: '发版', closeout: '关单' };
export const CHAPTERS = [
  { id: 'plan', no: '01', cn: '规划', keys: ['intake'] },
  { id: 'design', no: '02', cn: '设计', keys: ['spec'] },
  { id: 'build', no: '03', cn: '实现', keys: ['plan', 'implement'] },
  { id: 'test', no: '04', cn: '验证', keys: ['verify', 'review', 'ship', 'closeout'] },
];
const DISPOSED = new Set(['fixed', 'waived', 'deferred', 'recorded']);

const gitRun = (root, args) => {
  // windowsHide（2026-11-14 热修）：board-server 由 ensure-board 以无控制台方式拉起（detached+windowsHide），
  // 无控制台父进程的子 git 若不带 windowsHide 会各弹一个 cmd 窗口——每个 /api/workbench 请求约 7 个
  // git 调用，SSE 断流走 15s 轮询时连跳（用户实证）。全仓 spawn 惯例本就带此旗，此处 P2 新写时漏了。
  try {
    return spawnSync(GIT, args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch {
    return null;
  }
};

/** frontmatter 受限子集解析（状态/级别/日期——缺省 null，坏行不抛）。 */
export function fmOf(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { status: null, level: null, date: null };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([^：:]+)[：:]\s*(.+?)\s*$/);
    if (!kv) continue;
    const k = kv[1].trim();
    if (k === '状态') out.status = kv[2].trim();
    else if (k === '级别') out.level = kv[2].trim();
    else if (k === '日期') out.date = kv[2].trim();
  }
  return out;
}

/** 标题 = 首个 `# ` 行去掉 PLAN/INTENT/SPEC 前缀；取不到回 null（界面回退 stem）。 */
export function titleOf(text) {
  const m = String(text).match(/^#\s+(.+)$/m);
  if (!m) return null;
  return m[1].replace(/^(PLAN|INTENT|SPEC|INCIDENT)\s*[—-]\s*/, '').trim() || null;
}

/** 验收勾验计数：只数「验收」节内的框——入口节的 L2/L3 升级勾选框是模板常驻未勾项（L1 永不勾），
 *  全文计数会把所有 L1 plan 的 verify 永远判 active。节 = ^## 验收 行起至下一 ^## 行止；无该节返回 0/0。 */
export function checkboxOf(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*验收/.test(l));
  if (start < 0) return { done: 0, total: 0 };
  let done = 0;
  let todo = 0;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (/^- \[x\]/.test(lines[i])) done++;
    else if (/^- \[ \]/.test(lines[i])) todo++;
  }
  return { done, total: done + todo };
}

/** 任务短名 = stem 去日期前缀（check-commit-plan-ref 惯例：提交消息含短名，不带日期）。 */
export const shortOf = (stem) => String(stem).replace(/^\d{4}-\d{2}-\d{2}-/, '');

/** 面板 runId 抽取（pr-<hex7+>-<hex7+>，前段 = git --short 默认 7 位）——台账对象列引用 runId 而非族名，交叉引用靠它。 */
export const runIdsOf = (s) => (String(s || '').match(/pr-[0-9a-f]{7,}-[0-9a-f]{7,}/g) || []);

/** 族发现：workflow/{intents,specs,plans} 活跃 + archive 各月 → Map<stem, docs[]>（docs 含 kind/path/archived/status/level/title/mtime）。 */
export function scanFamilies(root) {
  const fams = new Map();
  const SINGULAR = { intents: 'intent', specs: 'spec', plans: 'plan' };
  const take = (dir, dirKind, archived) => {
    const kind = SINGULAR[dirKind];
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
      const abs = path.join(dir, e.name);
      const stem = e.name.replace(/\.md$/, '');
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const fm = fmOf(text);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const doc = {
        kind, path: rel, archived,
        status: fm.status, level: fm.level,
        title: titleOf(text),
        mtimeMs: fs.statSync(abs).mtimeMs,
        body: text,
      };
      if (!fams.has(stem)) fams.set(stem, []);
      fams.get(stem).push(doc);
    }
  };
  for (const kind of ['intents', 'specs', 'plans']) take(path.join(root, 'workflow', kind), kind, false);
  const archDir = path.join(root, 'workflow', 'archive');
  let months = [];
  try { months = fs.readdirSync(archDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* 无归档目录 */ }
  for (const m of months) for (const kind of ['intents', 'specs', 'plans']) take(path.join(archDir, m, kind), kind, true);
  return fams;
}

/** 确认账：.agents/confirmations.d/*.jsonl 全分片合并（坏行跳过计数，不 fail-loud——观测面）。 */
export function loadConfirmations(root) {
  const dir = path.join(root, '.agents', 'confirmations.d');
  const rows = [];
  let bad = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir); } catch { return { rows, bad }; }
  for (const f of ents.sort()) {
    if (!f.endsWith('.jsonl')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { bad++; continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
  }
  return { rows, bad };
}

/** 复核台账行级解析（8 列自洽已由 scanReviews 家族把门，这里只做行拆——单源列序与 metrics-core 一致）。 */
export function loadPanelRows(root) {
  const dir = path.join(root, 'workflow', 'reviews.d');
  const rows = [];
  let ents = [];
  try { ents = fs.readdirSync(dir); } catch { return rows; }
  for (const f of ents.sort()) {
    if (!f.endsWith('.md')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 8) continue;
      rows.push({
        date: cells[0], object: cells[1], host: cells[2],
        findings: Number(cells[3]) || 0, adopted: Number(cells[4]) || 0,
        rejected: Number(cells[5]) || 0, misreport: Number(cells[6]) || 0,
      });
    }
  }
  return rows;
}

/** 面板 run 工件：artifacts/<月>/*.json → findings 处置状态计数（undisposed = status 不在四终态）。 */
export function loadPanelRuns(root) {
  const dir = path.join(root, 'workflow', 'reviews.d', 'artifacts');
  const runs = [];
  let months = [];
  try { months = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return runs; }
  for (const m of months.sort()) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(dir, m)); } catch { continue; }
    for (const f of ents.sort()) {
      if (!f.endsWith('.json')) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, m, f), 'utf8')); } catch { continue; }
      const findings = Array.isArray(j.findings) ? j.findings : [];
      const counts = { fixed: 0, waived: 0, deferred: 0, recorded: 0, undisposed: 0 };
      const deferredIds = [];
      for (const x of findings) {
        const s = String(x.status || '');
        if (DISPOSED.has(s)) counts[s]++;
        else counts.undisposed++;
        if (s === 'deferred') deferredIds.push(String(x.id || '?'));
      }
      runs.push({
        month: m, file: f.replace(/\.json$/, ''),
        runId: String((j.run && j.run.runId) || f.replace(/\.json$/, '')),
        writtenAt: j.writtenAt || null,
        total: findings.length, counts, deferredIds,
        lenses: Array.isArray(j.run && j.run.lenses) ? j.run.lenses.length : 0,
        files: Array.isArray(j.run && j.run.files) ? j.run.files.length : 0,
      });
    }
  }
  return runs;
}

/** git log 单次 feed（口径同 gen-workflow-metrics.loadCommitFeed：提交行 + 逐行文件；P2 加 %h 短 SHA；失败 null 退化）。 */
export function gitFeed(root) {
  const r = gitRun(root, ['log', '--format=%cI%x1f%h%x1f%s', '--name-only']);
  if (!r || r.status !== 0) return null;
  const commits = [];
  let cur = null;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.includes('\x1f')) {
      const parts = line.split('\x1f');
      cur = { ts: parts[0], short: parts[1] || '', subj: parts.slice(2).join('\x1f'), files: [] };
      commits.push(cur);
    } else if (cur && line.trim()) {
      cur.files.push(line.trim().replace(/\\/g, '/'));
    }
  }
  return commits;
}

/** repo 面：branch / HEAD short / 脏文件数（非 git 仓全 null 退化）。 */
export function repoStatus(root) {
  const b = gitRun(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const h = gitRun(root, ['rev-parse', '--short', 'HEAD']);
  const s = gitRun(root, ['status', '--porcelain']);
  const ok = (x) => x && x.status === 0 && String(x.stdout || '').trim();
  return {
    root,
    branch: ok(b) ? b.stdout.trim() : null,
    head: ok(h) ? h.stdout.trim() : null,
    dirty: ok(s) ? s.stdout.split(/\r?\n/).filter((l) => l.trim()).length : null,
  };
}

/** 门禁运行流：.agents/verifications.jsonl（本地 gitignore 遥测）尾读最近 N 行 → 执行视图（P2）。
 *   坏行跳过；文件缺失 → 空数组（本机无跑数不误报）。 */
export function loadVerifications(root, limit = 15) {
  const p = path.join(root, '.agents', 'verifications.jsonl');
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const gates = Array.isArray(j.gates) ? j.gates : [];
      rows.push({
        ts: typeof j.ts === 'string' ? j.ts : null,
        exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
        headShort: typeof j.headShort === 'string' ? j.headShort : null,
        gateCount: gates.length || null,
        failedGates: gates.filter((g) => g && g.exit !== 0).map((g) => String(g.id || '?')),
        totalMs: typeof j.totalMs === 'number' ? j.totalMs : null,
        wallMs: typeof j.wallMs === 'number' ? j.wallMs : null,
      });
    } catch { /* 坏行跳过——观测面 */ }
  }
  return rows.slice(-limit).reverse();
}

/** Git 只读面（P2）：分支（≤5 支带最近提交，超出仅列名）/ 最近提交（复用 feed）/ 脏文件（cap 50）。 */
export function gitFace(root, feed, limitCommits = 15) {
  const out = { branches: [], commits: [], dirtyFiles: null, dirtyFilesCapped: false };
  const br = gitRun(root, ['branch', '--format=%(refname:short)']);
  if (!br || br.status !== 0) return out;
  const names = String(br.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const cur = repoStatus(root).branch;
  for (const name of names.slice(0, 20)) {
    const b = { name, current: name === cur, lastSubject: null, lastTs: null, listedOnly: false };
    // 逐支 log -1 只对 ≤5 支做（多分支仓防慢）；超出仅列名
    if (names.length <= 5) {
      const l = gitRun(root, ['log', '-1', '--format=%cI%x1f%s', name]);
      if (l && l.status === 0 && l.stdout.includes('\x1f')) {
        const i = l.stdout.indexOf('\x1f');
        b.lastTs = l.stdout.slice(0, i).trim();
        b.lastSubject = l.stdout.slice(i + 1).split(/\r?\n/)[0].trim();
      }
    } else {
      b.listedOnly = true;
    }
    out.branches.push(b);
  }
  if (feed) {
    out.commits = feed.slice(0, limitCommits).map((c) => ({
      short: c.short, ts: c.ts, subject: c.subj,
      files: c.files.length,
      ledgerOnly: c.files.length > 0 && c.files.every((f) => f.startsWith('workflow/') || f.startsWith('.agents/')),
    }));
  }
  const s = gitRun(root, ['status', '--porcelain']);
  if (s && s.status === 0) {
    const lines = String(s.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    out.dirtyFiles = lines.slice(0, 50);
    out.dirtyFilesCapped = lines.length > 50;
  }
  return out;
}

const stageState = (state, evidence, at = null) => ({ state, evidence, at });

/** 单族环节推导（契约节口径；docs = { intent, spec, plan } 最新者；锚 = feed 派生的 prodTs/shipTs/revs）。 */
export function deriveStages(fam, anchors, panelRows) {
  const plan = fam.plan || null;
  const intent = fam.intent || null;
  const spec = fam.spec || null;
  const planStatus = plan ? plan.status : null;
  const stages = {};

  // intake：intent 存在即据；L1 无 intent → 入口随 plan（draft 未确认 = active）
  if (intent) {
    stages.intake = intent.status === 'draft'
      ? stageState('active', `intent 在场待确认：${intent.path}`)
      : stageState('done', `intent：${intent.path}（${intent.status || '状态未知'}）`);
  } else if (plan) {
    stages.intake = planStatus === 'draft'
      ? stageState('active', 'L1 入口在 plan，待确认')
      : stageState('done', 'L1 入口随 plan 确认');
  } else stages.intake = stageState('queued', '无 intent / plan 文件');

  // spec：L1 或无 spec → na；draft → active；其余 done
  if (!spec) stages.spec = stageState('na', plan ? 'L1 不走 spec' : '无 spec 文件');
  else stages.spec = spec.status === 'draft'
    ? stageState('active', `spec 待确认：${spec.path}`)
    : stageState('done', `spec：${spec.path}（${spec.status || '状态未知'}）`);

  // plan：draft → active / approved|done → done / 终态 cancelled|superseded → na / 缺 → queued
  if (!plan) stages.plan = stageState('queued', '无 plan 文件');
  else if (planStatus === 'draft') stages.plan = stageState('active', 'plan 待确认（draft）');
  else if (planStatus === 'cancelled' || planStatus === 'superseded') stages.plan = stageState('na', `plan 终态 ${planStatus}`);
  else stages.plan = stageState('done', `plan 状态 ${planStatus || '未知'}`);

  // implement：产品提交锚（消息含 stem ∩ 非台账路径）→ done；approved 无锚 → active
  if (anchors.prodTs) stages.implement = stageState('done', `产品提交锚 ${anchors.prodTs.slice(0, 10)}`, anchors.prodTs);
  else if (planStatus === 'approved') stages.implement = stageState('active', 'plan approved，待产品提交');
  else stages.implement = stageState('queued', '无产品提交锚');

  // verify：验收勾验计数
  if (plan) {
    const cb = checkboxOf(plan.body);
    if (cb.total === 0) stages.verify = stageState('queued', '无验收勾验行');
    else if (cb.done < cb.total) stages.verify = stageState('active', `验收勾验 ${cb.done}/${cb.total}`);
    else stages.verify = stageState('done', `验收勾验 ${cb.done}/${cb.total}（全勾）`);
  } else stages.verify = stageState('queued', '无 plan 可勾验');

  // review：复核台账行对象列含 stem/短名，或行内 runId 被族文档体引用（面板评审族的 plan 来源行写 runId）
  const ids = [fam.stem, shortOf(fam.stem)];
  const bodyText = fam.bodyText || '';
  const hit = panelRows.find((r) => {
    if (!r.object) return false;
    if (ids.some((id) => r.object.includes(id))) return true;
    return runIdsOf(r.object).some((rid) => bodyText.includes(rid));
  });
  stages.review = hit
    ? stageState('done', `复核台账行：${hit.object}（${hit.date}，${hit.findings} 意见）`)
    : stageState('na', '无复核台账行提及');

  // ship：feed 触 marketplace.json ∩ 消息含 stem
  if (anchors.shipTs) stages.ship = stageState('done', `发版提交 ${anchors.shipTs.slice(0, 10)}`, anchors.shipTs);
  else stages.ship = stageState('na', '无 marketplace 发版提交');

  // closeout：归档 + done → done；活跃 approved → active；draft → queued；终态 → na
  if (!plan) stages.closeout = stageState('queued', '无 plan 文件');
  else if (plan.archived && planStatus === 'done') stages.closeout = stageState('done', '已归档关单');
  else if (planStatus === 'cancelled' || planStatus === 'superseded') stages.closeout = stageState('na', `终态 ${planStatus} 归档`);
  else if (plan.archived) stages.closeout = stageState('active', '已归档但状态非 done');
  else if (planStatus === 'approved' || planStatus === 'draft') stages.closeout = stageState(planStatus === 'draft' ? 'queued' : 'active', planStatus === 'draft' ? 'plan 未确认' : '实施中（活跃）');
  else stages.closeout = stageState('active', '未归档');

  return stages;
}

/** 章聚合：任一 active → active；全 done（≥1）→ done；全 na → na；余 queued。 */
export function deriveChapters(stages) {
  const out = {};
  for (const ch of CHAPTERS) {
    const sts = ch.keys.map((k) => stages[k] ? stages[k].state : 'queued');
    if (sts.includes('active')) out[ch.id] = { state: 'active', note: `${ch.cn}进行中` };
    else if (sts.every((s) => s === 'done')) out[ch.id] = { state: 'done', note: `${ch.cn}完成` };
    else if (sts.every((s) => s === 'na')) out[ch.id] = { state: 'na', note: `${ch.cn}不适用` };
    else out[ch.id] = { state: 'queued', note: `${ch.cn}未开始` };
  }
  return out;
}

/**
 * buildWorkbench({ root, now }) — 模型单源（契约见 plan「契约」节）。
 * 返回 { generatedAt, repo, stats, deliveries[], decisions{pending,recent,panels} }。
 */
export function buildWorkbench({ root, now = new Date() }) {
  root = path.resolve(root);
  const fams = scanFamilies(root);
  const { rows: confirmRows } = loadConfirmations(root);
  const panelRows = loadPanelRows(root);
  const panelRuns = loadPanelRuns(root);
  const feed = gitFeed(root);
  const repo = repoStatus(root);

  // 确认账索引：doc → 最新行；全量按 ts 排序
  const confirmByDoc = new Map();
  for (const r of confirmRows) {
    if (typeof r.doc !== 'string' || typeof r.ts !== 'string') continue;
    const prev = confirmByDoc.get(r.doc);
    if (!prev || r.ts > prev.ts) confirmByDoc.set(r.doc, r);
  }
  const recent = confirmRows
    .filter((r) => typeof r.doc === 'string' && typeof r.ts === 'string')
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 12)
    .map((r) => ({
      ts: r.ts, doc: r.doc, stage: r.stage ?? null,
      source: r.source ?? null, quoteGrounding: r.quoteGrounding ?? null,
    }));

  const nowIso = now.toISOString();
  const month = nowIso.slice(0, 7);
  const deliveries = [];
  for (const [stem, docs] of fams) {
    const fam = {};
    for (const d of docs) {
      // 同 kind 活跃优先、新优先（重名罕见，稳妥取活跃未归档的最新）
      if (!fam[d.kind] || (d.archived === false && fam[d.kind].archived === true)) fam[d.kind] = d;
      else if (d.archived === fam[d.kind].archived && d.mtimeMs > fam[d.kind].mtimeMs) fam[d.kind] = d;
    }
    // 锚：产品提交 / 发版提交 / 修订计数（feed 一次遍历，口径同返工代理段；消息按 stem/短名双匹配）
    const anchors = { prodTs: null, shipTs: null, revs: 0 };
    const ids = [stem, shortOf(stem)];
    if (feed) {
      const stemFiles = new Set(docs.map((d) => d.path));
      for (const c of feed) {
        const isProd = c.files.some((f) => !f.startsWith('workflow/') && !f.startsWith('.agents/'));
        if (isProd && ids.some((id) => c.subj.includes(id))) {
          if (!anchors.prodTs || c.ts > anchors.prodTs) anchors.prodTs = c.ts;
          if (c.files.some((f) => f === 'marketplace.json' || f.endsWith('/marketplace.json'))) {
            if (!anchors.shipTs || c.ts > anchors.shipTs) anchors.shipTs = c.ts;
          }
        }
        if (c.files.some((f) => stemFiles.has(f) || f.endsWith(`/${stem}.md`))) anchors.revs++;
      }
    }
    const bodyText = docs.map((d) => d.body).join('\n');
    const stages = deriveStages({ stem, bodyText, ...fam }, anchors, panelRows);
    const chapters = deriveChapters(stages);
    const planDoc = fam.plan || null;
    const docList = docs
      .slice()
      .sort((a, b) => (a.kind === 'plan' ? -1 : b.kind === 'plan' ? 1 : 0))
      .map((d) => {
        const c = confirmByDoc.get(d.path);
        return {
          kind: d.kind, path: d.path, status: d.status || '—',
          confirmedAt: c ? c.ts : null,
        };
      });
    const updatedAt = [
      ...docs.map((d) => (d.mtimeMs ? new Date(d.mtimeMs).toISOString() : null)),
      ...docList.map((d) => d.confirmedAt),
    ].filter(Boolean).sort().pop() || null;
    const active = planDoc ? !planDoc.archived : false;
    deliveries.push({
      id: stem,
      title: (planDoc && planDoc.title) || (fam.intent && fam.intent.title) || (fam.spec && fam.spec.title) || stem,
      level: (planDoc && planDoc.level) || (fam.intent && fam.intent.level) || null,
      status: active ? 'active' : 'done',
      updatedAt,
      chapters,
      stages: STAGE_KEYS.map((k) => ({
        key: k, name: STAGE_NAMES[k],
        state: stages[k].state, at: stages[k].at, evidence: stages[k].evidence,
      })),
      docs: docList,
      rework: { prodTs: anchors.prodTs, revs: anchors.revs },
    });
  }
  deliveries.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return (b.updatedAt || '') < (a.updatedAt || '') ? -1 : 1;
  });

  // 决策面 pending：draft 文档 + 面板未处置 findings + deferred 挂账
  const pending = [];
  for (const d of deliveries) {
    for (const doc of d.docs) {
      if (doc.status === 'draft') {
        pending.push({
          kind: 'doc-confirm',
          label: `待确认：${doc.path}`,
          detail: `${doc.kind} 状态 draft，等待用户一句话确认`,
          cmd: `node <插件根>/scripts/confirm-doc.mjs ${doc.path}`,
          at: null,
        });
      }
    }
  }
  const deferred = [];
  for (const run of panelRuns) {
    if (run.counts.undisposed > 0) {
      pending.push({
        kind: 'panel-undisposed',
        label: `面板未处置：${run.runId}`,
        detail: `${run.counts.undisposed}/${run.total} 条 findings 无处置`,
        cmd: `node <插件根>/scripts/pr-review.mjs dispose --run ${run.runId}`,
        at: run.writtenAt,
      });
    }
    for (const fid of run.deferredIds) {
      deferred.push({
        kind: 'deferred-finding',
        label: `挂账：${run.runId} ${fid}`,
        detail: 'finding 处置 deferred（延后收账）',
        cmd: `node <插件根>/scripts/pr-review.mjs dispose --run ${run.runId}`,
        at: run.writtenAt,
      });
    }
  }
  pending.push(...deferred);

  const panels = panelRows.map((r) => ({
    date: r.date, object: r.object,
    findings: r.findings, adopted: r.adopted, rejected: r.rejected, misreport: r.misreport,
  }));

  // P2 两节：执行运行流（本地门禁遥测 + 面板工件）与 Git 只读面
  const execution = {
    verifications: loadVerifications(root),
    panelRuns: panelRuns.slice(-10).reverse().map((r) => ({
      runId: r.runId, month: r.month, writtenAt: r.writtenAt,
      total: r.total, counts: r.counts, lenses: r.lenses, files: r.files,
    })),
  };
  const git = gitFace(root, feed);

  return {
    generatedAt: nowIso,
    repo,
    execution,
    git,
    stats: {
      deliveries: deliveries.length,
      active: deliveries.filter((d) => d.status === 'active').length,
      done: deliveries.filter((d) => d.status === 'done').length,
      pendingDecisions: pending.length,
      deferredFindings: deferred.length,
      panelFindingsMonth: panelRows.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.findings, 0),
    },
    deliveries,
    decisions: { pending, recent, panels },
  };
}

// ---- CLI 冒烟（--root 缺省 cwd；库消费走 buildWorkbench 导出，不受此段影响）----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd();
  process.stdout.write(`${JSON.stringify(buildWorkbench({ root }), null, 2)}\n`);
}
