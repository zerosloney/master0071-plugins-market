#!/usr/bin/env node
// ai-native-delivery: MCP server (stdio) — 工程骨架入口。
//
// 只接线 JSON-RPC 循环与协议层（mcp/protocol.mjs）；治理工具、台账读写与
// 项目根锚定逻辑由后续单元迁入。零依赖纯 Node，前置要求 Node ≥ 18。
//
// mcp.json 里 command 是裸名 "node"（规范允许），解释器由宿主的 PATH 解析——
// 宿主 PATH 里没有 node 属于宿主侧问题，本进程连启动都做不到；这里能兜住的是
// 「node 找到了但版本太老」这一类。

import readline from "node:readline";

import { handle, replyError } from "./protocol.mjs";

// 启动自检：Node 版本过低时直接给出可读提示，而不是让后续代码在半路炸出难懂的异常。
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write(
    `[ai-native-delivery] Node.js 18 or newer is required; this server runs on ${process.versions.node}.\n` +
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
  } catch {
    return;
  }
  Promise.resolve(handle(message)).catch((err) => {
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, err && err.message ? err.message : String(err));
    }
  });
});
