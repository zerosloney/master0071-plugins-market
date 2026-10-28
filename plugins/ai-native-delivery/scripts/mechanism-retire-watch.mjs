#!/usr/bin/env node
// mechanism-retire-watch.mjs — 1b 机制退役催办自动化（2026-10-14 L5 自举接线 1b/1c）
// 用途：读机制台账「退役阈值/最近触发」+ judgments 聚合，阈值触达自动产动作项——让机制的「死」与「生」同样强制。
//   自动化的是**感知/排序**（谁触达了阈值），处置仍人放行（改状态/删代码走人 + 一进一出）。
// 口径单源：.agents/config/mechanism-registry.md 列序（机制|门禁位置|触发统计口径|退役阈值|最近触发|状态|处置期限）
//   与判定流水（本地 .agents/judgments.jsonl ∪ 入库分片 workflow/gate-metrics.d/*.jsonl，
//   gate-metrics-shard 2026-10-22——换机/换 worktree 不再归零）。
// 判定（确定性，无 LLM）：
//   ① 现役行 + 阈值形态「连续 N 月 = 0」+ 口径列含「规则名」→ 以有数据的末月为终点取 N 个日历月，缺月不算零命中，全 0 即触达 → 动作项。
//   ② 待退役行 + 处置期限为日期且已过 → 动作项（逾期）。
//   ③ 其余阈值形态（不退役主干 / 使用率型 / 数据源型）→ 非自动可判，仅计数，交人工月判。
//   ④ 现役行 + 处置期限列含「复评 YYYY-MM-DD」且已过 → 动作项（owner-fiat 复评到期，2026-10-21 W5 惯例：
//     owner 裁决型退役/降档自带回头看闹钟——到期重评现口径，维持/恢复/调整由 owner 一句话定）。
// 退出码恒 0（催办报告不该阻断调度器；测量失败打 [ERROR] 行）。
// 用法：node <插件根>/scripts/mechanism-retire-watch.mjs [--json] [--root <仓库根>] [--now <ISO 日期>]
// 测试：node <插件根>/test/mechanism-retire-watch.test.mjs（纯函数 evaluate 进程内断言）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aggFromRows, readAllJudgments } from './agg-judgments.mjs';
import { findProjectRoot } from './paths.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''; };
const asJson = argv.includes('--json');
// ROOT 解析（2026-10-28 插件化修复，与 agg-judgments / check-query-contract / gen-effective-policy 同口径）：
//   项目 git 根（findProjectRoot）→ 旧锚 <script>/../..（源仓形态行为不变）。
//   旧锚在插件形态下 = 插件目录的上级（市场仓 plugins/）——台账落使用项目 git 根的不变量（README §台账
//   项目级不变量）在此处被绕过：机制台账恒报「不存在」且 exit 0，月度退役催办整体失效（假绿）。
const ROOT = path.resolve(argOf('--root') || findProjectRoot() || path.join(SCRIPT_DIR, '..', '..'));
const NOW = argOf('--now') ? new Date(argOf('--now')) : new Date();
const MODEL = argOf('--model') || process.env.MODEL_FAMILY || '';

// 模型代际重评分组（与 .agents/config/mechanism-registry.md「维护纪律」的 A–E 组列表对照——按组名定位，勿记行号）。
// C 组机器判据代际免评；A/B/D/E 组在检测到代际变更时产生 revisit-model 动作项，由 owner 在月度对账时逐件重评。
export const MODEL_AGE_GROUP = {
  // A · 纪律假设（观察 WARN/hard 是否加速归零，不因代际主动拆门）
  '三件套同名配对': 'A', '模板占位符残留': 'A', 'incident 复盘三件套': 'A', 'incident 归因字段': 'A',
  'approved 留痕': 'A', '确认指纹配对': 'A', '逐阶段审计': 'A', 'spec 验证落地': 'A',
  '闭环漏斗协议前动作阈值': 'A', '委派台账对账': 'A', '产品契约面归因': 'A',
  'incident 防复发证据门': 'A', '脚本测试覆盖对账': 'A', 'flaky 隔离重跑': 'A', 'PR 体积预算': 'A',
  // B · 能力边界假设（须主动重评；证据真相核验+密钥扫描属信任边界，代际不撤门）
  '常驻面体积预算': 'B', '独立复核上下文标识': 'B', '路由预判一致性': 'B', '触达面判低门': 'B',
  '证据真相核验': 'B', '密钥扫描门（gitleaks）': 'B',
  // C · 机器判据（代际免评，此处不予列入，评估时跳过）
  // D · 宿主生态（跟宿主软件版本走）
  '宿主 Adapter 一致性': 'D', '命令指针壳': 'D', 'opencode 权限镜像门': 'D',
  // E · 测量自举（代际只影响测量结论的解释）
  '门禁耗时埋点': 'E', '机制退役催办（1b）': 'E', 'papercut 回路定时报债（1c）': 'E',
  '复核效果台账': 'E', '门禁判定月度分片': 'E',
};

const REGISTRY_REL = path.join('.agents', 'config', 'mechanism-registry.md');

// STATUSES：状态列闭集（判定与格式校验的唯一取值来源）。
export const STATUSES = ['现役', '待退役', '已退役'];

// statusOf(raw)：状态列 → 闭集值。状态列允许在值后追加机制类型标记（`现役 [检出型]` /
//   `现役 [健康静默]` / `现役 [不退役主干]` / `现役 [数据面]`，见台账「机制类型标记」节），
//   标记只用于月度对账分流，**不参与状态判定**——故解析层统一剥离，判定层只见干净闭集值。
//   2026-10-22 收敛：此前三个消费者（检查 22 / gen-engine-map / 本脚本 evaluate）各自按精确
//   字符串比对状态列，标记一上线三处同时失配（检查 22 产出 35 条纯噪声、生成器写出「现役 0」、
//   本脚本对 35 行零覆盖）。现改为**唯一解析点在此**，消费者一律消费 status（标记另见 tag）。
export function statusOf(raw) {
  return String(raw).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

// tagOf(raw)：状态列 → 类型标记文本（不含方括号）；无标记 = ''。
export function tagOf(raw) {
  const m = String(raw).match(/\[([^\]]*)\]\s*$/);
  return m ? m[1].trim() : '';
}

// parseRegistry(text)：7 列管道表 → 行对象数组。列序固定（check-loop §22 按此解析）。
//   status = 剥离类型标记后的闭集值（判定用）；statusRaw = 原样单元格（报错定位用）；
//   tag = 类型标记文本（月度对账分流用）。
export function parseRegistry(text) {
  const rows = [];
  for (const l of String(text).split(/\r?\n/)) {
    if (!/^\|/.test(l)) continue;
    if (/^\|[\s:|-]+\|?\s*$/.test(l)) continue; // 分隔行
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 7) continue;
    if (cells[0] === '机制') continue; // 表头
    const [name, gate, criterion, threshold, lastTrigger, statusRaw, deadline] = cells;
    rows.push({ name, gate, criterion, threshold, lastTrigger, status: statusOf(statusRaw), statusRaw, tag: tagOf(statusRaw), deadline });
  }
  return rows;
}

// ruleNamesOf(criterion)：从「触发统计口径」列抽「」内规则名（/ 分隔）。无「」= 无法自动映射。
export function ruleNamesOf(criterion) {
  const names = [];
  for (const m of String(criterion).matchAll(/「([^」]+)」/g)) {
    for (const n of m[1].split('/')) {
      const t = n.trim();
      if (t) names.push(t);
    }
  }
  return names;
}

// zeroMonthsOf(threshold)：阈值形态「连续 N 月 = 0」→ N；否则 null（非自动可判）。
export function zeroMonthsOf(threshold) {
  const m = String(threshold).match(/连续\s*(\d+)\s*月\s*=\s*0/);
  return m ? Number(m[1]) : null;
}

// localDay(d)：本地日历日 YYYY-MM-DD。期限比较不用 UTC 零点，避免北京时 08:00 后把当天判逾期。
export function localDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

// calendarWindow(endYm, n)：以有数据的末月为终点，向前取 n 个日历月（含终点）。
export function calendarWindow(endYm, n) {
  const [y, m] = String(endYm).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// evaluate(registryRows, judgmentRows, now)：纯函数——产动作项。测试进程内断言。
export function evaluate(registryRows, judgmentRows, now = new Date(), { modelBaseline = '', model = '' } = {}) {
  const { byMonth } = aggFromRows(judgmentRows || [], null);
  const months = Object.keys(byMonth).sort(); // 升序
  const actions = [];
  const notAuto = [];
  const modelChanged = Boolean(modelBaseline && model && model !== modelBaseline);

  for (const r of registryRows) {
    if (r.status === '已退役') continue;

    if (r.status === '待退役') {
      const d = String(r.deadline).match(/\d{4}-\d{2}-\d{2}/);
      if (d && localDay(now) > d[0]) {
        actions.push({ kind: 'overdue', name: r.name, detail: `待退役处置期限 ${d[0]} 已过（今 ${localDay(now)}）——按台账维护纪律「退役动作」当日删代码+测试+更新本表` });
      } else if (!d) {
        actions.push({ kind: 'no-deadline', name: r.name, detail: `待退役但处置期限非日期（${r.deadline || '空'}）——补时间表或改回现役` });
      }
      continue;
    }

    // 现役
    // ④ owner-fiat 复评到期（W5 惯例）：「复评 YYYY-MM-DD」写进处置期限列即挂号，到期自动催办。
    {
      const rv = String(r.deadline).match(/复评\s*(\d{4}-\d{2}-\d{2})/);
      if (rv && localDay(now) > rv[1]) {
        actions.push({ kind: 'revisit', name: r.name, detail: `owner 裁决复评期 ${rv[1]} 已到（今 ${localDay(now)}）——重评该机制现口径（维持/恢复/调整，owner 一句话定；维持则在处置期限列顺延下一复评日）` });
      }
    }
    // ⑤ 模型代际重评：主力模型代际变更后，对 A/B/D/E 组机制产生 revisit-model 动作项；C 组机器判据代际免评。
    if (modelChanged) {
      const group = MODEL_AGE_GROUP[r.name];
      if (group && group !== 'C') {
        actions.push({
          kind: 'revisit-model',
          name: r.name,
          detail: `模型代际变更（${modelBaseline} → ${model}），建议本轮月度对账按 ${group} 组重评去留，结论写入「最近触发」列（如「${localDay(now)} 代际重评：维持/调整」）；机制 ${r.name} 归 ${group} 组`,
        });
      }
    }
    const n = zeroMonthsOf(r.threshold);
    const rules = ruleNamesOf(r.criterion);
    if (n === null) { notAuto.push({ name: r.name, reason: '阈值形态非「连续 N 月 = 0」' }); continue; }
    if (!rules.length) { notAuto.push({ name: r.name, reason: '口径列未列规则名（无法映射 judgments）' }); continue; }
    if (months.length < n) { notAuto.push({ name: r.name, reason: `judgments 仅 ${months.length} 月 < 阈值 ${n} 月（数据不足）` }); continue; }

    // 日历连续：缺月不算零命中（漏跑数月后陈旧月份不得凑成「连续」）。
    const window = calendarWindow(months[months.length - 1], n);
    const missing = window.filter((ym) => !byMonth[ym]);
    if (missing.length) {
      notAuto.push({ name: r.name, reason: `日历窗口 ${window.join(' / ')} 缺月 ${missing.join(' / ')}（断档不算零命中）` });
      continue;
    }
    const hits = window.map((ym) => {
      const cell = byMonth[ym].rules;
      let c = 0;
      for (const rule of rules) {
        const e = cell[rule];
        if (e) c += (e.WARN || 0) + (e.BLOCK || 0);
      }
      return { ym, count: c };
    });
    const total = hits.reduce((s, h) => s + h.count, 0);
    if (total === 0) {
      actions.push({ kind: 'threshold', name: r.name, detail: `连续 ${n} 月零触发（${window.join(' / ')}；规则 ${rules.join('、')}）——阈值触达，评估退役（改状态「待退役」并填处置期限）` });
    }
  }
  return { actions, notAuto, months, monthCount: months.length };
}

function readJudgments(root) {
  // 仓库级数据面（gate-metrics-shard 2026-10-22）：本地台账 ∪ workflow/gate-metrics.d/*.jsonl。
  // 本地台账 per-worktree/gitignore，换机即归零；分片入库后「连续 N 月 = 0」才有跨机燃料。
  const all = readAllJudgments(root);
  return { rows: all.rows, missing: all.missing };
}

function main() {
  const regPath = path.join(ROOT, REGISTRY_REL);
  if (!fs.existsSync(regPath)) {
    console.error(`[ERROR] mechanism-retire-watch: 台账不存在 ${REGISTRY_REL}`);
    if (asJson) console.log(JSON.stringify({ error: 'registry-missing', actions: [] }, null, 2));
    process.exit(0);
  }
  const registryRows = parseRegistry(fs.readFileSync(regPath, 'utf8'));
  const { rows: judgmentRows, missing } = readJudgments(ROOT);

  // 读取 engine.json 的 modelBaseline（模型代际基线），与 --model / MODEL_FAMILY 比较以触发代际重评。
  let modelBaseline = '';
  try {
    const eng = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'config', 'engine.json'), 'utf8'));
    modelBaseline = eng.modelBaseline || '';
  } catch { /* engine.json 缺失或不可解析，代际重评不触发 */ }

  const { actions, notAuto, monthCount } = evaluate(registryRows, judgmentRows, NOW, { modelBaseline, model: MODEL });

  if (asJson) {
    console.log(JSON.stringify({ registryRows: registryRows.length, judgmentMonths: monthCount, judgmentsMissing: missing, actions, notAuto }, null, 2));
    return;
  }

  console.log(`# 机制退役催办（${NOW.toISOString()}）`);
  console.log('');
  console.log(`台账 ${REGISTRY_REL}｜机制行 ${registryRows.length}｜judgments 月数 ${monthCount}${missing ? '（台账缺失——尚无运行记录）' : ''}`);
  console.log('');
  if (!actions.length) {
    console.log('✅ 无阈值触达 / 无逾期——本轮无动作项。');
  } else {
    console.log(`## 动作项 ${actions.length} 条`);
    for (const a of actions) console.log(`- [${a.kind}] ${a.name}：${a.detail}`);
  }
  if (notAuto.length) {
    console.log('');
    console.log(`## 非自动可判（${notAuto.length} 条，交人工月判）`);
    for (const x of notAuto) console.log(`- ${x.name}：${x.reason}`);
  }
  console.log('');
  console.log('> 处置仍人放行：改状态/删代码走人 + 一进一出（台账维护纪律）。本报告不自动改文件。');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
