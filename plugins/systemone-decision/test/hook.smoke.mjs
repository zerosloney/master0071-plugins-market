// hook 冒烟测试：本地 mock SystemOne 端点 + 子进程运行 UserPromptSubmit hook，不需要真实 API Key。
// 验证四类行为：需求不明确 → 注入结论；明确 → 静默；寒暄/缺 Key → 不发请求直接放行；接口故障 → fail-open。
// 注意：子进程必须用异步 spawn——本机部分沙箱环境下 spawnSync 子进程的 HTTP 请求会被挂起，
// 生产环境 ZCode 以异步方式拉起 hook，不受影响。
// 运行：node test/hook.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// 在临时目录跑被测插件：端点共享文件（.endpoint.json）写在插件根目录，直接跑仓库
// 副本会污染工作区，也让「写文件的用例」与「依赖环境变量的用例」互相串扰端点。
const runRoot = mkdtempSync(path.join(os.tmpdir(), 'systemone-hook-smoke-'));
cpSync(path.join(here, '..'), runRoot, { recursive: true });
const hookPath = path.join(runRoot, 'hooks', 'requirement-clarity.mjs');

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

// 风险闸三问的固定答案：verdict(choice) + risk(score) + irreversible(noul)
const RISK_LEVELS = ['只读或完全可回滚', '可逆的写操作', '难以回滚的写操作', '不可逆删除或影响生产/远程资源'];
const GATE_ANSWERS = {
  deny: {
    verdict: { type: 'choice', choice: 'deny', probabilities: { deny: 0.9, confirm: 0.1 }, confidence: 0.9 },
    risk: { type: 'score', legend: Object.fromEntries(RISK_LEVELS.map((c, i) => [String(i), c])), probabilities: { '3': 0.95 }, score: 3, confidence: 0.95 },
    irreversible: { type: 'noul', noul: 0.9 },
  },
  confirm: {
    verdict: { type: 'choice', choice: 'confirm', probabilities: { confirm: 0.85, allow: 0.15 }, confidence: 0.85 },
    risk: { type: 'score', legend: Object.fromEntries(RISK_LEVELS.map((c, i) => [String(i), c])), probabilities: { '2': 0.9 }, score: 2, confidence: 0.9 },
    irreversible: { type: 'noul', noul: 0.2 },
  },
  allow: {
    verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.92 }, confidence: 0.92 },
    risk: { type: 'score', legend: Object.fromEntries(RISK_LEVELS.map((c, i) => [String(i), c])), probabilities: { '0': 0.93 }, score: 0, confidence: 0.93 },
    irreversible: { type: 'noul', noul: 0.05 },
  },
};
let gateScenario = 'allow';

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    received.push(parsed);
    // 风险闸请求的题目 id 与需求预检不同，按题目特征分流固定答案
    const answers = parsed.questions && parsed.questions.verdict ? GATE_ANSWERS[gateScenario] : SCENARIOS[scenario];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'u2-decision', answers }));
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
const checkA = async (name, fn) => {
  try {
    await fn();
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

  // 7. 端点共享文件优先于环境变量：MCP 服务落盘的 baseUrl/model 生效，
  //    环境变量里的死端点被忽略（这是「设置页切换供应商后 hook 不再静默失效」的机制）
  scenario = 'unclear';
  received = [];
  writeFileSync(
    path.join(runRoot, '.endpoint.json'),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'shared-decision', timeoutMs: 9000 })
  );
  r = await run('帮我把这个项目优化一下，尽快弄好', {
    SYSTEMONE_BASE_URL: 'http://127.0.0.1:1/wrong',
    SYSTEMONE_MODEL: 'env-model',
  });
  check('共享端点文件优先于环境变量（含 model）', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '应打到共享文件里的端点而非环境变量的死端点');
    assert.equal(received[0].model, 'shared-decision');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });

  // 8. 共享文件损坏 → 回退环境变量（即落盘机制不存在时的旧行为）
  received = [];
  writeFileSync(path.join(runRoot, '.endpoint.json'), '{"oops');
  r = await run('帮我把这个项目优化一下，尽快弄好');
  check('共享端点文件损坏时回退环境变量', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '应回退到环境变量指定的 mock 端点');
    assert.equal(received[0].model, 'u2-decision');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });

  // ---------- 风险闸（PreToolUse）：内核直接调用 + 协议包装子进程 ----------

  const { assess } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'risk-gate.mjs')).href);
  const hookEnv = {
    SYSTEMONE_API_KEY: 'test-key',
    UNISOUND_API_KEY: '',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
  };
  const gateRun = (payload, envExtra = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(runRoot, 'hooks', 'pretool-risk.mjs')], {
        env: { ...process.env, ...hookEnv, ...envExtra },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.stdin.end(JSON.stringify(payload));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  gateScenario = 'allow';
  received = [];
  await checkA('风险闸内核：非 shell 工具与只读命令直通（不发请求）', async () => {
    assert.equal(await assess('Read', { file_path: 'x' }, hookEnv), null);
    assert.equal(await assess('Bash', { command: 'ls -la' }, hookEnv), null);
    assert.equal(await assess('Bash', { command: 'git status' }, hookEnv), null);
    assert.equal(received.length, 0);
  });

  gateScenario = 'deny';
  received = [];
  await checkA('风险闸内核：高风险且不可逆判定为 deny', async () => {
    const v = await assess('Bash', { command: 'rm -rf ./build' }, hookEnv);
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /风险闸/);
    assert.match(v.reason, /拒绝执行/);
    assert.equal(received.length, 1);
  });

  gateScenario = 'confirm';
  await checkA('风险闸内核：中风险或模型确认判定为 ask', async () => {
    const v = await assess('Bash', { command: 'npm run deploy' }, hookEnv);
    assert.equal(v.decision, 'ask');
    assert.match(v.reason, /确认/);
  });

  gateScenario = 'allow';
  await checkA('风险闸内核：allow 判定且低风险可逆时放行', async () => {
    assert.equal(await assess('Bash', { command: 'npm test' }, hookEnv), null);
  });

  gateScenario = 'deny';
  r = await gateRun({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } });
  check('风险闸 hook：deny 判定输出 permissionDecision=deny', () => {
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /风险闸/);
  });

  r = await gateRun({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  check('风险闸 hook：只读命令静默放行（exit 0 无输出）', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  r = await gateRun(
    { tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } },
    { SYSTEMONE_BASE_URL: 'http://127.0.0.1:9/v1', SYSTEMONE_TIMEOUT_MS: '1000' }
  );
  check('风险闸 hook：接口故障 fail-open 静默放行', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /风险闸跳过/);
  });

  rmSync(runRoot, { recursive: true, force: true });
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
