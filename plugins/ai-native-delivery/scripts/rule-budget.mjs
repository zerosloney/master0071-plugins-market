#!/usr/bin/env node
// 常驻面体积预算检查（单源：本脚本 + .agents/config/rule-budgets.txt；触发点：check-loop.mjs 检查 16（--all，WARN）、
// git hooks/pre-commit（--staged，硬拦）、CI workflow（--all））
// 自 rule-budget.sh 移植 node（2026-10-08 ci 去 sh 化）——CI agent（Windows）免 git-bash 依赖，
// check-loop 检查 16 从「无 sh 静默跳过」变恒可跑。语义逐条对齐 sh 版：
//   --all    查「提交后树」全量；--staged 仅查本次暂存触及的条目 + 触及目录的合计
//   退出码 0 通过 / 1 超限（违例打到 stdout，调用方决定警告还是阻断）；缺预算表 exit 0（fixture 沙箱不拦——既有语义）
// 「提交后树」= 索引（index）内容：staged 版优先于 HEAD；无 git（fixture）回退工作区文件。
// 字节口径 = 索引 / HEAD 内容（git cat-file，LF 归一）。禁用工作区 wc -c 口径（CRLF 膨胀系统性偏大，
// 2026-09-21 实测差 ~500B 一度误判超限）——本脚本所有字节数都走 cat-file，仅无 git 时才落工作区。
// 条目数预算（2026-10-15 减重手段②）：上限字段形如 `<N>#count` 时按「匹配文件条数」执法而非字节——
//   用于规则面一进一出（如 check-loop 段数上限）：新增一条须先退役一条（退役判定
//   agg-judgments --retire-candidates）。旧格式行（纯数字）不受影响；`#count` 行对旧读者（未升级的
//   脚本副本）因上限非纯数字被跳过——fail-open，不误拦。
//
// 路径解析（2026-10-27 插件化修复）：预算表里的路径是**源仓形态**口径（`.agents/scripts/…`、
//   `.agents/commands/…`）。插件化后治理脚本与命令面留在插件内（项目侧只落数据），故按 paths.mjs
//   同口径解析实际落位：脚本/命令面 → 项目侧优先、插件内回退；其余（AGENTS.md / .agents/notes/…
//   / .agents/config/…）→ 项目根相对原样（项目侧资产）。
//   修复前：预算表指向的 `.agents/scripts/` 在插件形态下永不存在 → expand() 返空、段数恒算 0 →
//   「常驻面只增不减」棘轮恒过（实测插件内真实值 22 段 / 5 hard，恰好压线——第 23 段不会被拦）。
//   预算表本身也带插件种子兜底（项目侧未初始化时读 config-templates/rule-budgets.txt）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, scriptPath, commandsDir, PLUGIN_CONFIG_TEMPLATES_DIR, PLUGIN_SCRIPTS_DIR } from './paths.mjs';

const mode = process.argv[2] === '--staged' ? '--staged' : '--all';

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim() };
};
const ROOT = findProjectRoot() || process.cwd();
if (ROOT !== process.cwd()) { try { process.chdir(ROOT); } catch { /* chdir 失败则按绝对路径口径走 */ } }

const BUDGETS_REL = '.agents/config/rule-budgets.txt';
// 「提交后」字节数：索引 → HEAD → 工作区
const fsize = (e) => {
  if (e.rel) {
    if (git(['cat-file', '-e', `:${e.rel}`]).ok) return Number(git(['cat-file', '-s', `:${e.rel}`]).out);
    if (git(['cat-file', '-e', `HEAD:${e.rel}`]).ok) return Number(git(['cat-file', '-s', `HEAD:${e.rel}`]).out);
  }
  try { return fs.readFileSync(e.abs).length; } catch { return 0; }
};

// 预算表内容：索引 → HEAD → 工作区 → 插件种子兜底（2026-10-27 budget-index-source + 插件化）。
// 此前只读工作区，而**内容字节读索引**——上限与被测内容取自两处：在工作区里未暂存地调高上限，
// 也能放行一次「内容已进索引」的提交（自我豁免面）。改同源后，抬上限须与内容一起进索引：
// 「同一提交改预算 + 加内容」仍可行（那是文档化的一进一出流程），但不暂存的抬价不再生效。
const readBudgets = () => {
  if (git(['cat-file', '-e', `:${BUDGETS_REL}`]).ok) return git(['cat-file', '-p', `:${BUDGETS_REL}`]).out;
  if (git(['cat-file', '-e', `HEAD:${BUDGETS_REL}`]).ok) return git(['cat-file', '-p', `HEAD:${BUDGETS_REL}`]).out;
  try { return fs.readFileSync(path.join(ROOT, BUDGETS_REL), 'utf8'); } catch { /* 落到插件种子 */ }
  try { return fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'rule-budgets.txt'), 'utf8'); } catch { return ''; }
};

const staged = mode === '--staged'
  ? git(['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only']).out.split('\n').filter(Boolean)
  : [];

// ── 落位解析（插件化修复）────────────────────────────────────────────────────
// 绝对路径（工作区读取口径）+ 仓内相对路径（git cat-file 取「提交后树」字节口径）。
// 插件内文件不在使用项目的仓内 → rel=null → 字节回退工作区读取，--staged 口径下不命中（正确跳过：
// 使用项目的提交触及不到引擎本体，引擎面的预算由市场仓 CI 执法）。
const SCRIPTS_RESOLVED = (() => {
  const p = path.join(ROOT, '.agents', 'scripts');
  return fs.existsSync(p) ? p : PLUGIN_SCRIPTS_DIR;
})();
const COMMANDS_RESOLVED = commandsDir(ROOT);

const resolveBudgetPath = (rel) => {
  if (rel === '.agents/scripts') return SCRIPTS_RESOLVED;
  if (rel.startsWith('.agents/scripts/')) return path.join(SCRIPTS_RESOLVED, rel.slice('.agents/scripts/'.length));
  if (rel === '.agents/commands') return COMMANDS_RESOLVED;
  if (rel.startsWith('.agents/commands/')) return path.join(COMMANDS_RESOLVED, rel.slice('.agents/commands/'.length));
  return path.join(ROOT, rel);
};

const toRepoRel = (abs) => {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
};

const entry = (abs) => ({ abs, rel: toRepoRel(abs) });

// intentional-simple: glob 仅支持预算表在用的两形态——「固定目录 + * 后缀」（.agents/commands/*.md）
// 与目录本身（/ 结尾，展开一层直接子文件）；表出现更复杂 glob 时再升级
const expand = (pat) => {
  if (pat.endsWith('/')) {
    const dir = resolveBudgetPath(pat);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => entry(path.join(dir, e.name)));
  }
  if (pat.includes('*')) {
    const i = pat.lastIndexOf('/');
    const dirPart = i < 0 ? '.' : pat.slice(0, i);
    const dir = resolveBudgetPath(dirPart);
    const name = pat.slice(i + 1);
    const star = name.indexOf('*');
    const pre = name.slice(0, star), suf = name.slice(star + 1);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()
      && e.name.startsWith(pre) && e.name.endsWith(suf))
      .map((e) => entry(path.join(dir, e.name)));
  }
  const abs = resolveBudgetPath(pat);
  return fs.existsSync(abs) ? [entry(abs)] : [];
};

// --staged 命中判据：按「解析后的仓内相对前缀」判本次暂存是否触及该条目（用原始模式匹配会在
// 插件形态下落空——条目已不在项目侧 .agents/ 下）。
const stagedPrefixFor = (pat) => {
  const cut = pat.endsWith('/') ? pat.length : pat.lastIndexOf('/') + 1;
  const base = resolveBudgetPath(pat.slice(0, cut));
  const rel = toRepoRel(base);
  if (!rel) return null;
  return rel.endsWith('/') ? rel : `${rel}/`;
};
const stagedTouches = (pat) => {
  const prefix = stagedPrefixFor(pat);
  if (!prefix) return false;
  return staged.some((sf) => sf === prefix.replace(/\/$/, '') || sf.startsWith(prefix));
};

let viol = 0;
const over = (what, bytes, lim) => { console.log(`常驻面超限：${what} ${bytes}B > 上限 ${lim}B`); viol = 1; };
const overCount = (pat, n, lim) => { console.log(`常驻面超限（条目数）：${pat} ${n} 项 > 上限 ${lim} 项——一进一出：新增须先退役一条（退役判定 agg-judgments --retire-candidates）`); viol = 1; };

// hard 车道有界（gate-health 2026-10-22）：`check-loop-hard <N>#count` 数 check-loop.mjs SECTIONS
// 里 `lane: 'hard'` 的段数——新增 hard 段须先退役一个 hard（总段数棘轮只锁 22，不锁 hard 数）。
const countHardSections = () => {
  try {
    const src = fs.readFileSync(scriptPath(ROOT, 'check-loop.mjs'), 'utf8');
    return (src.match(/\{\s*lane:\s*'hard'/g) || []).length;
  } catch { return 0; }
};

for (const line of readBudgets().split(/\r?\n/)) {
  const sp = line.lastIndexOf(' ');
  if (sp < 0) continue;
  const pat = line.slice(0, sp), lim = line.slice(sp + 1);
  if (pat === '' || pat.startsWith('#')) continue;
  // 条目数预算（2026-10-15 减重手段②）：`<N>#count` = 匹配文件数上限（一进一出的执法面）
  const cnt = /^(\d+)#count$/.exec(lim);
  if (!cnt && !/^\d+$/.test(lim)) continue;
  if (cnt) {
    if (pat === 'check-loop-hard') {
      // 伪路径：数 check-loop.mjs 的 hard 段（--staged 下仅当段表或预算表被暂存才查）
      if (mode === '--staged' && !stagedTouches('.agents/scripts/check-loop.mjs') && !staged.includes(BUDGETS_REL)) continue;
      const n = countHardSections();
      if (n > Number(cnt[1])) overCount(pat, n, cnt[1]);
      continue;
    }
    if (mode === '--staged' && !stagedTouches(pat)) continue;
    const n = expand(pat).length;
    if (n > Number(cnt[1])) overCount(pat, n, cnt[1]);
    continue;
  }
  if (pat.endsWith('/')) {
    // 目录合计：--staged 下仅当暂存触及该目录内文件才查（解析后的仓内相对前缀口径）
    if (mode === '--staged' && !stagedTouches(pat)) continue;
    const total = expand(pat).reduce((s, e) => s + fsize(e), 0);
    if (total > Number(lim)) over(`${pat} 合计`, total, lim);
  } else {
    for (const e of expand(pat)) {
      if (mode === '--staged' && (!e.rel || !staged.includes(e.rel))) continue;
      const b = fsize(e);
      if (b > Number(lim)) over(e.rel || e.abs, b, lim);
    }
  }
}
process.exit(viol ? 1 : 0);
