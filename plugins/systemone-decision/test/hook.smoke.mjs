// hook 冒烟测试：本地 mock SystemOne 端点 + 子进程运行 UserPromptSubmit hook，不需要真实 API Key。
// 验证四类行为：需求不明确 → 注入结论；明确 → 静默；寒暄/缺 Key → 不发请求直接放行；接口故障 → fail-open。
// 注意：子进程必须用异步 spawn——本机部分沙箱环境下 spawnSync 子进程的 HTTP 请求会被挂起，
// 生产环境 ZCode 以异步方式拉起 hook，不受影响。
// 运行：node test/hook.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, '..', 'hooks', 'requirement-clarity.mjs');

const LEVELS = ['模糊：目标都不清楚', '偏低：目标清楚但范围或关键约束不明', '较高：目标范围清楚，细节可自行决策', '明确：目标、范围、验收都清楚'];

// 按场景固定三问答案；测试进程切换 scenario 变量，hook 子进程通过 HTTP 感知
const SCENARIOS = {
  unclear: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 1, confidence: 0.92 },
    missing: { type: 'choice', choice: 'acceptance', probabilities: { acceptance: 0.88, goal: 0.12 }, confidence: 0.88 },
    proceed: { type: 'noul', noul: 0.42 },
  },
  clear: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 3, confidence: 0.95 },
    missing: { type: 'choice', choice: 'none', probabilities: { none: 0.9, goal: 0.1 }, confidence: 0.9 },
    proceed: { type: 'noul', noul: 0.91 },
  },
};
let scenario = 'clear';

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'u2-decision', answers: SCENARIOS[scenario] }));
  });
});

const run = (prompt, envExtra = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        SYSTEMONE_API_KEY: 'test-key',
        UNISOUND_API_KEY: '',
        SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
        ...envExtra,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end(prompt === null ? 'not-json' : JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit' }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

let failed = false;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
};

let received = [];
let port;

const main = async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  port = mock.address().port;

  // 1. 需求不明确 → 注入 hookSpecificOutput 结论
  scenario = 'unclear';
  received = [];
  let r = await run('帮我把这个项目优化一下，尽快弄好');
  check('需求不明确时注入 hookSpecificOutput 结论', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '应发出一次判定请求');
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /需求预检/);
    assert.match(ctx, /1\.0\/3/);
    assert.match(ctx, /acceptance/);
    assert.match(ctx, /0\.42/);
  });

  // 2. 需求明确 → 静默放行（但确实调用了判定接口）
  scenario = 'clear';
  received = [];
  r = await run('把 server.mjs 里的 thresholdOf 默认值从 0.7 改成 0.8');
  check('需求明确时静默放行（零噪音）', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 1, '静默发生在判定之后');
  });

  // 3. 寒暄捷径 → 不发请求直接放行
  scenario = 'unclear';
  received = [];
  r = await run('好的');
  check('寒暄捷径不触发判定请求', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 0);
  });

  // 4. 缺 API Key → 不发请求直接放行
  received = [];
  r = await run('帮我把这个项目优化一下，尽快弄好', { SYSTEMONE_API_KEY: '', UNISOUND_API_KEY: '' });
  check('缺 API Key 时静默放行且不发请求', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 0);
  });

  // 5. 接口不可达 → fail-open，不阻塞用户输入
  r = await run('帮我把这个项目优化一下，尽快弄好', { SYSTEMONE_BASE_URL: 'http://127.0.0.1:9/v1', SYSTEMONE_TIMEOUT_MS: '2000' });
  check('接口故障时 fail-open 静默放行', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /预检跳过/);
  });

  // 6. 非 JSON stdin → 当作空输入放行
  r = await run(null);
  check('非 JSON stdin 放行', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  mock.close();
  if (failed) {
    console.error('\nhook 冒烟测试存在失败项');
    process.exit(1);
  }
  console.log('\nhook 冒烟测试全部通过');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
