#!/usr/bin/env node
// check-local-gates.mjs — 门卫上岗自检（eli5 卡片 4，2026-10-08）
// 本机两条 clone 必做配置 + 钩子文件在位 + 工具链在位检测（node 通用必查；dotnet 按项目识别——
// 项目根有 .NET 标记才查，通用项目跳过，2026-10-28 通用化）；--fix 自动修配置项（文件类缺失给恢复指引，不代修）。
// ⑥ 起工具链按「环境变量（仅浏览器 CHROME_PATH）→ 本机登记 runtime-env.local.md → 标准安装位置探测」解析并回显路径（机理 runtime-env.md §6.3，
// 2026-10-10 本机事实出库——绝对路径不再入库登记，新机按回显补登记即可）。
// 鸡生蛋约束：钩子没挂时任何钩子面检测不可达，故自检必须是独立脚本 + 显著入口（README 入门节 / AGENTS.md 头部）。
// 用法：node <插件根>/scripts/check-local-gates.mjs [--fix]
// 退出码：0 全过 / 1 有缺。零工作区副作用（只读 git config + 文件存在性检测）。

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deploymentMode, gitHooksDir, projectRoot, scriptPath } from './paths.mjs';

const fix = process.argv.includes('--fix');
const git = (args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; }
};

const results = [];
const check = (ok, name, detail, fixCmd) => results.push({ ok, name, detail, fixCmd });

// ── 部署形态（2026-10-27 插件化修复）──
//   source-repo：项目侧自带 .agents/scripts 脚本副本 → 判 core.hooksPath=.githooks + 五钩子（源仓老口径）。
//   plugin     ：治理脚本留插件内（市场分发形态）→ 判 git 实际会执行的两个执法点（pre-commit / pre-push）在位。
// 两套判据互斥：插件形态下绝不给「设 core.hooksPath」的修复指引——core.hooksPath 会整体接管 git 的
// 钩子查找，init-engine 装到 git 默认钩子目录的钩子会因此静默失效（钩子文件仍在但不再执行）。
// 根锚定 git root（paths.mjs 单源）：子目录调用时判据看的是仓库根事实（钩子目录 / core.hooksPath
// 都是仓库级的），不是调用者恰好所在的那个子目录。
const ROOT = projectRoot();
const MODE = deploymentMode(ROOT);

// ① 钩子挂载面
if (MODE === 'source-repo') {
  const hooksPath = git(['config', 'core.hooksPath']);
  check(hooksPath === '.githooks', 'core.hooksPath → .githooks',
    hooksPath ? `当前值: ${hooksPath}` : '未配置', 'git config core.hooksPath .githooks');
} else {
  const hooksDir = gitHooksDir(ROOT);
  const configured = git(['config', 'core.hooksPath']);
  const gateHooks = ['pre-commit', 'pre-push'];
  const missing = hooksDir ? gateHooks.filter((h) => !fs.existsSync(path.join(hooksDir, h))) : gateHooks;
  check(missing.length === 0,
    `git 实际执行的钩子在位（${gateHooks.join(' / ')}）`,
    missing.length
      ? `缺失: ${missing.join('、')} —— 有效钩子目录 ${hooksDir || '(解析不出)'}${configured ? `（core.hooksPath=${configured}）` : ''}`
      : '',
    `node "${scriptPath(ROOT, 'init-engine.mjs')}" --root "${ROOT}"`);
  if (configured) {
    console.log(`  [提示] core.hooksPath = ${configured} —— 该设置整体接管 git 钩子查找；init-engine 装到 git 默认钩子目录的钩子在此情形下不执行`);
  }
}

// ② merge.ours.driver（appsettings.json 合并保护的本地开关）
//    插件形态不判：appsettings.json 是业务项目资产，插件不接管其合并语义（源仓形态老口径原样保留）。
const ours = git(['config', 'merge.ours.driver']);
if (MODE === 'source-repo') {
  check(ours === 'true', 'merge.ours.driver = true',
    ours ? `当前值: ${ours}` : '未配置', 'git config merge.ours.driver true');
}

// ②b merge.jsonl-union.driver（.agents/*.jsonl 台账并发去重合并驱动）
//     插件形态：期望值指向插件内 git-merge-jsonl.mjs 绝对路径（脚本留插件内，不落项目侧）。
//     但 git driver 值含嵌套引号，跨 shell 的「一键修复」不可靠 → 插件形态只作提示不计入缺配
//     （项目侧 git 配置属用户决策，插件不代改）。
const jsonlDriver = git(['config', 'merge.jsonl-union.driver']);
const expectedJsonlDriver = MODE === 'plugin'
  ? `node "${scriptPath(ROOT, 'git-merge-jsonl.mjs')}" %O %A %B`
  : 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';
if (MODE === 'source-repo') {
  check(jsonlDriver === expectedJsonlDriver, 'merge.jsonl-union.driver（台账并发并集合并驱动）',
    jsonlDriver ? `当前值: ${jsonlDriver}` : '未配置', `git config merge.jsonl-union.driver "${expectedJsonlDriver}"`);
} else {
  console.log(`  [提示] merge.jsonl-union.driver（台账并发并集合并，可选）：`
    + `${jsonlDriver ? `当前值 ${jsonlDriver}` : '未配置'} —— 期望驱动 ${expectedJsonlDriver}（含嵌套引号，按你的 shell 调整）`);
}

// ③ .gitattributes 的 merge=ours 与 merge=jsonl-union 行（仓库侧声明，与 ②/②b 配对生效）
// 判据脱敏泛化（2026-10-27 插件化迁移）：appsettings 具体路径按使用项目替换（源为业务解决方案内
// 固定路径，出库前清洗）——机制语义不变：连接串所在 appsettings.json 须有 merge=ours 保护行。
const gaText = fs.existsSync('.gitattributes') ? fs.readFileSync('.gitattributes', 'utf8').replace(/\r/g, '') : '';
const gaOursOk = /appsettings\.json\s+merge=ours$/m.test(gaText);
const gaJsonlOk = /^\.agents\/\*\.jsonl\s+merge=jsonl-union$/m.test(gaText);
if (MODE === 'source-repo') {
  check(gaOursOk && gaJsonlOk, '.gitattributes 含 appsettings merge=ours 与 jsonl merge=jsonl-union 行',
    (!gaOursOk ? 'appsettings 行缺失; ' : '') + (!gaJsonlOk ? '.agents/*.jsonl 行缺失' : ''), null);
} else {
  console.log(`  [提示] .gitattributes 含 .agents/*.jsonl merge=jsonl-union 行（台账并发合并声明）：`
    + `${gaJsonlOk ? '已在' : '未在 —— 台账并发合并按普通文本冲突处理（不丢行但会冲突）'}`);
}

// ④ 钩子文件在位（防「配了但文件缺」的假上岗）——源仓形态判 .githooks/ 五钩子；插件形态已在 ① 判过
if (MODE === 'source-repo') {
  const hooks = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit'];
  const missing = hooks.filter((h) => !fs.existsSync(path.join('.githooks', h)));
  check(missing.length === 0, `.githooks/ 五钩子文件在位（${hooks.join(' / ')}）`,
    missing.length ? `缺失: ${missing.join('、')} —— git checkout -- .githooks 恢复后重跑` : '', null);
}

// ⑤ node 在位且主版本 ≥ 18——pre-commit / pre-push 的门禁面几乎全依赖 node，缺失即整体瘫痪
//（pre-push 已 fail-closed 阻断推送；本项把暴露提前到上岗自检）。下限 = 代码真实可运行下限
//（mcp/server.mjs 同一判据，hooks 依赖的 `Object.hasOwn` / `AbortSignal.timeout` 均 ≥17.3）。
// 旧文案写 ≥22 并以「CI 验证锚」为由——该依据已过期：CI 矩阵自 2026-10 起跑 20 与 22，
// 在 Node 20 的开发机上装插件会被自己的上岗自检判红，与 CI 声明支持的事实相反。
// 故 18 为硬下限（低于即拦），<20 只代表未经 CI 验证，仍允许本地开发。无法自动安装，不代修。
const nodeVer = (() => { try { return execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const nodeMajor = Number((/^v(\d+)/.exec(nodeVer) || [])[1]);
check(nodeMajor >= 18, 'Node.js 在位且主版本 ≥ 18（代码下限；CI 验证锚 20 / 22）',
  nodeVer ? `当前: ${nodeVer}（低于 18，请升级）` : '未找到 node（六门中除 commit-msg 外全依赖 node）',
  null);

// ⑥ 工具链解析回显（跨机自适应，runtime-env.md §6.3）：解析顺序 = 环境变量（仅浏览器 CHROME_PATH）→ 本机登记 runtime-env.local.md → 标准安装位置。
// dotnet 改项目识别驱动（2026-10-28 通用化）：dotnet 是源项目（.NET 产品）静态门的依赖，
// 不是通用治理插件的上岗前提——消费项目可以是任意技术栈（Node / Python / Go…）。
// 项目根出现 .NET 标记（*.sln / *.csproj / *.fsproj / *.vbproj）才要求 dotnet 在位，
// 与 verify.mjs 产品门 requires「项目侧路径不在即不适用」同一哲学；
// 无标记的通用项目与浏览器缺失同待遇——仅回显提示，不拦上岗。
const dotnetMarkers = (() => {
  try { return fs.readdirSync(ROOT).filter((f) => /\.(sln|csproj|fsproj|vbproj)$/i.test(f)); } catch { return []; }
})();
const dotnetNeeded = dotnetMarkers.length > 0;
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
// 标准位置与登记均无时再试 PATH：Linux 发行版与 CI 镜像普遍只经 PATH 暴露 dotnet
//（探测序不变，env/登记 优先，PATH 仅作最后一级，登记了错路径的机器仍按登记如实报错）。
const dotnetOnPath = dotnetPath === null
  ? (() => { try { return execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim(); } catch { return ''; } })()
  : '';
const dotnetVer = dotnetPath
  ? (() => { try { return execFileSync(dotnetPath, ['--version'], { encoding: 'utf8' }).trim(); } catch { return ''; } })()
  : dotnetOnPath;
if (dotnetNeeded) {
  check(dotnetVer !== '', `dotnet 在位且可执行（检出 ${dotnetMarkers.join('、')}，静态门 build/test 依赖；标准位置无则登记 runtime-env.local.md）`,
    dotnetPath ? `路径 ${dotnetPath} 无法执行 --version` : '未找到：标准位置 / runtime-env.local.md 登记 / PATH 均无（模板 runtime-env.local.example.md）',
    null);
}
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
console.log(dotnetPath
  ? `  [echo] dotnet → ${dotnetVer}（${dotnetPath}）`
  : dotnetVer !== ''
    ? `  [echo] dotnet → ${dotnetVer}（PATH 解析）`
    : dotnetNeeded
      ? '  [echo] dotnet → 未解析到（本项目检出 .NET 标记，静态门需要它——标准位置 / runtime-env.local.md 登记 / PATH 均未命中）'
      : '  [echo] dotnet → 未检出 .NET 项目标记，跳过检查（通用项目不依赖 dotnet；出现 .sln/.csproj 即自动恢复检测）');
console.log(browserPath
  ? `  [echo] UI 浏览器 → ${browserPath}`
  : '  [echo] UI 浏览器 → 未解析到（env CHROME_PATH / runtime-env.local.md browser 行 / 标准位置均未命中有效路径；UI 实测前设其一）');
if (fail > 0) {
  console.log(fix
    ? '\n门卫未全上岗：配置类已尝试自动修复（文件类缺失须按指引手动恢复）；修复后重跑本脚本确认全绿。'
    : `\n门卫未全上岗——逐条执行上方修复命令，或一键: node "${scriptPath(ROOT, 'check-local-gates.mjs')}" --fix`);
  process.exit(1);
}
console.log(MODE === 'plugin'
  ? '\n[PASS] 门卫已上岗——插件形态：git 实际执行的 pre-commit / pre-push 两个执法点在位，node 工具链在位（机理详见 .agents/notes/runtime-env.md §7）。'
  : '\n[PASS] 七项全过——门卫已上岗（六门 pre-commit / 整树强制编译 pre-merge-commit / 闭环扫描+debt 提醒 pre-push / evict+积压提醒 post-commit / 台账并集合并；机理详见 .agents/notes/runtime-env.md §7）。');
