// git-core.mjs — 引擎 git 调用单源（2026-10-10 收敛系列 5：合并 check-loop-kit spawnGit/gitOut 与
// stage-gates gitRun 的「同口径两份实现」（该债由 stage-gates 头注登记、本单偿清））。
// 语义（取两侧并集，全部调用方共享）：
//   - 参数数组直 spawn（不走 shell——Windows cmd 不认单引号）；git.exe 显式解析（Windows spawn 不补扩展名）
//   - CHECK_LOOP_GIT 环境变量注入钩子（测试替身：指向不存在路径可稳定触发 spawn 异常）
//   - 瞬时类错误（EAGAIN/EPERM/EMFILE/EINTR）单次重试；重试终败响亮出账（进程级去重恰一条）——
//     「非 git 仓」（status≠0、无 error）仍是合法装户语义、静默降级
//   - 只读查询记忆化：同参（含 cwd）复用结果；带 error 的基础设施失败不缓存（保留重试语义）
//   - maxBuffer 32MB（pickaxe/name-only 大输出）
import { spawnSync } from 'node:child_process';

export const GIT = process.env.CHECK_LOOP_GIT || (process.platform === 'win32' ? 'git.exe' : 'git');

const GIT_TRANSIENT = new Set(['EAGAIN', 'EPERM', 'EMFILE', 'EINTR']);
const GIT_RESULT_CACHE = new Map(); // 键 = cwd + NUL + args.join(NUL)（多仓安全：confirm-doc 等 root 参数调用方）
let infraWarned = false;
function warnInfra(args, code) {
  if (infraWarned) return;
  infraWarned = true;
  console.error(`git-core: git 探测异常 ${args[0]}（${code}）——按非 git 仓降级，检查面可能收窄`);
}

export function spawnGit(args, cwd) {
  const cacheKey = cwd + '\u0000' + args.join('\u0000');
  if (GIT_RESULT_CACHE.has(cacheKey)) return GIT_RESULT_CACHE.get(cacheKey);
  const opts = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  let r = spawnSync(GIT, args, opts);
  if (r.error) {
    if (GIT_TRANSIENT.has(r.error.code)) r = spawnSync(GIT, args, opts);
    if (r.error) warnInfra(args, r.error.code || r.error.message);
  }
  if (!r.error) GIT_RESULT_CACHE.set(cacheKey, r);
  return r;
}

export function gitOut(args, cwd, { ok = () => true } = {}) {
  const r = spawnGit(args, cwd);
  if (r.error || r.status !== 0 || !ok(r)) return null;
  return r.stdout || '';
}

// --rev 模式 ROOT 切到临时 worktree 后调：缓存键含 cwd，本不必整体作废；保留接口防御未来键形变化
export function clearGitCache() {
  GIT_RESULT_CACHE.clear();
}
