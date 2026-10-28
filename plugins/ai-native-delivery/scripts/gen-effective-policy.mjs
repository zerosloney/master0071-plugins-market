#!/usr/bin/env node
// gen-effective-policy.mjs — 当前生效规则视图生成器（2026-10-09 AI-Native 架构审查 P2-5）
// 背景：豁免锚经 policy v1→v8 演进后，「存量豁免 vs 受管」的合成语义只活在 check-loop.mjs 源码里，
//   规则空间永久二分且不可读——本脚本把 policy.mjs 单源渲染为人可读的 workflow/effective-policy.md，
//   与 INDEX.md 同款「生成物 + --check 防漂移」纪律；verify.mjs 挂 --check 门（CI 强制随 policy 变更重生成）。
// 渲染内容：当前生效 policyVersion（engine.json，缺省回落 v1）、逐锚键的生效日 / 消费检查项 / 分级现状
//   （hard·已生效 / advisory·已生效 / 未到期——锚日 > 今日的升级锚标注「待升级」）。
// 判定单源：锚定义 = policy.mjs POLICIES（本脚本不写日期，只读只渲染）；键→检查项映射取自
//   check-loop.mjs 头部检查清单（编号是文档引用锚，此处仅作说明文本）。
// 用法：node <插件根>/scripts/gen-effective-policy.mjs [--root <dir>] [--check]
//   --check：与磁盘 workflow/effective-policy.md 比对，漂移 exit 1（CI/verify 用）。
//   比对前双侧行尾归一（CRLF→LF）。生成器仍只写 LF，--check 不改文件。
//   干净的 autocrlf 检出是 CRLF，字节相等会假红，且重生成只留下不可提交的行尾差。
// 测试：node <插件根>/test/gen-effective-policy.test.mjs（fixture 注入 --root）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, projectRoot } from './paths.mjs';
import { POLICIES, loadKitPolicy } from './policy.mjs';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
// ROOT 解析（2026-10-28 收口）：--root 注入（测试夹具契约）→ 项目 git 根（findProjectRoot）→ cwd。
// 此前回退是旧锚 <script>/../..：插件形态下解析到市场仓的 plugins/，生成的 effective-policy.md
// 会写进别人的目录（且 --check 会据此报漂移）。
const ROOT = argOf('--root') || findProjectRoot() || projectRoot();
const OUT = path.join(ROOT, 'workflow', 'effective-policy.md');

// 键 → 消费检查项与分级说明（单源 check-loop 检查清单编号；说明文本与本脚本共同演进）
const CONSUMERS = {
  moduleSince: ['检查 12', 'frontmatter「模块:」枚举合法性', 'advisory'],
  check14Since: ['检查 14', '新 done 的 spec/plan 须有 approved git 历史——advisory 生效锚', 'advisory'],
  check14HardSince: ['检查 14', '同上——锚日起升 hard-block', 'hard'],
  confirmDocsEffective: ['检查 15', 'docs 确认台账两条件准入（台账行 ∪ 自报日期≥锚）', 'hard'],
  confirmIncidentsEffective: ['检查 15', 'incidents 档确认阈值（fixed/closed 配对）', 'hard'],
  bindingTs: ['检查 15', '四终态内容绑定（台账行 ts≥锚 才比对 sha256）', 'hard'],
  delegationSince: ['检查 18', '委派台账对账——锚前存量豁免', 'advisory'],
  stageGateSince: ['检查 19', '逐阶段审计（起草先于入口确认 / 台账顺序）', 'advisory'],
  check17UnclosedAfter: ['检查 17', '发版提交树未收口三件套——版本 tag 锚（非日期）', 'hard'],
  verifySince: ['检查 8', '测试绿声明对账（无 SHA 声明「测试绿」须 24h 内凭证）+ confirm-doc →done 前置', 'advisory'],
  verifyHardSince: ['confirm-doc', '→done 测试绿凭证——锚日起升 hard（拒无凭证关单）', 'hard'],
  incidentRegrSince: ['检查 3', '防复发验证证据门（fixed/closed 须落自动化用例/回归清单引用）', 'hard'],
  specVerifSince: ['检查 21', 'spec 验证落地核查（L2/L3 done 的验证计划须引用测试文件/命令）', 'advisory'],
  attributionSince: ['检查 24', 'incident 归因字段（来源/影响环境 枚举存在性与合法性）——锚前存量豁免', 'advisory'],
  convergenceSince: ['检查 23', '判据级收敛对账（L2/L3 done spec 验收判据表逐条对证据——完成声明不是证据）——锚前存量豁免', 'advisory'],
  convergenceHardSince: ['检查 23', '同上——证据无效升 hard（命令须有不早于 spec 日期的 verify-evidence 全绿行；路径只认存在）', 'hard'],
  reviewerSince: ['检查 1', '独立复核上下文标识（复核行须含「复核上下文：<会话/子代理 id>」——独立性声明可证伪化）——锚前存量豁免', 'advisory'],
};

// today：视图基准日。EFFECTIVE_POLICY_TODAY 为测试注入缝（场景 2f 跨锚日稳定性用；生产不设）。
const today = () => process.env.EFFECTIVE_POLICY_TODAY || new Date().toISOString().slice(0, 10);

function render(viewDateStr) {
  const policy = loadKitPolicy(ROOT);
  const v = POLICIES[policy.policyVersion] || {};
  const todayStr = viewDateStr || today();
  const lines = [];
  lines.push('# 当前生效规则视图（生成物，勿手改）');
  lines.push('');
  lines.push('> 生成器 `node <插件根>/scripts/gen-effective-policy.mjs`（policy.mjs 单源渲染；漂移由 verify.mjs `effective-policy` 门 --check 把关——改 policy 后须重生成并随同提交）。');
  lines.push(`> 当前生效：**policyVersion ${policy.policyVersion}**（engine.json 声明 ${policy.requestedVersion}${policy.requestedVersion === policy.policyVersion ? '' : '，不在 POLICIES 表内已回落 v1'}）；视图日期 ${todayStr}。`);
  lines.push('');
  lines.push('| 锚键 | 生效日/锚 | 消费检查项 | 语义 | 分级 | 现状 |');
  lines.push('|---|---|---|---|---|---|');
  for (const key of Object.keys(v)) {
    const raw = v[key];
    const c = CONSUMERS[key] || ['—', '（未登记消费方——policy 加新键时同步登 CONSUMERS）', '—'];
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw));
    // 升级锚语义：日期 > 今日 = 未到期（维持低档）；其余 = 已生效
    const status = !isDate ? '生效（版本锚）' : (String(raw) <= todayStr ? '已生效' : `待升级（${raw} 起）`);
    lines.push(`| \`${key}\` | ${raw} | ${c[0]} | ${c[1]} | ${c[2]} | ${status} |`);
  }
  lines.push('');
  lines.push('<!-- GENERATED:BEGIN — gen-effective-policy.mjs 整段重写，手工说明写在本行之前 -->');
  return lines.join('\n') + '\n';
}

const text = render();
// 行尾归一（与 gen-workflow-index.mjs normEol 同句）：只影响 --check 判定，写盘仍是 LF。
const normEol = (s) => String(s).replace(/\r\n/g, '\n');
if (argv.includes('--check')) {
  let disk = '';
  try {
    disk = fs.readFileSync(OUT, 'utf8');
  } catch { /* 缺文件视作空——走漂移分支 */ }
  // 锚日时间炸弹拆除（2026-10-12 CI 实证：v12 两锚定 10-12，10-11 生成的视图含「待升级（10-12 起）」，
  // 锚日当天重渲染按当日判「已生效」→ 与仓内视图必差 → --check 必红——任何未来日期锚都会在锚日引爆）。
  // 修法：--check 对**磁盘文件自带的视图日期**重渲染（生成物与自身生成日自洽，跨锚日字节稳定）；
  // 显式重生成（默认模式）才前进视图日期并翻转状态列。视图日期行缺失的存量件回落当日口径。
  const mDate = disk.match(/视图日期 (\d{4}-\d{2}-\d{2})/);
  const checkText = mDate ? render(mDate[1]) : text;
  if (normEol(disk) === normEol(checkText)) {
    console.log('[effective-policy] ✅ 与磁盘一致（无漂移；按磁盘视图日期重渲染比对）');
    process.exit(0);
  }
  console.error('[effective-policy] ❌ 漂移：policy/engine 变更后未重生成 workflow/effective-policy.md');
  console.error('  修法：node <插件根>/scripts/gen-effective-policy.mjs && git add workflow/effective-policy.md（随 policy 变更同笔提交）');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`✅ 已生成 ${path.relative(process.cwd(), OUT)}`);
