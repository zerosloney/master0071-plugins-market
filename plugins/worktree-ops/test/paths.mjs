#!/usr/bin/env node
// worktree-ops 路径比较单测（白盒，直连 mcp/core.mjs 的 samePath / isInside）。
//
// 0.4.9 修复：samePath / isInside 只做 path.resolve + 大小写折叠，不解析 Windows 的 8.3 短名。
// GitHub Actions 的 TEMP 是 C:\Users\RUNNER~1\...，`git worktree list` 回长名
// C:\Users\runneradmin\...——同一目录被字符串比较判成两个，CI 上表现为「受管根外拒绝删除」
// 与「worktree not found」，而实际是同一个 worktree。现统一走 realpath 归一。
//
// 8.3 别名本身不可便携制造，故该项在无别名环境自动跳过；真实回归由 windows-latest 矩阵验证。
//
//   node test/paths.mjs
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath, isInside, CASE_INSENSITIVE_FS } from '../mcp/core.mjs';

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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'worktree-paths-'));
const root = path.join(sandbox, 'root');
const nested = path.join(root, 'wt', 'a');
const sibling = path.join(sandbox, 'sibling');
mkdirSync(nested, { recursive: true });
mkdirSync(sibling, { recursive: true });

check('同一路径 → 相等', samePath(nested, nested));
check(
  `大小写变体 → ${CASE_INSENSITIVE_FS ? '相等（不区分大小写文件系统）' : '不等（区分大小写文件系统）'}`,
  samePath(nested, nested.toUpperCase()) === CASE_INSENSITIVE_FS,
);
check('不同路径 → 不等', samePath(nested, sibling) === false);

// prunable 工作树的目录可能已被手动删走：取不到 realpath 时不得抛错，退回归一结果比较
const gone = path.join(sandbox, 'gone', 'x');
check('不存在的路径不抛错且自比相等', samePath(gone, gone) === true);
check('不存在的路径与现存路径 → 不等', samePath(gone, nested) === false);

check('嵌套目录在受管根内', isInside(nested, root) === true);
check('兄弟目录不在受管根内', isInside(sibling, root) === false);
check('受管根本身不算「在内」', isInside(root, root) === false);
check('目录不在不存在的受管根内', isInside(nested, gone) === false);

// 8.3 短名：仅当本机确有别名（GitHub Actions 的 RUNNER~1 即此类）时才有可断言对象
if (process.platform === 'win32' && existsSync('C:\\PROGRA~1')) {
  const longForm = realpathSync.native('C:\\PROGRA~1').replace(/^\\\\\?\\/, '');
  check('8.3 短名与长名指向同一目录 → 相等', samePath('C:\\PROGRA~1', longForm) === true, longForm);
  // 短名写法作父路径时，长名写法作子路径也必须判「在内」——受管根与 worktree 路径正是这样混用的
  check('短名父 / 长名子 → 判为「在内」', isInside(`${longForm}\\Windows`, 'C:\\PROGRA~1') === true, longForm);
} else {
  console.log('  · 8.3 别名不可用（非 Windows 或未启用短名）——跳过两项，回归由 windows-latest 矩阵验证');
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
