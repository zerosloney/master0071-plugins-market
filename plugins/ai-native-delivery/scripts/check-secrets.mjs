#!/usr/bin/env node
// check-secrets：gitleaks 包装门（2026-10-14 决定 4 / G5 安全插队；机制台账已登记）
// 用法：node <插件根>/scripts/check-secrets.mjs [--staged] [--lite]
//   默认     = 全量历史：gitleaks detect --baseline-path .gitleaks-baseline.json（基线外新泄漏 exit 1）
//   --staged = 提交增量：gitleaks protect --staged（只看暂存内容，历史存量不触；原 pre-commit 消费——
//              2026-10-21 owner 指令「密钥本地不扫」退役该腿，旗标保留供手动/测试）
// 二进制解析序（机理登记 = .agents/notes/runtime-env.md §6.3 gitleaks 条）：
//   GITLEAKS_BIN 环境变量（.mjs/.js 结尾经本进程 node 直跑——测试注缝）→ PATH 上 gitleaks
//   → .agents/tools/gitleaks(.exe)（git-ignore，机器本地）。
// **兜底接续（判据移植「装不上也要扫」）**：三处皆缺（典型 = CI agent 无外网/无法落二进制），
//   改走纯 Node 轻量扫描 check-secrets-lite.mjs（零二进制零网络，复用同一份基线做文件级豁免）——
//   **不再 loud-skip**：密钥门从此恒执法，只是执法者按环境降级（gitleaks → lite），退出码原样透传。
//   强制指定：SECRETS_SCAN_LITE=1 或 --lite 跳过 gitleaks；SECRETS_SCAN_REQUIRE_GITLEAKS=1 则缺二进制即
//   fail-closed（exit 2，供需要强执法面的场合）。降级事实在输出首行标明「执法者=lite」，不再发
//   GATE_SKIPPED 标记（门已执法，verify 绿行保留全量锚资格；强执法面 = 装机 gitleaks 全史逐行匹配）。
// 基线：.gitleaks-baseline.json = 使用项目自有资产（存量豁免清单，gitleaks detect --redact 全量报告
//   生成；真实有效密钥的作废轮换另行处置，不因基线豁免；不随插件分发，从扫描根读取）。
//   detect 模式基线缺失 = exit 2
//   （配置失守 fail-closed——静默无基线会让存量全量爆红，与拍板相反）。
// 测试：node <插件根>/test/check-secrets.test.mjs（CHECK_SECRETS_ROOT + GITLEAKS_BIN 指向 stub）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findProjectRoot, projectRoot } from './paths.mjs';
import { main as liteMain } from './check-secrets-lite.mjs';

// ROOT 解析（2026-10-28 收口）：env 注入（测试夹具契约）→ 项目 git 根（findProjectRoot）→ cwd。
// 此前回退是旧锚 <script>/../..：插件形态下解析到市场仓的 plugins/，基线文件与本地 gitleaks
// 都去那里找，结果是「基线缺失 → exit 2 拒跑」的误报原因难以归因。源仓夹具复制进
// <tmp>/.agents/scripts/ 且 cwd=<tmp> 时，cwd 回退与旧锚等价。
const ROOT = process.env.CHECK_SECRETS_ROOT
  || findProjectRoot()
  || projectRoot();
const STAGED = process.argv.includes('--staged');
const FORCE_LITE = process.argv.includes('--lite') || process.env.SECRETS_SCAN_LITE === '1';
const BASELINE = path.join(ROOT, '.gitleaks-baseline.json');

function resolveBin() {
  if (FORCE_LITE) return null;
  const envBin = process.env.GITLEAKS_BIN;
  if (envBin) {
    if (!fs.existsSync(envBin)) return null;
    return /\.(mjs|js)$/i.test(envBin) ? { node: envBin } : { raw: envBin };
  }
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (probe.status === 0) return { raw: 'gitleaks' };
  const local = path.join(ROOT, '.agents', 'tools', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
  if (fs.existsSync(local)) return { raw: local };
  return null;
}

const bin = resolveBin();
if (!bin) {
  if (process.env.SECRETS_SCAN_REQUIRE_GITLEAKS === '1' && !FORCE_LITE) {
    console.error('[check-secrets] ❌ SECRETS_SCAN_REQUIRE_GITLEAKS=1 但 gitleaks 三处解析皆缺——按配置 fail-closed 拦下（装机：官方 zip 解压 .agents/tools/ 或装进 PATH）');
    process.exit(2);
  }
  if (!STAGED && !fs.existsSync(BASELINE)) {
    console.error(`[check-secrets] ❌ 基线缺失 ${BASELINE}——轻量扫描同样依赖豁免清单，拒跑。重建：gitleaks detect --redact 全量报告存为该文件（无存量项目用 [] 起步）`);
    process.exit(2);
  }
  console.error(`[check-secrets] ℹ️ 执法者=lite（gitleaks 不可用${FORCE_LITE ? '／已强制 --lite' : '——未装或 CI 无外网'}）：纯 Node 轻量规则 + 同一基线文件级豁免；强执法面（全史逐行模式匹配）请装 gitleaks（装机见 .agents/notes/runtime-env.md §6.3 gitleaks 条）`);
  process.exit(liteMain(STAGED ? ['--staged'] : [], ROOT));
}
if (!STAGED && !fs.existsSync(BASELINE)) {
  console.error(`[check-secrets] ❌ 基线缺失 ${BASELINE}——detect 无基线 = 存量豁免失效全量爆红，拒跑。重建：gitleaks detect --redact 全量报告存为该文件（口径见 runtime-env §6.3）`);
  process.exit(2);
}
const args = STAGED
  ? ['protect', '--staged', '--redact', '--no-banner']
  : ['detect', '--source', '.', '--baseline-path', BASELINE, '--redact', '--no-banner'];
// gitleaks 挂起不挂死门禁（2026-11-09 审查收口）：120s 上界（verify 侧另有 300s 门级看门狗）
const r = bin.node
  ? spawnSync(process.execPath, [bin.node, ...args], { stdio: 'inherit', timeout: 120_000 })
  : spawnSync(bin.raw, args, { stdio: 'inherit', timeout: 120_000 });
if (r.status !== 0) {
  console.error(`[check-secrets] ❌ ${STAGED ? '暂存内容' : '历史（基线外）'}发现密钥泄漏（gitleaks exit ${r.status}）——上方为 redacted 明细；新泄漏修法：删除该密钥或作废轮换，禁改基线豁免`);
  process.exit(r.status ?? 1);
}
console.log(`[check-secrets] ✅ ${STAGED ? '暂存增量' : '全量（基线外）'}无泄漏`);
