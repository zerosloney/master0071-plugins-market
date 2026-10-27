// policy.mjs — check-loop 豁免锚的单源（policyVersion）
// 新豁免改 POLICIES 并升版本，不在 check-loop 里再写散落日期。
// engine.json 缺 policyVersion、或版本不在表内：回退版本 1（不启用版本 2 的 approved 锚）。
// audit 不在本表：缺省视为全量检查（已装仓库与无配置的测试夹具）；init 新装显式写 false。
import fs from 'node:fs';
import path from 'node:path';

// 基线与增量（2026-10-10 收敛系列 6）：版本表改「基线 + 显式差异」声明式构造——每版本只写
// 相对基线变化的锚，消除「全量手抄日期键、漏抄即静默改语义」的脆弱点（原 v2 注释自警）。
// 构造结果与原逐版本展开逐键相等（等价性由改造前后 JSON 深度比对钉死）；loadKitPolicy /
// gen-effective-policy 消费面零变化。版本沿革背景注释逐版本保留。
const merge = (base, over) => ({ ...base, ...over });

// ---- 基线 v1：首批五锚 ----
const V1 = {
  moduleSince: '2026-09-22',
  check14Since: '2026-09-23',
  confirmDocsEffective: '2026-09-27',
  confirmIncidentsEffective: '2026-09-28',
  bindingTs: '2026-09-28',
};

// 版本 2 = v1 + 检查 17 的 approved 锚 + 检查 19 的 stageGateSince + check14Since 后移至确认门实际上线日（2026-09-23 → 2026-09-26）。
// 漏抄日期键会改动其他检查的生效日——本表增量构造后该类错误整类消除。
const V2 = merge(V1, {
  check14Since: '2026-09-26',
  check17UnclosedAfter: '0.8.0',
  stageGateSince: '2026-09-29', // 检查 19 逐阶段审计的生效日（2026-09-30 stage-gate-machine）；锚 = 台账 ts 的 UTC 日期（复核 P2-3：本批 ts 2026-09-29T17:33Z 落在受审范围，顺序合规故静默）；v1 无此键 → 该检查整体跳过
});

// 版本 3 = v1 的五个日期，仅确认门两锚后移至装户确认纪律全量执行日（2026-10-06）。
// 背景（2026-10-06-v114-backflow-batch）：装户确认台账机制 09-27 上线但长期未运转——10-05 首次使用（demand-remain 链路），
// 同日后半夜的 pml 批次仍未过账，纪律全量执行实始于 10-06；故锚定 10-06（首用日 10-05 作废：同日边界拦不干净，装户实测）。
// 存量（< 2026-10-06）整体落入既有「存量豁免」，新档照常受管。以 v1 为基线、不夹带 v2 键激活；
// 装户经 engine.json policyVersion: 3 选入，kit 仓自身维持 v1。
const V3 = merge(V1, {
  confirmDocsEffective: '2026-10-06',
  confirmIncidentsEffective: '2026-10-06',
});

// 版本 4 = v3 + 检查 18 的 delegationSince（委派台账对账生效日）。
// 背景（loop-audit-remediation）：delegations.md 台账记法自始为「任务一句话」（全表 0 行含
// workflow 文件名），检查 18 匹配口径要求行含文件名且无生效日豁免——8 月底起的 L2/L3 存量在现口径下
// 永远无法满足，产出 113 条不可消退 advisory，违反「无判定依据的行不产出不可消除噪声」红线。
// 补锚后：日期 < delegationSince 的文档存量豁免；≥ 生效日的 L2/L3 done/fixed/closed 须在台账
// （记法约定同步补「任务一句话含文件名」，见 delegations.md 头部）。缺键（v1-v3）→ 检查 18 维持
// 原全量对账行为（向后兼容不放松）。装户经 engine.json policyVersion: 4 选入。
const V4 = merge(V3, {
  delegationSince: '2026-10-06', // 检查 18 委派台账对账生效日（2026-10-06 loop-audit-remediation）；v1-v3 无此键 → 原全量对账行为
});

// 版本 5 = v2 的全部日期 + verifySince（测试绿机器凭证生效日，verify-evidence）。
// 基准：Anthropic AI-Native SDLC「make test before done」。三处消费：verify.mjs 绿行落账（无开关，
// 纯事实记录）+ confirm-doc 置 done 门前置 advisory（24h 窗口）+ 检查 8 无 SHA 测试绿声明对账
// （intent 首次加入 git ≥ verifySince 才判）。缺键（v1-v4）→ 两处判定整体跳过，存量零新增告警。
// 注意本版本以 v2 为基线（本仓自用版本），不含 v3/v4 的装户后移锚——装户升 v5 视同同时接受
// v2 基线的早期锚（装户已选 v3/v4 的，升 v5 前 doctor 会提示锚变化，逐键核对后再升）。
const V5 = merge(V2, {
  verifySince: '2026-10-07', // 测试绿机器凭证生效日（2026-10-07 verify-evidence）；v1-v4 无此键 → 前置与对账整体跳过
});

// 版本 6 = v4 的全部日期 + verifySince + 两个新锚（2026-10-09）。
// 刻意不走 v5 的「v2 基线」：v5 会把确认门两锚回退到 09-27 且无 delegationSince（检查 18 退回全量对账，
// 复现 113 条不可消退告警）——本仓已在 v4，升级只做超集追加，逐键 = v4 ∪ {verifySince, incidentRegrSince, specVerifSince}。
// verifySince 激活 = 接受 verify-evidence 全套（verify.mjs 绿行落账 + confirm-doc done 前置
// advisory + 检查 8 测试绿声明对账）；incidentRegrSince = 检查 3 防复发验证证据门生效日（模板行 38 强制项
// 升机器门，存量豁免）；specVerifSince = 检查 21 spec 验证落地核查生效日。缺键（v1-v5）→ 对应检查跳过。
const V6 = merge(V4, {
  verifySince: '2026-10-07',
  incidentRegrSince: '2026-10-09',
  specVerifSince: '2026-10-09',
});

// 版本 7 = v6 + 检查 14 的 hard 升级锚 check14HardSince（2026-10-09）。
// 检查 14（新 done 的 spec/plan 须有 approved git 历史）自 2026-09-22 落地起恒 advisory——10-09 实时扫描
// 抓到 2 件在途 draft 直跳 done（10-08/10-09 各一件），确认环节留痕的软门正被实战绕过，升 hard。
// 锚取「发布次日」（2026-10-10，沿检查项 14 原 2026-09-23 生效先例）：当日在途件不追溯、维持 advisory
// 留痕，锚起新违例 hard-block（关单须先落 approved 单独提交再置 done——状态前置）。
// 缺键（v1–v6）→ 原 advisory 口径逐字节不变。
const V7 = merge(V6, {
  check14HardSince: '2026-10-10', // 检查 14 确认态缺失 hard 升级锚（2026-10-09）；v1–v6 无此键 → 原 advisory 口径
});

// 版本 8 = v7 + 测试绿凭证的 hard 升级锚 verifyHardSince（2026-10-09 AI-Native 架构审查修复）。
// 背景：confirm-doc 的 →done「24h 内须有 verifications.jsonl 绿行」自 verify-evidence 落地起
// 恒 advisory（灰度第一档）——而当时 verify.mjs 入口本身是坏的（语法错、台账恒空），软门无升级前提。
// 10-09 验证链修好（verify.mjs 语法错与门序修复）并首次落全绿凭证，前提成立，故升第二档：
// 锚日起置 done 无凭证即拒。
// 锚取「发布次日」（2026-10-10，与 check14HardSince 同日同则）：当日在途件不追溯、维持 advisory 留痕。
// 缺键（v1–v7）→ 原 advisory 口径逐字节不变。
const V8 = merge(V7, {
  verifyHardSince: '2026-10-10', // →done 测试绿凭证 hard 升级锚（2026-10-09 AI-Native 架构审查修复）；v1–v7 无此键 → 原 advisory 口径
});

// 版本 9 = v8 + 检查 24 的 incident 归因字段生效锚 attributionSince（incident-attribution）。
// 背景：incident 无「来源」标准字段导致「来源×环境」比例无法机器复算（深度调研核查实证：仅 2 件 vs ≥11 件
// 两口径相抵，逐件手工判读不可复现）。模板补 `来源:`/`影响环境:` 两枚枚举键，锚起新建件必填、字段非法即 WARN；
// 锚前存量不回填（存量未判读与已判读分桶，同 delegationSince 存量豁免纪律）。
// 锚 = 发布次日（2026-10-11）：当日在途件不追溯，维持零告警。缺键（v1–v8）→ 检查 24 整体跳过（存量零噪声）。
const V9 = merge(V8, {
  attributionSince: '2026-10-11', // 检查 24 incident 归因字段生效锚（2026-10-11 incident-attribution）；v1–v8 无此键 → 检查整体跳过
});

// 版本 10 = v9 + 检查 23 的判据级收敛对账生效锚 convergenceSince（convergence-audit）。
// 背景：spec 验证承诺此前只落在叙述节（检查 21 扫节内引用存在性），无「逐判据 × 逐证据」机器对账——
// 参照 GitHub spec-kit converge 机理「完成声明不是证据」。spec 模板新增「验收判据」承重表，锚起的
// L2/L3 done spec 逐行解析判据→证据（存在文件或验证命令白名单），状态列自报不作数。advisory 起步，
// 对账一致性数据先跑起来再议升格。锚 = 发布当日（advisory 档沿 specVerifSince 同日先例）；
// 日期口径 = frontmatter「日期」（fill-spec 必写、指纹绑定可对质），缺则 git 首加日退化。
// 缺键（v1–v9）→ 检查 23 整体跳过（存量零噪声）。
const V10 = merge(V9, {
  convergenceSince: '2026-10-11', // 检查 23 判据级收敛对账生效锚（2026-10-11 convergence-audit）；v1–v9 无此键 → 检查整体跳过
});

// 版本 11 = v10 + 检查 23 证据无效升 hard 的锚 convergenceHardSince（convergence-hard）。
// 不改 convergenceSince：锚前（< 2026-10-11）仍整段跳过；两锚之间维持 v10 的 warning + 命令声明口径。
// 硬档只认机械证据：路径看存在（不读正文、不判与判据是否相关）；命令须属于 verify.mjs 全量门
// （npm test / dotnet test / dotnet build / npm run build / verify.mjs），且 workflow/verify-evidence.md
// 有时间不早于该 spec「日期」的全绿行。全量门不跑的命令（verify-ui / vue-tsc 等）声明了也不算覆盖。
// 无「验收判据」表仍是 WARN。锚 = 发布次日（2026-10-12）：日期为 2026-10-11 的在途 spec 不追溯。
// 缺键（v1–v10）→ 维持 advisory，不升 hard。
const V11 = merge(V10, {
  convergenceHardSince: '2026-10-12', // 检查 23 证据无效 hard 锚（2026-10-11 convergence-hard）；v1–v10 无此键 → 维持 warning
});

// 版本 12 = v11 + 检查 1 独立复核上下文标识的生效锚 reviewerSince（2026-10-11 C2 信任链自洽补全）。
// 背景：引擎对代码声明做指纹绑定，但「由独立上下文复核」这句承重流程声明只收口头——与 2026-09-27
// confirm-doc 之前的确认链同构。隔离本身不可机器验证（思维私密），但隔离的前提条件（复核上下文 ≠
// 作者上下文）是机器事实：复核行落「复核上下文：<会话/子代理 id>」使伪装从「遗漏」升级为「积极伪造」
// （可事后对质）。advisory 起步（棘轮第一档）；只扫有独立复核行的 spec，锚前存量豁免不回填。
// 缺键（v1–v11）→ 检查整体跳过（存量零噪声）。
const V12 = merge(V11, {
  reviewerSince: '2026-10-12', // 检查 1 独立复核上下文标识（2026-10-11 C2）；v1–v11 无此键 → 检查整体跳过
});

// 版本 13 = v12 + 歧义清单门生效锚 clarifySince（clarify-ledger 2026-10-22）。
// 背景：2026-10-16「模糊点纪律」要求 spec 的 [NEEDS CLARIFICATION] 在 approved 前清零，但全仓判据为空
// （`grep NEEDS CLARIFICATION .agents/scripts/` 无命中）——纯约定，正是本引擎反复批判的 SDD 通病：
// 只有出口（不许脑补）没有入口（不教怎么找模糊点），且不可度量。
// 本锚只约束「锚日起新建的 spec」在 draft→approved 时须过歧义清单门（6 维闭集 × 状态闭集 × 待澄清归零）；
// 锚前存量不回填（同 delegationSince / attributionSince 存量豁免纪律），不可判定（缺「日期」字段）不误报。
// 缺键（v1–v12）→ 该门整体跳过（存量零噪声）。
const V13 = merge(V12, {
  clarifySince: '2026-10-22', // 歧义清单门生效锚（2026-10-22 clarify-ledger）；v1–v12 无此键 → 该门整体跳过
});

// 版本 14 = v13 + 验收覆盖门生效锚 coverageSince（coverage-map 2026-10-22）。
// 背景（实测）：37 对 L2/L3 intent↔spec 各有一条证据链（intent 走检查 8 勾验、spec 走检查 23 判据对账），
// 但无编号相连——intent 新增验收而 spec 未同步时两门都放行，覆盖率只能条数粗比（300:228）无法判定漏检。
// 本锚起：spec 确认门要求 intent 验收编号 A1..An 且每条至少被 spec 判据表「对应验收」列引用一次（单向）。
// 锚前存量不回填（13 对连判据表都没有，回填即逼改 37 份文档）；缺日期/无同名 intent（修复类）/无判据表 → 跳过。
const V14 = merge(V13, {
  coverageSince: '2026-10-22', // 验收覆盖门生效锚（2026-10-22 coverage-map）；v1–v13 无此键 → 该门整体跳过
});

export const POLICIES = {
  1: V1,
  2: V2,
  3: V3,
  4: V4,
  5: V5,
  6: V6,
  7: V7,
  8: V8,
  9: V9,
  10: V10,
  11: V11,
  12: V12,
  13: V13,
  14: V14,
};

export function loadKitPolicy(root) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'config', 'engine.json'), 'utf8'));
  } catch { /* 无 kit 或不可解析 */ }
  const requested = raw && Number.isInteger(raw.policyVersion) ? raw.policyVersion : 1;
  const policyVersion = Object.prototype.hasOwnProperty.call(POLICIES, requested) ? requested : 1;
  return {
    ...POLICIES[policyVersion],
    policyVersion,
    requestedVersion: requested,
    audit: raw && typeof raw.audit === 'boolean' ? raw.audit : undefined,
  };
}

export function auditEnabled(policy) {
  return policy.audit !== false;
}

// ---- 测试绿凭证判定（verify-evidence）----
// 单源（confirm-doc done 前置与 check-loop 检查 8 对账共用——防两处窗口字面量漂移，N3 教训）：
// hasFreshVerifyLine(lines, now)：verifications.jsonl 的行数组里是否存在「ts 距 now ≤ 24h 且
// exitCode === 0」的绿行。坏行（非 JSON / 缺 ts）跳过不抛；窗口 24h = 覆盖「跑 verify → 跨会话/
// 隔夜 → 次日关单」节奏（spec 2026-10-07-verify-evidence 论证）。
// testCmd 行剔除（2026-10-09 AI-Native 架构审查修复）：verify.mjs --test-cmd 是引擎自测的夹具通道，
// 其绿行记的是注入的假命令（exitCode 0 ≠ 真门全绿），不得充当关单凭证——正常生产跑不写此键。
// scope 行放行（verify-diet 2026-10-21 ②）：verify --scope diff 的绿行带 scope 标记（变更面未触产品
// 重门的增量关单）——算合法关单凭证：面计算已担保分支未触对应产品路径（口径单源 verify-scope.mjs），
// 信任级同 24h 窗；关单前新提交须重跑（先提交、后跑门）。
export function hasFreshVerifyLine(lines, now = Date.now()) {
  for (const line of lines || []) {
    if (!line || !line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.testCmd === true) continue;
      // 引擎段增量门绿行（verify --engine，2026-10-11 C7）不构成关单凭证——纵深防御：verify.mjs
      // 本就不为其落绿行，此处再拦一道，防未来回归把 7 门绿写成 all-gates 凭证。
      if (e && e.engineOnly === true) continue;
      if (e && e.exitCode === 0 && typeof e.ts === 'string') {
        const t = Date.parse(e.ts);
        if (Number.isFinite(t) && now - t <= 24 * 60 * 60 * 1000) return true;
      }
    } catch { /* 坏行容忍跳过（confirmations.jsonl 同口径） */ }
  }
  return false;
}
