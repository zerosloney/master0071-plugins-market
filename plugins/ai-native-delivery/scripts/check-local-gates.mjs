#!/usr/bin/env node
// check-local-gates.mjs — 门卫上岗自检（eli5 卡片 4，2026-10-08）
// 本机两条 clone 必做配置 + 钩子文件在位 + 工具链（node/dotnet）在位七项检测；--fix 自动修配置项（文件类缺失给恢复指引，不代修）。
// ⑥ 起工具链按「环境变量（仅浏览器 CHROME_PATH）→ 本机登记 runtime-env.local.md → 标准安装位置探测」解析并回显路径（机理 runtime-env.md §6.3，
// 2026-10-10 本机事实出库——绝对路径不再入库登记，新机按回显补登记即可）。
// 鸡生蛋约束：钩子没挂时任何钩子面检测不可达，故自检必须是独立脚本 + 显著入口（README 入门节 / AGENTS.md 头部）。
// 用法：node .agents/scripts/check-local-gates.mjs [--fix]
// 退出码：0 全过 / 1 有缺。零工作区副作用（只读 git config + 文件存在性检测）。

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const fix = process.argv.includes('--fix');
const git = (args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; }
};

const results = [];
const check = (ok, name, detail, fixCmd) => results.push({ ok, name, detail, fixCmd });

// ① core.hooksPath → .githooks（五钩子的挂载点）
const hooksPath = git(['config', 'core.hooksPath']);
check(hooksPath === '.githooks', 'core.hooksPath → .githooks',
  hooksPath ? `当前值: ${hooksPath}` : '未配置', 'git config core.hooksPath .githooks');

// ② merge.ours.driver（appsettings.json 合并保护的本地开关）
const ours = git(['config', 'merge.ours.driver']);
check(ours === 'true', 'merge.ours.driver = true',
  ours ? `当前值: ${ours}` : '未配置', 'git config merge.ours.driver true');

// ②b merge.jsonl-union.driver（.agents/*.jsonl 台账并发去重合并驱动）
const jsonlDriver = git(['config', 'merge.jsonl-union.driver']);
const expectedJsonlDriver = 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';
check(jsonlDriver === expectedJsonlDriver, 'merge.jsonl-union.driver（台账并发并集合并驱动）',
  jsonlDriver ? `当前值: ${jsonlDriver}` : '未配置', `git config merge.jsonl-union.driver "${expectedJsonlDriver}"`);

// ③ .gitattributes 的 merge=ours 与 merge=jsonl-union 行（仓库侧声明，与 ②/②b 配对生效）
// 判据脱敏泛化（2026-10-27 插件化迁移）：appsettings 具体路径按使用项目替换（源为业务解决方案内
// 固定路径，出库前清洗）——机制语义不变：连接串所在 appsettings.json 须有 merge=ours 保护行。
const gaText = fs.existsSync('.gitattributes') ? fs.readFileSync('.gitattributes', 'utf8').replace(/\r/g, '') : '';
const gaOursOk = /appsettings\.json\s+merge=ours$/m.test(gaText);
const gaJsonlOk = /^\.agents\/\*\.jsonl\s+merge=jsonl-union$/m.test(gaText);
check(gaOursOk && gaJsonlOk, '.gitattributes 含 appsettings merge=ours 与 jsonl merge=jsonl-union 行',
  (!gaOursOk ? 'appsettings 行缺失; ' : '') + (!gaJsonlOk ? '.agents/*.jsonl 行缺失' : ''), null);

// ④ 五钩子文件在位（防「配了 hooksPath 但文件缺」的假上岗）
const hooks = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit'];
const missing = hooks.filter((h) => !fs.existsSync(path.join('.githooks', h)));
check(missing.length === 0, `.githooks/ 五钩子文件在位（${hooks.join(' / ')}）`,
  missing.length ? `缺失: ${missing.join('、')} —— git checkout -- .githooks 恢复后重跑` : '', null);

// ⑤ node 在位且主版本 ≥ 22（CI 已验证锚 22.17.0 / 本机 24.21.0，runtime-env §6.2）——pre-commit /
// pre-push 的门禁面几乎全依赖 node，缺失即整体瘫痪（pre-push 已 fail-closed 阻断推送；本项把暴露提前到上岗自检）。版本下限 = CI 验证锚；无法自动安装，不代修。
const nodeVer = (() => { try { return execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const nodeMajor = Number((/^v(\d+)/.exec(nodeVer) || [])[1]);
check(nodeMajor >= 22, 'Node.js 在位且主版本 ≥ 22（CI 锚 22.17 / 本机 24.21）',
  nodeVer ? `当前: ${nodeVer}（低于 22，请升级）` : '未找到 node（六门中除 commit-msg 外全依赖 node）',
  null);

// ⑥ 工具链解析回显（跨机自适应，runtime-env.md §6.3）：解析顺序 = 环境变量（仅浏览器 CHROME_PATH）→ 本机登记 runtime-env.local.md → 标准安装位置。
// dotnet 缺失计入缺失（静态门 build/test 依赖）；浏览器缺失仅提示（仅 UI 实测需要，不拦上岗）。
const localTool = (name) => {
  try {
    const md = fs.readFileSync('.agents/notes/runtime-env.local.md', 'utf8');
    const row = md.split(/\r?\n/).find((l) => new RegExp(`^\\|\\s*${name}\\s*\\|`).test(l));
    if (!row) return null;
    const m = /^\|\s*[^|]+?\s*\|\s*([^|]+?)\s*\|/.exec(row);
    return m && m[1] ? m[1] : null;
  } catch { return null; } // 未登记（新机正常形态，走探测）
};
const resolveOnDisk = (name, probes, envVar) => {
  const envVal = envVar ? process.env[envVar] || null : null; // 与 browser-resolve.mjs 同语义：env 原始值入候选，存在性随下方统一过滤（失效即落空走下一级）
  const reg = localTool(name);
  return [envVal, reg, ...probes].filter(Boolean).find((p) => fs.existsSync(p)) ?? null;
};
const dotnetPath = resolveOnDisk('dotnet', ['C:/Program Files/dotnet/dotnet.exe']);
const dotnetVer = dotnetPath ? (() => { try { return execFileSync(dotnetPath, ['--version'], { encoding: 'utf8' }).trim(); } catch { return ''; } })() : '';
check(dotnetVer !== '', 'dotnet 在位且可执行（静态门 build/test 依赖；标准位置无则登记 runtime-env.local.md）',
  dotnetPath ? `路径 ${dotnetPath} 无法执行 --version` : '未找到：标准位置与 runtime-env.local.md 登记均无（模板 runtime-env.local.example.md）',
  null);
const browserPath = resolveOnDisk('browser', [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
], 'CHROME_PATH');

let fail = 0;
for (const r of results) {
  if (r.ok) { console.log(`  [OK] ${r.name}`); continue; }
  fail++;
  console.log(`  [缺失] ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
  if (fix && r.fixCmd) {
    try {
      execSync(r.fixCmd, { stdio: 'inherit' });
      console.log(`  [已修复] ${r.fixCmd}`);
    } catch (e) {
      console.log(`  [修复失败] ${e.message}`);
    }
  } else if (r.fixCmd) {
    console.log(`         修复: ${r.fixCmd}`);
  }
}
// 工具链路径回显（⑥ 探测结果，信息面——新机 clone 后据此补 runtime-env.local.md 登记，模板 runtime-env.local.example.md）
console.log(`  [echo] node → ${nodeVer || '?'}（PATH 解析）`);
console.log(`  [echo] git → ${(git(['--version']) || '?').replace(/^git version /, '')}（PATH 解析）`);
console.log(dotnetVer !== '' ? `  [echo] dotnet → ${dotnetVer}（${dotnetPath}）` : '  [echo] dotnet → 未解析到');
console.log(browserPath
  ? `  [echo] UI 浏览器 → ${browserPath}`
  : '  [echo] UI 浏览器 → 未解析到（env CHROME_PATH / runtime-env.local.md browser 行 / 标准位置均未命中有效路径；UI 实测前设其一）');
if (fail > 0) {
  console.log(fix
    ? '\n门卫未全上岗：配置类已尝试自动修复（文件类缺失须按指引手动恢复）；修复后重跑本脚本确认全绿。'
    : '\n门卫未全上岗——逐条执行上方修复命令，或一键: node .agents/scripts/check-local-gates.mjs --fix');
  process.exit(1);
}
console.log('\n[PASS] 七项全过——门卫已上岗（六门 pre-commit / 整树强制编译 pre-merge-commit / 闭环扫描+debt 提醒 pre-push / evict+积压提醒 post-commit / 台账并集合并；机理详见 .agents/notes/runtime-env.md §7）。');
