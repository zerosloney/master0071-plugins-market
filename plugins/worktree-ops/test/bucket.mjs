#!/usr/bin/env node
// worktree-ops 清理分桶单测（白盒，直连 mcp/core.mjs 的 bucketOf）。
//
// 0.4.6 修复：worktree_remove 过去只拦 `clean === false`，git status 取不到时 clean 为 null
// 会被当干净放行；audit 的 bucketOf 同样把这种工作树报成 safe。黑盒下无法稳定制造
// 「git 拒绝报告状态」的目录，这里直接对纯函数下断言，锁死两条口径：
//   · clean === null 且非 prunable → 绝不进 safe（与 remove 的 fail-closed 一致）
//   · prunable 例外仍先出 hold（目录已被手动删走，无未提交工作可丢）
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

// 非受管根判定关闭（managedPath = null），只考察状态维度。
const base = {
  locked: false,
  isMain: false,
  path: '/repo/wt/a',
  prunable: null,
  ahead: 0,
  behind: 0,
  ageDays: 0,
  dirtyCount: 0,
  mergedIntoTarget: true,
};

const clean = { ...base, clean: true };
const dirty = { ...base, clean: false, dirtyCount: 3 };
const unknown = { ...base, clean: null };
const prunableUnknown = { ...base, clean: null, prunable: 'prunable: directory not found' };

const b = (info) => bucketOf(info, 14, null);

check('干净且已并入 target → safe（基线，别把正常路径改坏）', b(clean).bucket === 'safe', JSON.stringify(b(clean)));
check('脏 → hold 并报未提交数', b(dirty).bucket === 'hold' && /3 uncommitted/.test(b(dirty).reason), JSON.stringify(b(dirty)));

const u = b(unknown);
check('git status 取不到 → 绝不进 safe', u.bucket !== 'safe', JSON.stringify(u));
check('git status 取不到 → review 并点明「未证明干净」', u.bucket === 'review' && /unproven/i.test(u.reason), JSON.stringify(u));

const p = b(prunableUnknown);
check('prunable 优先于「状态未知」出账（原因点名 prunable）', p.bucket === 'hold' && /prunable/.test(p.reason), JSON.stringify(p));

// 状态未知时 mergedIntoTarget 为真也不得翻成 safe——这是旧实现真正的放行路径。
check('状态未知 + 已并入 target 仍非 safe', b({ ...unknown, mergedIntoTarget: true }).bucket !== 'safe');
check('clean === undefined（字段缺失）同视为未证明', b({ ...base, clean: undefined }).bucket !== 'safe');

console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
