#!/usr/bin/env node
// board-server.test.mjs — 开发全景实时看板黑盒测试（2026-11 实时版新增）
// 手法同 doctor.test.mjs：mkdtemp 临时 git 仓 + spawn 真实 board-server 进程，HTTP 真打。
// 断言：①/api/health 就绪 ②/api/tour 出全景模型（steps/files/doc.path）③/tour 页面注入 MODE=live
// 且无残留锚点 ④/tour 无 file → 302 到最新 plan ⑤POST /api/tour/usage 落 .agents/cache/ ⑥未知路由 404
// ⑦坏 Host 403 ⑧路径穿越与白名单外路径 400 ⑨SSE：workflow 变更推 changed ⑩ensure-board 幂等复用
// ⑪auto-tour 恒 exit 0 并打印链接 ⑫board-port 解析序（显式 > engine.json options > 基线）。
// 零依赖，Node ≥ 18 直接运行：node test/board-server.test.mjs（node --test 亦可）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBoardPort, BASE_BOARD_PORT } from '../scripts/board-port.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(TEST_DIR, '..', 'scripts');
const SERVER = path.join(SCRIPTS, 'board-server.mjs');
const ENSURE = path.join(SCRIPTS, 'ensure-board.mjs');
const AUTO = path.join(SCRIPTS, 'auto-tour.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const PORT = 8900 + (process.pid % 120);
const PLAN_REL = 'workflow/plans/2026-11-13-demo.md';

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'app.js'), 'console.log(1)\n', 'utf8');
  fs.writeFileSync(path.join(d, PLAN_REL), [
    '---', '状态: approved', '级别: L1', '---', '# PLAN — demo', '',
    '## 入口', '- 来源：测试', '- 目标：验证实时看板', '',
    '## 改动方案', '- `src/app.js`：改一行', '', '## 验收', '- [x] 冒烟通过',
  ].join('\n'), 'utf8');
  g('add', '-A'); g('commit', '-qm', 'init');
  return d;
};

const req = (port, pathname, opts = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {}, timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
  if (opts.body) r.write(opts.body);
  r.end();
});

const waitReady = async (port, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await req(port, '/api/health');
    if (h.status === 200) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

// ①–⑧ 服务面
{
  const root = mkRepo();
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (c) => { out += c; });
  srv.stderr.on('data', (c) => { out += c; });
  const ready = await waitReady(PORT);
  check('① 服务就绪（/api/health 200）', ready, out.slice(0, 200));

  const health = await req(PORT, '/api/health');
  check('① /api/health 回 ok:true', health.status === 200 && /"ok"\s*:\s*true/.test(health.body), health.body.slice(0, 120));

  const tour = await req(PORT, '/api/tour?file=' + encodeURIComponent(PLAN_REL));
  let j = {};
  try { j = JSON.parse(tour.body); } catch { /* 留空 */ }
  check('② /api/tour 出全景模型', tour.status === 200 && Array.isArray(j.steps) && j.steps.length >= 1 && j.doc && j.doc.path === PLAN_REL,
    `status=${tour.status} body=${tour.body.slice(0, 160)}`);

  const page = await req(PORT, '/tour?file=' + encodeURIComponent(PLAN_REL));
  check('③ /tour 注入 MODE=live 且无残留锚点',
    page.status === 200 && /const MODE = "live"/.test(page.body) && /const EMBEDDED = null/.test(page.body) && !/__TOUR_[A-Z]+__/.test(page.body),
    `status=${page.status}`);

  const redir = await req(PORT, '/tour');
  check('④ /tour 无 file → 302 到最新 plan', redir.status === 302 && decodeURIComponent(String(redir.headers.location || '')).startsWith('/tour?file=workflow/plans/'),
    `status=${redir.status} loc=${redir.headers && redir.headers.location}`);

  const usage = await req(PORT, '/api/tour/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: PLAN_REL, view: 'panorama' }) });
  const usageFile = path.join(root, '.agents', 'cache', 'tour-usage.jsonl');
  check('⑤ usage 埋点 200 且落 .agents/cache/tour-usage.jsonl',
    usage.status === 200 && fs.existsSync(usageFile) && /panorama/.test(fs.readFileSync(usageFile, 'utf8')),
    `status=${usage.status}`);

  const nf = await req(PORT, '/api/nope');
  check('⑥ 未知路由 404（不做任意静态服务）', nf.status === 404, `status=${nf.status}`);

  const bad = await req(PORT, '/api/health', { headers: { Host: 'evil.example.com' } });
  check('⑦ 坏 Host 403', bad.status === 403, `status=${bad.status}`);

  const trav = await req(PORT, '/api/tour?file=' + encodeURIComponent('../../../etc/passwd'));
  const outside = await req(PORT, '/api/tour?file=' + encodeURIComponent('workflow/secret.md'));
  check('⑧ 路径穿越与白名单外路径均 400', trav.status === 400 && outside.status === 400, `trav=${trav.status} outside=${outside.status}`);

  // ⑨ SSE：workflow 变更 → changed 事件
  const sse = await new Promise((resolve) => {
    let got = '';
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', timeout: 6000 }, (res) => {
      res.on('data', (c) => {
        got += c;
        if (got.includes('event: changed')) { r.destroy(); resolve(got); }
      });
      res.on('end', () => resolve(got));
      setTimeout(() => { try { r.destroy(); } catch { /* 无所谓 */ } resolve(got); }, 4000);
    });
    r.on('error', () => resolve(got));
    setTimeout(() => { try { fs.appendFileSync(path.join(root, 'workflow', 'plans', '2026-11-13-new.md'), '---\n状态: draft\n---\n# 新档\n'); } catch { /* 无所谓 */ } }, 400);
  });
  check('⑨ SSE 变更推送 changed 事件', /event: changed/.test(sse), sse.slice(0, 160));

  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑩–⑪ ensure-board 幂等 / auto-tour
{
  const root = mkRepo();
  const p1 = PORT + 1;
  const first = spawnSync(process.execPath, [ENSURE, '--port', String(p1), '--root', root], { encoding: 'utf8', timeout: 15000 });
  const ready = await waitReady(p1, 8000);
  const second = spawnSync(process.execPath, [ENSURE, '--port', String(p1), '--root', root], { encoding: 'utf8', timeout: 15000 });
  check('⑩ ensure-board 幂等：首次拉起就绪、二次复用', ready && first.status === 0 && second.status === 0 && /看板已在运行/.test(second.stdout),
    `first=${first.status} second=${second.status} out=${second.stdout.slice(0, 120)} err=${second.stderr.slice(0, 120)}`);
  const pidFile = path.join(root, '.agents', 'cache', 'board-server.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  const auto = spawnSync(process.execPath, [AUTO, '--port', String(p1), '--root', root], { encoding: 'utf8', timeout: 15000 });
  check('⑪ auto-tour 恒 exit 0 并打印实时链接', auto.status === 0 && /开发全景（实时）：http:\/\/127\.0\.0\.1:\d+\/tour/.test(auto.stdout),
    `status=${auto.status} out=${auto.stdout.slice(0, 160)} err=${auto.stderr.slice(0, 120)}`);
  if (pid) { try { process.kill(pid); } catch { /* 已退出 */ } }
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑫ 端口解析序
{
  const root = mkRepo();
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 16, options: { boardPort: 8999 } }), 'utf8');
  check('⑫ 端口解析：显式 > engine.json options > 基线',
    resolveBoardPort({ explicit: '9100', root }) === 9100 && resolveBoardPort({ root }) === 8999 && resolveBoardPort({ root: path.join(root, 'nonexistent') }) === BASE_BOARD_PORT,
    `explicit=${resolveBoardPort({ explicit: '9100', root })} cfg=${resolveBoardPort({ root })} base=${resolveBoardPort({ root: path.join(root, 'nonexistent') })}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
