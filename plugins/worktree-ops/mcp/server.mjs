#!/usr/bin/env node
// worktree-ops: MCP server (stdio) that manages git worktrees in a configurable
// directory outside the repository.
//
// Agent hosts generally pin a session's working directory at start, so this server
// does not pretend to relocate the running session. It owns the worktree lifecycle,
// the configurable root directory, and the handoff text that tells the user where to
// open the work that belongs in that worktree.
//
// Configuration precedence (highest first):
//   1. environment overrides  WORKTREE_ROOT / WORKTREE_BASE_REF /
//      WORKTREE_BRANCH_PREFIX / WORKTREE_STALE_DAYS
//   2. per-repository overrides in the config file
//   3. global config file
//   4. built-in defaults
//
// Config file location:
//   Windows  %APPDATA%/worktree-ops/config.json
//   POSIX    $XDG_CONFIG_HOME/worktree-ops/config.json  (default ~/.config)
// Override the whole directory with WORKTREE_CONFIG_HOME.

// Entry point: wires the core layer, the tool table and the JSON-RPC loop together.
// All behaviour lives in core.mjs / tools.mjs / protocol.mjs.

import readline from "node:readline";

import { handle, replyError } from "./protocol.mjs";

// 启动自检：Node 版本过低时直接给出可读提示，而不是让后续代码在半路炸出难懂的异常。
// mcp.json 里 command 是裸名 "node"（规范允许），所以解释器由宿主的 PATH 解析——
// 宿主 PATH 里没有 node 属于宿主侧问题，本进程连启动都做不到；这里能兜住的是
// 「node 找到了但版本太老」这一类。
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write(
    `[worktree-ops] Node.js 18 or newer is required; this server runs on ${process.versions.node}.\n` +
      "Install a newer Node.js and make sure the host launches it with that version on PATH.\n",
  );
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    // 畸形 JSON 必须回 -32700：静默丢弃会让客户端一直等到宿主超时，
    // 分不清是「服务端没收到」还是「服务端卡住了」。id 用 null（JSON-RPC 对解析错误的约定）。
    replyError(null, -32700, `Parse error: ${err && err.message ? err.message : String(err)}`);
    return;
  }
  Promise.resolve(handle(message)).catch((err) => {
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, err && err.message ? err.message : String(err));
    }
  });
});
