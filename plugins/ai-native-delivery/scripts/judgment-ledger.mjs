// judgment-ledger.mjs — check-loop 判定流水落账（judgment-ledger，灰度消费端数据底座）
// 背景：mechanism-registry 月度对账原为「人工 grep check-loop 输出」；advisory→hard 升格与退役判定
// 均缺 per-rule 判定流水（时间戳+结论）。本模块把每次 check-loop 真实运行追加为一行 per-rule 计数
// 到 .agents/judgments.jsonl（本地，gitignore——同 verifications.jsonl「本机机器事实不跨机共享」口径）。
// 消费：node .agents/scripts/agg-judgments.mjs（月度×规则计数）；mechanism-registry 月度对账直接查账。
// 诚实边界：非签名链（同 verify-evidence）——本地追加可被改，事后对质靠 git 历史与确认台账。
// fail-open：落账失败只打 stderr，不改变门禁裁决（观测面不得挡住裁决面）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LEDGER_REL = path.join('.agents', 'judgments.jsonl');

// tallyJudgments(entries)：'- [标签] …' → {rule:标签(剥严重度前缀), level:按来源数组}；
// 无括号标签行 → {rule:'未标注', level:按来源}。输出按 rule 字典序的 {rule,level,count} 数组（确定性，测试可断言）。
// 严重度以来源数组为准（blockers 侧恒 BLOCK、warnings 侧恒 WARN）——与 check-loop.mjs 的退出码依据同源
// （判读与判定分离：标签只命名规则，不改判定）。
// 规则名归一（2026-10-22 门禁收敛批 3）：剥除段体自定义的严重度前缀（WARN / NOTE）——否则同一逻辑
// 规则因前缀写法不同被拆成两条 rule，污染 per-rule 计数与「连续 6 月 = 0」退役候选判据
// （实证：s27 的「[NOTE 回归清单临时脚本缺失]」以带 NOTE 的全名落账 114 次，与无前缀写法分裂）。
export function tallyJudgments(blockers = [], warnings = []) {
  const tally = new Map();
  const add = (raw, fallbackLevel) => {
    const m = String(raw).match(/^\s*-\s*\[([^\]]+)\]/);
    let rule = '未标注';
    const level = fallbackLevel;
    if (m) {
      const tag = m[1].trim();
      rule = tag.replace(/^(?:WARN|NOTE)\b\s*/, '');
    }
    const key = `${level}\u0000${rule}`;
    const cur = tally.get(key) || { rule, level, count: 0 };
    cur.count++;
    tally.set(key, cur);
  };
  for (const b of blockers || []) add(b, 'BLOCK');
  for (const w of warnings || []) add(w, 'WARN');
  return [...tally.values()].sort((a, b) => (a.level + a.rule).localeCompare(b.level + b.rule));
}

const shortRev = (root) => {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() || null : null;
  } catch {
    return null;
  }
};

// recordRun({ root, mode, blockers, warnings, now })：追加一行运行判定；守卫 fixture（CHECK_LOOP_ROOT）
// 与显式关闭（CHECK_LOOP_NO_LEDGER）；任何失败 fail-open（stderr 一行，不 throw、不改 exit code）。
export function recordRun({ root, mode, blockers, warnings, now = new Date() }) {
  try {
    if (process.env.CHECK_LOOP_ROOT || process.env.CHECK_LOOP_NO_LEDGER) return;
    const row = {
      ts: now.toISOString(),
      mode: mode || 'hard',
      rev: shortRev(root),
      blockers: (blockers || []).length,
      warnings: (warnings || []).length,
      rules: tallyJudgments(blockers, warnings),
    };
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.appendFileSync(path.join(root, LEDGER_REL), `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error(`judgment-ledger: 落账失败（不阻断门禁）——${err.code || err.message}`);
  }
}
