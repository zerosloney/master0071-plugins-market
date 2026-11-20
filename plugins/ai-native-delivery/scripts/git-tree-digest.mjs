// git-tree-digest.mjs — 工作树脏状态摘要（判据移植蓝本 agentic-flow-kit 66bf13a，BACKLOG 34）：
// sha256(`git status --porcelain` 输出 + `git diff HEAD` 内容) 前 16 位。独立无副作用模块（纯导出函数）：
// verify.mjs 落账（绿/失败行绑定「验证时刻工作树 = 基线提交 + 未提交改动」）与测试共用单源。
// 三态恒可判定：干净树 = ''、脏树 = 16 位 hex、git 不可用 / 非 git 根 = null（调用方省略键，不伪造）。
// 零提交仓 `diff HEAD` 失败时只以 porcelain 入摘要（该状态下未提交改动本就全在 porcelain 里）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const dirtyTreeDigest = (root) => {
  const st = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: root });
  if (st.status !== 0) return null;
  if (!st.stdout.trim()) return '';
  const diff = spawnSync('git', ['diff', 'HEAD'], { encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return createHash('sha256').update(`${st.stdout}\n${diff.status === 0 ? diff.stdout : ''}`, 'utf8').digest('hex').slice(0, 16);
};
