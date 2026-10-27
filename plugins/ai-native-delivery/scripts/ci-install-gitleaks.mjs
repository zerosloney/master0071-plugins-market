#!/usr/bin/env node
// ci-install-gitleaks — CI agent 装机 gitleaks 至 .agents/tools/（2026-10-15 papercut 消债，分片
//   workflow/papercuts.d/2026-10.md 2026-10-15 行，控制器合并视图 L91）。动机：verify 安全段
//   secrets-scan（check-secrets.mjs）三处解析（GITLEAKS_BIN→PATH→.agents/tools/）在 CI agent 全空
//   → 响亮跳过不执法，main 直推全量在 CI 不设防（runtime-env §6.2 单源登记）。本脚本在 main 全量
//   verify 前置一步：GitHub releases 官方 zip 下载解压至 .agents/tools/，复用既有解析序（不新开口子）。
// fail-closed：下载/解压/版本核验任一失败 = exit 1——宁可红，不可静默降级回「跳过不执法」。
// 版本锚 8.30.1：与本机及基线生成口径一致（runtime-env §6.3）。agent = 自托管 Windows 池（池名随项目 CI 登记，不随插件分发），
//   解压走 PowerShell Expand-Archive；非 win32 回退 tar -xf（bsdtar 可解 zip），供他日换池。
// checkout clean:true 每跑重装（.agents/tools/ 在工作区内随清）——~10MB/跑 换确定性，缓存化留待再登记。
// 本机验证：GITLEAKS_TOOLS_DIR 指临时目录直跑（下载/解压/核验三步全走）；CI 用缺省 .agents/tools/。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '8.30.1';
const win = process.platform === 'win32';
const plat = win ? 'windows_x64' : 'linux_x64';
const URL = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${plat}.zip`;
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
fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

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
console.log(`[ci-install-gitleaks] ✅ gitleaks ${VERSION} 装机完成：${bin}——check-secrets 解析序第三级就位，secrets-scan 将真执法`);
