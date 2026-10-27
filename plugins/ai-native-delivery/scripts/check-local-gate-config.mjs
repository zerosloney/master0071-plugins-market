#!/usr/bin/env node
// check-local-gate-config.mjs — 本地门禁挂载自检（verify 门 WARN 档；2026-10-25 优化1）
//
// 动机：core.hooksPath 不随 clone 传播，漏配 = 全部门禁静默失效（2026-09-16 事故实证，机理
//   runtime-env.md §7）。check-local-gates.mjs 是上岗自检的显著入口，但「靠人记得跑」是整座
//   防御纵深唯一的地基软肋——本门把同一 git 面（① core.hooksPath ② merge.ours ②b merge.jsonl-union
//   ③ .gitattributes 两行 ④ 五钩子文件在位）挂进 verify 门表，每次关单/CI 自动对质。
//   判据与 check-local-gates.mjs ①-④ 逐条对齐（单源：一边改另一边须跟）；node/dotnet/浏览器
//   工具链项不进本门——其余 verify 门自身即依赖 node，dotnet 由 backend-build 门执法。
//
// 档位：默认 WARN——缺配只告警不阻断（打出修复命令，exit 0）；--strict 缺配即 exit 1（升格
//   开关：WARN 期观察误报后由 owner 拍板把 verify.mjs 门表 cmd 换成 --strict，机制台账该行挂复评）。
//   CI（TF_BUILD）不挂本地钩子是常态而非违规：loud-skip（跳过可见，与 E2E 门对称）。
//   非 git 仓库（git config 不可用）→ 同样 loud-skip（fixture 根合法形态）。
//
// 用法：node .agents/scripts/check-local-gate-config.mjs [--root <仓库根>] [--strict]
// 退出码：0 = 全配或 WARN 档放行 / 1 = --strict 下有缺配。零工作区副作用。
// 测试：node .agents/scripts/check-local-gate-config.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const strict = process.argv.includes('--strict');
let root = process.cwd();
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

const JSONL_DRIVER = 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';
const hooksPath = git(['config', 'core.hooksPath']);
const gaText = (() => {
  const p = path.join(root, '.gitattributes');
  try { return fs.readFileSync(p, 'utf8').replace(/\r/g, ''); } catch { return ''; }
})();
const hooks = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit'];
const missingHooks = hooks.filter((h) => !fs.existsSync(path.join(root, '.githooks', h)));

const results = [
  {
    ok: hooksPath === '.githooks',
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

const bad = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`[local-gate-config]   [OK] ${r.name}`);
  else console.log(`[local-gate-config]   ${strict ? '[缺失]' : '⚠️ WARN'} ${r.name}${r.fix ? ` —— 修复: ${r.fix}` : ' —— git checkout 恢复文件'}`);
}
if (!bad.length) {
  console.log('[local-gate-config] 本地门禁挂载面全配（hooksPath + 两条 merge driver + .gitattributes + 五钩子在位）');
  process.exit(0);
}
console.log(`[local-gate-config] ${strict ? '❌' : '⚠️'} ${bad.length} 项缺配——一键修复: node .agents/scripts/check-local-gates.mjs --fix（机理见 .agents/notes/runtime-env.md §7）`);
process.exit(strict ? 1 : 0);
