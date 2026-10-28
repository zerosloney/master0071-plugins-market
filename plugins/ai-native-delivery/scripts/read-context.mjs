#!/usr/bin/env node
// read-context — 跨会话恢复上下文汇总（设计文档 §3.3 read_context 工具的实现内核；可独立 CLI 跑、被 mcp/tools.mjs 包装）
// 汇总三面：
//   ① workflow/INDEX.md 存在性 + 头部（跨会话恢复的入口文档）；
//   ② workflow/plans|specs|intents 三目录在途文件清单（frontmatter「状态」∈ 活跃集 draft/approved）；
//   ③ .agents/confirmations.jsonl（∪ confirmations.d/ 分片）最近 N=5 行——最近确认事实。
// 未初始化语义（§5.2 首次执行契约）：workflow/ 不存在 → {initialized:false, hint} 而非报错——
//   装户首调是合法形态，工具面不制造假红；hint 指向 init_engine 或任意命令触发的幂等初始化。
// 台账读取只读、坏行容忍跳过（与 ledger-loader 同口径）；不写任何文件。
// 用法：node read-context.mjs [--root <仓库根>]（缺省用 git root 锚定的项目根）
// 测试：node test/mcp-tools.test.mjs（未初始化/已初始化两态）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, engineDir, ledgerDir } from './paths.mjs';

export const HINT_UNINITIALIZED = '先跑 init_engine 或任意命令触发初始化';
const INDEX_HEAD_LINES = 15;
const CONFIRM_TAIL = 5;

// frontmatter 单键提取（「状态:」/「级别:」只在 frontmatter 区取，防正文误命中——confirm-doc 同口径）
function fmValue(text, key) {
  const nl = String(text).replace(/\r\n/g, '\n').split('\n');
  if (!/^---\s*$/.test(nl[0] || '')) return '';
  for (let i = 1; i < nl.length && !/^---\s*$/.test(nl[i]); i++) {
    const m = nl[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (m) return m[1].trim();
  }
  return '';
}

const ACTIVE_DOC_STATUS = new Set(['draft', 'approved']); // doc.status.active（workflow-enums 单源的活跃集）

function inFlightFiles(root, dir, degraded = []) {
  const abs = path.join(ledgerDir(root), dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const f of fs.readdirSync(abs).sort()) {
    if (!f.endsWith('.md') || f.startsWith('_TEMPLATE')) continue;
    const absFile = path.join(abs, f);
    let text = '';
    try {
      text = fs.readFileSync(absFile, 'utf8');
    } catch (e) {
      // 读不出 ≠ 没有（2026-10-27 修复）：此前静默 continue——在途件数偏小且无任何痕迹。
      degraded.push(`workflow/${dir}/${f} 读不出（${(e && e.code) || (e && e.message) || '未知错误'}）——未计入在途清单`);
      continue;
    }
    const status = fmValue(text, '状态');
    if (!ACTIVE_DOC_STATUS.has(status)) continue;
    out.push({ file: `${dir}/${f}`, status, level: fmValue(text, '级别') || null });
  }
  return out;
}

// 降级出账（2026-10-27 修复）：读不出 ≠ 没有。读失败此前被静默剔除——在途件数偏小、
// INDEX 读失败与「INDEX 为空文件」输出同形，调用方无法区分「没这回事」与「没读出来」。
// 现统一收集到 degraded 数组，由 readContext 回传给调用方（MCP read_context / CLI stdout）。

// 最近确认行：主台账 ∪ confirmations.d 分片（原始行，坏行跳过），按 ts 排序取尾 N——
// 「最近 N 行」取原始追加语义，不做 loadAllConfirmations 的同键去重（重确认的多次落账都是事实）。
function recentConfirmations(root, n = CONFIRM_TAIL, degraded = []) {
  const rows = [];
  const mainFile = path.join(engineDir(root), 'confirmations.jsonl');
  const files = [mainFile];
  const shardDir = path.join(engineDir(root), 'confirmations.d');
  try {
    if (fs.existsSync(shardDir)) {
      for (const f of fs.readdirSync(shardDir).sort()) {
        if (f.endsWith('.jsonl')) files.push(path.join(shardDir, f));
      }
    }
  } catch (e) {
    degraded.push(`.agents/confirmations.d/ 目录不可读（${(e && e.code) || (e && e.message) || '未知错误'}）——只回主台账`);
  }
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      degraded.push(`${path.basename(file)} 读不出（${(e && e.code) || (e && e.message) || '未知错误'}）——该账未计入最近确认行`);
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') rows.push({ ...obj, _file: path.basename(file) });
      } catch { /* 坏行容忍（与门禁读取侧同口径） */ }
    }
  }
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return rows.slice(-n).map(({ _file, ...rest }) => ({ ...rest, ledger: _file }));
}

/**
 * 汇总项目上下文。root 必须是已解析的项目根（调用方经 paths.findProjectRoot 锚定）。
 */
export function readContext(root) {
  const wf = ledgerDir(root);
  if (!fs.existsSync(wf)) {
    return { initialized: false, hint: HINT_UNINITIALIZED };
  }
  const degraded = [];
  const indexFile = path.join(wf, 'INDEX.md');
  let index = { exists: false, head: [] };
  if (fs.existsSync(indexFile)) {
    let text = '';
    let readable = true;
    try {
      text = fs.readFileSync(indexFile, 'utf8');
    } catch (e) {
      // 读失败与「INDEX 是空文件」此前输出同形（exists:true + head:[]）——调用方分不出
      // 「没有索引」与「索引读不出来」。现单列 readable=false 并出账。
      readable = false;
      degraded.push(`workflow/INDEX.md 读不出（${(e && e.code) || (e && e.message) || '未知错误'}）——索引内容未取到（不是「索引为空」）`);
    }
    index = { exists: true, readable, head: readable ? text.replace(/\r\n/g, '\n').split('\n').slice(0, INDEX_HEAD_LINES) : [] };
  }
  const inFlight = {
    intents: inFlightFiles(root, 'intents', degraded),
    specs: inFlightFiles(root, 'specs', degraded),
    plans: inFlightFiles(root, 'plans', degraded),
  };
  const confirmations = recentConfirmations(root, CONFIRM_TAIL, degraded);
  return {
    initialized: true,
    index,
    inFlight,
    inFlightCount: inFlight.intents.length + inFlight.specs.length + inFlight.plans.length,
    confirmations,
    degraded,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('read-context.mjs');
if (isMain) {
  const ri = process.argv.indexOf('--root');
  const root = ri >= 0 ? path.resolve(process.argv[ri + 1] || '') : findProjectRoot();
  if (!root) {
    console.error('read-context: 无法定位项目根（当前目录不在 git 仓库内）——用 --root <仓库根> 显式指定');
    process.exit(1);
  }
  console.log(JSON.stringify(readContext(root), null, 2));
}
