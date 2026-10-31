// 用法:node <插件根>/scripts/check-loop.mjs [--rev <sha>] [--all | --hygiene]
// 默认（2026-10-10 收敛）：只跑硬门 §1 §3 §3x §8 §14 §15 §17；2026-10-11 起含 §23；
// 2026-10-12 起含 §25（路由预判一致性，纯 WARN advisory——预判字段在场才检，缺字段零告警）。
// 2026-10-21 门禁极小化第 1 批：§17 退役删除；§1 配对/L3 三件、§3 配对/回路、§14 留痕降 WARN——
//   段仍在 hard 车道默认跑，但只报告不阻断（红线判低/L3 状态例外，保 hard 阻断）；hard 阻断面 =
//   红线判低(§1) + L3 状态(§1) + 回归证据(§3x) + 验收勾验(§8) + 确认指纹(§15) + 收敛对账(§23)。
// 2026-10-22 门禁收敛批 1：§3 三件套、§14 留痕、§25 路由预判三段由 hard 车道下沉 hygiene——
//   实测三段 blockers.push 均为 0（427 次 hard 运行产出 419 次 WARN、0 次阻断），占着默认关单/
//   pre-push 车道却从不拦任何东西；承载力已前移到动作时刻（§3 → closeout skill §0 第 2 项；
//   §14 → confirm-doc/stage-gates 落态前置门），下沉不丢校验，只改何时跑。
//   hard 车道现存 5 段 = §1 §3x §8 §15 §23（全部有阻断力）；hygiene 车道 17 段（含 §25——
//   其可见性依赖 --hygiene 被人工/项目自定期运行——本插件无 loop-watch 自动接线，不随 git hooks 跑）。
// 2026-10-22 门禁收敛批 4：§20 已退役（挂载条件为包源环境，本仓恒不触发）。编号留疤不重排。
// 2026-10-23 P1：§28 消费端脚本覆盖对账（hygiene）——按本仓 .agents/scripts 真实面重判覆盖，
//   替代 §20 的包源判据；豁免表 .agents/config/scripts-test-exempt.txt。
// 2026-10-22 门禁收敛批 3：judgment-ledger 规则名归一（剥 WARN/NOTE 严重度前缀）——同一逻辑规则
//   因前缀写法不同被拆成两条 rule，污染 per-rule 计数与「连续 6 月 = 0」退役候选判据（实证 s27 的
//   「NOTE 回归清单临时脚本缺失」以带前缀的全名落账 114 次，与无前缀写法分裂）。
// 2026-10-22 门禁收敛批 2「信噪比」：advisory 告警（WARN/NOTE）按标签折叠输出（同类多行折为
//   「×N 条同类」单行，明细落 tmp/check-loop-warn.log）——**BLOCK 一律不折**；无标签条目逐条输出。
//   折叠只改呈现不改判据；实现见 warn-format.mjs + warn-format.test.mjs（S1-S7 锁住折叠规则）。
// 现状（2026-10-23）：22 段 = hard 5（§1 §3x §8 §15 §23）+ hygiene 17（§28 脚本覆盖对账为 P1 新增）；
//   段数棘轮见 .agents/config/rule-budgets.txt（check-loop-sections 计数上限 22，退役一段同降一）。
// --hygiene 只跑卫生段（索引/宿主/词表/指标签名/委派等 WARN）。--all 两段都跑。
// 测试:node <插件根>/test/check-loop.test.mjs（fixture 注入 CHECK_LOOP_ROOT；套件默认 --all）
import * as kit from './check-loop-kit.mjs';
import { formatWarnings, WARN_LOG_REL } from './warn-format.mjs';
import { recordRun } from './judgment-ledger.mjs';
import { scriptPath } from './paths.mjs';

// 基础设施解构铺平（4a）：段体自单文件时代逐字保留，名字由本解构供给——零漂移迁移
const {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} = kit;

import { run as s01_pairing } from './check-loop-sections/s01-pairing.mjs';
import { run as s02_templates } from './check-loop-sections/s02-templates.mjs';
import { run as s03_incidents } from './check-loop-sections/s03-incidents.mjs';
import { run as s04_refs } from './check-loop-sections/s04-refs.mjs';
import { run as s05_adapters } from './check-loop-sections/s05-adapters.mjs';
import { run as s03x_regr_evidence } from './check-loop-sections/s03x-regr-evidence.mjs';
import { run as s08_acceptance } from './check-loop-sections/s08-acceptance.mjs';
import { run as s09_kebab } from './check-loop-sections/s09-kebab.mjs';
import { run as s10_migration } from './check-loop-sections/s10-migration.mjs';
import { run as s14_approved_trace } from './check-loop-sections/s14-approved-trace.mjs';
import { run as s15_fingerprint } from './check-loop-sections/s15-fingerprint.mjs';
import { run as s16_metric_claims } from './check-loop-sections/s16-metric-claims.mjs';
// §17 已退役（2026-10-21 门禁极小化第 1 批，恒不触发）：段体删除，编号留疤（不重排）。
import { run as s18_delegations } from './check-loop-sections/s18-delegations.mjs';
import { run as s19_stage_audit } from './check-loop-sections/s19-stage-audit.mjs';
// §20 已退役（2026-10-22 门禁收敛批 4，恒不触发）：段体+测试+豁免表已删除，编号留疤（不重排）。
import { run as s21_spec_verif } from './check-loop-sections/s21-spec-verif.mjs';
import { run as s22_registry } from './check-loop-sections/s22-registry.mjs';
import { run as s23_convergence_audit } from './check-loop-sections/s23-convergence-audit.mjs';
import { run as s24_incident_attribution } from './check-loop-sections/s24-incident-attribution.mjs';
import { run as s25_prejudgment } from './check-loop-sections/s25-prejudgment.mjs';
import { run as s26_funnel_action } from './check-loop-sections/s26-funnel-action.mjs';
import { run as s27_regression_consistency } from './check-loop-sections/s27-regression-consistency.mjs';
import { run as s28_script_coverage } from './check-loop-sections/s28-script-coverage.mjs';

// 顺序 = 原单文件段序。lane：hard = 默认关单/pre-push（只放有阻断力的段——2026-10-22 批 1 后
//   车道与阻断级别对齐，§3/§14/§25 因零阻断力下沉 hygiene）；hygiene = --hygiene / --all。
// 编号是承重引用（2026-10-11 D3 定案）：§N 被 policy 锚名（check14Since）、机制台账「门禁位置」列、
// wiki 车道表、judgments rule 串跨文件引用——§7 空缺与 §3x 插号为历史疤，永不重编号（重编号=打断引用图）。
const SECTIONS = [
  { lane: 'hard', run: s01_pairing },
  { lane: 'hygiene', run: s02_templates },
  { lane: 'hygiene', run: s03_incidents },
  { lane: 'hygiene', run: s04_refs },
  { lane: 'hygiene', run: s05_adapters },
  { lane: 'hard', run: s03x_regr_evidence },
  { lane: 'hard', run: s08_acceptance },
  { lane: 'hygiene', run: s09_kebab },
  { lane: 'hygiene', run: s10_migration },
  { lane: 'hygiene', run: s14_approved_trace },
  { lane: 'hard', run: s15_fingerprint },
  { lane: 'hygiene', run: s16_metric_claims },
  { lane: 'hygiene', run: s18_delegations },
  { lane: 'hygiene', run: s19_stage_audit },
  { lane: 'hygiene', run: s21_spec_verif },
  { lane: 'hygiene', run: s22_registry },
  { lane: 'hard', run: s23_convergence_audit },
  { lane: 'hygiene', run: s24_incident_attribution },
  { lane: 'hygiene', run: s25_prejudgment },
  { lane: 'hygiene', run: s26_funnel_action },
  { lane: 'hygiene', run: s27_regression_consistency },
  { lane: 'hygiene', run: s28_script_coverage },
];
for (const section of SECTIONS) {
  if (kit.LOOP_MODE === 'all' || section.lane === kit.LOOP_MODE) section.run();
}
// --- 判定流水落账（judgment-ledger，灰度消费端数据底座）---
// 每次真实运行追加一行 per-rule 判定计数到 .agents/judgments.jsonl（本地 gitignore；fixture 经
// CHECK_LOOP_ROOT 守卫自动跳过）——mechanism-registry 月度对账与 advisory→hard 升格判定的数据源
// 由「人工 grep 输出」升级为 agg-judgments.mjs 查账。fail-open：落账失败不改变门禁裁决与输出契约。
recordRun({ root: ROOT, mode: kit.LOOP_MODE, blockers, warnings });
// --- 输出（banner 沿 sh 版格式 = 稳定输出契约：banner 后空行、条目 '- ' 前缀；文件名自称用 check-loop.mjs）---
// 告警聚合（2026-10-22 门禁收敛批 2「信噪比」）：**折 advisory（WARN / NOTE），一律不折 BLOCK**。
// 动机（实测）：一次 --all 跑出 17 条 WARN + 19 条 NOTE，其中同类多行 + 多行告警把 actionable 项淹掉——
// 告警不精确比告警多更伤，输出一旦不可读，门禁即退化形式。折叠后逐条明细仍完整落
// tmp/check-loop-warn.log（供排障与事后对质），不丢信息、不降判据。
// 开关口径：只在「真引擎自跑」时折叠——判据取**本项目实际会跑的**引擎脚本本体是否存在：
//   scriptPath(ROOT, 'check-loop.mjs') 项目侧副本优先、回退插件内本体（paths.mjs 单源）。
//   此前判据写死 ROOT/.agents/scripts/check-loop.mjs → 插件形态下该路径恒不存在 → 恒 false →
//   「门禁收敛批 2」的折叠对插件用户永不触发（信噪比机制整族失效）。
//   CHECK_LOOP_VERBOSE=1 强制逐条（排障用；测试夹具也用它把告警保持在逐条形态，断言不依赖折叠）。
// 实现落位：warn-format.mjs——本文件无 isMain 守卫（被 import 即全量执行并 exit），
// 聚合逻辑不可在此直接单测；抽成无副作用模块后由 warn-format.test.mjs 锁住折叠规则（S1-S7）。
const WARN_LOG = path.join(ROOT, 'tmp', 'check-loop-warn.log');
const selfRun = fs.existsSync(scriptPath(ROOT, 'check-loop.mjs'));
const compactOn = selfRun && process.env.CHECK_LOOP_VERBOSE !== '1';
const renderWarnings = (list) => formatWarnings(list, { enabled: compactOn, logPath: WARN_LOG, logNote: WARN_LOG_REL });
if (blockers.length) {
  process.stderr.write(`闭环骨架断档（check-loop.mjs）— HARD-BLOCK:\n\n${blockers.join('\n')}\n\n`);
  if (warnings.length) process.stderr.write(`WARN（advisory,不阻断）:\n\n${renderWarnings(warnings)}\n`);
  process.exit(1);
}
if (warnings.length) {
  process.stderr.write(`check-loop.mjs WARN（advisory,不阻断）:\n\n${renderWarnings(warnings)}\n`);
}
process.exit(0);
