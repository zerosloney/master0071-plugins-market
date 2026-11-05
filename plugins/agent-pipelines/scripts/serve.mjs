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
// --port / --interval 的取值校验（2026-11-01 修复）。旧写法 `Number(args.port) > 0 ? … : 8787`
// 只挡下界：70000 这类越界值会一路传到 server.listen()，由 net 层**同步**抛
// ERR_SOCKET_BAD_PORT（`server.on("error")` 收不到同步抛出），用户看到的是崩栈而不是可读报错；
// 而 -1 / abc 会被静默换成默认端口——端口被人占用时看板悄悄换了地方，调用方无从察觉。
// 与 README.md:63「参数或环境错误 → 退出码 2」及下方 error 处理器自称的「可读报错 + 退出码 2」对齐。
function positivePort(raw, label, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`agent-pipelines live board: --${label} 需要 1-65535 的整数端口，收到「${raw}」`);
    process.exit(2);
  }
  return n;
}

function positiveInt(raw, label, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`agent-pipelines live board: --${label} 需要正整数，收到「${raw}」`);
    process.exit(2);
  }
  return n;
}

const port = positivePort(args.port, "port", 8787);
const interval = positiveInt(args.interval, "interval", 1000);

let clients = new Set();
let lastHtml = "";
// 已渲染内容对应的 mtime 标记（2026-11-05 重构）：watch 与轮询对同一次写入都会触发，
// 靠它把「一次变更」收敛成一次渲染，其余触发复用 lastHtml。渲染成功才更新——渲染中途
// 文件被替换抛错时保留旧标记，下一次触发会重试。
let renderedStateMtime = 0;
let renderedEventsMtime = 0;

function renderHtml() {
  const state = loadState(file);
  const events = loadEvents(file);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const graph = layoutGraph(tasks);
  return buildHtml({ pipeline, file, state, events, graph, live: true });
}

function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0; // 文件尚不存在（如还没产生事件日志）：以 0 为哨兵，一旦创建即视为变化
  }
}

// 一次变更只渲染一次：refresh 是唯一渲染入口，mtime 未变直接复用 lastHtml。
// 旧实现 setInterval/watch 里 lastHtml = renderHtml() 之后 broadcast() 内又 renderHtml()
// 一次——一次状态写触发 state+events 两个 watch + 轮询，≥3 次全量渲染，每次重读最多
// 2×5MiB 事件日志。state 与 events 由同一次写入共同更新，但两个文件的 mtime 元数据
// 对外可见的时刻相差亚毫秒到数毫秒（实测 NTFS ~1ms），两个 watch 会先后观察到两次
// 「变化」——仅靠 mtime 缓存合并不掉，还需要下面的去抖窗口。
function refresh() {
  const stateMtime = mtimeOf(file);
  const eventsMtime = mtimeOf(eventsFile);
  if (stateMtime === renderedStateMtime && eventsMtime === renderedEventsMtime) return;
  let html;
  try {
    html = renderHtml();
  } catch {
    return; // 文件暂不可读（被替换的瞬间）：不动已渲染标记，等下一次触发重试
  }
  const changed = html !== lastHtml;
  lastHtml = html;
  renderedStateMtime = stateMtime;
  renderedEventsMtime = eventsMtime;
  broadcast(changed);
}

// watch 触发去抖：从首个触发起 50ms 窗口内的触发合并成一次 refresh（窗口不顺延，
// 连续写入不会无限推迟渲染）。默认轮询兜底间隔是 100ms 量级，50ms 的推送延迟对看板
// 实时性不可感知；换来的是一次变更（state+events 同批落盘）只全量渲染一次。
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 50);
}

function broadcast(changed) {
  for (const res of clients) {
    try {
      res.write(`event: render\ndata: ${JSON.stringify({ changed, ts: new Date().toISOString() })}\n\n`);
    } catch {
      // 客户端在 close 事件到达前断开：写失败直接摘除，别让广播循环中断或抛未捕获异常
      clients.delete(res);
    }
  }
}

// Host 头校验（2026-10-28）：只绑 127.0.0.1 **不防 DNS rebinding**——恶意页面把自己的域名解析到
// 127.0.0.1，浏览器就会以「同源」的身份向本服务发请求，读走看板里的任务标题、验收标准、状态文件
// 绝对路径与提示词。这是本地 HTTP 服务的标准攻击面，与其说「只读所以无害」，不如说「读到的正是
// 未公开的工作内容」。
// 判据：Host 的主机名必须是回环字面量。DNS rebinding 用的域名在任何解析阶段都不是这些字面量，
// 因此被挡在门外；正常访问 http://127.0.0.1:port / http://localhost:port 不受影响。
//
// 2026-10-29 修复：旧实现手工切串（`raw.startsWith("[") ? … : raw.split(":")[0]`），
// `[::1]@evil.example` 会被切成 `[::1]` 从而放行——实测该 Host 返回 **200 + 完整看板正文**。
// 浏览器不支持这种带 userinfo 的 Host（请求会先被浏览器拒），所以它不是可用的 rebinding 绕过，
// 但「Host 的主机名必须是回环字面量」这条不变量确实被破了：解析要交给 URL，不要自己切。
// 用 URL 解析后只认 hostname（它已去掉 userinfo、端口与 IPv6 方括号）。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function hostAllowed(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return false;
  let url;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return false; // 解析不了就不能证明它回环：拒绝
  }
  // userinfo 出现在 Host 里不是任何合法客户端的行为，直接拒
  if (url.username || url.password) return false;
  // `http://[::1]:8787` → hostname 为 `[::1]`（Node 保留方括号），统一去括号后比对
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

function handleRequest(req, res) {
  // 兜底：畸形请求行/请求头可能让 new URL 抛错，回调内异常会打崩整个看板进程
  try {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`forbidden: unexpected Host header (${req.headers.host || "missing"}); this board only answers loopback names`);
      return;
    }
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
setInterval(refresh, interval);

// watch 立即推送：文件一变化就触发（经 50ms 去抖窗口合并同批写入），减少轮询延迟。
try {
  watch(file, () => scheduleRefresh());
} catch {}
try {
  watch(eventsFile, () => scheduleRefresh());
} catch {}

// 状态文件缺失/损坏时给可读指引并以退出码 2 结束，而不是模块顶层裸栈崩溃
// （启动渲染同时把 mtime 标记对齐到当前内容：首个轮询周期不会对未变化的内容重渲染）
try {
  lastHtml = renderHtml();
  renderedStateMtime = mtimeOf(file);
  renderedEventsMtime = mtimeOf(eventsFile);
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