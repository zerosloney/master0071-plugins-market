#!/usr/bin/env node
// check-local-gate-config.mjs — 本地门禁挂载自检（verify 门 WARN 档；2026-10-25 优化1）
//
// 动机：本地钩子挂载缺失 = 全部门禁静默失效（2026-09-16 事故实证，机理 runtime-env.md §7）。
//   check-local-gates.mjs 是上岗自检的显著入口，但「靠人记得跑」是整座防御纵深唯一的地基软肋——
//   本门把本地门禁挂载面挂进 verify 门表，每次关单/CI 自动对质。
//
// 判据按**部署形态**分两套（2026-10-27 插件化修复）：
//   source-repo 形态（项目侧自带 .agents/scripts 脚本副本）：core.hooksPath=.githooks + 五钩子在位
//     + merge.ours / merge.jsonl-union 两条 driver + .gitattributes 两行（源仓形态的老口径，原样保留）。
//   plugin 形态（治理脚本留插件内、随市场分发）：判 **git 实际会执行的两个执法点**（pre-commit /
//     pre-push）在位。判据取「有效钩子目录」——core.hooksPath 已设置则以其为准，否则取 git 默认钩子目录
//     （git rev-parse --git-path hooks：worktree 下 .git 是文件，直接拼 .git/hooks 会指错）。
//
// 为什么两套判据不得混用（本次修复的根因）：源仓形态的「core.hooksPath=.githooks」会**整体接管**
//   git 的钩子查找——插件形态下 init-engine 装到 git 默认钩子目录的 pre-commit / pre-push 会因此
//   静默失效（实测：钩子文件仍在，但 commit 不再被拦）。故插件形态既不复用该判据，也绝不给出
//   「设 core.hooksPath」这类会自伤的修复指引。
//
// 档位：默认 WARN——缺配只告警不阻断（打出修复命令，exit 0）；--strict 缺配即 exit 1（升格开关：
//   WARN 期观察误报后由 owner 拍板把 verify.mjs 门表 cmd 换成 --strict，机制台账该行挂复评）。
//   CI（TF_BUILD）不挂本地钩子是常态而非违规：loud-skip（跳过可见，与 E2E 门对称）。
//   非 git 仓库（git 不可用）→ 同样 loud-skip（fixture 根合法形态）。
//
// 用法：node <插件根>/scripts/check-local-gate-config.mjs [--root <仓库根>] [--strict]
// 退出码：0 = 全配或 WARN 档放行 / 1 = --strict 下有缺配。零工作区副作用。
// 测试：node test/check-local-gate-config.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deploymentMode, gitHooksDir, projectRoot, scriptPath } from './paths.mjs';

const strict = process.argv.includes('--strict');
// 根锚定 git root（paths.mjs 单源）：--root 显式指定仍优先；不指定时子目录调用也看仓库根，
// 不把「钩子没挂」判到子目录头上（源仓形态判据读 .githooks / core.hooksPath，都是仓库级事实）。
let root = projectRoot();
{
  const i = process.argv.indexOf('--root');
  if (i >= 0 && process.argv[i + 1]) root = path.resolve(process.argv[i + 1]);
}

if (process.env.TF_BUILD) {
  console.log('[local-gate-config] ⏭️ CI 环境（TF_BUILD）——CI checkout 不挂本地钩子属常态，跳过（本地缺配由各机 verify 跑出）');
  process.exit(0);
}

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd: root });
  if (r.status === 0) return String(r.stdout || '').trim();
  if (r.status === 1) return ''; // git config 键未配置（合法缺省，非错误——与「fatal 非 git 仓」分离）
  return null; // fatal（非 git 仓库 / git 不可用）
};
if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  console.log(`[local-gate-config] ⏭️ ${root} 非 git 仓库（git 不可用或不在工作树内）——无本地门禁挂载面，跳过`);
  process.exit(0);
}

const MODE = deploymentMode(root);
const JSONL_DRIVER = 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';
const hooks = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit'];

let results = [];
let advisories = [];

if (MODE === 'source-repo') {
  // ── 源仓形态：老口径原样保留（core.hooksPath=.githooks + 五钩子 + 两条 driver + .gitattributes）──
  const gaText = (() => {
    const p = path.join(root, '.gitattributes');
    try { return fs.readFileSync(p, 'utf8').replace(/\r/g, ''); } catch { return ''; }
  })();
  const missingHooks = hooks.filter((h) => !fs.existsSync(path.join(root, '.githooks', h)));
  results = [
    {
      ok: git(['config', 'core.hooksPath']) === '.githooks',
      name: 'core.hooksPath → .githooks（漏配 = 五钩子全部静默失效）',
      fix: 'git config core.hooksPath .githooks',
    },
    {
      ok: git(['config', 'merge.ours.driver']) === 'true',
      name: 'merge.ours.driver（appsettings.json 连接串合并保护）',
      fix: 'git config merge.ours.driver true',
    },
    {
      ok: git(['config', 'merge.jsonl-union.driver']) === JSONL_DRIVER,
      name: 'merge.jsonl-union.driver（台账 jsonl 并发并集合并）',
      fix: `git config merge.jsonl-union.driver "${JSONL_DRIVER}"`,
    },
    {
      // 判据脱敏泛化（2026-10-27 插件化迁移）：appsettings 具体路径按使用项目替换（源为业务解决方案内
      // 固定路径，出库前清洗）——机制语义不变：连接串所在 appsettings.json 须有 merge=ours 保护行。
      ok: /appsettings\.json\s+merge=ours$/m.test(gaText)
        && /^\.agents\/\*\.jsonl\s+merge=jsonl-union$/m.test(gaText),
      name: '.gitattributes 含 merge=ours 与 merge=jsonl-union 两行',
      fix: null, // 仓库侧文件：git checkout -- .gitattributes 恢复
    },
    {
      ok: missingHooks.length === 0,
      name: `.githooks/ 五钩子文件在位${missingHooks.length ? `（缺 ${missingHooks.join('、')}）` : ''}`,
      fix: null,
    },
  ];
} else {
  // ── 插件形态：判 git 实际会执行的两个执法点 ──
  const hooksDir = gitHooksDir(root);
  const configured = git(['config', 'core.hooksPath']);
  const initCmd = `node "${scriptPath(root, 'init-engine.mjs')}" --root "${root}"`;
  const gateHooks = ['pre-commit', 'pre-push'];
  const missing = hooksDir ? gateHooks.filter((h) => !fs.existsSync(path.join(hooksDir, h))) : gateHooks;
  const dirLabel = hooksDir
    ? (configured ? `${configured}（core.hooksPath 指定）` : path.join(root, '.git', 'hooks'))
    : '(解析不出 git 钩子目录)';
  results = gateHooks.map((h) => ({
    ok: !missing.includes(h),
    name: `钩子在位：${h}${missing.includes(h) ? ' —— 缺（该钩子不执行 = 对应门禁静默失效）' : ''}`,
    fix: missing.includes(h) ? initCmd : null,
  }));
  if (configured) {
    advisories.push(`core.hooksPath = ${configured} —— 该设置整体接管 git 钩子查找（相对仓库根解析）：`
      + `init-engine 装到 git 默认钩子目录的钩子在此情形下不执行。`);
  }
  // 台账并发合并：插件随分发 git-merge-jsonl.mjs，但 git config 与 .gitattributes 属项目侧资产，
  // init-engine 不代改（改动合并语义是用户决策）——如实提示接线方式，不计入缺配、不触发 --strict。
  const jsonlDriver = `node "${scriptPath(root, 'git-merge-jsonl.mjs')}" %O %A %B`;
  const gaText = (() => {
    try { return fs.readFileSync(path.join(root, '.gitattributes'), 'utf8').replace(/\r/g, ''); } catch { return ''; }
  })();
  advisories.push(`台账并发并集合并（可选，插件不代改项目 git 配置）：`
    + `driver ${git(['config', 'merge.jsonl-union.driver']) ? '已配' : '未配'}`
    + `、.gitattributes 行 ${/^\.agents\/\*\.jsonl\s+merge=jsonl-union$/m.test(gaText) ? '已在' : '未在'}`
    + ` —— 期望驱动值 ${jsonlDriver}（含嵌套引号，落地时按你的 shell 调整引号写法）`);
}

const bad = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`[local-gate-config]   [OK] ${r.name}`);
  else console.log(`[local-gate-config]   ${strict ? '[缺失]' : '⚠️ WARN'} ${r.name}${r.fix ? ` —— 修复: ${r.fix}` : ' —— git checkout 恢复文件'}`);
}
for (const a of advisories) console.log(`[local-gate-config]   [提示] ${a}`);
if (!bad.length) {
  console.log(`[local-gate-config] 本地门禁挂载面全配（${MODE === 'plugin' ? 'git 实际执行的 pre-commit / pre-push 两执法点' : 'hooksPath + 两条 merge driver + .gitattributes + 五钩子在位'}）`);
  process.exit(0);
}
// 一键修复入口：两种形态的 --fix 都已安全（源仓形态设 core.hooksPath 是其正确挂载面；
// 插件形态的 --fix 改为重跑 init-engine，绝不碰 core.hooksPath——见 check-local-gates.mjs ①）。
console.log(`[local-gate-config] ${strict ? '❌' : '⚠️'} ${bad.length} 项缺配——一键修复: node "${scriptPath(root, 'check-local-gates.mjs')}" --fix（机理见 .agents/notes/runtime-env.md §7）`);
process.exit(strict ? 1 : 0);
