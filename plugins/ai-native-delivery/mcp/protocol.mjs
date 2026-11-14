// ai-native-delivery MCP server — JSON-RPC framing.
//
// 协议层：initialize / ping / tools/list / tools/call 分派。工具表在 tools.mjs（10 个治理工具，
// 设计文档 §3.3 起家 7 个 + 2026-11-12 扩容 3 个巡检工具），实现内核在 core.mjs；本文件只做握手、
// 分派与错误协议，保持 SERVER_INFO 版本位。

import { tools, ToolError } from "./tools.mjs";

// 协议版本：stdio 传输 initialize 握手可接受的 MCP 协议版本（2026-11-05 收尾批：从单一版本
// 收成版本列表——只认一个版本时，客户端报**受支持的旧版本**也被回落声明，等于对受支持版本
// 谎报不兼容；口径同 plugins/systemone-decision/mcp/server.mjs 的版本协商）。
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/* --------------------------------------------------------- MCP json-rpc */

// 服务端身份，initialize 时回给客户端。
// 版本位与 plugins/ai-native-delivery/plugin.json 同步，由 `node scripts/release.mjs ai-native-delivery <x.y.z>` 统一改
const SERVER_INFO = { name: 'ai-native-delivery', version: '0.3.13' };

const TOOL_MAP = new Map(tools.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

// schema 类型判据（2026-11-05 市场审查修复的配套）：按 JSON Schema 声明的 type 判值形。
// type 兼容单字符串与数组两种声明形态；object/array 分辨（typeof 都是 'object'）。
const declaredTypes = (prop) => (Array.isArray(prop.type) ? prop.type : [prop.type]);
const typeMatches = (decls, v) => {
  if (v === null) return decls.includes("null");
  const t = typeof v;
  if (t !== "object") return decls.includes(t);
  return decls.includes(Array.isArray(v) ? "array" : "object");
};
const actualTypeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function replyInvalidParam(id, text) {
  return reply(id, { content: [{ type: "text", text }], isError: true });
}

async function handle(message) {
  // 协议层 id 闸（2026-11-05 市场审查修复；server.mjs 循环已闸一道，这里兜协议契约本身）：
  //   无 id = 通知：一律不回包——回包没有 id 宿主无法配对，等于向对端塞垃圾帧；副作用工具
  //     （tools/call）更不能被通知触发（通知语义不触发工具）；
  //   id 非字符串/数字（对象/数组/布尔）或非有限数字（1e999→Infinity 序列化即 null 无法配对，
  //     2026-11-09 与 server.mjs id 闸同步收口）：无法回写合法响应，拒收。
  if (!message || typeof message !== "object" || typeof message.method !== "string") return undefined;
  const { id, method, params } = message;
  if (id === undefined || id === null) return undefined;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) return undefined;
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
      // 裸 initialized 带 id 的请求（2026-11-05 收尾批）：部分客户端把它发成请求而非通知——
      // 不回包客户端会挂到自己的超时。能走到这里说明已过 id 闸（必带 id），回空 result 即可；
      // 标准通知形态（无 id）根本进不了分派（server.mjs 与函数顶的 id 闸都拦），维持不回包。
      return reply(id, {});
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = params && params.name;
      const tool = TOOL_MAP.get(name);
      // unknown tool 走 JSON-RPC 规范的 -32602（2026-11-05，审查 m1 顺带修）：isError 结果是
      // 「工具执行了但失败」的形态，工具不存在根本没执行——两者不该共用一个形态。
      if (!tool) return replyError(id, -32602, `unknown tool: ${name}`);
      const args = params.arguments || {};
      // 未知参数直接报错：拼错的字段名被静默忽略时，调用方会以为参数已生效。
      const known = new Set(Object.keys(tool.inputSchema.properties || {}));
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        return replyInvalidParam(
          id,
          `Error: unknown parameter(s) for ${name}: ${unknown.join(", ")}\n` +
            `Valid parameters: ${[...known].join(", ")}`,
        );
      }
      // schema 的 type / enum 在此执行（2026-11-05 市场审查修复）：此前只执行未知键与 required，
      // 声明的类型与枚举完全不落地——doc:123 静默丢弃、strict_quote:"yes" 静默按 false、
      // update_ledger content:123 落盘 "123\n"。schema 是调用方唯一读得到的契约，声明了就执行；
      // handler 侧的宽松兜底保留（防御纵深）。错误消息点名参数 / 期望 / 实际。
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue;
        const prop = (tool.inputSchema.properties || {})[key];
        if (!prop) continue; // 未知键已被上面的 unknown 闸拦下
        if (prop.type !== undefined && !typeMatches(declaredTypes(prop), value)) {
          return replyInvalidParam(
            id,
            `Error: invalid type for parameter "${key}" of ${name}: expected ${declaredTypes(prop).join(" / ")}, got ${actualTypeOf(value)}`,
          );
        }
        if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
          return replyInvalidParam(
            id,
            `Error: invalid value for parameter "${key}" of ${name}: expected one of ${prop.enum.map((e) => JSON.stringify(e)).join(" / ")}, got ${JSON.stringify(value)}`,
          );
        }
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
      // 无 id / 非法 id 已在函数头顶的 id 闸拦掉，走到这里必然可回包
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

export { handle, replyError };
