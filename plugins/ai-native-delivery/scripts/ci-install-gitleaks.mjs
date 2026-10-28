#!/usr/bin/env node
// ci-install-gitleaks — CI agent 装机 gitleaks 至 .agents/tools/（2026-10-15 papercut 消债，分片
//   workflow/papercuts.d/2026-10.md 2026-10-15 行，控制器合并视图 L91）。动机：verify 安全段
//   secrets-scan（check-secrets.mjs）三处解析（GITLEAKS_BIN→PATH→.agents/tools/）在 CI agent 全空
//   → 响亮跳过不执法，main 直推全量在 CI 不设防（runtime-env §6.2 单源登记）。本脚本在 main 全量
//   verify 前置一步：GitHub releases 官方 zip 下载解压至 .agents/tools/，复用既有解析序（不新开口子）。
// fail-closed：下载/校验/解压/版本核验任一失败 = exit 1——宁可红，不可静默降级回「跳过不执法」。
// 完整性校验（2026-10-28 审计 P1 补齐）：下载的 zip 先校 sha256（官方 release 的
//   gitleaks_8.30.1_checksums.txt），不匹配即 fail-closed 不解压不落盘。
//   为什么必须有：解压后比对 `gitleaks version` 字符串**只验版本号、不验二进制来源**——
//   被替换的同版本二进制照样通过那道检查，而 CI agent 随后会拿它扫全仓密钥。校验失败的红，
//   比「装了一个来路不明的扫描器」安全得多（后者会静默给出「已扫描干净」的假绿）。
//   校验值随版本硬编码在下方 SHA256 表——升版时从官方 checksums 文件同步更新该表（离线可审计，
//   不在安装路径上再拉一次校验文件）。未知平台 = 响亮失败（不放行）。
// 版本锚 8.30.1：与本机及基线生成口径一致（runtime-env §6.3）。agent = 自托管 Windows 池（池名随项目 CI 登记，不随插件分发），
//   解压走 PowerShell Expand-Archive；非 win32 回退 tar -xf（bsdtar 可解 zip），供他日换池。
// checkout clean:true 每跑重装（.agents/tools/ 在工作区内随清）——~10MB/跑 换确定性，缓存化留待再登记。
// 本机验证：GITLEAKS_TOOLS_DIR 指临时目录直跑（下载/解压/核验三步全走）；CI 用缺省 .agents/tools/。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '8.30.1';
const win = process.platform === 'win32';
const plat = win ? 'windows_x64' : 'linux_x64';
const URL = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${plat}.zip`;
// 官方 sha256（取自 release 的 gitleaks_8.30.1_checksums.txt，2026-10-28 核对）。
// 键 = 平台名（与 URL 里的 ${plat} 同口径），值 = 该平台 zip 的 sha256 十六进制。
const SHA256 = {
  windows_x64: 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const toolsDir = process.env.GITLEAKS_TOOLS_DIR || path.join(ROOT, '.agents', 'tools');
const bin = path.join(toolsDir, win ? 'gitleaks.exe' : 'gitleaks');

const probe = () => spawnSync(bin, ['version'], { encoding: 'utf8' });

if (fs.existsSync(bin)) {
  const p = probe();
  if (p.status === 0 && String(p.stdout).includes(VERSION)) {
    console.log(`[ci-install-gitleaks] 已装机 ${VERSION}（${bin}）——幂等跳过下载`);
    process.exit(0);
  }
  console.error('[ci-install-gitleaks] 既有二进制版本核验异常，重装覆盖');
}

fs.mkdirSync(toolsDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-ci-'));
const zip = path.join(tmp, 'gitleaks.zip');
console.log(`[ci-install-gitleaks] 下载 ${URL}`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`[ci-install-gitleaks] ❌ 下载失败 HTTP ${res.status}——secrets-scan 将无法执法，fail-closed 拦 build`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
// 完整性校验先行：sha256 不匹配即中止（不解压、不落盘、不执行）。
// 版本号字符串比对不构成来源证明——同版本的被替换二进制照样过；这里比的是字节本身。
const expected = SHA256[plat];
if (!expected) {
  console.error(`[ci-install-gitleaks] ❌ 平台 ${plat} 无登记的 sha256（SHA256 表缺该键）——拒绝安装未知来源的二进制`);
  process.exit(1);
}
const actual = createHash('sha256').update(buf).digest('hex');
if (actual !== expected) {
  console.error(`[ci-install-gitleaks] ❌ sha256 校验不通过（期望 ${expected}，实得 ${actual}）——解压物与官方 release 不符，拒绝安装`);
  console.error('  处置：确认网络出口未被劫持；确需升级版本时，从官方 release 的 gitleaks_<版本>_checksums.txt 同步本文件 SHA256 表');
  process.exit(1);
}
console.log(`[ci-install-gitleaks] sha256 校验通过（${actual.slice(0, 16)}…）`);
fs.writeFileSync(zip, buf);

const extract = win
  ? spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-Path', zip, '-DestinationPath', tmp, '-Force'], { encoding: 'utf8' })
  : spawnSync('tar', ['-xf', zip, '-C', tmp], { encoding: 'utf8' });
if (extract.status !== 0) {
  console.error(`[ci-install-gitleaks] ❌ 解压失败：${extract.stderr || '(无 stderr)'}`);
  process.exit(1);
}
const inner = path.join(tmp, win ? 'gitleaks.exe' : 'gitleaks');
if (!fs.existsSync(inner)) {
  console.error(`[ci-install-gitleaks] ❌ 解压产物缺 ${inner}（zip 结构变更？）`);
  process.exit(1);
}
fs.copyFileSync(inner, bin);
fs.rmSync(tmp, { recursive: true, force: true });

const p = probe();
if (p.status !== 0 || !String(p.stdout).includes(VERSION)) {
  console.error(`[ci-install-gitleaks] ❌ 装机后版本核验失败（exit ${p.status}，out：${p.stdout}）——fail-closed 拦 build`);
  process.exit(1);
}
console.log(`[ci-install-gitleaks] ✅ gitleaks ${VERSION} 装机完成（sha256 已核）：${bin}——check-secrets 解析序第三级就位，secrets-scan 将真执法`);
