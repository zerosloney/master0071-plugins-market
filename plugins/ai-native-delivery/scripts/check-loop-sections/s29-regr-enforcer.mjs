// check-loop-sections/s29-regr-enforcer.mjs — 29. 回归清单执法者配对 [hard-block]（2026-11-11 判据移植；锚 regrEnforcerSince）
// 背景：回归清单「执法者」列空置长期无告警——规则已写但没有任何东西执法 = 重犯信号（清单规则的
//   人工纪律没有机器面）。本段让锚（regrEnforcerSince）后新增行从此有门。
// 判据：主台账「## 防复发验证」节 + 全部分片 workflow/regression-checklist.d/<YYYY-MM>.md 的数据行
//   （双 | 包边、非表头非分隔行；首列剥反引号后以 \d{4}- 开头——反引号 slug 形态同认）。行日期 =
//   首列前 10 字符；< regrEnforcerSince → 跳过（存量不追溯，同 convergenceSince 惯例）。锚后行：
//   第 4 列（执法者）非空且非 —/- → 通过；为空或行被切成非 4 列 → HARD-BLOCK（填真执法资产：
//   测试类/脚本/门禁 §N/regression-smoke/verify-ui 证据路径，或显式 [prompt-only] 并登记 papercuts
//   挂债）。表头行/分隔行/非数据行跳过；主台账无该节不报错。
// 步骤 D 扩展（2026-11-12，设计稿 ai-native-closed-loop-and-memory）：锚后行执法者为**仓内文件
//   路径形态**（含 / 或 \ 或已知扩展名；URL/人名/门禁 §N 等纯外部形态不检）时，机检「文件存在 +
//   node --check 级可解析」（语法检不实际运行；非 JS 扩展只查存在性）——不存在或不可解析 →
//   该行 HARD-BLOCK「指认失效」（与「未指认」分列，消息可区分）。[prompt-only] 维持放行（挂债
//   行计数由 verify.mjs 尾部摘要消费，见 regr-enforcer-scan 的 promptOnly 返回）。
//   锚前不追溯语义保持不变；「指认失效」只检锚后行。
// 分工：check-regression-consistency.mjs（§27）查清单引用的资产存在性（WARN 弱档）；本段查执法者
//   配对与被指认执法者的可达性（hard）——两门互补，互不替代。
// 缺键（v1–v15 无 regrEnforcerSince）→ 整段跳过（存量项目零破坏）。
// 行判据单源 = regr-enforcer-scan.mjs（本段与 verify.mjs 挂债摘要共用，勿在本文件复制第二套）。
import { kitPolicy, ROOT, blockers } from '../check-loop-kit.mjs';
import { scanRegrEnforcer } from '../regr-enforcer-scan.mjs';

export function run() {
// --- 29. 回归清单执法者配对 [hard-block]（2026-11-11 判据移植；2026-11-12 步骤 D 扩指认可达性）---
{
  const anchor = kitPolicy.regrEnforcerSince;
  if (anchor) {
    const { targets } = scanRegrEnforcer(ROOT, { anchor });
    for (const t of targets) {
      if (t.missed.length) {
        blockers.push(`- [回归执法者缺失] ${t.base} ${t.missed.length} 行执法者未配对（${t.missed.join('; ')}）——回归清单锚（${anchor}）后行须指认「复发时谁会红」：填真执法资产（测试类 / 脚本 / 门禁 §N / regression-smoke / verify-ui 证据路径）或显式 \`[prompt-only]\` 并登记 papercuts 挂债（检查 29；锚前存量不追溯）`);
      }
      if (t.invalid.length) {
        blockers.push(`- [回归执法者指认失效] ${t.base} ${t.invalid.length} 行指认的执法者不可达（${t.invalid.join('; ')}）——仓内路径形态的执法者须存在且 node --check 级可解析（不实际运行；URL/人名/门禁 §N 等纯外部形态不检）；「未指认」与「指认失效」同属本门 hard（检查 29；锚前存量不追溯）`);
      }
    }
  }
}
}
