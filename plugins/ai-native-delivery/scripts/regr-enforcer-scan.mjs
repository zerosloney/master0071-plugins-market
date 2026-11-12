// regr-enforcer-scan.mjs — 回归清单「执法者」行扫描（纯函数模块，root 注入、零副作用；2026-11-12）
// 判据单源：check-loop-sections/s29-regr-enforcer.mjs（hard 门：未指认/指认失效）与 verify.mjs
// 尾部 [prompt-only] 挂债摘要共用同一套行判据——行切分/数据行判据/锚过滤/路径形态判定只在此
// 实现，两处消费不各自复制（口径漂移防线，同 metrics-core 自 gen-workflow-metrics 抽取的先例）。
// 判据沿革（2026-11-11 s29 判据移植）：主台账「## 防复发验证」节 + 全部分片
//   workflow/regression-checklist.d/<YYYY-MM>.md 的数据行（双 | 包边、非表头非分隔行；首列剥
//   反引号后以 \d{4}- 开头）。行日期 = 首列前 10 字符；< anchor 跳过（存量不追溯）。
// 步骤 D 扩展（设计稿 ai-native-closed-loop-and-memory）：锚后行执法者为**仓内文件路径形态**
//   （含 / 或 \ 或已知扩展名；URL/人名/门禁 §N 等纯外部形态不检）时，机检「文件存在 +
//   node --check 级可解析」（语法检不实际运行——设计稿 §3：可达性机检止于此，跑通断言属 CI/项目侧）。
//   摘要消费方（verify.mjs）只要计数，parseCheck:false 跳过语法检省 spawn。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WF_REL } from './paths.mjs';

// 行切分沿用 s23 / agg-delegations splitTables 口径：双 | 包边、slice(1,-1)、逐格 trim
const cellsOf = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
// 数据行 = 双 | 包边表行、非分隔行、首列（剥反引号）以 \d{4}- 开头；日期 = 首列前 10 字符
const isDataRow = (l) => {
  if (!/^\s*\|.*\|\s*$/.test(l) || isSep(l)) return false;
  const first = (cellsOf(l)[0] || '').replace(/^`+|`+$/g, '').trim();
  return /^\d{4}-/.test(first);
};
const dateOf = (cells) => (cells[0] || '').replace(/^`+|`+$/g, '').trim().slice(0, 10);

// 仓内路径形态判定（步骤 D）：含 / 或 \ 或已知扩展名 → 机检；剥反引号后判定。
// URL（http/https）与无分隔符无扩展名的文本（人名 / 门禁 §N / regression-smoke 等）→ null 不检。
const KNOWN_EXT_RE = /\.(mjs|cjs|js|mts|cts|ts|tsx|jsx|json|yml|yaml|md|txt|sh|ps1|psm1|py|rb|go|rs|java|cs|fs|fsx|cpp|h|hpp|sql|toml)$/i;
export function looksLikeRepoPath(enforcer) {
  const t = String(enforcer || '').replace(/^`+|`+$/g, '').trim();
  if (!t || /^https?:\/\//i.test(t)) return null;
  if (!/[\\/]/.test(t) && !KNOWN_EXT_RE.test(t)) return null;
  return t;
}
// JS 族扩展才做语法检（node --check 只认 JS）；其余扩展存在性即达（设计稿「重脚本用语法检即可」）
const JS_EXT_RE = /\.(mjs|cjs|js|mts|cts)$/i;

/**
 * scanRegrEnforcer(root, { anchor, parseCheck })：扫描主台账 + 分片的锚后执法者行。
 * @returns {{targets:Array<{base:string, missed:string[], invalid:string[], promptOnly:Array<{base,date,topic}>}>}}
 *   missed = 未指认（执法者列空 / 行被切列）的消息片段（s29 聚合文案的括号内条目，格式沿 s29 现行）；
 *   invalid = 指认失效（路径形态执法者不存在 / 不可解析）的消息片段；
 *   promptOnly = 显式人工执法声明行（[prompt-only] 前缀——合法放行，但每行都是挂债，verify 尾部摘要消费）。
 */
export function scanRegrEnforcer(root, { anchor, parseCheck = true } = {}) {
  const targets = [];
  if (!anchor) return { targets }; // 缺锚（v1–v15）→ 整段跳过（存量项目零破坏），语义与 s29 一致
  const parseCache = new Map();
  const parseOk = (abs) => {
    if (parseCache.has(abs)) return parseCache.get(abs);
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const ok = r.status === 0;
    parseCache.set(abs, ok);
    return ok;
  };
  // 扫描面：主台账「防复发验证」节（## 级开节，### 子节不停）+ 全部分片整文件
  const secLines = [];
  let inSec = false;
  const mainLedger = path.join(root, WF_REL, 'regression-checklist.md');
  const mainLines = fs.existsSync(mainLedger) ? fs.readFileSync(mainLedger, 'utf8').split(/\r?\n/) : [];
  for (const l of mainLines) {
    if (/^##\s+.*防复发验证/.test(l)) { inSec = true; continue; }
    if (inSec && /^##\s+/.test(l)) { inSec = false; continue; }
    if (inSec) secLines.push(l);
  }
  const files = [{ base: 'regression-checklist.md', lines: secLines }];
  const shardDir = path.join(root, WF_REL, 'regression-checklist.d');
  const shards = fs.existsSync(shardDir) ? fs.readdirSync(shardDir).filter((n) => n.endsWith('.md')).sort() : [];
  for (const f of shards) files.push({ base: f, lines: fs.readFileSync(path.join(shardDir, f), 'utf8').split(/\r?\n/) });
  for (const t of files) {
    const missed = [];
    const invalid = [];
    const promptOnly = [];
    for (const l of t.lines) {
      if (!isDataRow(l)) continue; // 表头行/分隔行/非数据行跳过
      const cells = cellsOf(l);
      const d = dateOf(cells);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < anchor) continue; // 不可判定或锚前存量不追溯
      const topic = (cells[1] || cells[0] || l).replace(/\s+/g, ' ').trim().slice(0, 40);
      const enforcer = cells.length === 4 ? cells[3] : '';
      if (!enforcer || enforcer === '—' || enforcer === '-') {
        missed.push(`${d}「${topic}」${cells.length === 4 ? '执法者列为空' : `行被切成 ${cells.length} 列（表头口径 4 列）`}`);
        continue;
      }
      if (enforcer.startsWith('[prompt-only]')) { promptOnly.push({ base: t.base, date: d, topic }); continue; }
      const rel = looksLikeRepoPath(enforcer);
      if (!rel) continue; // 纯外部形态（URL / 人名 / 门禁 §N 等）不检
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
      if (!fs.existsSync(abs)) { invalid.push(`${d}「${topic}」指认 ${rel}：文件不存在`); continue; }
      if (JS_EXT_RE.test(rel) && !parseOk(abs)) invalid.push(`${d}「${topic}」指认 ${rel}：语法不可解析（node --check 失败）`);
    }
    targets.push({ base: t.base, missed, invalid, promptOnly });
  }
  return { targets };
}
