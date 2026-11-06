#!/usr/bin/env node
// ai-native-delivery: MCP server (stdio) — 工程骨架入口。
//
// 只接线 JSON-RPC 循环与协议层（mcp/protocol.mjs）；治理工具、台账读写与
// 项目根锚定逻辑由后续单元迁入。零依赖纯 Node，前置要求 Node ≥ 18。
//
// mcp.json 里 command 是裸名 "node"（规范允许），解释器由宿主的 PATH 解析——
// 宿主 PATH 里没有 node 属于宿主侧问题，本进程连启动都做不到；这里能兜住的是
// 「node 找到了但版本太老」这一类。

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

// 单行上限（2026-11-05 收尾批，移植 plugins/systemone-decision/mcp/server.mjs 的 LINE_MAX_BYTES
// 先例）：一行迟迟不出现换行时（宿主异常灌数据/管道错位），行缓冲会无限累积直到吃光内存。
// 超限行直接拒收并回 JSON-RPC 约定的 Parse error（id=null：行级内容超限，无法可靠解析出 id），
// 拒收后清空缓冲，服务对后续行照常应答。
const LINE_MAX_BYTES = 1024 * 1024;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    // 完整行超限同样拒收：拒绝发生在源头，而不是让超大串先过 JSON.parse
    if (Buffer.byteLength(line, "utf8") > LINE_MAX_BYTES) {
      replyError(null, -32700, `单行消息超过 ${LINE_MAX_BYTES} 字节上限，已拒收该行`);
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // 四道闸（2026-11-05 市场审查修复，照 plugins/systemone-decision/mcp/server.mjs 同款）：
    //   形状闸：非对象 / 缺 method 的消息不是 JSON-RPC，丢弃；
    //   版本闸：jsonrpc 白名单外拒收——回包等于对任意版本都声称兼容；
    //   id 闸：id 非字符串/数字（对象/数组/布尔）时无法回写合法响应，拒收不回显；
    //   通知闸：无 id 一律不回包、不分发——副作用工具（tools/call）不得被通知触发。
    if (!message || typeof message !== "object" || typeof message.method !== "string") continue;
    if (message.jsonrpc !== "2.0") continue;
    if (message.id !== undefined && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") continue;
    if (message.id === undefined || message.id === null) continue;
    Promise.resolve(handle(message)).catch((err) => {
      if (message && message.id !== undefined) {
        replyError(message.id, -32603, err && err.message ? err.message : String(err));
      }
    });
  }
  // 完整行消费完后剩下的就是一条尚未出现换行的行：超限即拒——它要么在无限累积（内存风险），
  // 要么不是本协议的消息（永远等不到换行）。拒收后清空缓冲，服务器对后续行照常服务。
  if (buffer.length > 0 && Buffer.byteLength(buffer, "utf8") > LINE_MAX_BYTES) {
    buffer = "";
    replyError(null, -32700, `单行消息超过 ${LINE_MAX_BYTES} 字节上限，已拒收该行`);
  }
});
process.stdin.on("end", () => process.exit(0));

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
