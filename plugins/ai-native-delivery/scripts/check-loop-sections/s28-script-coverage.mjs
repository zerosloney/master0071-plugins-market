// check-loop-sections/s28-script-coverage.mjs — 28. 引擎脚本测试覆盖对账（消费端）[hygiene warning]
// （2026-10-23 P1：复活 2026-10-22 退役的 §20 包源版判据——原挂载条件 templates/_agents/scripts
//  在本仓恒不触发，退役理由成立但覆盖需求未消失；本段改扫本仓 .agents/scripts 真实面。
//  判定单源 = check-script-coverage.mjs；豁免表 .agents/config/scripts-test-exempt.txt。）
import { warnings, ROOT } from '../check-loop-kit.mjs';
import { scanCoverage } from '../check-script-coverage.mjs';

export function run() {
  try {
    const r = scanCoverage(ROOT);
    if (r.skipped) return; // 夹具根无 .agents/scripts：本段无判据面，静默跳过
    for (const m of r.malformed) {
      warnings.push(`- [WARN 脚本覆盖豁免表非法] ${m}`);
    }
    if (r.uncovered.length) {
      const names = r.uncovered.map((u) => u.path.replace('.agents/scripts/', '')).join('、');
      warnings.push(
        `- [WARN 脚本测试覆盖缺失] ${r.uncovered.length} 个脚本无直接/间接测试：${names}` +
        '——补同名 .test.mjs，或在 .agents/config/scripts-test-exempt.txt 登记 indirect/exempt（理由必填）');
    }
  } catch (err) {
    warnings.push(`- [WARN 脚本覆盖对账执行失败] ${err.message}——检查器异常非覆盖结论，但须人工看一眼`);
  }
}
