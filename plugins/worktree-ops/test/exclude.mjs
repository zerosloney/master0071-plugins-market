#!/usr/bin/env node
// worktree-ops 本地忽略写入单测（白盒，直连 mcp/core.mjs 的 ensureInsideRepoIgnore）。
//
// 0.4.8 修复：entry 由**配置来的**受管根路径派生后直接追加进 .git/info/exclude。路径里若含
// 换行，一行会被拆成两条规则——等于借配置往 exclude 注入任意 ignore 项，静默隐藏本该可见的
// 未跟踪文件。黑盒下难以在 NTFS 上稳定制造这种路径，故直接对函数下断言。
//
//   node test/exclude.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureInsideRepoIgnore } from '../mcp/core.mjs';

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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'worktree-exclude-'));
const repo = path.join(sandbox, 'repo');
const gitDir = path.join(repo, '.git');
mkdirSync(path.join(gitDir, 'info'), { recursive: true });
const excludePath = path.join(gitDir, 'info', 'exclude');
const readExclude = () => (existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '');

// 正常路径：写成 /wts/ 形式，且幂等
const first = ensureInsideRepoIgnore(repo, path.join(repo, 'wts'), gitDir);
check('仓库内受管根 → 写入 /<rel>/ 形式条目', first?.wrote === true && first.entry === '/wts/', JSON.stringify(first));
check('条目确实落进 .git/info/exclude', readExclude().split(/\r?\n/).includes('/wts/'), JSON.stringify(readExclude()));

const second = ensureInsideRepoIgnore(repo, path.join(repo, 'wts'), gitDir);
check('重复调用幂等（wrote=false，不重复追加）', second?.wrote === false, JSON.stringify(second));
check('幂等后条目只出现一次', readExclude().split(/\r?\n/).filter((l) => l === '/wts/').length === 1);

// 注入守卫：含控制字符的路径一律放弃写入，且绝不把注入内容落盘
const before = readExclude();
const injected = ensureInsideRepoIgnore(repo, path.join(repo, 'evil\n*'), gitDir);
check('含换行的路径 → 返回 null（拒绝写入）', injected === null, JSON.stringify(injected));
check('注入内容未落进 exclude（前后字节完全一致）', readExclude() === before, JSON.stringify(readExclude()));
const tabs = ensureInsideRepoIgnore(repo, path.join(repo, 'a\tb'), gitDir);
check('含制表符的路径同样拒绝', tabs === null, JSON.stringify(tabs));

// 其余既有短路条件不得被本次改动破坏
check('仓库外的受管根 → null', ensureInsideRepoIgnore(repo, path.join(sandbox, 'outside'), gitDir) === null);
check('仓库根本身 → null', ensureInsideRepoIgnore(repo, repo, gitDir) === null);
check('拿不到 gitDir → null', ensureInsideRepoIgnore(repo, path.join(repo, 'wts'), null) === null);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
