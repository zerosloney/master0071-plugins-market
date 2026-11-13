#!/usr/bin/env node
// auto-tour.test.mjs — 一键拉起开发全景看板的黑盒测试（2026-11 实时版新增）
// 断言：①auto-tour 恒 exit 0 并打印实时链接 ②链接指向 /tour?file=workflow/plans/… ③端口被占时
// 仍 exit 0（失败不阻断，错误进 stderr）④看板就绪后链接可打开（/api/health 200）。
// 零依赖，Node ≥ 18 直接运行：node test/auto-tour.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTO = path.join(TEST_DIR, '..', 'scripts', 'auto-tour.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const PORT = 9110 + (process.pid % 60);

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tour-test-'));
  const g = (...a) => spawnSync(GIT, a, { cwd: d, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workflow', 'plans', '2026-11-13-demo.md'), '---\n状态: approved\n---\n# PLAN — demo\n', 'utf8');
  g('add', '-A'); g('commit', '-qm', 'init');
  return d;
};

const runCliAsync = (args, timeoutMs = 25000) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => { try { c.kill(); } catch { /* 已退出 */ } resolve({ status: null, stdout, stderr }); }, timeoutMs);
  c.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
});

const health = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode === 200));
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

// ①②④ 正常路径
{
  const root = mkRoot();
  const r = await runCliAsync([AUTO, '--port', String(PORT), '--root', root]);
  const m = /开发全景（实时）：(http:\/\/127\.0\.0\.1:\d+\/tour\?file=workflow%2Fplans%2F[\w.-]+\.md)/.exec(r.stdout || '');
  check('① auto-tour 恒 exit 0 并打印实时链接', r.status === 0 && Boolean(m), `status=${r.status} out=${r.stdout.slice(0, 160)} err=${r.stderr.slice(0, 120)}`);
  check('② 链接指向 /tour?file=workflow/plans/…', Boolean(m) && decodeURIComponent(m[1]).includes('/tour?file=workflow/plans/'), m ? m[1] : '无');
  const ok = await health(PORT);
  check('④ 链接对应的看板已就绪（/api/health 200）', ok, `port=${PORT}`);
  const pidFile = path.join(root, '.agents', 'cache', 'board-server.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  if (pid) { try { process.kill(pid); } catch { /* 已退出 */ } }
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 端口被占 → 仍 exit 0（失败不阻断），错误进 stderr
{
  const root = mkRoot();
  const other = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => other.listen(PORT + 1, '127.0.0.1', r));
  const r = await runCliAsync([AUTO, '--port', String(PORT + 1), '--root', root]);
  check('③ 端口被占时仍 exit 0（失败不阻断），错误进 stderr', r.status === 0 && /auto-tour/.test(r.stderr),
    `status=${r.status} err=${r.stderr.slice(0, 160)}`);
  other.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
