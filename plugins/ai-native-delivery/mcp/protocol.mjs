// ai-native-delivery MCP server — JSON-RPC framing.
//
// 协议层：initialize / ping / tools/list / tools/call 分派。工具表在 tools.mjs（7 个治理工具，
// 设计文档 §3.3），实现内核在 core.mjs；本文件只做握手、分派与错误协议，保持 SERVER_INFO 版本位。

import { tools, ToolError } from "./tools.mjs";

// 协议版本：stdio 传输 initialize 握手可接受的 MCP 协议版本
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18"];

/* --------------------------------------------------------- MCP json-rpc */

// 服务端身份，initialize 时回给客户端。
// 版本位与 plugins/ai-native-delivery/plugin.json 同步，由 `node scripts/release.mjs ai-native-delivery <x.y.z>` 统一改
const SERVER_INFO = { name: 'ai-native-delivery', version: '0.1.4' };

const TOOL_MAP = new Map(tools.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(id, {
        // 协议版本：不认识客户端报的那个版本就回落到服务器支持的最新版本，
        // 而不是原样回显——回显等于对任意版本都声称支持。
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes((params && params.protocolVersion) || "")
          ? params.protocolVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "initialized":
      return undefined;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = params && params.name;
      const tool = TOOL_MAP.get(name);
      if (!tool) return reply(id, { content: [{ type: "text", text: `Error: unknown tool ${name}` }], isError: true });
      const args = params.arguments || {};
      // 未知参数直接报错：拼错的字段名被静默忽略时，调用方会以为参数已生效。
      const known = new Set(Object.keys(tool.inputSchema.properties || {}));
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        return reply(id, {
          content: [
            {
              type: "text",
              text:
                `Error: unknown parameter(s) for ${name}: ${unknown.join(", ")}\n` +
                `Valid parameters: ${[...known].join(", ")}`,
            },
          ],
          isError: true,
        });
      }
      // schema 的 required 在此执行：缺参（含空串）直接报错，不让 handler 拿半份输入自作主张
      const missing = (tool.inputSchema.required || []).filter((k) => {
        const v = args[k];
        return v === undefined || v === null || (typeof v === "string" && !v.trim());
      });
      if (missing.length > 0) {
        return reply(id, {
          content: [
            {
              type: "text",
              text:
                `Error: missing required parameter(s) for ${name}: ${missing.join(", ")}\n` +
                `Required parameters: ${(tool.inputSchema.required || []).join(", ")}`,
            },
          ],
          isError: true,
        });
      }
      try {
        return reply(id, tool.handler(args));
      } catch (err) {
        // ToolError = 面向调用方的业务错误（带 hint，如项目根不可定位）——原样回传不 crash；
        // 其余异常归一为 isError 文本，服务进程保持存活继续服务下一个请求。
        return reply(id, { content: [{ type: "text", text: `Error: ${err instanceof ToolError || (err && err.message) ? err.message : String(err)}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return undefined;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

export { handle, replyError };
