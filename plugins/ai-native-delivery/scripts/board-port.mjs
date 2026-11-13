// board-port.mjs — 开发全景实时看板的端口解析单源（ensure-board.mjs / auto-tour.mjs 共用）
// 口径：显式 --port（绝对值）> 项目侧 engine.json options.boardPort > 基端口常量。
// 刻意不带源仓的槽位偏移（SHIPYARD_SLOT）——那是多 worktree 并行时的派生口径，与本插件无关；
// 并行场景请显式 --port 区分。
import fs from 'node:fs';
import path from 'node:path';

export const BASE_BOARD_PORT = 8933;

/**
 * 解析看板端口。
 * @param {object} opts
 * @param {string} [opts.explicit] 调用方 --port 原始字符串
 * @param {string} opts.root 仓库根（engine.json 定位用）
 * @returns {number}
 */
export function resolveBoardPort({ explicit = '', root } = {}) {
  if (explicit && Number(explicit)) return Number(explicit);
  let configured = BASE_BOARD_PORT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'config', 'engine.json'), 'utf8'));
    configured = Number(cfg && cfg.options && cfg.options.boardPort) || BASE_BOARD_PORT;
  } catch { /* 无配置或不可读 → 回落基线 */ }
  return configured;
}
