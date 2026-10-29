#!/usr/bin/env node
// worktree-ops 清理分桶单测（白盒，直连 mcp/core.mjs 的 bucketOf）。
//
// 0.4.6 修复：worktree_remove 过去只拦 `clean === false`，git status 取不到时 clean 为 null
// 会被当干净放行；audit 的 bucketOf 同样把这种工作树报成 safe。黑盒下无法稳定制造
// 「git 拒绝报告状态」的目录，这里直接对纯函数下断言，锁死两条口径：
//   · clean === null 且非 prunable → 绝不进 safe（与 remove 的 fail-closed 一致）
//   · prunable 例外仍先出 hold（目录已被手动删走，无未提交工作可丢）
//
// 2026-10-29 市场审查修复：**受管根参数不再是可选项**。
// 旧用例一律传 managedPath=null 并断言 safe，而 null 恰恰是「没配 root」——worktree_remove
// 对这种状态永远拒绝（`outside the managed root (none configured)`），于是测试把「audit 说
// 能删、remove 一定拒绝」这个错误行为钉成了契约。现在基线用真实受管根，null 单独出一组反断言。
//
//   node test/bucket.mjs
//
// 退出码非 0 表示有断言失败。

import { bucketOf } from '../mcp/core.mjs';

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

const base = {
  locked: false,
  isMain: false,
  path: '/repo/wt/a',
  prunable: null,
  ahead: 0,
  behind: 0,
  ageDays: 0,
  dirtyCount: 0,
  ignoredCount: 0,
  ignoredFiles: [],
  mergedIntoTarget: true,
};

/** 受管根 = /repo/wt（基线用例的 path 落在其内）。 */
const ROOT = '/repo/wt';

const clean = { ...base, clean: true };
const dirty = { ...base, clean: false, dirtyCount: 3 };
const unknown = { ...base, clean: null };
const prunableUnknown = { ...base, clean: null, prunable: 'prunable: directory not found' };
const ignoredOnly = { ...base, clean: true, ignoredCount: 2, ignoredFiles: ['!! .env', '!! build/'] };

const b = (info, managedPath = ROOT) => bucketOf(info, 14, managedPath);

console.log('受管根内（基线）');
check('干净且已并入 target → safe（基线，别把正常路径改坏）', b(clean).bucket === 'safe', JSON.stringify(b(clean)));
check('脏 → hold 并报未提交数', b(dirty).bucket === 'hold' && /3 uncommitted/.test(b(dirty).reason), JSON.stringify(b(dirty)));

console.log('\n状态未知');
const u = b(unknown);
check('git status 取不到 → 绝不进 safe', u.bucket !== 'safe', JSON.stringify(u));
check('git status 取不到 → review 并点明「未证明干净」', u.bucket === 'review' && /unproven/i.test(u.reason), JSON.stringify(u));

const p = b(prunableUnknown);
check('prunable 优先于「状态未知」出账（原因点名 prunable）', p.bucket === 'hold' && /prunable/.test(p.reason), JSON.stringify(p));

// 状态未知时 mergedIntoTarget 为真也不得翻成 safe——这是旧实现真正的放行路径。
check('状态未知 + 已并入 target 仍非 safe', b({ ...unknown, mergedIntoTarget: true }).bucket !== 'safe');
check('clean === undefined（字段缺失）同视为未证明', b({ ...base, clean: undefined }).bucket !== 'safe');

console.log('\ngitignored 内容（2026-10-29 新增）');
// 回归：裸 `git status --porcelain` 看不见被 .gitignore 的文件，只含 .env + build/ 的工作树
// 被判 clean，remove 不带任何 flag 就连同 .env 一起删掉。分桶必须与 remove 同口径。
const ig = b(ignoredOnly);
check('只含 gitignored 文件 → 绝不进 safe', ig.bucket !== 'safe', JSON.stringify(ig));
check('只含 gitignored 文件 → hold 并点明会随目录删除', ig.bucket === 'hold' && /gitignored/.test(ig.reason), JSON.stringify(ig));
check('ignoredCount 缺省（旧描述对象）不误伤', b({ ...clean, ignoredCount: undefined }).bucket === 'safe');

console.log('\n未配置受管根（2026-10-29 修正）');
// 旧实现写成 `if (managedPath && !isInside(...))`，null 时整条跳过 → 没配根时全部报 safe，
// 而 worktree_remove 在同一状态下必拒绝。audit 的指引必须与 remove 的护栏同宽。
const noRoot = b(clean, null);
check('无受管根 → 绝不进 safe', noRoot.bucket !== 'safe', JSON.stringify(noRoot));
check('无受管根 → review 并点明没配根', noRoot.bucket === 'review' && /no managed root/i.test(noRoot.reason), JSON.stringify(noRoot));

console.log('\n受管根外');
const outside = b({ ...clean, path: '/elsewhere/wt/a' }, ROOT);
check('受管根外 → review 并点明 outside', outside.bucket === 'review' && /outside the managed root/.test(outside.reason), JSON.stringify(outside));

console.log('\n未合并提交');
const ahead = b({ ...clean, ahead: 2 }, ROOT);
check('有未合并提交 → hold', ahead.bucket === 'hold' && /2 commit/.test(ahead.reason), JSON.stringify(ahead));

console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
