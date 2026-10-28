#!/usr/bin/env node
// worktree-ops git 子进程超时单测（白盒，直连 mcp/core.mjs 的 git / runGitProcess）。
//
// 旧实现的 git 调用（execFileSync）没有 timeout / killSignal：一次挂住的 git
// （超大仓库、Windows 文件锁、网络盘）会永久阻塞整个 MCP 服务。工具实现是同步的，
// 宿主只能看到「工具无响应」，进行中的状态还不确定。
//
// 修法：统一走 runGitProcess，带 timeout（默认 30s）与 killSignal，并把超时翻译成
// 含命令、cwd、耗时的可读错误。本套件用「可控的慢命令」（node -e setTimeout）验证，
// 不真的等 30s——超时值本身可注入覆盖。
//
//   node test/timeout.mjs

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  getGitTimeoutMs,
  git,
  runGitProcess,
  setGitTimeoutMs,
} from '../mcp/core.mjs';

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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'worktree-timeout-'));
const cwd = path.join(sandbox, 'work');
mkdirSync(cwd, { recursive: true });

// 慢命令：睡 5 秒。超时生效时应当在远小于 5 秒内返回错误，而不是挂住。
const slowCommand = [process.execPath, '-e', 'setTimeout(() => {}, 5000)'];

check('默认超时上限是 30 秒', DEFAULT_GIT_TIMEOUT_MS === 30000, String(DEFAULT_GIT_TIMEOUT_MS));
check('默认超时值可读回', getGitTimeoutMs() === DEFAULT_GIT_TIMEOUT_MS, String(getGitTimeoutMs()));

// ① 超时抛错，且错误文本含命令、cwd、耗时
const started = Date.now();
let timeoutError = null;
try {
  runGitProcess(slowCommand[0], slowCommand.slice(1), { cwd, timeoutMs: 300 });
} catch (err) {
  timeoutError = err;
}
const elapsed = Date.now() - started;
check('慢命令被超时打断并抛错', timeoutError !== null, String(timeoutError));
check(
  '超时错误写明命令与 cwd',
  Boolean(timeoutError) && /timed out/.test(timeoutError.message) && timeoutError.message.includes(cwd),
  timeoutError ? timeoutError.message : '',
);
check(
  '超时错误写明耗时与上限',
  Boolean(timeoutError) && /after \d+ms/.test(timeoutError.message) && /limit 300ms/.test(timeoutError.message),
  timeoutError ? timeoutError.message : '',
);
check('超时后立即返回而不是挂住（远快于命令本身的 5 秒）', elapsed < 4000, `${elapsed}ms`);

// ② allowFail 语义不变：失败返回 null，不抛错
const nulled = runGitProcess(slowCommand[0], slowCommand.slice(1), { cwd, timeoutMs: 200, allowFail: true });
check('allowFail 时超时返回 null 而不是抛错', nulled === null, String(nulled));

// ③ 注入的超时值对 git() 生效（不是只对 runGitProcess 生效）
setGitTimeoutMs(1);
check('注入的超时值可读回', getGitTimeoutMs() === 1, String(getGitTimeoutMs()));
let gitError = null;
try {
  git(["--version"], cwd);
} catch (err) {
  gitError = err;
}
check('git() 也受超时约束（挂住的 git 会被杀掉并报错）', gitError !== null && /timed out/.test(gitError.message), gitError ? gitError.message : 'no error');
setGitTimeoutMs(DEFAULT_GIT_TIMEOUT_MS);
check('超时值可恢复默认', getGitTimeoutMs() === DEFAULT_GIT_TIMEOUT_MS, String(getGitTimeoutMs()));

// ④ 正常命令不受影响
const ok = runGitProcess(process.execPath, ['-e', 'process.stdout.write("hi")'], { cwd, timeoutMs: 5000 });
check('正常命令照常返回输出', String(ok).trim() === 'hi', String(ok));

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${fail.length === 0 ? '全部通过' : `${fail.length} 项失败`}：${pass} 断言`);
process.exit(fail.length === 0 ? 0 : 1);
