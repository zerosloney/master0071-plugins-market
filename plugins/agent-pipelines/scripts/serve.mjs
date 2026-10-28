#!/usr/bin/env node
// agent-pipelines 实时看板：HTTP + SSE 监听状态文件与事件日志，浏览器自动刷新。
// 用法：node scripts/serve.mjs --pipeline coding --file .loop-cli/state/coding-pipeline.json [--port 8787] [--interval 1000]
// 只读：不写状态、不追加事件、不取锁。默认只绑 127.0.0.1。
import { createServer } from "node:http";
import { statSync, watch } from "node:fs";
import path from "node:path";
import { buildHtml, layoutGraph, loadEvents, loadState, pipelineOf, stateFile } from "./render.mjs";
import { parseArgs } from "./args.mjs";

const args = parseArgs(process.argv.slice(2), { boolean: ["json"], value: ["pipeline", "file", "port", "interval"] });
const pipeline = pipelineOf(args);
const file = stateFile(args, pipeline);
const eventsFile = file.replace(/\.json$/, ".events.jsonl");
const port = Number(args.port) > 0 ? Number(args.port) : 8787;
const interval = Number(args.interval) > 0 ? Number(args.interval) : 1000;

let clients = new Set();
let lastHtml = "";
let lastStateMtime = 0;
let lastEventsMtime = 0;

function renderHtml() {
  const state = loadState(file);
  const events = loadEvents(file);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const graph = layoutGraph(tasks);
  return buildHtml({ pipeline, file, state, events, graph, live: true });
}

function broadcast() {
  const html = renderHtml();
  const changed = html !== lastHtml;
  lastHtml = html;
  for (const res of clients) {
    try {
      res.write(`event: render\ndata: ${JSON.stringify({ changed, ts: new Date().toISOString() })}\n\n`);
    } catch {
      // 客户端在 close 事件到达前断开：写失败直接摘除，别让广播循环中断或抛未捕获异常
      clients.delete(res);
    }
  }
}

function handleRequest(req, res) {
  // 兜底：畸形请求行/请求头可能让 new URL 抛错，回调内异常会打崩整个看板进程
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(lastHtml);
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      // write 到已销毁的流会触发 error 事件（先于 close）：不接住就是未捕获异常，直接打崩看板进程
      res.on("error", () => clients.delete(res));
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, pipeline, file, port, clients: clients.size }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad request");
  }
}

// 轮询兜底：watch 在部分平台（含文件被原子替换时）可能失效，轮询保证最终一致。
setInterval(() => {
  try {
    const stateMtime = statSync(file).mtimeMs;
    const eventsMtime = statSync(eventsFile).mtimeMs;
    if (stateMtime !== lastStateMtime || eventsMtime !== lastEventsMtime) {
      lastStateMtime = stateMtime;
      lastEventsMtime = eventsMtime;
      lastHtml = renderHtml();
      broadcast();
    }
  } catch {
    // 文件暂不可读（被替换的瞬间），等待下一轮
  }
}, interval);

// watch 立即推送：文件一变化就触发，减少轮询延迟。
try {
  watch(file, () => {
    try {
      lastHtml = renderHtml();
      broadcast();
    } catch {}
  });
} catch {}
try {
  watch(eventsFile, () => {
    try {
      lastHtml = renderHtml();
      broadcast();
    } catch {}
  });
} catch {}

// 状态文件缺失/损坏时给可读指引并以退出码 2 结束，而不是模块顶层裸栈崩溃
try {
  lastHtml = renderHtml();
} catch (err) {
  console.error(`agent-pipelines live board could not start: ${err.message}`);
  console.error(`先运行 state.mjs init 创建状态文件，例如：node scripts/state.mjs init --pipeline ${pipeline} --file ${file} --prompt "<目标>"`);
  process.exit(2);
}

const server = createServer(handleRequest);
// 端口被占（常见于上一个看板没退干净）时给可读报错并以退出码 2 结束，而不是抛未监听的 error 事件
server.on("error", (err) => {
  console.error(`agent-pipelines live board could not listen on 127.0.0.1:${port}: ${err.message}`);
  process.exit(2);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`agent-pipelines live board: http://127.0.0.1:${port}`);
  console.log(`state: ${file}`);
  console.log(`events: ${eventsFile}`);
  console.log("SSE: /events · health: /health · Ctrl+C 停止");
});