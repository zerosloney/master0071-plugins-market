// judgment-ledger.mjs — check-loop 判定流水落账（judgment-ledger，灰度消费端数据底座）
// 背景：mechanism-registry 月度对账原为「人工 grep check-loop 输出」；advisory→hard 升格与退役判定
// 均缺 per-rule 判定流水（时间戳+结论）。本模块把每次 check-loop 真实运行追加为一行 per-rule 计数
// 到 .agents/judgments.jsonl（本地，gitignore——同 verifications.jsonl「本机机器事实不跨机共享」口径）。
// 消费：node <插件根>/scripts/agg-judgments.mjs（月度×规则计数）；mechanism-registry 月度对账直接查账。
// 诚实边界：非签名链（同 verify-evidence）——本地追加可被改，事后对质靠 git 历史与确认台账。
// fail-open：落账失败只打 stderr，不改变门禁裁决（观测面不得挡住裁决面）。
// dismiss 面（2026-11 误拦遥测）：--dismiss <规则名> --reason <一句话>（CLI）/ recordDismiss（库）——
// 人工登记动作：agent 被门禁拦下而判定「不该拦」后，由人或 agent 代登记一条 kind:"dismiss" 行
// （规则名+原因+ts+rev 锚），落 judgments 同库（同 appendFileSync 追加路径，无新文件新锁），不自动触发。
// 三态：缺规则名/缺 reason 拒（fail-closed——登记动作垃圾进=账被污染，与 recordRun 的门禁 fail-open
// 语义相反：登记必须真实落账，写盘失败向上 throw 不静默丢）；规则名不在账内（无命中也无 dismiss）
// → stderr 警告从权（照登不误——dismiss 可先于本机命中出现，如换机场景，typo 风险交警告由人眼把关）。
// 消费：agg-judgments 误拦面（误拦率 = dismiss/(命中+dismiss)）与 --retire-candidates 候选旁注。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GIT } from './git-core.mjs';
import { readAllJudgments } from './agg-judgments.mjs';
import { resolveProjectRoot, ledgerRefusal, testAnyRootAllowed } from './paths.mjs';

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
    // 统一走 git-core 的 GIT 常量（Windows 上 'git.exe'）——裸 'git' 在部分受限环境解析不到可执行文件，
    // 会让 rev 恒为 null（观测面静默降级）。与仓内其余 git 调用同口径。
    const r = spawnSync(GIT, ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
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

// knownRuleSet(root)：账内出现过的规则名（命中行 rules ∪ dismiss 行/合并行 dismissals，本地 ∪ 分片）——
// dismiss 的 universe 判定单源（与 agg-judgments --retire-candidates 的 universe 同口径：账内出现过的规则）。
function knownRuleSet(root) {
  const set = new Set();
  for (const row of readAllJudgments(root).rows) {
    for (const r of Array.isArray(row.rules) ? row.rules : []) {
      if (r && typeof r.rule === 'string') set.add(r.rule);
    }
    for (const d of Array.isArray(row.dismissals) ? row.dismissals : []) {
      if (d && typeof d.rule === 'string') set.add(d.rule);
    }
  }
  return set;
}

// recordDismiss({ root, rule, reason, now })：人工登记一条误拦（kind:"dismiss"，append-only 同库）。
// 返回 { ok:true, unknown, rule, path }；缺规则名/缺 reason throw（fail-closed）；规则名不在账内 →
// stderr 警告一行后照登（从权）；写盘失败向上 throw（登记动作不许静默丢——与 recordRun 的 fail-open 相反）。
export function recordDismiss({ root, rule, reason, now = new Date() }) {
  const name = String(rule ?? '').trim();
  const why = String(reason ?? '').trim();
  if (!name) throw new Error('缺规则名——dismiss 须指明被误拦的规则');
  if (!why) throw new Error(`缺 reason——误拦登记必须带一句话原因（无因登记不入账；规则「${name}」）`);
  let unknown = false;
  try {
    unknown = !knownRuleSet(root).has(name);
    if (unknown) {
      console.error(`judgment-ledger: 规则「${name}」在 judgments 账内无命中记录（未知规则名）——照登不误（从权）；请核对拼写，typo 的 dismiss 会给不存在的规则记误拦`);
    }
  } catch { /* 账读不到不拦登记（universe 判定尽力而为，落账本身不受影响） */ }
  const row = {
    ts: now.toISOString(),
    kind: 'dismiss',
    rule: name,
    reason: why,
    rev: shortRev(root), // 注册时点锚（可选 root 锚：git 仓内为短 rev，否则 null）
  };
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.appendFileSync(path.join(root, LEDGER_REL), `${JSON.stringify(row)}\n`);
  return { ok: true, unknown, rule: name, path: path.join(root, LEDGER_REL) };
}

// ---- CLI 面（人工登记误拦；写侧 fail-closed 与 confirm-doc 同口径：须在使用项目的 git 仓库内运行）----
// 用法：node <插件根>/scripts/judgment-ledger.mjs --dismiss <规则名> --reason <一句话> [--root <仓库根>]
const isMain = process.argv[1] && process.argv[1].endsWith('judgment-ledger.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--dismiss')) {
    console.error('judgment-ledger: 缺 --dismiss。用法：node judgment-ledger.mjs --dismiss <规则名> --reason <一句话> [--root <仓库根>]');
    process.exit(2);
  }
  // 取 --k <值>：值缺省 / 值是另一个旗标 → 返回空串（交给 recordDismiss 校验拒掉）
  const val = (k) => {
    const p = argv.indexOf(k);
    if (p < 0) return null;
    const v = argv[p + 1];
    return v && !String(v).startsWith('--') ? v : '';
  };
  const explicit = val('--root');
  const probe = resolveProjectRoot(explicit ? path.resolve(explicit) : process.cwd());
  if (!probe.root && !testAnyRootAllowed()) {
    console.error(`judgment-ledger: ❌ ${ledgerRefusal(probe.status, probe.detail)}`);
    console.error('   hint: 在使用项目的 git 仓库内运行，或用 --root <仓库根> 显式指定（须在 git 仓库内）。');
    process.exit(2);
  }
  try {
    const r = recordDismiss({ root: probe.root, rule: val('--dismiss') ?? '', reason: val('--reason') ?? '' });
    console.log(`✅ dismiss 已落账：规则「${r.rule}」→ ${path.relative(probe.root, r.path)}（append-only 追加${r.unknown ? '；账内无此规则命中记录，已按从权照登' : ''}）`);
    console.log('   误拦面查看：node scripts/agg-judgments.mjs（误拦率 = dismiss/(命中+dismiss)）');
  } catch (err) {
    console.error(`judgment-ledger: ${err.message}`);
    console.error('   用法：node judgment-ledger.mjs --dismiss <规则名> --reason <一句话> [--root <仓库根>]');
    process.exit(2);
  }
}
