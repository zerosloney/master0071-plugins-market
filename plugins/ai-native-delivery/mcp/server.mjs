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
  // 四道闸（2026-11-05 市场审查修复，照 plugins/systemone-decision/mcp/server.mjs 同款）：
  //   形状闸：非对象 / 缺 method 的消息不是 JSON-RPC，丢弃；
  //   版本闸：jsonrpc 白名单外拒收——回包等于对任意版本都声称兼容；
  //   id 闸：id 非字符串/数字（对象/数组/布尔）时无法回写合法响应，拒收不回显；
  //   通知闸：无 id 一律不回包、不分发——副作用工具（tools/call）不得被通知触发。
  if (!message || typeof message !== "object" || typeof message.method !== "string") return;
  if (message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") return;
  if (message.id === undefined || message.id === null) return;
  Promise.resolve(handle(message)).catch((err) => {
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, err && err.message ? err.message : String(err));
    }
  });
});

// 宿主正常关停（关掉 stdio 读端）的瞬间，挂起的 write 会抛 EPIPE——不挂 error 处理就是
// uncaughtException 兜底加崩栈收场（退出码 1），长驻服务在正常关停时也以失败退出。
// EPIPE 只意味着对端已不在：安静退出即可（口径同 plugins/systemone-decision/mcp/server.mjs
// 的既有先例）；其余错误原样上抛，维持 uncaughtException 兜底。
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

process.on("uncaughtException", (e) => {
  process.stderr.write(`[ai-native-delivery] uncaught: ${e && e.stack ? e.stack : e}\n`);
  // 记完日志必须退出：带未知状态继续跑，宿主 MCP 客户端会一直等那条永远不会到的响应，
  // 只能耗到自己的超时才发现出了问题（口径同姊妹实现）。
  process.exit(1);
});
