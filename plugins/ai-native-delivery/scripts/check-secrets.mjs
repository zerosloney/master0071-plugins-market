#!/usr/bin/env node
// check-secrets：gitleaks 包装门（2026-10-14 决定 4 / G5 安全插队；机制台账已登记）
// 用法：node <插件根>/scripts/check-secrets.mjs [--staged]
//   默认     = 全量历史：gitleaks detect --baseline-path .gitleaks-baseline.json（基线外新泄漏 exit 1）
//   --staged = 提交增量：gitleaks protect --staged（只看暂存内容，历史存量不触；原 pre-commit 消费——
//              2026-10-21 owner 指令「密钥本地不扫」退役该腿，旗标保留供手动/测试）
// 二进制解析序（机理登记 = .agents/notes/runtime-env.md §6.3 gitleaks 条）：
//   GITLEAKS_BIN 环境变量（.mjs/.js 结尾经本进程 node 直跑——测试注缝）→ PATH 上 gitleaks
//   → .agents/tools/gitleaks(.exe)（git-ignore，机器本地）。三处皆缺 = 响亮跳过 exit 0
//   （loud-skip 诚实原则：跳过可见；不 fail-closed，未装机机器仍可提交）。
// 基线：.gitleaks-baseline.json = 2026-10-14 历史全量 1221 处存量豁免（--redact 生成；用户拍板
//   「豁免清单」，真实有效密钥的作废轮换另行处置，不因基线豁免）。2026-10-15 同口径重生成扩至 1227 处：
//   追加 7bd06ebb（历史业务系统动作脚本）6 处「权限Key」uuid——用户确认系旧系统权限条目
//   标识符非凭证，与既有 wiki 产品需求采集物同类同处置。2026-10-24 再生成扩至 1230 处：追加
//   e6f33915/919e7084 私有 npm 源 _auth 3 处（frontend/.npmrc ×2 + 文档抄录 ×1，同凭据家族）——
//   用户拍板「公司私有 npm 源 Basic 认证凭据豁免，不作废轮换，下次不再扫」（内部源端点见项目侧登记，不随插件分发）。
//   detect 模式基线缺失 = exit 2
//   （配置失守 fail-closed——静默无基线会让存量全量爆红，与拍板相反）。
// 测试：node <插件根>/test/check-secrets.test.mjs（CHECK_SECRETS_ROOT + GITLEAKS_BIN 指向 stub）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findProjectRoot, projectRoot } from './paths.mjs';

// ROOT 解析（2026-10-28 收口）：env 注入（测试夹具契约）→ 项目 git 根（findProjectRoot）→ cwd。
// 此前回退是旧锚 <script>/../..：插件形态下解析到市场仓的 plugins/，基线文件与本地 gitleaks
// 都去那里找，结果是「基线缺失 → exit 2 拒跑」的误报原因难以归因。源仓夹具复制进
// <tmp>/.agents/scripts/ 且 cwd=<tmp> 时，cwd 回退与旧锚等价。
const ROOT = process.env.CHECK_SECRETS_ROOT
  || findProjectRoot()
  || projectRoot();
const STAGED = process.argv.includes('--staged');
const BASELINE = path.join(ROOT, '.gitleaks-baseline.json');

function resolveBin() {
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
  console.error('[check-secrets] ⏭️ gitleaks 未安装——密钥门本轮未执法（loud-skip，跳过可见）。装机：见 .agents/notes/runtime-env.md §6.3 gitleaks 条（官方 zip 解压 .agents/tools/ 或装进 PATH）');
  process.exit(0);
}
if (!STAGED && !fs.existsSync(BASELINE)) {
  console.error(`[check-secrets] ❌ 基线缺失 ${BASELINE}——detect 无基线 = 存量豁免失效全量爆红，拒跑。重建：gitleaks detect --redact 全量报告存为该文件（口径见 runtime-env §6.3）`);
  process.exit(2);
}
const args = STAGED
  ? ['protect', '--staged', '--redact', '--no-banner']
  : ['detect', '--source', '.', '--baseline-path', BASELINE, '--redact', '--no-banner'];
const r = bin.node
  ? spawnSync(process.execPath, [bin.node, ...args], { stdio: 'inherit' })
  : spawnSync(bin.raw, args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`[check-secrets] ❌ ${STAGED ? '暂存内容' : '历史（基线外）'}发现密钥泄漏（gitleaks exit ${r.status}）——上方为 redacted 明细；新泄漏修法：删除该密钥或作废轮换，禁改基线豁免`);
  process.exit(r.status ?? 1);
}
console.log(`[check-secrets] ✅ ${STAGED ? '暂存增量' : '全量（基线外）'}无泄漏`);
