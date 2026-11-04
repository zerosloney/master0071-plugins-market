#!/usr/bin/env node
// worktree-ops 配置锁单测（白盒，直连 mcp/core.mjs）。
//
// smoke.mjs 是纯黑盒（stdio JSON-RPC 驱动 server.mjs），配置锁的竞态路径
// 「迟到 release 不得误删新持锁者的锁」「陈旧锁接管」「写盘前归属校验」在黑盒下
// 无法稳定触发，这里直接对 acquireConfigLock / saveConfig 做单测。测试自建临时
// 目录，结束清理。
//
//   node test/lock.mjs
//
// 退出码非 0 表示有断言失败。

import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireConfigLock, CONFIG_LOCK_STALE_MS, saveConfig } from '../mcp/core.mjs';

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
// saveConfig 的落盘目标由 configDir() 在调用时读该环境变量决定：指向沙箱后，
// saveConfig 操作的 config.json 与锁文件就是上面两个路径。
process.env.WORKTREE_CONFIG_HOME = sandbox;

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

  // 陈旧锁接管（> CONFIG_LOCK_STALE_MS）：不用真实等 30s，手工造锁后用 utimesSync
  // 把 mtime 回拨到阈值之外即可驱动接管路径，随后验证 saveConfig 照常落盘。
  section('陈旧锁超阈值被接管，接管后 saveConfig 正常落盘');
  const staleTs = new Date(Date.now() - (CONFIG_LOCK_STALE_MS + 5000));
  writeFileSync(lockPath, '888888');
  utimesSync(lockPath, staleTs, staleTs);
  // saveConfig 内部自取锁：这里的 acquire 走的就是陈旧锁接管路径
  let staleSaved = null;
  try {
    staleSaved = saveConfig({ top: { baseRef: 'stale-takeover-ok' } });
  } catch (err) {
    staleSaved = err;
  }
  check(
    '接管后 saveConfig 落盘成功且内容生效',
    staleSaved === cfgFile && existsSync(cfgFile) && JSON.parse(readFileSync(cfgFile, 'utf8')).baseRef === 'stale-takeover-ok',
    staleSaved instanceof Error ? staleSaved.message : `returned ${staleSaved}`,
  );
  check('saveConfig 的内部 release 已清理锁', !existsSync(lockPath), lockPath);

  section('陈旧锁被 acquireConfigLock 立即接管，锁内容为新持有者 pid');
  writeFileSync(lockPath, '888888');
  utimesSync(lockPath, staleTs, staleTs);
  const takeoverStarted = Date.now();
  let takeoverErr = null;
  let releaseStale = null;
  try {
    releaseStale = acquireConfigLock(cfgFile);
  } catch (err) {
    takeoverErr = err;
  }
  const takeoverTook = Date.now() - takeoverStarted;
  check(
    '超龄锁立即被接管（未等 2s 死限）',
    takeoverErr === null && existsSync(lockPath) && takeoverTook < 1000,
    takeoverErr ? takeoverErr.message : `${takeoverTook}ms`,
  );
  check(
    '接管后锁内容是新持有者 pid（原子替换，不留空窗）',
    existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid),
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(lock file missing)',
  );
  releaseStale();
  check('接管的锁可正常释放', !existsSync(lockPath), lockPath);

  section('写盘前归属校验：临界区内锁被换主则拒绝落盘（接管竞态防线）');
  // 真实竞态是「saveConfig 持锁期间另一进程把锁换成它的 pid」，单进程同步测试无法
  // 在 acquire 与写盘之间插手。core.mjs 以 `import fs from "node:fs"` 动态取属性，
  // 这里临时替换 fs.readFileSync，借 readConfigFile 必经的 config.json 读取把换主
  // 动作真实写进临界区窗口：saveConfig 一读磁盘就先把锁内容改成别人的 pid。
  // 修复前 saveConfig 不做写前归属校验，会照常落盘（本用例失败）。
  const configBefore = readFileSync(cfgFile, 'utf8');
  const realReadFileSync = fs.readFileSync;
  let tamperFired = false;
  fs.readFileSync = function readFileSyncWithOwnershipTakeover(file, ...rest) {
    if (file === cfgFile) {
      tamperFired = true;
      writeFileSync(lockPath, '999999');
    }
    return realReadFileSync.call(fs, file, ...rest);
  };
  let ownerErr = null;
  try {
    saveConfig({ top: { baseRef: 'must-not-land' } });
  } catch (err) {
    ownerErr = err;
  }
  fs.readFileSync = realReadFileSync;
  check(
    'saveConfig 写盘前发现锁已换主并抛错',
    ownerErr instanceof Error && /lost the config lock/.test(ownerErr.message),
    ownerErr ? ownerErr.message : '(no error thrown)',
  );
  check('换主动作确实发生在临界区窗口内', tamperFired, '(patch never reached)');
  check('config.json 内容保持不变（拒绝落盘）', readFileSync(cfgFile, 'utf8') === configBefore, 'config.json was modified');
  check(
    'release 不误删换主后的锁（迟到 release 防线兜底）',
    existsSync(lockPath) && readFileSync(lockPath, 'utf8') === '999999',
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '(lock file missing)',
  );
  // 清理换主后的锁，避免污染临时目录
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已不存在 */
  }

  section('写盘失败不泄漏临时文件（清理 try 覆盖 writeFileSync 本身）');
  // 旧实现的清理 try 从写盘之后才开始：writeFileSync 本身失败（ENOSPC/EACCES）时，
  // 刚建的 .tmp 半截文件永久残留。沿用本文件的 fs monkeypatch 前例：对 saveConfig 的
  // 临时路径先真实写出半截内容、再抛 ENOSPC，修复前残留可断言。
  const beforeEnospc = readFileSync(cfgFile, 'utf8');
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function writeFileSyncHalfThenFail(file, ...rest) {
    if (typeof file === 'string' && file.startsWith(`${cfgFile}.`) && file.endsWith('.tmp')) {
      realWriteFileSync.call(fs, file, '{ "root": null, "partial"', 'utf8');
      const err = new Error(`ENOSPC: no space left on device, write '${file}'`);
      err.code = 'ENOSPC';
      throw err;
    }
    return realWriteFileSync.call(fs, file, ...rest);
  };
  let enospcErr = null;
  try {
    saveConfig({ top: { baseRef: 'must-not-land-enospc' } });
  } catch (err) {
    enospcErr = err;
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }
  check(
    'writeFileSync 对临时文件失败时 saveConfig 原样抛错',
    enospcErr instanceof Error && enospcErr.code === 'ENOSPC',
    enospcErr ? `${enospcErr.code || '(no code)'} ${enospcErr.message}` : '(no error thrown)',
  );
  const tmpResidue = readdirSync(sandbox).filter((f) => f.endsWith('.tmp'));
  check('失败后目录里无 *.tmp 残留', tmpResidue.length === 0, tmpResidue.join(', ') || '(none)');
  check(
    'config.json 内容保持不变（本次保存中止）',
    readFileSync(cfgFile, 'utf8') === beforeEnospc,
    'config.json was modified',
  );
  check('锁已随 finally 释放', !existsSync(lockPath), lockPath);

  section('锁 fd 泄漏：writeSync 抛错时 fd 仍被关闭（try/finally 补强）');
  // openSync(wx) → writeSync → closeSync 原本无 try/finally：writeSync 抛错时 fd 泄漏。
  // 单进程内无法真实构造 writeSync 失败，沿用 fs monkeypatch 前例替换 fs.writeSync：
  // 首次写锁即抛 EEXIST 码错误 → 走既有竞争退避路径直至 2s 死限，spy 验证 closeSync
  // 在抛错路径上仍被调用，且最终以明确的超时错误收场（不崩溃）。
  const realOpenSync = fs.openSync;
  const realWriteSync = fs.writeSync;
  const realCloseSync = fs.closeSync;
  let openedFd = null;
  let writeSyncCalls = 0;
  const closeSyncCalls = [];
  fs.openSync = function openSyncSpy(file, ...rest) {
    const fd = realOpenSync.call(fs, file, ...rest);
    if (file === lockPath && openedFd === null) openedFd = fd;
    return fd;
  };
  fs.writeSync = function writeSyncThenFail(fd, ...rest) {
    writeSyncCalls += 1;
    const err = new Error(`EEXIST: file already exists, write '${lockPath}' (simulated mid-write failure)`);
    err.code = 'EEXIST';
    throw err;
  };
  fs.closeSync = function closeSyncSpy(fd, ...rest) {
    closeSyncCalls.push(fd);
    return realCloseSync.call(fs, fd, ...rest);
  };
  let writeFailErr = null;
  const writeFailStarted = Date.now();
  try {
    acquireConfigLock(cfgFile);
  } catch (err) {
    writeFailErr = err;
  } finally {
    fs.openSync = realOpenSync;
    fs.writeSync = realWriteSync;
    fs.closeSync = realCloseSync;
  }
  check('writeSync 替换确实命中（首次写锁即抛错）', writeSyncCalls >= 1, `calls=${writeSyncCalls}`);
  check(
    'writeSync 抛错后 closeSync 仍被调用（fd 不泄漏）',
    openedFd !== null && closeSyncCalls.includes(openedFd),
    `openedFd=${openedFd}, closeSyncCalls=${JSON.stringify(closeSyncCalls)}`,
  );
  check(
    '错误按既有竞争路径走满死限后明确报错（不崩溃）',
    writeFailErr instanceof Error && /could not acquire the config lock/.test(writeFailErr.message),
    writeFailErr ? writeFailErr.message : '(no error thrown)',
  );
  const writeFailWaited = Date.now() - writeFailStarted;
  check('确实等满死限（约 2s）', writeFailWaited >= 2000, `${writeFailWaited}ms`);
  // 失败路径会留下内容不全的锁文件（openSync 已建、writeSync 未写）：清理，避免污染临时目录
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已不存在 */
  }
  check('清理后无锁残留', !existsSync(lockPath), lockPath);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
