#!/usr/bin/env node
// 常驻面体积预算检查（单源：本脚本 + .agents/config/rule-budgets.txt；触发点：check-loop.mjs 检查 13（--all，WARN）、
// .githooks/pre-commit（--staged，硬拦）、CI workflow（--all））
// 自 rule-budget.sh 移植 node（2026-10-08 ci 去 sh 化）——CI agent（Windows）免 git-bash 依赖，
// check-loop 检查 13 从「无 sh 静默跳过」变恒可跑。语义逐条对齐 sh 版：
//   --all    查「提交后树」全量；--staged 仅查本次暂存触及的条目 + 触及目录的合计
//   退出码 0 通过 / 1 超限（违例打到 stdout，调用方决定警告还是阻断）；缺预算表 exit 0（fixture 沙箱不拦——既有语义）
// 「提交后树」= 索引（index）内容：staged 版优先于 HEAD；无 git（fixture）回退工作区文件。
// 字节口径 = 索引 / HEAD 内容（git cat-file，LF 归一）。禁用工作区 wc -c 口径（CRLF 膨胀系统性偏大，
// 2026-09-21 实测差 ~500B 一度误判超限）——本脚本所有字节数都走 cat-file，仅无 git 时才落工作区。
// 条目数预算（2026-10-15 减重手段②）：上限字段形如 `<N>#count` 时按「匹配文件条数」执法而非字节——
//   用于规则面一进一出（如 check-loop 段数上限）：新增一条须先退役一条（退役判定
//   agg-judgments --retire-candidates）。旧格式行（纯数字）不受影响；`#count` 行对旧读者（未升级的
//   脚本副本）因上限非纯数字被跳过——fail-open，不误拦。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] === '--staged' ? '--staged' : '--all';

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim() };
};
const root = git(['rev-parse', '--show-toplevel']);
if (root.ok) process.chdir(root.out); // 非 git 环境（fixture 沙箱）留在原地

const BUDGETS = '.agents/config/rule-budgets.txt';
// 预算表缺失语义不变（exit 0，fixture 沙箱不拦）：三源皆取不到 → readBudgets() 返空串，
// 循环零迭代即通过。此处刻意不再用工作区 existsSync 守卫——否则「预算表已进索引、工作区被删」
// 会 fail-open 跳检（与下方 fsize 的索引优先口径不一致）。

// 「提交后」字节数：索引 → HEAD → 工作区
const fsize = (f) => {
  if (git(['cat-file', '-e', `:${f}`]).ok) return Number(git(['cat-file', '-s', `:${f}`]).out);
  if (git(['cat-file', '-e', `HEAD:${f}`]).ok) return Number(git(['cat-file', '-s', `HEAD:${f}`]).out);
  try { return fs.readFileSync(f).length; } catch { return 0; }
};

// 预算表内容：索引 → HEAD → 工作区（2026-10-27 budget-index-source）。
// 此前只读工作区，而**内容字节读索引**——上限与被测内容取自两处：在工作区里未暂存地调高上限，
// 也能放行一次「内容已进索引」的提交（自我豁免面）。改同源后，抬上限须与内容一起进索引：
// 「同一提交改预算 + 加内容」仍可行（那是文档化的一进一出流程），但不暂存的抬价不再生效。
const readBudgets = () => {
  if (git(['cat-file', '-e', `:${BUDGETS}`]).ok) return git(['cat-file', '-p', `:${BUDGETS}`]).out;
  if (git(['cat-file', '-e', `HEAD:${BUDGETS}`]).ok) return git(['cat-file', '-p', `HEAD:${BUDGETS}`]).out;
  try { return fs.readFileSync(BUDGETS, 'utf8'); } catch { return ''; }
};

const staged = mode === '--staged'
  ? git(['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only']).out.split('\n').filter(Boolean)
  : [];

// intentional-simple: glob 仅支持预算表在用的两形态——「固定目录 + * 后缀」（.agents/commands/*.md）
// 与目录本身（/ 结尾，展开一层直接子文件）；表出现更复杂 glob 时再升级
const expand = (pat) => {
  if (pat.endsWith('/')) {
    const dir = pat.replace(/\/$/, '');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  }
  if (pat.includes('*')) {
    const i = pat.lastIndexOf('/');
    const dir = i < 0 ? '.' : pat.slice(0, i);
    const name = pat.slice(i + 1);
    const star = name.indexOf('*');
    const pre = name.slice(0, star), suf = name.slice(star + 1);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()
      && e.name.startsWith(pre) && e.name.endsWith(suf))
      .map((e) => path.join(dir, e.name));
  }
  return fs.existsSync(pat) ? [pat] : [];
};

let viol = 0;
const over = (what, bytes, lim) => { console.log(`常驻面超限：${what} ${bytes}B > 上限 ${lim}B`); viol = 1; };
const overCount = (pat, n, lim) => { console.log(`常驻面超限（条目数）：${pat} ${n} 项 > 上限 ${lim} 项——一进一出：新增须先退役一条（退役判定 agg-judgments --retire-candidates）`); viol = 1; };

// hard 车道有界（gate-health 2026-10-22）：`check-loop-hard <N>#count` 数 check-loop.mjs SECTIONS
// 里 `lane: 'hard'` 的段数——新增 hard 段须先退役一个 hard（总段数棘轮只锁 21，不锁 hard 数）。
const countHardSections = () => {
  try {
    const src = fs.readFileSync('.agents/scripts/check-loop.mjs', 'utf8');
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
      if (mode === '--staged' && !staged.some((sf) => sf === '.agents/scripts/check-loop.mjs' || sf === BUDGETS)) continue;
      const n = countHardSections();
      if (n > Number(cnt[1])) overCount(pat, n, cnt[1]);
      continue;
    }
    if (mode === '--staged' && !staged.some((sf) => sf.startsWith(pat))) continue;
    const n = expand(pat).length;
    if (n > Number(cnt[1])) overCount(pat, n, cnt[1]);
    continue;
  }
  if (pat.endsWith('/')) {
    // 目录合计：--staged 下仅当暂存触及该目录内文件才查（字面前缀匹配，同 sh 版 2026-09-24 口径）
    if (mode === '--staged' && !staged.some((sf) => sf.startsWith(pat))) continue;
    const total = expand(pat).reduce((s, f) => s + fsize(f), 0);
    if (total > Number(lim)) over(`${pat} 合计`, total, lim);
  } else {
    for (const f of expand(pat)) {
      if (mode === '--staged' && !staged.includes(f.replace(/\\/g, '/'))) continue;
      const b = fsize(f);
      if (b > Number(lim)) over(f, b, lim);
    }
  }
}
process.exit(viol ? 1 : 0);
