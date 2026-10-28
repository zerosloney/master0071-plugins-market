#!/usr/bin/env node
// verify.mjs — 统一静态门编排（2026-10-09 质量增强版；2026-10-09 守护者自守护批次）
// 用途：在关单或 CI 前一键过门——执行全部静态检查，逐项输出 pass/fail。
// 语义：单源口径。确保本地 run-verify 与 Azure Pipeline 行为 100% 一致。
// 凭证落账：全绿才落绿凭证；任一步红即落失败行，供根因分析。
// 自守护：scripts-syntax / engine-tests 两门守引擎自身（2026-10-09 审计 P0-1：本文件曾因
//         SyntaxError 进 CI 而全链静默）。--test-cmd 为 fixture 测试注入缝：给了它则只跑
//         [test, check-loop] 两步夹具，绿行带 testCmd:true 标记（生产凭证不与之混淆，
//         且 fixture 模式不触真实 npm/dotnet）。fail-fast：任一门红立即 exit 1。
// 编排（2026-10-16 并行化）：guardian 门（scripts-syntax）串行先跑、未过即止；其余门进工作池并发
//         （--jobs N / --serial，缺省 clamp(2..4, floor(cpus/4))），各自缓冲输出、完成即整块回放。
//         任一门红 → 停排新门 + taskkill /T 树杀在跑门（fail-fast 语义与「未执行门」清单口径保留）。
//         实测（12 逻辑核，15 门时）：串行 ~300s → 并发墙钟 ~120s（j3 膝点；见 run() 内档位注释）。
//         门数沿革：2026-10-09 九门 → 2026-10-14 18 门（G5 安全段 +2、依赖审计分两面）→
//         2026-10-16 15 门（依赖漏洞审计三门退役，理由见 GATES 内安全段注释）→
//         2026-10-22 16 门（引擎地图漂移门挂入第 6 位，改进 3）。
//         2026-10-24 19 门（复核 P1：工作流索引/指标自洽两门 + 台账指针存在性门）。
//         2026-10-25 20 门（优化1：本地门禁挂载自检 WARN 档挂入引擎段第 4 位——core.hooksPath 不随
//         clone 传播的静默失效面从「靠人记得跑 check-local-gates」升格为每次关单自动对质）。
//         2026-10-27 插件化迁移：wiki-consistency 门加 optional 标记——该门脚本为项目自带件（wiki 内容
//         源项目专有不随插件分发），缺失降级 SKIP（项目适配点，门表计数/序不变），在场照常执法。
// 用法：node <插件根>/scripts/verify.mjs [--full | --scope] [--list] [--jobs N | --serial]
//       node <插件根>/scripts/verify.mjs --stub-gate <cmd>   （仅 CHECK_LOOP_ROOT 夹具；走生产尾段，不打 testCmd）
//   **默认档 = diff 面增量**（verify-scope-default 2026-10-22）：不带参数即按变更面裁门；`--full` 显式全量。
//     兜底：最近 24h 无全量绿行（或 diff 面解析失败）→ 自动退回全量并打印 ⏭️ 兜底行，不静默降档。
//     基线候选 = 本地台账 ∪ 仓库凭证（workflow/verify-evidence.md，verify-evidence-fallback 2026-10-22）：
//     新 worktree 无本地绿行时不再必然重付全量税；候选须为 HEAD 祖先，否则回落 origin/main。
//   **门禁健康（gate-health 2026-10-22）**：成本预算 advisory（.agents/config/gate-budgets.json，
//     超限只告警不阻断，点名「下一批须退役一门」）+ 失败归因（env/flaky/real，failure-attribution.mjs，
//     只标注不改裁决）+ flaky 隔离重跑（仅 backend-test/engine-tests 且首跑命中 flaky 签名；
//     重跑绿记入绿行 `flaky` 字段，重跑红照常红）——把「体感重」变成可对质数字，假红不再训练人绕过门禁。
//   **分层跑（2026-10-23，P0-1 改口径）**：engine-code 触面 → 引擎套件全量；业务/文档面 →
//     `npm test -- --fast`（跳过最慢 9 套件，不再整门跳过）。全量 / --engine / CI / 零裁剪仍全量。
//     绿行 `fastTests` 标记可审计。
//   --list：按执行序打印门 id 后退出（含 RUN_E2E=1 时的条件门），不执行；不参与默认裁剪（门表恒 20）。
//   --jobs / --serial：并发档位与串行回退（见上「编排」）。
// 沿革：verify-evidence（凭证落账）；2026-10-09 统一质量检查门禁 d009965（九门）；
//       guardian-selfcheck（修 :31 缺 =、GATES 加 scripts-syntax/engine-tests、
//       恢复 --test-cmd 夹具缝供 verify.test.mjs 断言）；
//       verify-parallel（串行编排 = 各门之和，本机 318s → 并发墙钟 ~130s；绿行加 wallMs）。
//       verify-diet（2026-10-21）：③backend-test --no-build 消双构建；①失败门输出留痕 tmp/ 并回显尾部；
//       ④前端关单门 vue-tsc 分离（TF_BUILD 下仍全量 build）；②--scope diff 面增量关单（口径单源 verify-scope.mjs）。
//       verify-diet 二批（2026-10-21 P0，owner 拍板）：⑤--scope 引擎自检面——engine-tests 引擎面触 = 全量、
//       业务面 = --fast（2026-10-23 改口径，不再整门跳过）；⑥ledger-invariant
//       全史扫描默认 CI-only（diff 面触及台账时本地回列；门表/--list 恒 20，绿行 envSkips 记录跳过事实）。

import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeDiffScope, parseEvidenceGreens, EVIDENCE_REL } from './verify-scope.mjs';
import { classifyFailure } from './failure-attribution.mjs';
// 路径收口（2026-10-27 插件化迁移）：SCRIPT_DIR 落插件内（paths.mjs 单源）；项目根仍 git root 锚定
//（CHECK_LOOP_ROOT fixture 注入原样保留）。锚点根（脚本定位/配置读取）非 git 环境回退插件根本身
//（源仓 SCRIPT_DIR/../.. 的引擎目录锚等位点）；**账本根不回退**——见 LEDGER 与 paths.mjs ledgerRoot。
import { PLUGIN_SCRIPTS_DIR, PLUGIN_ROOT, ledgerRoot, ledgerRefusal, scriptPath, configDir } from './paths.mjs';

const SCRIPT_DIR = PLUGIN_SCRIPTS_DIR;
const LEDGER = ledgerRoot({ fixture: process.env.CHECK_LOOP_ROOT });
const ROOT = LEDGER.root || PLUGIN_ROOT;
// 引擎门命令（2026-10-27 插件化迁移）：门表逐字保真，仅脚本定位改走 scriptPath——
// 项目侧 .agents/scripts/<name> 优先（源仓形态 / 测试夹具副本），回退插件内本体（paths.mjs 单源）。
const eng = (name) => `node "${scriptPath(ROOT, name)}"`;

// --- 门禁定义 ---
// 引擎段在前（2026-10-10）：语法与引擎测试仍最先；编排/预算/生效规则/闭环硬门/泳道接在其后。
// 产品段维持原相对顺序。遇红即停，但产品面的红不再挡在引擎段前面。
// --list 只打印 id 后退出，不执行。
const GATES = [
  // guardian（2026-10-16 并行编排）：本门未过则后序门一并不启动——引擎脚本不可解析时其余门无意义，
  // 且夹具根（CHECK_LOOP_ROOT 指向无脚本目录）下若并行铺开，20 门会在假根里乱跑（verify.test 场景 7 口径）。
  { id: 'scripts-syntax', cohort: 'engine', guardian: true, name: '引擎脚本语法自检', cmd: eng('check-scripts-syntax.mjs'), folder: '.', type: 'shell' },
  { id: 'engine-tests', cohort: 'engine', name: '引擎脚本测试套件 (npm test)', cmd: 'npm test', folder: '.', type: 'shell' },
  { id: 'workflows-check', cohort: 'engine', name: '编排脚本检查', cmd: eng('workflows-check.mjs'), folder: '.', type: 'shell' },
  { id: 'rule-budget', cohort: 'engine', name: '常驻面预算检查', cmd: eng('rule-budget.mjs') + ' --all', folder: '.', type: 'shell' },
  // 本地门禁挂载自检（2026-10-25 优化1，WARN 档）：判据与 check-local-gates.mjs ①-④ 对齐（单源，一边改
  // 另一边须跟）。默认 WARN 缺配只告警；CI（TF_BUILD）/非 git 根 loud-skip；升格 = cmd 加 --strict（owner 拍板）。
  { id: 'local-gate-config', cohort: 'engine', name: '本地门禁挂载自检（WARN 档）', cmd: eng('check-local-gate-config.mjs'), folder: '.', type: 'shell' },
  // 生效规则视图漂移门（2026-10-09 P2-5）：policy/engine 变更后必须重生成 effective-policy.md 随同提交——
  // 把「存量豁免 vs 受管」的规则二分从 check-loop 源码显性化，CI 强制不漂移。
  // --check 比对前行尾归一，autocrlf 检出不算漂移。
  { id: 'effective-policy', cohort: 'engine', name: '生效规则视图漂移检查', cmd: eng('gen-effective-policy.mjs') + ' --check', folder: '.', type: 'shell' },
  // 引擎地图漂移门（2026-10-22 改进 3）：engine-map.md 是冷启动单源生成物（钩子清单 / GATES /
  // check-loop 段表 / 机制台账摘要 / 目录计数），此前 --check 只存在于脚本自身，**没有任何门调用它**
  // ——故能漂移数月无人见（实证：台账状态列加类型标记后生成物写出「现役 0」，与台账声明的 35 矛盾，
  // 而 --check 恒红也没人跑到）。与 effective-policy 同型：生成物 + --check + verify 门三件套。
  // 语义要求工作树（改完单源就地重生成随同提交），故挂 verify 而非 pre-push（后者扫待推树）。
  { id: 'engine-map', cohort: 'engine', name: '引擎地图漂移检查', cmd: eng('gen-engine-map.mjs') + ' --check', folder: '.', type: 'shell' },
  // 生成物漂移门（2026-10-24 复核 P1）：INDEX.md 是活跃流程的冷启动入口，此前只有 --check 与
  // check-loop 日检 WARN，实测已漂移 3 件无人拦。与 engine-map 同型：生成物 + --check + verify 门三件套。
  { id: 'workflow-index', cohort: 'engine', name: '工作流索引漂移检查', cmd: eng('gen-workflow-index.mjs') + ' --check', folder: '.', type: 'shell' },
  // metrics 门（2026-10-27 修「门名不符实」）：metrics.md 是月度快照，**不做磁盘逐字漂移校验**（作者口径：
  // 任何文档改动都会让当前值漂移，拿它比磁盘只会常红）。此前本门只跑 --dry-run——恒 exit 0、只打印，
  // 名叫「指标数据自洽检查」却不做任何检查；实测 published 表停在 2026-10-25（92 全量绿行 / 165.7s /
  // 最慢门首位 backend-test）而台账已到 137 绿行 / 193.3s / 首位 ledger-invariant，漂移 18 次验证无人见。
  // 现改「时效门」：GENERATED 区写入快照生成时刻，本门判自述有多旧（上限 31 天，METRICS_MAX_AGE_DAYS
  // 可调）；--dry-run 的数据自洽校验（reviews.d 采纳+拒绝+误报=意见数，数据脏时 fail-loud）仍保留。
  { id: 'workflow-metrics', cohort: 'engine', name: '指标快照时效检查', cmd: eng('gen-workflow-metrics.mjs') + ' --check && ' + eng('gen-workflow-metrics.mjs') + ' --dry-run', folder: '.', type: 'shell' },
  // 默认硬门。卫生段不进关单（2026-10-10）：要看时另跑 check-loop.mjs --hygiene。
  { id: 'check-loop', cohort: 'engine', name: '闭环门禁校验', cmd: eng('check-loop.mjs'), folder: '.', type: 'shell' },
  { id: 'ledger-doc-presence', cohort: 'engine', name: '台账指针存在性', cmd: eng('check-ledger-doc-presence.mjs'), folder: '.', type: 'shell' },
  // 确认台账不变量（ledger-invariant-ci）：历史全扫挂进引擎段——此前该门自称 CI 机器门
  // 却从未进任何门表，71 处存量断档积累数月无人见（当日 DAG 感知重写 + HISTORY_BASELINE 声明后
  // 首次全绿，方具挂门条件）。pre-commit 仅 --staged 前缀面，全史审计由此门独担。
  // verify-diet 二批（2026-10-21 P0-2，owner 拍板）：本地关单不再重复付全史扫描（~37s）——TF_BUILD 外
  // 执行期 loud-skip（diff 面触台账即回列；门表/--list 恒 20，同 lane-surface-ci「本地跳过」先例）；全史审计由 CI 独担
  // （main 全量 verify 含本门；develop 最小 CI 面 secrets+check-loop 不含本门——2026-10-25 起），新违规仍被提交时刻 --staged 增量门当场拦。
  { id: 'ledger-invariant', cohort: 'engine', name: '确认台账不变量（历史全扫）', cmd: eng('check-ledger-invariant.mjs'), folder: '.', type: 'shell' },
  // 泳道 diff 面（ai-native-review-p1）：CI（TF_BUILD/合并提交检出）按基准执法——产品契约面
  // 改动须 diff 内协伴 L2+ 入口；本地手跑无基准事实 → 脚本内 advisory 跳过（显式 --base origin/main 可预检）。
  { id: 'lane-surface-ci', cohort: 'engine', name: '泳道完整性（CI diff 面；本地无基准则跳过）', cmd: eng('check-lane-surface.mjs') + ' --ci', folder: '.', type: 'shell' },
  // 安全段（2026-10-14 决定 4 / G5 插队）：密钥扫描。
  // secrets-scan：gitleaks detect + 基线（.gitleaks-baseline.json，存量 1227 处豁免清单，用户拍板——
  //   2026-10-15 扩 6 处权限Key 标识符，见 check-secrets.mjs 头注）；
  //   缺二进制响亮跳过（loud-skip，装机见 runtime-env §6.3）。pre-commit 侧另有 --staged 增量门。
  // 依赖漏洞审计三门（nuget-audit / frontend-audit-prod / frontend-audit-devtool）2026-10-16 退役
  //   （owner 指令）：三者皆依赖公网漏洞服务（npm `/-/npm/v1/security/*`、NuGet 源索引的
  //   `VulnerabilityInfo`），内网镜像均不代理该面（实测见 runtime-env §6.4「漏洞数据源实测」），
  //   冷缓存/网络抖动即假红、换内网源即假绿——判据不可靠，故整族退出关单门表。
  //   退役留档：机制台账两行（NuGet 漏洞门 / 前端依赖审计）+ papercuts 2026-10-16 行。
  { id: 'secrets-scan', cohort: 'security', name: '密钥扫描（gitleaks 全量+基线）', cmd: eng('check-secrets.mjs'), folder: '.', type: 'shell' },
  { id: 'frontend-lint', cohort: 'product', name: '前端代码规范检查', cmd: 'npm run lint:check', folder: 'frontend', type: 'shell' },
  // 前端单测硬门（2026-10-09）：Vitest 纯 node 面零外部依赖，CI 可执法——
  // 补齐「后端 1426 用例 vs 前端 0」的验证面不对称（AI-Native 架构审查 P1-1）。
  { id: 'frontend-unit-test', cohort: 'product', name: '前端单测 (Vitest)', cmd: 'npm run test:unit', folder: 'frontend', type: 'shell' },
  // 项目适配点（2026-10-27 插件化迁移）：wiki 三方一致性脚本为**项目自带件**（wiki 内容源项目专有，
  // 不随插件分发）——脚本缺失时本门降级 SKIP（显式输出适配点说明，不算门红），在场时照常执法；
  // 门表计数与序不变（--list 恒 20 仍含本门），判据单源 optionalGateMissing（文末导出，测试锁语义）。
  { id: 'wiki-consistency', cohort: 'product', optional: 'verify-wiki-consistency.mjs', name: 'wiki 三方一致性', cmd: eng('verify-wiki-consistency.mjs'), folder: '.', type: 'shell' },
  // 项目适配点（2026-10-27 脱敏泛化）：解决方案名按使用项目替换（源为业务解决方案名，出库前清洗）。
  { id: 'backend-build', cohort: 'product', name: '后端编译', cmd: 'dotnet build App.sln', folder: '.', type: 'shell' },
  // --no-build（verify-diet 2026-10-21 ③）：测试直接消费 backend-build 产物，消「build → test 内部再
  // 构建同一 sln」的双构建。deps 仍必需：--no-build 无产物即红，且保持依赖门序（依赖门红 → 本门不启动）。
  // 入口收敛（gate-diet #1' 2026-10-23）：无分区库配置时等价于 dotnet test sln --no-build；
  // 配置分区库时 = 单测一次 + 集成测试按独立库进程分区并行（scripts/verify/backend/run-backend-tests.mjs）。
  { id: 'backend-test', cohort: 'product', name: '后端自动化测试', cmd: 'node scripts/verify/backend/run-backend-tests.mjs', folder: '.', type: 'shell', deps: ['backend-build'] },
  // 前端关单门（verify-diet ④ 分离）：本地关单只执法类型检查——vite bundle 产物不进任何断言，
  // 对验证语义无贡献，完整构建留在 deploy 与 CI（TF_BUILD 时仍 npm run build 全量）。
  // 门 id/计数变更（--list 恒 20，2026-10-25 local-gate-config 加入引擎段；2026-10-24 复核加三门）；s23 GATE_CMD 已同步收 vue-tsc。
  { id: 'frontend-build', cohort: 'product',
    name: process.env.TF_BUILD ? '前端构建 (含类型检查)' : '前端类型检查 (vue-tsc)',
    cmd: process.env.TF_BUILD ? 'npm run build' : 'npm run type-check',
    folder: 'frontend', type: 'shell' },
];

// fixture 夹具门（--test-cmd 注入时替换全部生产门，verify.test.mjs 的 1/2、2/2 断言依赖此口径）
// check-loop 用绝对路径直调真实脚本——夹具根里没有脚本本体，root 归属仍由 CHECK_LOOP_ROOT 裁决。

// optional 门判据（2026-10-27 插件化迁移，导出供 verify.test 锁「缺失降级 SKIP」语义）：
// gate.optional = 该门依赖的**项目自带**脚本名（scriptPath 项目侧优先、回退插件内定位）——
// 两处皆缺 → 门降级 SKIP（不算门红）；脚本在场 → 照常执法。
export const optionalGateMissing = (gate, root) => !!gate.optional && !fs.existsSync(scriptPath(root, gate.optional));
const fixtureGates = (cmd) => [
  { id: 'test', name: '测试步（注入）', cmd, folder: '.', type: 'shell' },
  { id: 'check-loop', name: '闭环门禁校验', cmd: `node "${path.join(SCRIPT_DIR, 'check-loop.mjs')}"`, folder: '.', type: 'shell' },
];

// E2E 冒烟条件门（2026-10-09）：RUN_E2E=1 才执法——前置是全栈在线
// （前端 5203 + API 8932 + SMOKE_ADMIN/SMOKE_ADMIN_PASSWORD 凭证），CI 未配全栈前不假装执法；
// 未启用时开跑前显式打印 loud-skip（跳过可见，与 fail-loud 对称）。
if (process.env.RUN_E2E === '1') {
  GATES.push({ id: 'frontend-e2e', cohort: 'product', name: '前端 E2E 冒烟 (Playwright)', cmd: 'npm run test:e2e', folder: 'frontend', type: 'shell' });
}

// 计数捕获：优先 run-tests 的「断言合计」汇总行，退路取末条「合计: PASS x / FAIL y」
//（夹具假命令与单套件输出皆走退路；无匹配则省略计数键，exitCode 才是硬事实）。
const parseCounts = (out) => {
  const agg = /断言合计 PASS (\d+) \/ FAIL (\d+)/.exec(out || '');
  if (agg) return { passed: Number(agg[1]), failed: Number(agg[2]) };
  const all = [...(out || '').matchAll(/合计: PASS (\d+) \/ FAIL (\d+)/g)];
  if (all.length) return { passed: Number(all[all.length - 1][1]), failed: Number(all[all.length - 1][2]) };
  return null;
};

// 门禁成本预算（gate-budget 2026-10-22）：advisory——超限只告警不阻断；连续两月超限由 owner
// 裁决降档/退役一门（一进一出）。配置缺失/非法 = 不告警（fail-open，观测面不挡裁决面）。
const readGateConfig = (root) => {
  try { return JSON.parse(fs.readFileSync(path.join(configDir(root), 'gate-budgets.json'), 'utf8')); } catch { return {}; }
};
const readGateBudget = (root, key) => {
  const v = Number(readGateConfig(root)[key]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

const recordFailure = (step, exitInfo, note, attribution) => {
  try {
    const entry = { ts: new Date().toISOString(), exitCode: typeof exitInfo === 'number' ? exitInfo : -1, suite: step, note };
    // 归因（gate-health 2026-10-22）：env / flaky / real——红单可读，AI 不在假红上反复重跑。
    if (attribution) entry.attribution = attribution;
    if (process.env.PIPELINE_RUN_ID) entry.runId = process.env.PIPELINE_RUN_ID;
    if (!LEDGER.writable) {
      console.error(`[verify] ⚠️ ${ledgerRefusal(LEDGER.status, LEDGER.detail)}（本次红行未落账：suite=${step}）`);
      return;
    }
    fs.mkdirSync(path.join(ROOT, '.agents'), { recursive: true });
    fs.appendFileSync(path.join(ROOT, '.agents', 'verifications.jsonl'), `${JSON.stringify(entry)}\n`);
    console.log(`[verify] 🧾 失败行已留痕 verifications.jsonl（suite=${step}${attribution ? `，归因 ${attribution}` : ''}）`);
  } catch (e) {
    console.error(`[verify] ⚠️ 失败行落账失败（${e.code || e.message}）`);
  }
};

// 门输出留痕（verify-diet 2026-10-21 ①）：失败门完整 stdout/stderr 落 tmp/verify-<id>.log 并回显
// 尾部 40 行——fail-fast 红从「只知道 exit 1」变为可当场定性（papercuts 2026-10-17 拟修①；
// 先例：后端门红无法区分已知负载偶发与新回归，只能盲跑复跑）。落盘失败不改裁决（同 recordFailure 容错）。
const persistGateLog = (gate, r) => {
  try {
    const dir = path.join(ROOT, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `verify-${gate.id}.log`);
    fs.writeFileSync(p, [
      `# gate=${gate.id} name=${gate.name}`,
      `# cmd=${gate.cmd}`,
      `# status=${r.status ?? r.error?.code} duration=${r.durMs}ms`,
      '=== stdout ===', r.stdout || '(空)',
      '=== stderr ===', r.stderr || '(空)', '',
    ].join('\n'));
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trimEnd().split(/\r?\n/).slice(-40).join('\n');
    if (tail) console.error(`[verify] 🧾 门输出尾部 40 行（全文 ${path.relative(ROOT, p)}）：\n${tail}`);
    return p;
  } catch { return null; }
};

async function run() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--test-cmd');
  const testCmd = ti >= 0 ? argv[ti + 1] : null;
  // --stub-gate（2026-10-15）：单门夹具但走生产尾段（落凭证 / 门禁成本 / gen-verify-evidence）。
  // 不打 testCmd 标记。必须配 CHECK_LOOP_ROOT，禁止在真实仓库写出可被当成关单凭证的绿行。
  const si = argv.indexOf('--stub-gate');
  const stubCmd = si >= 0 ? argv[si + 1] : null;
  if (si >= 0 && !stubCmd) {
    console.error('[verify] --stub-gate 需要一条命令');
    process.exit(2);
  }
  if (stubCmd && testCmd) {
    console.error('[verify] --stub-gate 与 --test-cmd 互斥');
    process.exit(2);
  }
  if (stubCmd && !process.env.CHECK_LOOP_ROOT) {
    console.error('[verify] --stub-gate 只允许配合 CHECK_LOOP_ROOT 夹具根（禁止在真实仓库落无关单凭证）');
    process.exit(2);
  }
  // --scope（verify-diet 2026-10-21 ②；复核后基线升级）：diff 面增量关单——变更面（基线..HEAD ∪
  // 工作区 ∪ untracked；基线 = 最近全量绿行 headShort，回落在 origin/main merge-base）未触及的产品
  // 重门与引擎自检门跳过（密钥扫描 + wiki 一致性 + 关单主干引擎门恒跑；engine-tests 按
  // .agents/.githooks/package.json 面裁剪——verify-diet 二批 P0-1，口径单源 verify-scope.mjs）。
  // 纯文档/业务面分支把关单压到分钟级以下；面触及对应路径自动回列，基线/面解析失败 fail-loud 拒增量。
  // 与 --test-cmd/--engine 互斥（夹具行不带生产标记、与引擎段增量门语义重叠）；--stub-gate 下只记
  // entry.scope 标记不裁门（stub 整表替换，测试通道用它做凭证渲染的集成断言）。
  const engineOnly = argv.includes('--engine');
  const explicitScope = argv.includes('--scope');
  const explicitFull = argv.includes('--full');
  const listOnly = argv.includes('--list');
  if (explicitScope && explicitFull) {
    console.error('[verify] --scope 与 --full 互斥');
    process.exit(2);
  }
  if (explicitScope && (testCmd || engineOnly)) {
    console.error('[verify] --scope 与 --test-cmd / --engine 互斥');
    process.exit(2);
  }
  // 默认档（verify-scope-default 2026-10-22，owner 拍板）：未显式 --full、且非夹具/非引擎段/非 --list →
  // 默认走 diff 面增量，`--full` 才全量。实测依据：一日 23 次全量、墙钟中位 234s ≈ 90 分钟纯等待，而
  // 绝大多数分支只动文档面；「默认便宜、全量显式」是把关单压到分钟级以下的唯一杠杆。
  // --list 不参与：门表恒 20 是叙事锚与对外契约，裁剪只在执行期生效。
  let scopeMode = explicitScope ? 'diff'
    : (!explicitFull && !testCmd && !stubCmd && !engineOnly && !listOnly) ? 'diff' : null;
  let scope = null;
  let ledgerBase = null;
  let baseSourceHint = 'ledger';
  if (scopeMode) {
    // 基线候选（verify-evidence-fallback 2026-10-22）：本地台账最近一次**全量**（非 scope/夹具/引擎段）
    // 绿行 ∪ 仓库级凭证 workflow/verify-evidence.md（入库追加保全，跨机/换 worktree 不失历史）。
    // 取「最新且为 HEAD 祖先」者——新 worktree 无本地台账时不再必然退回全量；非祖先（别的分支 /
    // rebase 残留）拒用，回落 origin/main。凭证 baseSource 记来源，审计可对质基线从哪来。
    const candidates = [];
    try {
      const vp = LEDGER.writable ? path.join(ROOT, '.agents', 'verifications.jsonl') : null;
      const rows = vp && fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      for (let i = rows.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(rows[i]);
          // fastTests 行（engine-tests 降 --fast、无 scope 标记的裁剪绿）禁作全量锚——
          // 否则增量担保建立在漏跑慢套件的树上（2026-10-24 复核 P1-5）
          // envSkips 行（2026-10-27 anchor-envskip）：CI-only 门被 loud-skip 的「看似全量」行同样禁作锚——
          // 该行实跑门数 < 门表（实测 12 条 gates=14/15 + envSkips=ledger-invariant），
          // 一旦当锚，后续增量担保会建立在「没跑 ledger-invariant」的树上。
          if (e.exitCode === 0 && e.suite === 'all-gates' && e.headShort && !e.scope && !e.fastTests && !e.testCmd && !e.engineOnly
            && !(Array.isArray(e.envSkips) && e.envSkips.length)) {
            candidates.push({ sha: e.headShort, ts: e.ts, source: 'ledger' });
            break;
          }
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 读不到台账 = 无本地候选 */ }
    try {
      const ep = path.join(ROOT, EVIDENCE_REL);
      if (fs.existsSync(ep)) {
        for (const row of parseEvidenceGreens(fs.readFileSync(ep, 'utf8'))) {
          candidates.push({ sha: row.headShort, ts: row.ts, source: 'evidence' });
        }
      }
    } catch { /* 读不到凭证 = 无仓库候选 */ }
    const seen = new Set();
    const ordered = candidates
      .filter((c) => c.sha && Number.isFinite(Date.parse(c.ts)))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .filter((c) => (seen.has(c.sha) ? false : (seen.add(c.sha), true)));
    const isAncestor = (sha) => spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { encoding: 'utf8', cwd: ROOT }).status === 0;
    const chosen = ordered.find((c) => isAncestor(c.sha)) || null;
    const lastFullTs = chosen ? chosen.ts : null;
    if (chosen) { ledgerBase = chosen.sha; baseSourceHint = chosen.source; }
    // 24h 全量兜底：**只约束默认档**（显式 --scope = 操作者已判读面，且夹具端到端用例依赖无历史绿行算面）。
    // 判据 = 最近全量绿行 age < 24h；过期或不存在 → 本次退回全量。
    // 刻意**不认失败行**：红树上的增量绿会伪造安全感，「跑过」不等于「跑绿」。代价是树长期红时默认档
    // 恒失效——这是有意的取舍：门禁全红时该修树，不该降档。
    if (!explicitScope) {
      const age = lastFullTs ? Date.now() - Date.parse(lastFullTs) : null;
      const freshFull = age !== null && Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000;
      if (!freshFull) {
        const why = lastFullTs ? `最近全量绿 ${lastFullTs.slice(0, 16)}（已 ${(age / 3600000).toFixed(1)}h）` : '本地台账与仓库凭证均无全量绿行';
        console.log(`[verify] ⏭️ 24h 内无全量绿行（${why}）→ 本次全量执法（兜底）\n`);
        scopeMode = null;
      }
    }
  }
  if (scopeMode) {
    const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: ROOT });
    try {
      scope = computeDiffScope(git, ledgerBase, baseSourceHint);
    } catch (e) {
      // 显式 --scope 保持 fail-loud（拒增量）；默认档退回全量——默认档不该因基线缺失整体失败。
      if (explicitScope) {
        console.error(`[verify] --scope: ${e.message}`);
        process.exit(2);
      }
      console.log(`[verify] ⏭️ diff 面解析失败（${e.message}）→ 本次全量执法（兜底）\n`);
      scopeMode = null;
    }
  }
  // 场景集分层（2026-10-23）：engine-code 触面 → 引擎套件全量；业务/文档面 → --fast（不再整门跳过）。
  // 全量 / --engine / CI / 零裁剪（engine-code 必触）仍全量；绿行 fastTests 标记可审计。
  let fastEngineTests = false;
  if (scopeMode === 'diff' && scope) {
    const et = GATES.find((g) => g.id === 'engine-tests');
    if (et) {
      if (scope.touched.has('engine-code')) {
        et.cmd = 'npm test'; // 显式复位，防同进程/夹具残留
      } else {
        et.cmd = 'npm test -- --fast';
        fastEngineTests = true;
        scope.skippedGateIds = scope.skippedGateIds.filter((id) => id !== 'engine-tests');
      }
    }
  }
  if (scopeMode && scope && !stubCmd) {
    const faceNote = ['backend', 'frontend', 'engine-code'].map((f) => `${f}:${scope.touched.has(f) ? '触' : '未触'}`).join(' ');
    const skipNote = scope.skippedGateIds.length
      ? `跳过 ${scope.skippedGateIds.length} 门（${scope.skippedGateIds.join('、')}）`
      : '产品面全触及——全量执法';
    const baseWhy = scope.baseSource === 'ledger' ? '上次全量绿行'
      : scope.baseSource === 'evidence' ? '仓库凭证' : 'origin/main';
    console.log(`[verify] 🔀 scope=diff：基线 ${scope.baseShort}（${baseWhy}）｜变更面 ${scope.fileCount} 文件（${faceNote}）——${skipNote}\n`);
  }
  // --engine（2026-10-11 C7 方案②）：只跑 cohort=engine 的引擎段门——原设计供 develop 增量 CI
  // （该 CI 步已随 2026-10-21 死步清理删除；--engine 保留本地/手动用法）。与全量的关键差异：
  // 全绿**不落 all-gates 绿行、不生成摘要**——13 门绿不是 20 门关单凭证，落了会被 hasFreshVerifyLine
  // 与 gen-verify-evidence 误认成全量绿（伪凭证）；失败行照记（suite=门 id，诊断用）。
  const skipSet = scope ? new Set(scope.skippedGateIds) : new Set();
  // CI-only 门（verify-diet 二批 2026-10-21 P0-2；2026-10-24 复核 P1 收紧）：ledger-invariant 全史扫描
  // 在 TF_BUILD 外默认 loud-skip，但 diff 面触及台账/修剪 manifest 时回列（verify-scope.ledgerTouched）
  // ——台账变更才付 ~90s，未触及仍跳过；全量档（无 scope）与 CI 照跑。绿行 envSkips 记录跳过事实。
  const CI_ONLY_GATE_IDS = new Set(['ledger-invariant']);
  const localLedgerSkip = !testCmd && !stubCmd && !process.env.TF_BUILD
    && !!scope && !scope.ledgerTouched;
  const envSkipIds = localLedgerSkip ? CI_ONLY_GATE_IDS : new Set();
  const gates = testCmd ? fixtureGates(testCmd)
    : stubCmd ? [{ id: 'stub', cohort: 'engine', name: '夹具单门', cmd: stubCmd, folder: '.', type: 'shell' }]
    : engineOnly ? GATES.filter((g) => g.cohort === 'engine')
    : GATES.filter((g) => !skipSet.has(g.id));
  // deps 完整性断言（复核 P2）：依赖门被裁剪/表形态破坏时，worker 会把依赖孤儿静默 continue——
  // 门从绿跑里无声消失、绿凭证残缺。此处 fail-loud，不带病跑（--no-build 放大此陷阱的后果）。
  {
    const gateIds = new Set(gates.map((g) => g.id));
    for (const g of gates) {
      for (const d of g.deps || []) {
        if (!gateIds.has(d)) {
          console.error(`[verify] 门 ${g.id} 依赖 ${d} 不在本轮门清单——裁剪/表形态错误，拒绝运行`);
          process.exit(2);
        }
      }
    }
  }

  if (argv.includes('--list')) {
    if (testCmd) {
      console.error('[verify] --list 与 --test-cmd 互斥');
      process.exit(1);
    }
    const verbose = argv.includes('--verbose');
    for (const g of gates) console.log(verbose ? `${g.id}\t${g.cmd}` : g.id);
    process.exit(0);
  }

  // 并发档位（2026-10-16 并行编排）：门之间无共享状态（各自独立进程 + 独立工作目录），串行编排下
  // 总耗时 = 各门之和（本机实测（15 门时）~300s：engine-tests 118s / backend-test 63s / ledger-invariant 55s…）。
  // 工作池并发后墙钟 ≈ max(最长门, 各门之和 / 并发)——门自身已内部并行（npm test 套件池 6、dotnet 多核、
  // check-loop.test 分片 6），并发档位越高越互相抢核，最长门（engine-tests）反而变慢。本机 12 逻辑核
  // 实测（×2 取均值，全绿）：j2 177.8s / **j3 122.3s** / j4 129.3s / j6 136.6s——膝点在 3。
  // 缺省 = clamp(2..4, floor(cpus/4))（12 核 → 3）；--serial 回退串行（排障/对比）；--jobs N 显式钉档。
  const serial = argv.includes('--serial');
  const jobsRaw = argv.includes('--jobs') ? Number(argv[argv.indexOf('--jobs') + 1]) : null;
  if (jobsRaw !== null && (!Number.isInteger(jobsRaw) || jobsRaw < 1)) {
    console.error(`[verify] --jobs 须为正整数（现 ${argv[argv.indexOf('--jobs') + 1]}）`);
    process.exit(2);
  }
  const JOBS = serial ? 1 : Math.min(jobsRaw ?? Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4))), gates.length);
  // 单门输出上限（与旧 spawnSync maxBuffer 同口径）：超限即树杀判红，不静默截断
  const MAX_GATE_OUTPUT = 32 * 1024 * 1024;
  // 树杀（fail-fast 中止在跑门）：Windows 下 shell:true 起的是 cmd.exe，kill 只杀壳不杀孙进程
  // （npm→node、dotnet→vstest 会成孤儿并占住 bin 锁）——故走 taskkill /T /F 整树。
  const killTree = (child) => {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* best-effort：杀不动不改变裁决 */ }
  };

  console.log(`[verify] 🚀 开始全量静态门验证 (共 ${gates.length} 项，并发 ${JOBS}${serial ? '·串行' : ''})${testCmd ? '【fixture 模式】' : ''}${stubCmd ? '【stub 尾段】' : ''}${engineOnly ? '【引擎段增量门】' : ''}\n`);
  if (!testCmd && !stubCmd && process.env.RUN_E2E !== '1') {
    console.log('[verify] ⏭️  E2E 冒烟门未启用（RUN_E2E≠1）——前置为全栈在线（前端 5203 + API 8932 + SMOKE_ADMIN/SMOKE_ADMIN_PASSWORD）；启用方式：RUN_E2E=1 node <插件根>/scripts/verify.mjs\n');
  }

  let passedCount = 0;
  const outputs = {};
  // 逐门耗时埋点（2026-10-14 G8 门禁计时）：durations 随 all-gates 绿行入 verifications.jsonl，
  // metrics.md「门禁成本/迭代」表消费——G10（影响面裁剪）的判据数据源。
  const durations = {};
  const flakyGates = []; // 重跑绿的 flaky 门（写进绿行 flaky 字段，可审计）
  let cohortSeen = '';
  const cohortLabel = { engine: '引擎段', security: '安全段', product: '产品段' };
  const doneIdx = new Set();  // 已出裁决的门序（成功/失败/中止；未列入者 = fail-fast 后状态未知）
  const aborted = new Set();  // 因他门失败被树杀中止的门序
  const running = new Map();  // 门序 -> child（树杀目标）
  let failedIdx = -1;

  const startGate = (i) => {
    const gate = gates[i];
    // optional 门（2026-10-27 插件化迁移）：项目自带脚本缺失 → 合成 SKIP（不 spawn、不计耗时、
    // 不进 passedCount；跳过在 finishGate 以 ⏭️ 行显式可见，与 CI-only loud-skip 对称——没跑 ≠ 过了）。
    if (optionalGateMissing(gate, ROOT)) {
      return Promise.resolve({ status: 0, skip: true, optionalSkip: true, stdout: '', stderr: '', durMs: 0 });
    }
    // CI-only 门本地 loud-skip：合成「通过」裁决（不 spawn、不计耗时、不进 passedCount）——
    // 跳过在 finishGate 以 ⏭️ 行显式可见（与 E2E loud-skip 对称：没跑 ≠ 过了，台账可区分）。
    if (envSkipIds.has(gate.id)) {
      return Promise.resolve({ status: 0, skip: true, stdout: '', stderr: '', durMs: 0 });
    }
    if (gate.cohort && gate.cohort !== cohortSeen) {
      cohortSeen = gate.cohort;
      const n = gates.filter((g) => g.cohort === cohortSeen).length;
      console.log(`[verify] —— ${cohortLabel[cohortSeen] || cohortSeen}（${n}）——`);
    }
    console.log(`[verify] ▶ ${i + 1}/${gates.length} ${gate.name}...`);
    const t0 = performance.now();
    const child = spawn(gate.cmd, { shell: true, cwd: path.join(ROOT, gate.folder) });
    running.set(i, child);
    const buf = { stdout: '', stderr: '', overflow: false };
    const pump = (src, key) => {
      src.setEncoding('utf8');
      src.on('data', (d) => {
        if (buf.overflow) return;
        buf[key] += d;
        // 与旧 spawnSync maxBuffer 同口径：超限即中止判红（不静默截断——截断后的输出不可当证据）
        if (buf[key].length > MAX_GATE_OUTPUT) { buf.overflow = true; killTree(child); }
      });
    };
    pump(child.stdout, 'stdout');
    pump(child.stderr, 'stderr');
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status, error) => {
        if (settled) return;
        settled = true;
        running.delete(i);
        resolve({ status, error, ...buf, durMs: Math.round(performance.now() - t0) });
      };
      child.on('error', (e) => settle(null, e));
      child.on('close', (status) => settle(status, null));
    });
  };

  // 出裁决：先回放该门缓冲输出（并发下输出按门整块回放，逐门可读，与 run-tests 同口径），再打结论行。
  // 返回 true = 该门红（调用方据此 fail-fast）。
  const finishGate = (i, r) => {
    const gate = gates[i];
    doneIdx.add(i);
    if (r.skip) {
      if (r.optionalSkip) {
        console.log(`[verify] ⏭️ ${i + 1}/${gates.length} ${gate.name}：SKIP（项目适配点：wiki 一致性门需要项目自带脚本 ${gate.optional}——wiki 内容源项目专有不随插件分发，缺失降级不挡关单；脚本在场即照常执法）\n`);
        return false;
      }
      console.log(`[verify] ⏭️ ${i + 1}/${gates.length} ${gate.name}：CI-only（TF_BUILD 外跳过——提交时刻 --staged 增量门已执法，全史扫描 CI 兜底）\n`);
      return false;
    }
    durations[gate.id] = r.durMs;
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (aborted.has(i)) {
      console.error(`[verify] ⏹ ${i + 1}/${gates.length} ${gate.name} 已中止（他门失败触发 fail-fast，状态未知）`);
      return false;
    }
    if (r.overflow) {
      console.error(`[verify] ❌ ${i + 1}/${gates.length} ${gate.name} 未通过（输出超 ${MAX_GATE_OUTPUT / 1024 / 1024}MB 上限，已中止）`);
      persistGateLog(gate, r);
      recordFailure(gate.id, -1, 'output-overflow');
      return true;
    }
    if (r.status !== 0) {
      const logPath = persistGateLog(gate, r);
      const note = `exit ${r.status ?? r.error?.code}${logPath ? `·log ${path.relative(ROOT, logPath)}` : ''}`;
      // 归因（gate-health 2026-10-22）：env / flaky / real——只标注不改裁决；假红可当场定性。
      const attribution = classifyFailure(`${r.stdout || ''}\n${r.stderr || ''}`);
      console.error(`[verify] ❌ ${i + 1}/${gates.length} ${gate.name} 未通过 (${note})｜归因 ${attribution}`);
      recordFailure(gate.id, r.status, note, attribution);
      return true;
    }
    outputs[gate.id] = r.stdout || '';
    if (r.flakyRetry) {
      console.log(`[verify] ⚠️ ${gate.name} 首跑红（exit ${r.firstStatus}）→ 重跑绿：判 flaky（已记入绿行 flaky 字段）`);
      if (r.firstTail) console.log(`[verify]   首跑尾部：\n${r.firstTail}`);
      flakyGates.push(gate.id);
    }
    console.log(`[verify] ✅ ${i + 1}/${gates.length} ${gate.name} 通过 [${r.durMs} ms]\n`);
    passedCount++;
    return false;
  };

  const wallStart = performance.now();

  // flaky 隔离重跑（gate-health 2026-10-22）：只对已知争用型门（backend-test / engine-tests），
  // 且首跑输出命中 flaky 签名（Msg 1205 / 死锁 / Execution Timeout / syscall: rm）才重跑一次。
  // 两跑都报告；重跑绿 → 判 flaky 并写进绿行 `flaky` 字段（可审计），重跑红 → 照常红。
  // 不做「无签名也重跑」——那会把真回归洗成偶发；也不自动降档（降档须 owner 裁决 + 复评日）。
  const gateConfig = readGateConfig(ROOT);
  const flakyRetryEnabled = gateConfig.flakyRetry !== false;
  const retryGates = new Set(Array.isArray(gateConfig.flakyRetryGates) ? gateConfig.flakyRetryGates : ['backend-test', 'engine-tests']);
  const tailOf = (r, n = 20) => `${r.stdout || ''}\n${r.stderr || ''}`.trimEnd().split(/\r?\n/).slice(-n).join('\n');
  const runGate = async (i) => {
    const gate = gates[i];
    const first = await startGate(i);
    if (!flakyRetryEnabled || first.status === 0 || !retryGates.has(gate.id)) return first;
    const attribution = classifyFailure(`${first.stdout || ''}\n${first.stderr || ''}`);
    if (attribution !== 'flaky') return first;
    console.log(`[verify] 🔁 ${gate.name} 首跑红且命中 flaky 签名——隔离重跑一次（两跑结果都报告）...`);
    const second = await startGate(i);
    return { ...second, flakyRetry: true, firstStatus: first.status, firstTail: tailOf(first) };
  };

  // 依赖边（deps）：本门须待所列门**成功**后才启动——backend-test 走 --no-build 直接消费 backend-build
  // 产物（verify-diet ③，双构建已消）；deps 兼任门序：构建红 → 测试不启动。串行后 19s+81s 仍在
  // engine-tests 的影子里，不增墙钟。依赖门红/未跑 → 本门不启动（状态未知，由尾段清单兜底）。
  const idxOf = new Map(gates.map((g, i) => [g.id, i]));
  const gatePromise = new Map(); // 门序 -> 该门结果 Promise（依赖方 await 用）

  // 守卫段（guardian）：串行先跑、未过即止——后序门一并不启动
  for (let i = 0; i < gates.length && failedIdx < 0; i++) {
    if (!gates[i].guardian) continue;
    const p = runGate(i);
    gatePromise.set(i, p);
    if (finishGate(i, await p) && failedIdx < 0) failedIdx = i;
  }

  if (failedIdx < 0) {
    // 主体段：工作池并发（完成一个补一个）；任一门红 → 停排新门 + 树杀在跑门（fail-fast 语义保留）
    const bodyIdx = gates.map((_, i) => i).filter((i) => !gates[i].guardian);
    let cursor = 0;
    const worker = async () => {
      while (failedIdx < 0 && cursor < bodyIdx.length) {
        const i = bodyIdx[cursor++];
        const deps = gates[i].deps || [];
        if (deps.length) {
          const depResults = await Promise.all(deps.map((d) => gatePromise.get(idxOf.get(d)) ?? Promise.resolve(null)));
          if (failedIdx >= 0) return;
          if (depResults.some((r) => !r || r.status !== 0)) continue; // 依赖未过 → 本门不启动
        }
        const p = runGate(i);
        gatePromise.set(i, p);
        if (finishGate(i, await p) && failedIdx < 0) {
          failedIdx = i;
          for (const [j, child] of [...running]) { aborted.add(j); killTree(child); }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOBS, bodyIdx.length) }, worker));
  }

  if (failedIdx >= 0) {
    // 未执行门清单（2026-10-11 D2；2026-10-16 并发编排后按「已出裁决」算）：fail-fast 后状态未知≠通过——
    // 验证系统输出须完备，与 E2E loud-skip 对称（否则「没跑」在台账里与「过了」不可区分）。
    const remaining = gates.map((g, i) => i).filter((i) => !doneIdx.has(i)).map((i) => gates[i].id);
    if (remaining.length) console.error(`[verify] ⏭️ 未执行门（fail-fast，状态未知）：${remaining.join('、')}`);
    process.exit(1);
  }

  // ---- 全绿尾段（任一门红已在上方 exit 1 返回，能走到这里即全绿）----
  // 引擎段增量门不落 all-gates 凭证（头注：13 门绿 ≠ 20 门关单凭证）——台账/摘要双跳过；
  // fixture 绿行照落（带 testCmd:true 标记，hasFreshVerifyLine 不认——测试面沿既有契约）
  if (!engineOnly) {
    let entry = null;
    try {
      entry = { ts: new Date().toISOString(), exitCode: 0, suite: 'all-gates', gates: passedCount };
      // HEAD 短 SHA 钉进绿行本体（2026-10-09 AI-Native 架构审查修复收尾）：确定性证据此前只存在于测试
      // 夹具、绿行无 SHA 可锚定验证对象；非 git 环境（fixture 根在 os.tmpdir）解析失败则省略该键，不伪造。
      const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: ROOT });
      if (rev.status === 0 && rev.stdout) entry.headShort = rev.stdout.trim();
      const counts = parseCounts(outputs['engine-tests'] || outputs['test'] || '');
      if (counts) Object.assign(entry, counts);
      // 门禁成本入账（G8）：逐门毫秒 + 总耗时，metrics 消费。
      // totalMs = 各门之和（并发后已非墙钟，保留以续接历史口径）；wallMs = 本次实际墙钟（2026-10-16
      // 并行编排引入）——「一次迭代的等待成本」是墙钟，metrics 表以 wallMs 优先。
      entry.totalMs = Object.values(durations).reduce((a, b) => a + b, 0);
      entry.wallMs = Math.round(performance.now() - wallStart);
      entry.durations = durations;
      if (testCmd) entry.testCmd = true;
      // flaky 重跑绿（gate-health 2026-10-22）：绿行记录哪些门是「首跑红、重跑绿」——审计可对质，
      // 不把偶发洗成无痕。hasFreshVerifyLine 仍认其为关单凭证（门最终绿了）。
      if (flakyGates.length) entry.flaky = flakyGates;
      // CI-only 本地跳过（verify-diet 二批 P0-2）：绿行记录跳过事实——审计面可对质「该行没跑哪些门、为何」。
      if (envSkipIds.size) entry.envSkips = [...envSkipIds];
      // scope 增量凭证标记（verify-diet ②）：gen-verify-evidence 渲染进摘要行，审计面可对质
      // 「该绿行跑了哪些门、基于哪个基线」；hasFreshVerifyLine 认其为合法关单凭证（口径见 verify-scope.mjs）。
      // **只在真裁掉门时打标记**（verify-scope-default 2026-10-22 修复）：变截面全触及 → 20 门照跑全量，
      // 该行实质是全量绿，若仍挂 scope 标记就不再被认作全量绿锚（24h 兜底与基线 hint 的双重锚）——
      // 基线会冻结在此处永不前进，变截面越滚越大，默认档永久退化为全量。零裁剪即零标记，ratschet 才转得动。
      if (scopeMode && scope && scope.skippedGateIds.length) entry.scope = { mode: scopeMode, base: scope.baseShort, baseSource: scope.baseSource, skipped: scope.skippedGateIds, fileCount: scope.fileCount };
      // 分层跑标记（2026-10-23）：diff 档 engine-tests 用 --fast——绿行记录，审计可对质。
      if (fastEngineTests) entry.fastTests = true;
      if (process.env.PIPELINE_RUN_ID) entry.runId = process.env.PIPELINE_RUN_ID;
      if (!LEDGER.writable) {
        console.error(`[verify] ❌ ${ledgerRefusal(LEDGER.status, LEDGER.detail)}（门全绿但不产出凭证——无凭证即不可关单）`);
      } else {
        fs.mkdirSync(path.join(ROOT, '.agents'), { recursive: true });
        fs.appendFileSync(path.join(ROOT, '.agents', 'verifications.jsonl'), `${JSON.stringify(entry)}\n`);
        console.log(`[verify] 🧾 全绿凭证已落账 verifications.jsonl`);
      }
    } catch (e) {
      console.error(`[verify] ⚠️ 凭证落账失败: ${e.message}`);
    }
    // 摘要事件原子化（2026-10-11 C4）：全绿事实与仓内摘要（workflow/verify-evidence.md——检查 23 收敛
    // 硬门自 convergenceHardSince 2026-10-12 起的读源）同刻生成，消除「本地台账已绿、committed 摘要滞后」
    // 的双真相分叉。仅生产全量模式（fixture 假门 / 引擎段增量门均不得产凭证）；生成失败响亮告警但不
    // 推翻绿裁决（同落账口径）。
    if (!testCmd) {
      const top3 = Object.entries(durations).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, ms]) => `${id}(${(ms / 1000).toFixed(1)}s)`).join(' ');
      const wallMs = entry ? entry.wallMs : Math.round(performance.now() - wallStart);
      const totalMs = entry ? entry.totalMs : Object.values(durations).reduce((a, b) => a + b, 0);
      // 成本预算（gate-budget 2026-10-22）：advisory——超限只告警不阻断；把「体感重」变成可对质的数字。
      const budget = readGateBudget(ROOT, scopeMode ? 'scopeMs' : 'fullMs');
      const over = budget !== null && wallMs > budget;
      const budgetNote = budget === null ? '' : `（预算 ${(budget / 1000).toFixed(0)}s${over ? `，超 ${((wallMs / budget - 1) * 100).toFixed(1)}%` : ''}）`;
      console.log(`[verify] ⏱️ 门禁成本：墙钟 ${(wallMs / 1000).toFixed(1)}s${budgetNote}｜各门合计 ${(totalMs / 1000).toFixed(1)}s｜最慢三门 ${top3}`);
      if (over) {
        console.log('[verify] ⚠️ 门禁成本超预算——下一批须退役一门（一进一出；候选 node <插件根>/scripts/agg-judgments.mjs --retire-candidates）');
      }
      const gen = LEDGER.writable
        ? spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'gen-verify-evidence.mjs'), '--root', ROOT], { encoding: 'utf8' })
        : null;
      if (gen === null) {
        console.error(`[verify] ❌ ${ledgerRefusal(LEDGER.status, LEDGER.detail)}（仓内摘要 verify-evidence.md 未生成）`);
      } else if (gen.status === 0) {
        if (gen.stdout) process.stdout.write(String(gen.stdout).trimEnd() + '\n');
      } else {
        console.error(`[verify] ⚠️ 绿凭证摘要生成失败（${String(gen.stderr || gen.stdout || '').trim().slice(0, 200)}）——绿裁决不变，手动补跑 node <插件根>/scripts/gen-verify-evidence.mjs`);
      }
    }
  }
  if (engineOnly) {
    console.log(`\n[verify] ✅ 引擎段 ${passedCount} 门全绿——增量门通过（非 20 门关单凭证，不落 all-gates 台账与摘要）`);
  } else {
    console.log(`\n[verify] 🎉 全绿——可以关单（共 ${passedCount} 项通过）`);
  }
}

// CLI 入口守卫（2026-10-27 插件化迁移）：optionalGateMissing 导出后本文件可被测试 import（锁门表语义），
// 仅直跑时执行编排（与 workflows-check.mjs / gen-engine-map.mjs 同款守卫口径）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => {
    console.error(`[verify] 💥 运行时崩溃: ${e.stack}`);
    process.exit(1);
  });
}
