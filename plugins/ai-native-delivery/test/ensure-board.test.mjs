#!/usr/bin/env node
// ensure-board.test.mjs — 看板幂等拉起黑盒测试（2026-11 实时版新增）
// 断言：①首次拉起后就绪（health 200）且打印链接 ②二次拉起复用（stdout 明说"已在运行"、不新起进程）
// ③端口被别的服务占用时报错退出 1（不当成自己的看板）④pid 文件落在 .agents/cache/ 且内容是数字 pid
// ⑤库面 ensureBoard() 返回 ok/port/url/reused 四字段。
// 零依赖，Node ≥ 18 直接运行：node test/ensure-board.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBoard } from '../scripts/ensure-board.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENSURE = path.join(TEST_DIR, '..', 'scripts', 'ensure-board.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const PORT = 9020 + (process.pid % 90);

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// 异步跑 CLI：占用端口的假服务跑在本进程内，spawnSync 会阻塞事件循环让假服务无法应答
// （探活必然超时 → spawnSync 被杀 → status=null）。异步 spawn 才让得出事件循环。
const runCliAsync = (args, timeoutMs = 25000) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } resolve({ status: null, stdout, stderr }); }, timeoutMs);
  c.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
});

const mkRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-board-test-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workflow', 'plans', '2026-11-13-demo.md'), '---\n状态: approved\n---\n# PLAN — demo\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'init');
  return d;
};

const health = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode === 200));
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

const waitReady = async (port, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await health(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

// ①②④ 幂等拉起 + pid 文件
{
  const root = mkRoot();
  const first = spawnSync(process.execPath, [ENSURE, '--port', String(PORT), '--root', root], { encoding: 'utf8', timeout: 20000 });
  const ready = await waitReady(PORT);
  const second = spawnSync(process.execPath, [ENSURE, '--port', String(PORT), '--root', root], { encoding: 'utf8', timeout: 20000 });
  check('① 首次拉起后就绪并打印链接', first.status === 0 && ready && /http:\/\/127\.0\.0\.1:\d+\/tour/.test(first.stdout),
    `status=${first.status} out=${first.stdout.slice(0, 160)} err=${first.stderr.slice(0, 120)}`);
  check('② 二次拉起复用（不新起进程）', second.status === 0 && /看板已在运行/.test(second.stdout),
    `status=${second.status} out=${second.stdout.slice(0, 160)}`);
  const pidFile = path.join(root, '.agents', 'cache', 'board-server.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  check('④ pid 文件落在 .agents/cache/ 且是数字 pid', pid > 0, `pidFile=${pidFile} pid=${pid}`);
  if (pid) { try { process.kill(pid); } catch { /* 已退出 */ } }
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 端口被别的服务占用 → 报错退出 1
{
  const root = mkRoot();
  const other = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => other.listen(PORT + 1, '127.0.0.1', r));
  const r = await runCliAsync([ENSURE, '--port', String(PORT + 1), '--root', root]);
  check('③ 端口被非本看板服务占用 → 报错退出 1（不误当自己的看板）', r.status === 1 && /看板/.test(r.stderr),
    `status=${r.status} err=${r.stderr.slice(0, 160)}`);
  other.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ 库面形状
{
  const root = mkRoot();
  const r = await ensureBoard({ root, port: PORT + 2 });
  check('⑤ ensureBoard() 返回 ok/port/url/reused 四字段', r && r.ok === true && r.port === PORT + 2 && typeof r.url === 'string' && typeof r.reused === 'boolean',
    JSON.stringify(r));
  if (r && r.ok) {
    const pidFile = path.join(root, '.agents', 'cache', 'board-server.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (pid) { try { process.kill(pid); } catch { /* 已退出 */ } }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
