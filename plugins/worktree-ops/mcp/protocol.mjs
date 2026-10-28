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
const SERVER_INFO = { name: 'worktree-ops', version: '0.4.9' };

const TOOL_MAP = new Map(tools.map((t) => [t.name, t]));

/** schema 里的 type 允许写成数组（如 ["string","null"]）。 */
function schemaTypes(type) {
  return Array.isArray(type) ? type : [type];
}

/** 参数类型是否与 schema 相符。
 *  此前 schema 的 type 只写在清单里、没人执行，而工具内部的 boolArg 只认 true/"true"：
 *  noCheckout:"yes" 这类写法会被静默当成 false——调用方以为传了，实际没生效。
 *  这里做一次轻量校验：拦下真正对不上的类型，同时放行工具本来就会无损转换的写法
 *  （数字串、布尔串），免得把既有行为判成错误。 */
function matchesType(type, value) {
  const types = schemaTypes(type);
  if (value === null) return types.includes("null");
  // 空串在本仓是「未传」的约定（numArg("") → null、设置页回传空串），不按类型不匹配处理
  if (value === "") return true;
  const actual = typeof value;
  if (types.includes(actual)) return true;
  if (types.includes("number") && actual === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return true;
  if (types.includes("boolean") && actual === "string" && (value === "true" || value === "false")) return true;
  return false;
}

function jsonTypeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

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
      // 类型校验：schema 的 type 此前没人执行。破坏性参数上尤其要紧——
      // noCheckout:"yes" 会被 boolArg 静默当成 false，调用方以为生效了其实没有。
      const schema = tool.inputSchema.properties || {};
      const badTypes = Object.keys(args).filter(
        (k) => known.has(k) && schema[k] && schema[k].type && !matchesType(schema[k].type, args[k]),
      );
      if (badTypes.length > 0) {
        const detail = badTypes
          .map((k) => `${k}: expected ${schemaTypes(schema[k].type).join(" or ")}, got ${jsonTypeName(args[k])}`)
          .join("; ");
        return reply(id, {
          content: [
            {
              type: "text",
              text:
                `Error: invalid parameter type for ${name}: ${detail}\n` +
                `Pass a value of the declared type; a mismatched value is rejected instead of being silently ignored.`,
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
