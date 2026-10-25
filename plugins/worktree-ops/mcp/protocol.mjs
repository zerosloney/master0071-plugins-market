// worktree-ops MCP server — JSON-RPC framing.
//
// Owns initialize / tools/list / tools/call dispatch.

import {
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./core.mjs";

import { tools } from "./tools.mjs";

/* --------------------------------------------------------- MCP json-rpc */

// 服务端身份，initialize 时回给客户端。
// 版本位与 plugins/worktree-ops/plugin.json 同步，由 `node scripts/release.mjs worktree-ops <x.y.z>` 统一改
const SERVER_INFO = { name: 'worktree-ops', version: '0.4.2' };

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
      // 未知参数直接报错：拼错的字段名（forse / repoPaths）被静默忽略时，调用方会以为
      // force 已经生效、或以为传了路径。破坏性工具上这种静默尤其危险。
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
      // schema 的 required 此前只写在清单里、没人执行：status / handoff 缺 name（含空串）
      // 会走 pickWorktree 的空名语义静默描述主工作树——调用看似成功，对象完全错误。
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
        const result = tool.handler(args);
        return reply(id, result);
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: `Error: ${err && err.message ? err.message : String(err)}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return undefined;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

export { handle, replyError };
