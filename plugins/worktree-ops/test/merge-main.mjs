#!/usr/bin/env node
// worktree-ops merge_back 落点单测（白盒，直连 mcp/tools.mjs 的 merge_back 处理函数）。
//
// 旧实现把合并落在「会话所在的 worktree」：会话在 link worktree 里时 repo 解析成那个
// worktree，于是：
//   · 校验拿到的是 wt/feature 而不是主干 → 拒绝并提示「去 checkout main」，
//     而 main 已在主检出检出，git 会报 'main' is already used by worktree → 指引不可执行；
//   · 反向误用（target 写成 wt/feature）则合并静默落到 feature 分支。
//
// 修法：合并目标固定为主检出（core.mainWorktreePath），校验改为主检出的当前分支；
// 目标分支被别的 worktree 占用时给出「一个分支只能在一处检出」的可执行指引。
//
// 本套件还钉住两条 P3 口径：clean 不可得时阻断合并（与 remove 同口径），
// 以及清理失败时的回执只说事实（合并没发生就不写「合并之后」）。
//
//   node test/merge-main.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupFailedReply, tools } from '../mcp/tools.mjs';

let pass = 0;
const fail = [];
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ── 一次性仓库 ────────────────────────────────────────────────────────────────
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'worktree-merge-main-'));
const cfgHome = path.join(sandbox, 'cfg');
const repo = path.join(sandbox, 'repo');
const root = path.join(sandbox, 'root');
const linkWt = path.join(root, 'wt-feature');
mkdirSync(repo, { recursive: true });
mkdirSync(cfgHome, { recursive: true });
git(['init', '-b', 'main'], repo);
git(['config', 'user.email', 'merge@test.invalid'], repo);
git(['config', 'user.name', 'merge'], repo);
writeFileSync(path.join(repo, 'README.md'), 'hello\n');
git(['add', '.'], repo);
git(['commit', '-m', 'init'], repo);

// 配置文件与进程环境：让处理函数落在一次性配置里，不碰用户真实配置
process.env.WORKTREE_CONFIG_HOME = cfgHome;
delete process.env.WORKTREE_ROOT;
delete process.env.WORKTREE_BASE_REF;
delete process.env.WORKTREE_BRANCH_PREFIX;
delete process.env.WORKTREE_STALE_DAYS;
writeFileSync(path.join(cfgHome, 'config.json'), JSON.stringify({ root, baseRef: 'auto', branchPrefix: 'wt/', staleDays: 14 }));

const mergeBack = tools.find((t) => t.name === 'worktree_merge_back');
const call = (args) => {
  const r = mergeBack.handler(args);
  return { isError: Boolean(r.isError), text: (r.content || []).map((c) => c.text).join('\n') };
};

// link worktree：会话落在它里面
git(['worktree', 'add', '-b', 'wt/feature', linkWt, 'main'], repo);
git(['config', 'user.email', 'merge@test.invalid'], linkWt);
git(['config', 'user.name', 'merge'], linkWt);
writeFileSync(path.join(linkWt, 'feature.txt'), 'feature\n');
git(['add', '.'], linkWt);
git(['commit', '-m', 'feat: feature'], linkWt);

// ① 会话在 link worktree 里：merge_back 的落点必须是主检出，不是会话 worktree
{
  const r = call({ repoPath: linkWt, name: 'wt/feature', target: 'main', merge: true });
  check(
    'link worktree 会话下 merge_back 不再被 REFUSED',
    !r.isError && /merge wt\/feature into main: ok/.test(r.text),
    r.text,
  );
  const mainLog = git(['log', '--format=%s', '-3'], repo);
  check('合并提交落在主检出上', mainLog.includes('Merge wt/feature into main'), mainLog);
  const linkLog = git(['log', '--format=%s', '-2'], linkWt);
  check('会话 worktree 自己没有被合并进去', !linkLog.includes('Merge wt/feature into main'), linkLog);
  check('主检出确实拿到了工作树里的文件', execFileSync('git', ['show', 'main:feature.txt'], { cwd: repo, encoding: 'utf8' }).trim() === 'feature', mainLog);
}

// ② 默认 target 取主检出的当前分支（不是会话所在分支）
{
  const r = call({ repoPath: linkWt, name: 'wt/feature' });
  check(
    '默认 target 取主检出的分支（main）',
    !r.isError && /Plan for wt\/feature → main:/.test(r.text),
    r.text,
  );
}

// ③ 目标分支被别的 worktree 占用：指引必须说清「一个分支只能在一处检出」
{
  const r = call({ repoPath: repo, name: 'wt/feature', target: 'wt/feature', merge: true });
  check(
    'target 被别的 worktree 占用时拒绝合并',
    r.isError && /REFUSED/.test(r.text),
    r.text,
  );
  check(
    '拒绝语点名占用该分支的 worktree 并说明一个分支只能在一处检出',
    /wt-feature/.test(r.text) && /only one worktree/.test(r.text),
    r.text,
  );
  check(
    '拒绝语指向主检出路径（而不是会话 worktree）',
    r.text.includes(repo) && !r.text.includes(`Check out \`wt/feature\` in ${linkWt}`),
    r.text,
  );
}

// ④ clean 不可得（git status 跑不成）时阻断合并：与 worktree_remove 同口径
{
  const brokenWt = path.join(root, 'wt-broken');
  git(['worktree', 'add', '-b', 'wt/broken', brokenWt, 'main'], repo);
  // 把工作树的 .git 指针**内容**写坏 → git status 在该目录跑不起来（"not a git repository: ..."）。
  // 注意必须 truncate + `r+` 写入，不能用默认的 writeFileSync（它以 w 打开，Windows 上对 worktree 的
  // 受保护 .git 指针文件会 EPERM——本套件曾在 Windows 上崩在这一步、后续断言全不执行，
  // 2026-10-28 市场审查实测复现）。truncate + r+ 只打开既有文件、不重建，避开该限制，语义与原实现一致。
  const wtGit = path.join(brokenWt, '.git');
  truncateSync(wtGit, 0);
  writeFileSync(wtGit, 'gitdir: /definitely/not/here\n', { flag: 'r+' });
  const r = call({ repoPath: repo, name: 'wt/broken', target: 'main', merge: true });
  check(
    'clean 不可得时 merge 被阻断（不得当作干净）',
    r.isError && /unknown/.test(r.text) && /Cleanliness is unknown/.test(r.text),
    r.text,
  );
  check('计划行把状态显示成 unknown 而不是 no (0 uncommitted)', /- clean: unknown/.test(r.text), r.text);
}

// ⑤ 清理失败时的回执：只说事实
{
  const steps = ['Plan for wt/x → main:'];
  const err = new Error('fatal: something went wrong');
  const merged = cleanupFailedReply(steps, err, { mergeLanded: true, mainPath: repo, info: { path: '/x', branch: 'wt/x' } });
  const mergedText = (merged.content || []).map((c) => c.text).join('\n');
  check('合并已落地时清理失败报成功（结果在共享 ref 上）', !merged.isError, mergedText);
  check('合并已落地的回执写明合并确实落地了', /the merge itself landed in/.test(mergedText), mergedText);

  const notMerged = cleanupFailedReply(steps, err, { mergeLanded: false, mainPath: repo, info: { path: '/x', branch: 'wt/x' } });
  const notMergedText = (notMerged.content || []).map((c) => c.text).join('\n');
  check('没发生合并时清理失败如实报错', Boolean(notMerged.isError), notMergedText);
  check('没合并的回执不再写「after the merge step」', !/after the merge step/.test(notMergedText), notMergedText);
  check('没合并的回执写明本次没有合并', /no merge was performed/.test(notMergedText), notMergedText);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
