// board-server.mjs — 开发全景实时看板服务（本地只读，2026-11 实时版新增；2026-11-14 P1 加交付工作台）
// 用途：为 board/dev-tour.html 的 live 模式与 board/workbench.html 三视图页提供接口 ——
//   GET  /tour?file=<workflow 文档>   实时版页面（模板注入 MODE=live）
//   GET  /api/tour?file=<...>          全景模型 JSON（每次请求现场重建 → 恒最新）
//   GET  /workbench                    交付工作台 P1 三视图页（概览/交付流/决策中心，页面自拉 /api/workbench）
//   GET  /api/workbench                交付工作台聚合模型 JSON（workbench-model 现场重建 → 恒最新）
//   GET  /api/events                   SSE 变更推送（changed → 客户端刷新；watchdead → 退化为轮询）
//   POST /api/tour/usage               视图用量埋点（唯一写面：append 到 .agents/cache/tour-usage.jsonl）
//   GET  /api/health                   就绪探针（ensure-board 复用判定）
//
// 安全面（刻意比源仓更窄）：
//   - 只绑 127.0.0.1；Host 头只认 127.0.0.1:PORT / localhost:PORT（DNS rebinding 缓解）
//   - **不提供任意静态文件服务**——除两份模板外不吐任何仓内文件；只读面只有 workflow/ 下的文档与派生模型
//   - 文档白名单：workflow/{plans,specs,intents}/**.md（拒绝对路径、拒 ..、拒 archive 与 _TEMPLATE）
//   - 唯一写面是 usage 埋点（append 到 .agents/cache/，该目录已 gitignore，本机数据不外发）
//
// 用法：node scripts/board-server.mjs [--port <端口>] [--root <仓库根>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTour } from './dev-tour-model.mjs';
import { buildWorkbench } from './workbench-model.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'board', 'dev-tour.html');
const WORKBENCH_TEMPLATE = path.join(PLUGIN_ROOT, 'board', 'workbench.html');
const TOUR_DOC_DIRS = ['plans', 'specs', 'intents'];
const MAX_DIFF_LINES = 120;

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root') || process.cwd());
const PORT = Number(argOf('port')) || 8933;
// pid 文件：便于「停看板」（删文件即停）与测试清理；落 .agents/cache/（已 gitignore）
const PID_FILE = argOf('pid-file') || path.join(ROOT, '.agents', 'cache', 'board-server.pid');

const sseClients = new Set();
const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

/** 文档白名单：只认 workflow/{plans,specs,intents}/ 下的 .md（相对路径、posix 分隔）。 */
function tourDocRel(file) {
  if (!file) return null;
  const rel = String(file).replace(/\\/g, '/').trim();
  if (!rel || rel.includes('..') || path.isAbsolute(rel) || !rel.endsWith('.md')) return null;
  const parts = rel.split('/');
  if (parts.length < 3 || parts[0] !== 'workflow' || !TOUR_DOC_DIRS.includes(parts[1])) return null;
  if (parts.some((p) => p.startsWith('_'))) return null;
  return parts.join('/');
}

/** 最新可用的 plan 文档（首页重定向与 auto-tour 链接用）。 */
function latestPlanRel() {
  const dir = path.join(ROOT, 'workflow', 'plans');
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = ents.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b.name)).mtimeMs - fs.statSync(path.join(dir, a.name)).mtimeMs);
  return `workflow/plans/${files[0].name}`;
}

/** 页面：模板注入 live 模式锚点（数据走 /api/tour 现场拉取，故 DATA=null）。 */
function serveTourPage(res, rel) {
  let html;
  try {
    html = fs.readFileSync(TEMPLATE, 'utf8');
  } catch (e) {
    return sendJson(res, 500, { error: `全景模板读取失败：${e.message}` });
  }
  html = html.replace('__TOUR_DATA__', 'null').replace('__TOUR_FILE__', JSON.stringify(rel)).replace('__TOUR_MODE__', '"live"');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** 模型：每次请求现场重建（恒最新；构建量级 ~100ms 级，够用）。 */
function tourModel(rel) {
  const model = buildTour({ root: ROOT, docPath: rel, base: 'HEAD', withDiff: true, maxDiffLines: MAX_DIFF_LINES });
  return { ...model, doc: { ...(model.doc || {}), path: rel } };
}

const broadcast = (event, data) => {
  for (const res of sseClients) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 断开的客户端随 close 移除 */ }
  }
};

// 监听 workflow/ 变更 → 推 changed（SSE 断则客户端自己退化为 5s 轮询，页面已内置）
let watchTimer = null;
function startWatcher() {
  const wf = path.join(ROOT, 'workflow');
  try {
    if (!fs.existsSync(wf)) return;
    const watcher = fs.watch(wf, { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => broadcast('changed', { ts: new Date().toISOString() }), 300);
    });
    watcher.on('error', () => broadcast('watchdead', { ts: new Date().toISOString() }));
  } catch {
    // 递归监听不可用（部分平台/文件系统）→ 告知客户端退化为轮询
    broadcast('watchdead', { ts: new Date().toISOString() });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Host 校验（DNS rebinding 缓解）：本地只读服务只认本机 Host
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
      return sendJson(res, 403, { error: `Host 不受信任（仅接受 127.0.0.1:${PORT} / localhost:${PORT}）` });
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT, root: ROOT });

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url.pathname === '/api/tour') {
      const rel = tourDocRel(url.searchParams.get('file'));
      if (!rel) return sendJson(res, 400, { error: '缺少或非法的 file 参数（workflow/{plans,specs,intents}/<name>.md）' });
      try {
        return sendJson(res, 200, tourModel(rel));
      } catch (e) {
        const status = /不存在/.test(e.message) ? 404 : 500;
        return sendJson(res, status, { error: e.message });
      }
    }

    // 交付工作台 P1（2026-11-14）：三视图页与聚合模型——页面 live-only（无锚点注入），数据自拉
    if (url.pathname === '/workbench') {
      let html;
      try {
        html = fs.readFileSync(WORKBENCH_TEMPLATE, 'utf8');
      } catch (e) {
        return sendJson(res, 500, { error: `工作台模板读取失败：${e.message}` });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (url.pathname === '/api/workbench') {
      try {
        return sendJson(res, 200, buildWorkbench({ root: ROOT }));
      } catch (e) {
        return sendJson(res, 500, { error: `工作台模型构建失败：${e.message}` });
      }
    }

    if (url.pathname === '/tour') {
      const file = url.searchParams.get('file');
      const rel = tourDocRel(file);
      if (!rel) {
        // 无 file → 重定向到最新 plan（没有 plan 就给可读错误，不吐目录列表）
        const latest = latestPlanRel();
        if (!latest) return sendJson(res, 400, { error: 'workflow/plans/ 下没有可展示的 plan 文档' });
        res.writeHead(302, { Location: `/tour?file=${encodeURIComponent(latest)}` });
        return res.end();
      }
      return serveTourPage(res, rel);
    }

    // 视图用量埋点：唯一写路由——append 一行 JSON 到 .agents/cache/tour-usage.jsonl（本机数据不外发）
    if (url.pathname === '/api/tour/usage') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '仅接受 POST' });
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        if (total > 8192) return sendJson(res, 400, { error: 'body 超过 8KB（用量埋点只需一行 JSON）' });
        chunks.push(c);
      }
      let row;
      try {
        row = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: `body 非合法 JSON：${e.message}` });
      }
      const rec = {
        ts: String(row.ts || new Date().toISOString()).slice(0, 32),
        doc: String(row.doc || '').slice(0, 200),
        view: String(row.view || '').slice(0, 40),
      };
      try {
        const dir = path.join(ROOT, '.agents', 'cache');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'tour-usage.jsonl'), `${JSON.stringify(rec)}\n`, 'utf8');
      } catch (e) {
        return sendJson(res, 500, { error: `用量埋点写入失败：${e.message}` });
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: `未知路由：${url.pathname}（本服务只提供 dev-tour 实时接口，不做任意静态文件服务）` });
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.on('error', (e) => {
  process.stderr.write(`[board-server] 监听失败：${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch { /* pid 文件写不了不影响服务 */ }
  process.stdout.write(`[board-server] 已就绪 http://127.0.0.1:${PORT}/tour（项目根：${ROOT}）\n`);
  startWatcher();
});

// pid 文件随进程消亡：删文件即「停看板」的信号面（服务本身靠 Ctrl-C / kill 停止）
const dropPidFile = () => { try { fs.rmSync(PID_FILE, { force: true }); } catch { /* 无所谓 */ } };
process.on('exit', dropPidFile);
process.on('SIGINT', () => { dropPidFile(); process.exit(0); });
process.on('SIGTERM', () => { dropPidFile(); process.exit(0); });
