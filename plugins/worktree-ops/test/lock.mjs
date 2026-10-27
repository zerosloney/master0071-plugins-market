#!/usr/bin/env node
// worktree-ops 配置锁单测（白盒，直连 mcp/core.mjs）。
//
// smoke.mjs 是纯黑盒（stdio JSON-RPC 驱动 server.mjs），0.4.4 修复的配置锁
// 「迟到 release 不得误删新持锁者的锁」在黑盒下无法稳定触发，这里直接对
// acquireConfigLock 做单测。测试自建临时目录，结束清理。
//
//   node test/lock.mjs
//
// 退出码非 0 表示有断言失败。

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireConfigLock } from '../mcp/core.mjs';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n${title}`);

const sandbox = mkdtempSync(path.join(tmpdir(), 'worktree-ops-lock-'));
const cfgFile = path.join(sandbox, 'config.json');
const lockPath = `${cfgFile}.lock`;

try {
  section('正常获取与释放');
  const release1 = acquireConfigLock(cfgFile);
  check(
    'acquire 后锁文件存在且内容为当前进程 pid',
    existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid),
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(lock file missing)',
  );
  release1();
  check('release 后锁文件被删除', !existsSync(lockPath), lockPath);

  section('释放后他人可立即获取');
  const release2 = acquireConfigLock(cfgFile);
  check('第二次 acquire 立即成功（无死限等待）', existsSync(lockPath), lockPath);
  // release 幂等：锁已被清理后再次 release 走「已被清理」分支，不得抛错
  let doubleReleaseOk = true;
  try {
    release2();
    release2();
  } catch (err) {
    doubleReleaseOk = false;
  }
  check('锁已释放后重复 release 不抛错（幂等）', doubleReleaseOk && !existsSync(lockPath), lockPath);

  section('迟到 release 不误删新持锁者的锁（0.4.4 修复点）');
  // acquireConfigLock 写入锁文件的就是 String(process.pid)；单进程内起不了第二个
  // 「不同归属」的持锁者，直接把锁内容改写成别人的 pid，等价模拟陈旧锁被后来者
  // 接管后的归属状态。
  const releaseA = acquireConfigLock(cfgFile);
  writeFileSync(lockPath, '999999');
  releaseA();
  check(
    'A 迟到的 release 不删除已换主的锁',
    existsSync(lockPath) && readFileSync(lockPath, 'utf8') === '999999',
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(lock file missing)',
  );
  // 清理手工接管的锁，避免污染后续用例与临时目录
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已不存在 */
  }

  section('持锁未释放时再次 acquire 等到死限后报错');
  const holder = acquireConfigLock(cfgFile);
  const started = Date.now();
  let contentionErr = null;
  try {
    acquireConfigLock(cfgFile);
  } catch (err) {
    contentionErr = err;
  }
  const waited = Date.now() - started;
  check(
    '死限（2s）内拿不到锁时明确报错',
    contentionErr instanceof Error && /could not acquire the config lock/.test(contentionErr.message),
    contentionErr && contentionErr.message,
  );
  check('报错前确实等满了死限（约 2s）', waited >= 2000, `${waited}ms`);
  holder();
  check('竞争失败后原持锁者仍可正常释放', !existsSync(lockPath), lockPath);

  // 「陈旧锁超 30s 被接管」路径不在本文件覆盖：CONFIG_LOCK_STALE_MS 是模块常量，
  // core.mjs 直接调用 Date.now，没有注入时钟的手段；真实等待 30s 会拖垮测试。
  // 接管后的归属校验已由上面「换主后迟到 release」用例覆盖。
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
