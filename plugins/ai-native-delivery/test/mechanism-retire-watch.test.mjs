#!/usr/bin/env node
// mechanism-retire-watch.test.mjs — 1b 机制退役催办纯函数套件（2026-10-14 L5 自举接线 1b）
// parseRegistry / ruleNamesOf / zeroMonthsOf / evaluate 进程内断言。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRegistry, ruleNamesOf, zeroMonthsOf, evaluate, statusOf, tagOf, STATUSES, registryCandidates, readRegistryText, srcOf } from '../scripts/mechanism-retire-watch.mjs';
import { mergeJudgmentRows, retireCandidates } from '../scripts/agg-judgments.mjs'; // S16 两侧对账断言

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, '..', 'scripts', 'mechanism-retire-watch.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

// ---- S1 parseRegistry ----
{
  const text = [
    '| 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |',
    '|---|---|---|---|---|---|---|',
    '| 甲门 | check-loop §1 | WARN「甲规则」计数（月） | 连续 6 月 = 0 → 评估退役 | 2026-10 在用 | 现役 | — |',
    '| 乙门 | check-loop §2 | hard 计数 | 不退役（主干） | 2026-10 | 现役 | — |',
    '| 丙门 | check-loop §3 | WARN 计数 | 连续 6 月 = 0 | 2026-10 | 待退役 | 2026-01-01 |',
    '| 坏行 | 少列 |',
  ].join('\n');
  const rows = parseRegistry(text);
  check('S1 只取 7 列数据行（表头/分隔/坏行剔除）', rows.length === 3, String(rows.length));
  check('S1 列序正确', rows[0].name === '甲门' && rows[0].status === '现役' && rows[0].deadline === '—', JSON.stringify(rows[0]));
  check('S1 待退役行期限解析', rows[2].status === '待退役' && rows[2].deadline === '2026-01-01');
}

// ---- S1b parseRegistry：状态列带机制类型标记（2026-10-22 收敛）----
// 状态列允许在值后追加 `[检出型]` / `[健康静默]` / `[不退役主干]` / `[数据面]` 标记；
// 标记只用于月度对账分流，不参与状态判定——解析层统一剥离。此前三个消费者各自精确比对
// 状态列，标记上线后同时失配（检查 22 产出 35 条纯噪声、生成器写出「现役 0」）。
{
  const text = [
    '| 机制 | 门禁位置 | 触发统计口径 | 退役阈值 | 最近触发 | 状态 | 处置期限 |',
    '|---|---|---|---|---|---|---|',
    '| 甲门 | check-loop §1 | WARN 计数 | 连续 6 月 = 0 | 2026-10 | 现役 [检出型] | — |',
    '| 乙门 | check-loop §4 | WARN 计数 | 不适用 | 2026-10 | 现役 [健康静默] | — |',
    '| 丙门 | check-loop §8 | hard 计数 | 不退役 | 2026-10 | 现役 [不退役主干] | 复评 2027-01-21 |',
    '| 丁门 | metrics | 数据计数 | 6 有数据月 = 0 | 2026-10 | 现役 [数据面] | — |',
    '| 戊门 | check-loop §5 | WARN 计数 | — | 2026-10 | 待退役 [检出型] | 2026-01-01 |',
    '| 己门 | check-loop §9 | WARN 计数 | — | 2026-10 | 已退役 | — |',
  ].join('\n');
  const rows = parseRegistry(text);
  check('S1b 六行全解析', rows.length === 6, String(rows.length));
  check('S1b 标记不参与状态判定——现役 4 行', rows.filter((r) => r.status === '现役').length === 4, JSON.stringify(rows.map((r) => r.status)));
  check('S1b 待退役带标记仍识别', rows[4].status === '待退役' && rows[4].tag === '检出型', JSON.stringify(rows[4]));
  check('S1b 已退役无标记', rows[5].status === '已退役' && rows[5].tag === '', JSON.stringify(rows[5]));
  check('S1b statusRaw 保留原样供报错定位', rows[0].statusRaw === '现役 [检出型]', rows[0].statusRaw);
  check('S1b 四种标记全部提取', rows.slice(0, 4).map((r) => r.tag).join(',') === '检出型,健康静默,不退役主干,数据面', JSON.stringify(rows.slice(0, 4).map((r) => r.tag)));
  check('S1b statusOf 幂等（已剥离值再剥离不变）', statusOf('现役') === '现役' && statusOf('现役 [检出型]') === '现役');
  check('S1b STATUSES 闭集', STATUSES.join(',') === '现役,待退役,已退役', STATUSES.join(','));
}

// ---- S2 ruleNamesOf ----
check('S2 单规则名', ruleNamesOf('WARN「模板未填」计数（月）').join(',') === '模板未填');
check('S2 斜杠分隔多规则', ruleNamesOf('WARN「预判类型不符/预判级别不符/预判字段不可解析」计数').join(',') === '预判类型不符,预判级别不符,预判字段不可解析');
check('S2 无「」→ 空', ruleNamesOf('hard/WARN 计数（月）').length === 0);

// ---- S3 zeroMonthsOf ----
check('S3 连续 6 月 = 0', zeroMonthsOf('连续 6 月 = 0 → 评估退役') === 6);
check('S3 带前缀仍解析', zeroMonthsOf('WARN 命中连续 6 月 = 0 且新增预判字段停滞 → 评估退役') === 6);
check('S3 非零阈值形态 → null', zeroMonthsOf('不退役（防伪主干）') === null);
check('S3 使用率型 → null', zeroMonthsOf('<10% 且无新增 → 退役双协议') === null);

// ---- S4 evaluate：阈值触达 ----
{
  const reg = [{ name: '甲门', criterion: 'WARN「甲规则」计数', threshold: '连续 2 月 = 0 → 评估退役', status: '现役', deadline: '—' }];
  const j = [
    { ts: '2026-08-01T00:00:00Z', rules: [{ rule: '甲规则', level: 'WARN', count: 0 }] },
    { ts: '2026-09-01T00:00:00Z', rules: [] },
  ];
  const r = evaluate(reg, j, new Date('2026-10-14'));
  check('S4 连续 2 月零触发 → 动作项', r.actions.length === 1 && r.actions[0].kind === 'threshold', JSON.stringify(r.actions));
  check('S4 动作项含窗口与规则名', /2026-08 \/ 2026-09/.test(r.actions[0].detail) && /甲规则/.test(r.actions[0].detail), r.actions[0].detail);
}

// ---- S5 evaluate：窗口内有触发 → 不产动作项 ----
{
  const reg = [{ name: '甲门', criterion: 'WARN「甲规则」计数', threshold: '连续 2 月 = 0', status: '现役', deadline: '—' }];
  const j = [
    { ts: '2026-08-01T00:00:00Z', rules: [{ rule: '甲规则', level: 'WARN', count: 1 }] },
    { ts: '2026-09-01T00:00:00Z', rules: [] },
  ];
  const r = evaluate(reg, j, new Date('2026-10-14'));
  check('S5 窗口内命中 → 无动作项', r.actions.length === 0, JSON.stringify(r.actions));
}

// ---- S6 evaluate：数据不足 / 无规则名 → notAuto ----
{
  const reg = [
    { name: '甲门', criterion: 'WARN「甲规则」计数', threshold: '连续 6 月 = 0', status: '现役', deadline: '—' },
    { name: '乙门', criterion: 'hard 计数', threshold: '连续 6 月 = 0', status: '现役', deadline: '—' },
    { name: '丙门', criterion: 'WARN「丙规则」计数', threshold: '不退役（主干）', status: '现役', deadline: '—' },
  ];
  const j = [{ ts: '2026-09-01T00:00:00Z', rules: [] }];
  const r = evaluate(reg, j, new Date('2026-10-14'));
  check('S6 数据不足 → notAuto', r.notAuto.some((x) => x.name === '甲门' && /数据不足/.test(x.reason)), JSON.stringify(r.notAuto));
  check('S6 无规则名 → notAuto', r.notAuto.some((x) => x.name === '乙门' && /未列规则名/.test(x.reason)));
  check('S6 非零阈值形态 → notAuto', r.notAuto.some((x) => x.name === '丙门' && /非「连续/.test(x.reason)));
  check('S6 无动作项', r.actions.length === 0);
}

// ---- S7 evaluate：待退役逾期 / 缺期限 ----
{
  const reg = [
    { name: '甲门', criterion: '', threshold: '', status: '待退役', deadline: '2026-01-01' },
    { name: '乙门', criterion: '', threshold: '', status: '待退役', deadline: '下批次' },
    { name: '丙门', criterion: '', threshold: '', status: '已退役', deadline: '—' },
  ];
  const r = evaluate(reg, [], new Date('2026-10-14'));
  check('S7 逾期 → overdue', r.actions.some((a) => a.kind === 'overdue' && a.name === '甲门'), JSON.stringify(r.actions));
  check('S7 非日期期限 → no-deadline', r.actions.some((a) => a.kind === 'no-deadline' && a.name === '乙门'));
  check('S7 已退役行跳过', !r.actions.some((a) => a.name === '丙门'));
}
// ---- S7b：期限当天不逾期（本地日，不当天 08:00 后提前催）----
{
  const reg = [{ name: '甲门', criterion: '', threshold: '', status: '待退役', deadline: '2026-10-14' }];
  const now = new Date(2026, 9, 14, 9, 0, 0);
  const r = evaluate(reg, [], now);
  check('S7b 期限当天本地 09:00 不逾期', r.actions.length === 0, JSON.stringify(r.actions));
}
// ---- S4b（2026-11 统一口径改判）：窗口内缺月按零命中计，不再「缺月拒绝判定」----
// 旧口径与 agg-judgments 的「末 N 个数据月」双口径：同一句「连续 N 月 = 0」同数据两种结论
// （本例旧 agg 判候选、旧 retire-watch 拒判）。统一为日历窗口（锚 = 末个有数据月，含无数据月）
// 后：锚 10、窗 [09,10]，9 月无运行按零计 → 2 月窗触达；停摆误判由新鲜度守卫另挡（S15）。
{
  const reg = [{ name: '甲门', criterion: 'WARN「甲规则」计数', threshold: '连续 2 月 = 0 → 评估退役', status: '现役', deadline: '—' }];
  const j = [
    { ts: '2026-08-01T00:00:00Z', rules: [] },
    { ts: '2026-10-01T00:00:00Z', rules: [] },
  ];
  const r = evaluate(reg, j, new Date('2026-10-14T00:00:00Z'));
  check('S4b 缺 9 月按零命中计 → [09,10] 日历窗触达 → threshold 动作',
    r.actions.length === 1 && r.actions[0].kind === 'threshold', JSON.stringify(r.actions));
  check('S4b 动作明细含日历窗 2026-09 / 2026-10', r.actions.length === 1 && /2026-09 \/ 2026-10/.test(r.actions[0].detail), r.actions[0]?.detail);
  check('S4b 不再以「缺月」拒绝判定', !r.notAuto.some((x) => x.name === '甲门' && /缺月/.test(x.reason)), JSON.stringify(r.notAuto));
}

// ---- S8 空入参 ----
check('S8 空台账 → 无动作项', evaluate([], [], new Date()).actions.length === 0);
check('S8 null judgments 不 throw', evaluate([], null, new Date()).actions.length === 0);


// ---- S9：owner-fiat 复评到期（W5 惯例，2026-10-21 第 3 批规则④）----
{
  const mk = (deadline) => [{ name: '乙门', criterion: '', threshold: '不退役（主干）', status: '现役', deadline }];
  const due = evaluate(mk('复评 2026-10-01'), [], new Date('2026-10-21T00:00:00Z'));
  check('S9 复评期已过 → revisit 动作项（含复评字样与日期）',
    due.actions.length === 1 && due.actions[0].kind === 'revisit' && /复评期 2026-10-01/.test(due.actions[0].detail),
    JSON.stringify(due.actions));
  const notYet = evaluate(mk('复评 2027-01-21'), [], new Date('2026-10-21T00:00:00Z'));
  check('S9 复评期未到 → 零动作', notYet.actions.length === 0, JSON.stringify(notYet.actions));
  const sameDay = evaluate(mk('复评 2026-10-21'), [], new Date(2026, 9, 21, 9, 0, 0));
  check('S9 复评期当天不催（本地日口径，同 S7b）', sameDay.actions.length === 0, JSON.stringify(sameDay.actions));
  const plain = evaluate(mk('—'), [], new Date('2026-10-21T00:00:00Z'));
  check('S9 无复评标注的现役行不受影响', plain.actions.length === 0, JSON.stringify(plain.actions));
}

// ---- S10 模型代际重评：A 组机制 → revisit-model 动作项 --------------------------
{
  const reg = [
    { name: '三件套同名配对', criterion: '', threshold: '', status: '现役', deadline: '—' },
    { name: '路由预判一致性', criterion: '', threshold: '', status: '现役', deadline: '—' },
  ];
  const changed = evaluate(reg, [], new Date('2026-10-22T00:00:00Z'), { modelBaseline: 'GLM-4.x', model: 'GLM-5.x' });
  check('S10 代际变更 → A 组产生 revisit-model 动作项',
    changed.actions.filter((a) => a.kind === 'revisit-model').length === 2,
    JSON.stringify(changed.actions));
  check('S10 动作项含代际对与组别',
    /GLM-4\.x → GLM-5\.x/.test(changed.actions[0].detail) && /A 组/.test(changed.actions[0].detail),
    JSON.stringify(changed.actions));
}

// ---- S11 模型代际重评：C 组机器判据免评（未列入分组）→ 无 revisit-model -------
{
  const reg = [
    { name: '引用有效性', criterion: '', threshold: '', status: '现役', deadline: '—' },
    { name: '文件名 kebab-case', criterion: '', threshold: '', status: '现役', deadline: '—' },
  ];
  const free = evaluate(reg, [], new Date('2026-10-22T00:00:00Z'), { modelBaseline: 'GLM-4.x', model: 'GLM-5.x' });
  check('S11 C 组机器判据代际免评 → 无 revisit-model',
    free.actions.filter((a) => a.kind === 'revisit-model').length === 0,
    JSON.stringify(free.actions));
}

// ---- S12 模型未变更（model === modelBaseline）→ 无 revisit-model --------------
{
  const reg = [
    { name: '三件套同名配对', criterion: '', threshold: '', status: '现役', deadline: '—' },
  ];
  const same = evaluate(reg, [], new Date('2026-10-22T00:00:00Z'), { modelBaseline: 'GLM-4.x', model: 'GLM-4.x' });
  check('S12 模型未变更 → 无 revisit-model', same.actions.length === 0, JSON.stringify(same.actions));
}

// ---- S13 缺 modelBaseline 或 model → 无 revisit-model --------------------------
{
  const reg = [
    { name: '三件套同名配对', criterion: '', threshold: '', status: '现役', deadline: '—' },
  ];
  const noBase = evaluate(reg, [], new Date('2026-10-22T00:00:00Z'), { modelBaseline: '', model: 'GLM-5.x' });
  const noModel = evaluate(reg, [], new Date('2026-10-22T00:00:00Z'), { modelBaseline: 'GLM-4.x', model: '' });
  check('S13 缺基线或当前模型 → 无 revisit-model', noBase.actions.length === 0 && noModel.actions.length === 0,
    JSON.stringify({ noBase: noBase.actions, noModel: noModel.actions }));
}

// ---- S14 月度分片参与退役判据（gate-metrics-shard 2026-10-22）----
// 本地台账只有 2026-03 命中；分片提供 2026-04..09 六个有数据月（空规则）→ 窗口内零命中 → threshold 动作。
{
  const local = [{ ts: '2026-03-15T00:00:00Z', rules: [{ rule: '规则甲', level: 'WARN', count: 2 }] }];
  const shards = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((ym) => ({
    ts: `${ym}-01T00:00:00.000Z`, rules: [],
  }));
  const rows = mergeJudgmentRows(local, shards);
  const reg = [{ name: '测试机制', criterion: '「规则甲」', threshold: '连续 6 月 = 0 → 评估退役', status: '现役', deadline: '—' }];
  const r = evaluate(reg, rows, new Date('2026-10-01T00:00:00Z'));
  check('S14 分片月计入数据月（6 月窗口零命中 → threshold）',
    r.monthCount === 7 && r.actions.some((a) => a.kind === 'threshold'), JSON.stringify(r));
}

// ---- S15 新鲜度守卫（2026-11 统一口径）：锚月距今超过 RETIRE_STALE_MONTHS → 遥测陈旧不产候选 ----
// 旧口径：停摆数月后锚月仍取末个有数据月照凑日历窗（缺月挡了一下），但「数据月连续且停摆」的
// 形态（分片月一直在归档、近几月断了）会照产候选。统一后：锚月距「今」超半径 → notAuto 遥测陈旧。
{
  const reg = [{ name: '甲门', criterion: 'WARN「甲规则」计数', threshold: '连续 2 月 = 0', status: '现役', deadline: '—' }];
  const j = [
    { ts: '2026-02-01T00:00:00Z', rules: [] },
    { ts: '2026-03-01T00:00:00Z', rules: [] },
  ];
  const r = evaluate(reg, j, new Date('2026-10-14T00:00:00Z')); // 锚 2026-03 距今 7 个月
  check('S15 遥测停摆 → notAuto「遥测陈旧」且零 threshold 动作',
    r.actions.length === 0 && r.notAuto.some((x) => x.name === '甲门' && /遥测陈旧/.test(x.reason) && /2026-03/.test(x.reason)),
    JSON.stringify(r));
}

// ---- S16 两侧对账钉住（2026-11 统一口径）：同月份数据 evaluate 与 retireCandidates 结论一致 ----
// 旧双口径下本夹具两侧各说各话（旧 agg 判候选、旧 evaluate 因缺月拒判）；统一后必须同判。
{
  const rows = [
    { ts: '2026-02-15T00:00:00Z', rules: [{ rule: '规则甲', level: 'WARN', count: 2 }] },
    { ts: '2026-03-15T00:00:00Z', rules: [] },
    { ts: '2026-06-15T00:00:00Z', rules: [] }, // 04-05 断档无运行
  ];
  const now = new Date('2026-07-01T00:00:00Z'); // 锚 2026-06 距今 1 个月 → 新鲜
  const reg = [{ name: '甲门', criterion: '「规则甲」', threshold: '连续 3 月 = 0', status: '现役', deadline: '—' }];
  const r = evaluate(reg, rows, now);
  const rc = retireCandidates(rows, 3, { now });
  check('S16 对账：evaluate 触达（threshold）且 agg 判候选——两侧同结论',
    r.actions.length === 1 && r.actions[0].kind === 'threshold' && rc.sufficient === true && rc.candidates.some((c) => c.rule === '规则甲'),
    JSON.stringify({ actions: r.actions, rc: { from: rc.windowFrom, to: rc.windowTo, candidates: rc.candidates } }));
}

// ---- S17b CLI 端到端（2026-11 F4 步骤 A 种子兜底）：无项目侧表 → 读插件种子出报告 ----
// 修复前只认项目侧 .agents/config/mechanism-registry.md 硬路径：插件仓/未初始化装户实跑
// 直接 [ERROR] 台账不存在（exit 0 假绿），机制级退役筛静默失效。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-watch-cli-'));
  const r = spawnSync(process.execPath, [CLI, '--json', '--root', tmp], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 解析失败保持 null，走 FAIL 分支 */ }
  check('S17b 无项目侧表 → CLI 不再 registry-missing（读种子出全量报告）',
    r.status === 0 && j !== null && !j.error && j.registryRows > 0,
    `exit=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- S17 registry 回退链 helper（2026-11 F4 步骤 A）：候选序 + 项目侧自治优先 ----
// s22-registry.mjs（检查 22）同样消费 registryCandidates 单源定位——本节是两侧共用的定位正证。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-watch-reg-'));
  const cands = registryCandidates(tmp);
  check('S17 候选链序：项目侧在前、插件种子在后',
    cands.length === 2 && !/config-templates/.test(cands[0]) && /config-templates/.test(cands[1]),
    JSON.stringify(cands));
  // 无项目侧表 → 种子兜底（from=seed）
  const fb = readRegistryText(tmp);
  check('S17 项目侧缺表 → 读插件种子（from=seed，可解析出数据行）',
    fb !== null && fb.from === 'seed' && parseRegistry(fb.text).length > 0,
    JSON.stringify(fb && { from: fb.from, rows: parseRegistry(fb.text).length }));
  // 项目侧在场 → 项目侧自治（init 首拷后装户改行不受种子升版侵蚀；设计稿开放问题 2 的自治语义）
  fs.mkdirSync(path.join(tmp, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.agents', 'config', 'mechanism-registry.md'),
    '| 甲门 | check-loop §1 | 「甲规则」计数 | 连续 2 月 = 0 | 2026-10 | 现役 | — |\n');
  const proj = readRegistryText(tmp);
  check('S17 项目侧在场 → 项目侧优先（from=project，不读种子）',
    proj !== null && proj.from === 'project' && parseRegistry(proj.text).length === 1,
    JSON.stringify(proj && { from: proj.from, rows: parseRegistry(proj.text).length }));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- S18 口径列证据源声明（2026-11 F4 步骤 B @src 语法）----
// 无 @src 尾缀 = judgments（既有行为零变化，S1–S17 全量回归钉住）；仅实现 @src:none；
// 其余已声明源（gate-metrics/verify）读取器未实现 → notAuto 写明理由，防静默当 judgments 处理。
{
  const now = new Date('2026-10-14T00:00:00Z');
  // @src:none → 专属 no-fuel 动作（不查 judgments、不进 notAuto 桶；kind 可过滤——B3 降噪契约：
  // verify 摘要侧只按 kind 计数不展开，本侧保证 actions[].kind === 'no-fuel' 可筛）
  const none = evaluate(
    [{ name: 'PR 体积预算', criterion: '超限 PR 计数（月） @src:none', threshold: '连续 6 月 0 超限 → 评估退役', status: '现役', deadline: '—' }],
    [], now);
  check('S18 @src:none → 专属 no-fuel 动作（judgments 为空也产，不查遥测）',
    none.actions.length === 1 && none.actions[0].kind === 'no-fuel' && none.actions[0].name === 'PR 体积预算',
    JSON.stringify(none.actions));
  check('S18 no-fuel detail 固定文案（接遥测或 owner 复评改判据 + @src:none 声明标注）',
    none.actions.length === 1 && /判据无遥测燃料/.test(none.actions[0].detail) && /@src:none/.test(none.actions[0].detail),
    none.actions[0] && none.actions[0].detail);
  check('S18 no-fuel 与 notAuto 分桶（不再「未列规则名/数据不足」糊一桶）',
    none.actions.length === 1 && none.notAuto.length === 0, JSON.stringify(none.notAuto));
  // 已声明未实现的读取器 → notAuto 带理由（不产动作、不当 judgments 判）
  const unimpl = evaluate(
    [{ name: '乙门', criterion: 'WARN「乙规则」计数 @src:gate-metrics', threshold: '连续 2 月 = 0', status: '现役', deadline: '—' }],
    [], now);
  check('S18 @src:gate-metrics → notAuto「读取器未实现」（零动作，防静默当 judgments）',
    unimpl.actions.length === 0 && unimpl.notAuto.some((x) => x.name === '乙门' && /@src:gate-metrics/.test(x.reason) && /读取器未实现/.test(x.reason)),
    JSON.stringify(unimpl));
  // srcOf 单元：默认 judgments；尾缀解析并剥离（body 供后续规则名抽取不带声明尾缀）
  check('S18 srcOf 无尾缀 → judgments（默认零变化）', srcOf('WARN「甲规则」计数（月）').src === 'judgments');
  check('S18 srcOf 尾缀解析并剥离 body', (() => {
    const r = srcOf('超限 PR 计数（月） @src:none');
    return r.src === 'none' && r.body === '超限 PR 计数（月）';
  })());
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
