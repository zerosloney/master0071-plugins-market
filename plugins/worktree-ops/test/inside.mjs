#!/usr/bin/env node
// worktree-ops 受管根包含判定单测（白盒，直连 mcp/core.mjs 的 isInside）。
//
// 受管根判定曾两侧口径不对称：root 一侧走 canonical（存在→真实路径），dir 一侧在
// 目录不存在时退回字面 path.resolve。Windows 的 junction / 8.3 短名下，同一个目录的
// 两种写法被判成两个目录，三个后果都在 create 路径上：
//   · 用户显式传的 path 明明在自己的受管根里，却被拒 "outside the managed root"；
//   · 根目录设在仓库内时 isInside(dir, repo) 误判 → .git/info/exclude 不写 →
//     新 worktree 以未跟踪目录污染主检出 git status（plugin.json 声称要避免的场景）；
//   · isInside(dir, gitDir) 同样误判 → 「落点在 .git 目录内一律拒绝」的护栏被绕过。
//
// 修法：canonicalPath 归一到**最长的已存在祖先**再把剩余段拼回去，两侧同口径后再做
// path.relative。junction 用 fs.symlinkSync(..., 'junction') 造（Windows 无需管理员权限）。
//
//   node test/inside.mjs

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from '../mcp/core.mjs';

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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'worktree-inside-'));
const real = path.join(sandbox, 'real');
const junction = path.join(sandbox, 'junction');
const outside = path.join(sandbox, 'outside');
mkdirSync(path.join(real, '.git'), { recursive: true });
mkdirSync(outside, { recursive: true });
// 'junction' 只在 Windows 上有意义；其他平台按普通目录符号链接处理，语义等价
symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir');

// ① junction 作受管根，落点尚不存在（新建 worktree 的典型形态）
check(
  'junction 根 + 不存在的子目录 → 判为「在内」',
  isInside(path.join(junction, 'newwt'), junction) === true,
  `${path.join(junction, 'newwt')} vs ${junction}`,
);

// ② 根存在、子目录不存在（无 junction）：最朴素的形态也不能漏判
const plainRoot = path.join(sandbox, 'plain-root');
mkdirSync(plainRoot, { recursive: true });
check(
  '根存在 + 子目录不存在 → 判为「在内」',
  isInside(path.join(plainRoot, 'not-created-yet'), plainRoot) === true,
  plainRoot,
);

// ③ 两侧混用写法：junction 下的 .git 与真实 .git 是同一个目录
check(
  'junction 下的 .git/子目录 vs 真实 .git → 判为「在内」',
  isInside(path.join(junction, '.git', 'wt-x'), path.join(real, '.git')) === true,
  `${path.join(junction, '.git', 'wt-x')} vs ${path.join(real, '.git')}`,
);
check(
  'junction 下的 .git/子目录 vs junction 下的 .git → 判为「在内」',
  isInside(path.join(junction, '.git', 'wt-x'), path.join(junction, '.git')) === true,
  path.join(junction, '.git'),
);

// ④ 真正在受管根外的路径仍必须判为「在外」（修护栏不能修过头）
check(
  '受管根外的目录 → 判为「不在内」',
  isInside(outside, junction) === false,
  outside,
);
check(
  '受管根外的兄弟目录（名字是根的前缀）→ 判为「不在内」',
  isInside(path.join(sandbox, 'junction-other'), junction) === false,
  path.join(sandbox, 'junction-other'),
);

// ⑤ 受管根本身不算「在内」（与既有口径一致）
check('受管根本身不算「在内」', isInside(junction, junction) === false, junction);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
