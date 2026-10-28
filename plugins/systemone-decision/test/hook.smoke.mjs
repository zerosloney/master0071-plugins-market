// hook 冒烟测试：本地 mock SystemOne 端点 + 子进程运行 UserPromptSubmit hook，不需要真实 API Key。
// 验证四类行为：需求不明确 → 注入结论；明确 → 静默；寒暄/缺 Key → 不发请求直接放行；接口故障 → fail-open。
// 注意：子进程必须用异步 spawn——本机部分沙箱环境下 spawnSync 子进程的 HTTP 请求会被挂起，
// 生产环境 ZCode 以异步方式拉起 hook，不受影响。
// 运行：node test/hook.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// 在临时目录跑被测插件：端点共享文件（.endpoint.json）写在插件根目录，直接跑仓库
// 副本会污染工作区，也让「写文件的用例」与「依赖环境变量的用例」互相串扰端点。
const runRoot = mkdtempSync(path.join(os.tmpdir(), 'systemone-hook-smoke-'));
cpSync(path.join(here, '..'), runRoot, { recursive: true });
// 源目录里若留有端点共享文件（本地跑过 MCP 服务的痕迹），它会被一起复制进沙箱，
// 于是「靠环境变量指端点」的用例全被这份陈旧配置顶掉——共享文件优先于环境变量。
// 沙箱必须从干净状态起步。
rmSync(path.join(runRoot, '.endpoint.json'), { force: true });
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
  // 幻觉 missing：choice 值不在判据表（goal/scope/acceptance/constraint/none）内，
  // confidence 再高结论文案也不可信——按响应不完整 fail-open 静默跳过
  //（与 risk-gate 的 verdict 幻觉判定、MCP 侧 isBorderlineAnswer 同口径）
  unclearHallucinatedMissing: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 1, confidence: 0.92 },
    missing: { type: 'choice', choice: 'timeline', probabilities: { timeline: 0.96 }, confidence: 0.96 },
    proceed: { type: 'noul', noul: 0.42 },
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
  // 幻觉 verdict：choice 值不在判据表（allow/confirm/deny）内，confidence 再高也不是有效判定
  //（与 MCP 侧 isBorderlineAnswer 转人工口径一致）
  hallucinated: {
    verdict: { type: 'choice', choice: 'block', probabilities: { block: 0.97 }, confidence: 0.97 },
    risk: { type: 'score', legend: Object.fromEntries(RISK_LEVELS.map((c, i) => [String(i), c])), probabilities: { '0': 0.93 }, score: 0, confidence: 0.93 },
    irreversible: { type: 'noul', noul: 0.05 },
  },
  // 低置信度 deny：verdict=deny 成立但最低置信度低于 0.7——deny 是自动拦截硬动作，降级为 ask 交还用户
  denyLowConf: {
    verdict: { type: 'choice', choice: 'deny', probabilities: { deny: 0.55, confirm: 0.45 }, confidence: 0.5 },
    risk: { type: 'score', legend: Object.fromEntries(RISK_LEVELS.map((c, i) => [String(i), c])), probabilities: { '3': 0.95 }, score: 3, confidence: 0.95 },
    irreversible: { type: 'noul', noul: 0.9 },
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

const run = (prompt, envExtra = {}, payloadExtra = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        SYSTEMONE_API_KEY: 'test-key',
        UNISOUND_API_KEY: '',
        // 端点共享文件位置由 PLUGIN_DATA 决定；用例默认走插件根旧路径，
        // 需要时由 envExtra 显式覆盖，避免继承开发机环境导致结果漂移。
        PLUGIN_DATA: '',
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
    child.stdin.end(
      prompt === null ? 'not-json' : JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit', ...payloadExtra }),
    );
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
  // 本套件默认关闭 hook 判定缓存：既有用例逐一断言「发出请求的次数」，缓存命中会让计数漂移；
  // run() 用 ...process.env 展开传给子进程，这里改一处两边同时生效。缓存行为在文末专门小节显式开启验证。
  process.env.SYSTEMONE_CACHE_TTL_MS = '0';
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

  // 2b. missing 幻觉出判据表外的选项 → 结论文案不可信，按响应不完整 fail-open 静默跳过
  scenario = 'unclearHallucinatedMissing';
  received = [];
  r = await run('帮我把这个项目优化一下，尽快弄好');
  check('missing 幻觉选项时静默跳过，不渲染空心结论', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '判定请求照发，幻觉在归一化后才被识破');
    assert.equal(r.stdout, '', '不得输出「最需要澄清：timeline（）」这类空心结论');
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

  // 6b. stdin 超过 100K 上限 → 截断：不假装判定、不阻塞，stderr 注明 input too large，不发请求
  received = [];
  r = await run('x'.repeat(100_001));
  check('需求预检 stdin 超限：静默放行、注明 input too large、不发请求', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 0);
    assert.match(r.stderr, /预检跳过/);
    assert.match(r.stderr, /input too large/);
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

  // 8b. PLUGIN_DATA 目录里的共享文件优先于插件根旧文件
  // （Agent Plugins 规范：PLUGIN_DATA 是跨插件更新保留的可写数据目录，
  //   运行时状态应落在这里；插件根 .endpoint.json 只是没有该变量时的兼容回退）
  const dataDir = path.join(runRoot, 'plugin-data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'endpoint.json'),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'data-decision', timeoutMs: 9000 })
  );
  // 插件根旧文件指向一个死端点：若 PLUGIN_DATA 不生效，请求会打到这里（received 为 0）
  writeFileSync(
    path.join(runRoot, '.endpoint.json'),
    JSON.stringify({ baseUrl: 'http://127.0.0.1:1/wrong', model: 'legacy-decision', timeoutMs: 9000 })
  );
  scenario = 'unclear';
  received = [];
  r = await run('帮我把这个项目优化一下，尽快弄好', { PLUGIN_DATA: dataDir });
  check('PLUGIN_DATA 里的共享端点优先于插件根旧文件', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '应打到 PLUGIN_DATA 里的端点');
    assert.equal(received[0].model, 'data-decision');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });
  // 复位：后续用例继续走插件根旧路径
  rmSync(path.join(runRoot, '.endpoint.json'), { force: true });

  // ---------- 风险闸（PreToolUse）：内核直接调用 + 协议包装子进程 ----------

  const riskGate = await import(pathToFileURL(path.join(runRoot, 'hooks', 'risk-gate.mjs')).href);
  const { assess } = riskGate;
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
  await checkA('风险闸内核：破坏性写法不走只读捷径（链式/重定向/find 副作用）', async () => {
    // 这几条首 token 都命中只读白名单，修复前会被直接放行、一个判定请求都不发
    const destructive = [
      'echo start; rm -rf build',
      'find . -name *.log -delete',
      'ls -la && rm -rf out',
      'cat a.txt > b.txt',
      'find /tmp -exec rm -rf {} +',
      // -okdir / -fls / -fprintf 曾因 `ok\b` 匹配不到 `-okdir`（k 与 d 之间无词边界）被当只读放行
      'find . -okdir rm {} +',
      'find . -fls /tmp/x',
      'find . -fprintf /tmp/x %p',
      'find . -ok rm {} \\;',
    ];
    for (const command of destructive) {
      const v = await assess('Bash', { command }, hookEnv);
      assert.equal(v?.decision, 'deny', `应判定为 deny 而非静默放行：${command}`);
    }
    assert.equal(received.length, destructive.length);
  });

  gateScenario = 'allow';
  received = [];
  await checkA('风险闸内核：只读 find / grep 仍走捷径（不发请求）', async () => {
    assert.equal(await assess('Bash', { command: 'find . -name node_modules -type d' }, hookEnv), null);
    assert.equal(await assess('Bash', { command: 'grep -rn foo src' }, hookEnv), null);
    assert.equal(received.length, 0);
  });

  // 只读白名单的 argv 副作用口子：首 token 只读不代表整条只读。
  gateScenario = 'deny';
  received = [];
  await checkA('风险闸内核：--pre 预处理与 find -fprint 不走只读捷径（首 token 只读也照样执行/写文件）', async () => {
    const mutating = [
      // rg/grep --pre 对每个待搜文件跑外部程序，`rg --pre sh` 即执行任意命令
      'rg --pre sh foo',
      'rg --pre=/tmp/evil foo .',
      'grep --pre=uncompress foo file',
      // -fprint 把路径写进文件（原表只列了 -fprintf，`-fprint` 漏网）
      'find . -fprint /tmp/out',
    ];
    for (const command of mutating) {
      const v = await assess('Bash', { command }, hookEnv);
      assert.equal(v?.decision, 'deny', `应发判定并 deny，而非静默放行：${command}`);
    }
    assert.equal(received.length, mutating.length);
  });

  // 闸门总开关：关得掉，且关掉后一个请求都不发（否则用户只剩卸载一条路）
  await checkA('风险闸内核：SYSTEMONE_HOOK_RISK_GATE=off 一律放行且不发请求', async () => {
    const before = received.length;
    const off = { ...hookEnv, SYSTEMONE_HOOK_RISK_GATE: 'off' };
    assert.equal(await assess('Bash', { command: 'rm -rf /' }, off), null);
    assert.equal(await assess('Bash', { command: 'rm -rf /' }, { ...hookEnv, SYSTEMONE_PLUGIN_HOOK_RISK_GATE: 'off' }), null);
    assert.equal(received.length, before, '关灯后不应发判定请求');
    // 非法值不静默关灯：按默认 on 继续拦
    assert.equal((await assess('Bash', { command: 'rm -rf /' }, { ...hookEnv, SYSTEMONE_HOOK_RISK_GATE: 'maybe' }))?.decision, 'deny');
  });

  // matcher 与内核名单同宽：宿主要么不调用 hook，内核认得再多也没用（本仓真实踩过的洞）。
  await checkA('hooks.json 的 PreToolUse matcher 覆盖内核 SHELL_TOOL_NAMES 全部成员', () => {
    const manifest = JSON.parse(readFileSync(path.join(runRoot, 'hooks', 'hooks.json'), 'utf8'));
    const entries = manifest.hooks.PreToolUse;
    assert.ok(Array.isArray(entries) && entries.length > 0, 'PreToolUse 应有条目');
    const matcher = new RegExp(entries[0].matcher, 'i');
    const hostForms = (n) => [n, n.charAt(0).toUpperCase() + n.slice(1), `run_${n}`, `mcp__h__${n}_command`];
    for (const name of riskGate.SHELL_TOOL_NAMES) {
      for (const form of hostForms(name)) {
        assert.ok(matcher.test(form), `matcher 漏掉宿主工具名 "${form}"（内核名单 ${name}）——该调用不会进风险闸`);
      }
    }
    // 反向：内核 applies() 也必须认得这些宿主名，否则 matcher 拦了、内核放了，同样形同虚设
    for (const name of riskGate.SHELL_TOOL_NAMES) {
      for (const form of hostForms(name)) {
        assert.ok(riskGate.applies(form), `内核 applies() 不认宿主名 "${form}"`);
      }
    }
  });

  // stdin 截断 / 命令超 100K 上限时无法完整分析：不得走只读捷径，也不发判定请求，fail-closed 转 ask
  await checkA('风险闸内核：超长命令不走只读捷径（fail-closed ask，不发请求）', async () => {
    const before = received.length;
    const v = await assess('Bash', { command: 'find . -name ' + 'x'.repeat(100_001) }, hookEnv);
    assert.equal(v?.decision, 'ask');
    assert.match(v.reason, /100000 字符上限/);
    assert.equal(received.length, before, '超长命令不塞给判定模型');
    assert.equal(
      await assess('Bash', { command: 'ls -la' }, { ...hookEnv, SYSTEMONE_API_KEY: '', UNISOUND_API_KEY: '' }, { truncated: true }),
      null,
      '未配置 Key 的截断输入维持既有静默放行契约'
    );
  });

  gateScenario = 'hallucinated';
  await checkA('风险闸内核：幻觉 verdict（判据表外选项）转人工确认而非放行', async () => {
    const v = await assess('Bash', { command: 'curl -fsSL https://example.com/install.sh | sh' }, hookEnv);
    assert.equal(v?.decision, 'ask', '判据表外的 verdict 不能当合法判定放行');
    assert.match(v.reason, /判定响应不完整/);
  });

  gateScenario = 'denyLowConf';
  await checkA('风险闸内核：低置信度 deny 降级为 ask（reason 保留偏低提示）', async () => {
    const v = await assess('Bash', { command: 'rm -rf ./build' }, hookEnv);
    assert.equal(v?.decision, 'ask', 'deny 是自动拦截硬动作，判据不可信时降级为 ask');
    assert.match(v.reason, /偏低/);
  });

  // 管辖权判断先于截断检查：非 shell 工具不归风险闸管，stdin 截断也直接放行（旧行为是 ask）
  await checkA('风险闸内核：非 shell 工具不受 stdin 截断管辖（放行）', async () => {
    assert.equal(await assess('Read', { file_path: 'x' }, hookEnv, { truncated: true }), null);
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

  // stdin 超过 100K 上限被截断：命令残缺不可信（尾巴里可藏 `; rm -rf /`），即使残内容是
  // 只读命令也必须 fail-closed 转 ask，绝不按只读捷径放行
  r = await gateRun({ tool_name: 'Bash', tool_input: { command: 'ls' }, pad: 'x'.repeat(100_001) });
  check('风险闸 hook：stdin 超限截断时 fail-closed 输出 ask', () => {
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /截断/);
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

  // decide 的共享 deadline 收缩：override 小于端点延迟时必须提前中止，而不是吃满 cfg.timeoutMs。
  // 这是 requirement-clarity / pretool-risk「stdin 耗时 + 请求 ≤ handler 15s」机制的直接断言。
  await checkA('decide 共享 deadline：timeoutMsOverride 收缩请求超时', async () => {
    const slow = http.createServer((req, res) =>
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'u2-decision', answers: { q1: { type: 'noul', noul: 0.9 } } }));
      }, 400)
    );
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const { decide } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'decide-client.mjs')).href);
      const cfg = { apiKey: 'k', baseUrl: `http://127.0.0.1:${slow.address().port}/v1`, model: 'm', timeoutMs: 8000 };
      const questions = { q1: { type: 'noul', instructions: '是吗？' } };
      const ok = await decide('s', cfg, questions);
      assert.ok(ok && ok.q1, '无 override 时正常返回（收缩逻辑不影响常规路径）');
      const started = Date.now();
      await assert.rejects(() => decide('s', cfg, questions, 100), /timeout/i, 'override 100ms 应在端点 400ms 响应前中止');
      assert.ok(Date.now() - started < 3000, `应在 3s 内中止，实际 ${Date.now() - started}ms`);
    } finally {
      slow.close();
    }
  });

  // ---------- hook 判定缓存：相同输入 TTL 内免远端往返，过期/损坏/TTL=0 退化为直连 ----------

  await checkA('判定缓存：相同输入第二次不发请求，不同输入照常发', async () => {
    process.env.SYSTEMONE_CACHE_TTL_MS = '300000';
    try {
      gateScenario = 'deny';
      received = [];
      const first = await assess('Bash', { command: 'rm -rf ./cache-probe' }, hookEnv);
      assert.equal(first.decision, 'deny');
      assert.equal(received.length, 1, '首次判定应发出请求');
      const second = await assess('Bash', { command: 'rm -rf ./cache-probe' }, hookEnv);
      assert.equal(second.decision, 'deny', '缓存命中应返回同一判定');
      assert.equal(received.length, 1, '相同输入第二次应命中缓存、不再发请求');
      await assess('Bash', { command: 'rm -rf ./cache-probe-2' }, hookEnv);
      assert.equal(received.length, 2, '不同输入不共享缓存');
    } finally {
      process.env.SYSTEMONE_CACHE_TTL_MS = '0';
    }
  });

  await checkA('判定缓存：TTL 过期后重新发请求', async () => {
    process.env.SYSTEMONE_CACHE_TTL_MS = '1';
    try {
      received = [];
      await assess('Bash', { command: 'rm -rf ./cache-ttl' }, hookEnv);
      assert.equal(received.length, 1);
      await new Promise((r) => setTimeout(r, 5)); // 等 1ms TTL 过期
      await assess('Bash', { command: 'rm -rf ./cache-ttl' }, hookEnv);
      assert.equal(received.length, 2, '过期条目应视为未命中');
    } finally {
      process.env.SYSTEMONE_CACHE_TTL_MS = '0';
    }
  });

  await checkA('判定缓存：缓存文件损坏时当未命中（fail-open）', async () => {
    process.env.SYSTEMONE_CACHE_TTL_MS = '300000';
    try {
      writeFileSync(path.join(runRoot, 'decision-cache.json'), '{"entries": [broken');
      received = [];
      const v = await assess('Bash', { command: 'rm -rf ./cache-corrupt' }, hookEnv);
      assert.equal(v.decision, 'deny');
      assert.equal(received.length, 1, '损坏的缓存文件应被当作空缓存');
    } finally {
      process.env.SYSTEMONE_CACHE_TTL_MS = '0';
    }
  });

  // 子进程端到端：同一提示第二次提交命中缓存——行为不变（仍注入预检结论）且不再发请求
  scenario = 'unclear';
  received = [];
  const cachePrompt = '缓存端到端验证：把 decision-cache 的上限从 100 调到 200 并补齐测试';
  r = await run(cachePrompt, { SYSTEMONE_CACHE_TTL_MS: '300000' });
  check('判定缓存端到端：首次提交发出请求并写入缓存', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });
  r = await run(cachePrompt, { SYSTEMONE_CACHE_TTL_MS: '300000' });
  check('判定缓存端到端：重发同一提示命中缓存且结论一致', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '第二次应命中缓存、不再发请求');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });
  rmSync(path.join(runRoot, 'decision-cache.json'), { force: true });

  // ---------- 预检开关与会话配额：off / first:N / 裸数字 / 非法值 / 配额文件损坏 ----------

  const quotaFile = path.join(runRoot, 'precheck-quota.json');
  const quotaPrompt = '配额开关验证：把 precheck-quota 的会话桶上限从 100 调到 200 并补测试';
  rmSync(quotaFile, { force: true });

  scenario = 'unclear';
  received = [];
  r = await run(quotaPrompt, { SYSTEMONE_HOOK_PRECHECK: 'off' });
  check('预检开关 off：静默跳过且不发请求', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 0);
    assert.match(r.stderr, /预检跳过/);
  });

  received = [];
  r = await run(quotaPrompt, { SYSTEMONE_HOOK_PRECHECK: 'first:1' }, { session_id: 's1' });
  check('配额 first:1：会话 s1 首条输入正常判定并计数', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
    assert.ok(JSON.parse(readFileSync(quotaFile, 'utf8')).sessions.s1.count === 1, '配额文件应记 s1=1');
  });
  r = await run(quotaPrompt, { SYSTEMONE_HOOK_PRECHECK: 'first:1' }, { session_id: 's1' });
  check('配额 first:1：同会话第二条静默跳过、不发请求', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(received.length, 1, '配额用尽后不再发请求');
    assert.match(r.stderr, /配额已用尽/);
  });
  r = await run(quotaPrompt, { SYSTEMONE_HOOK_PRECHECK: 'first:1' }, { session_id: 's2' });
  check('配额 first:1：不同会话独立计数', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 2, '会话 s2 有自己的配额');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });

  rmSync(quotaFile, { force: true });
  received = [];
  r = await run(quotaPrompt + ' 裸数字', { SYSTEMONE_HOOK_PRECHECK: '1' }, { session_id: 's3' });
  await run(quotaPrompt + ' 裸数字', { SYSTEMONE_HOOK_PRECHECK: '1' }, { session_id: 's3' });
  check('配额裸数字 N 等同 first:N', () => {
    assert.equal(received.length, 1, '首条判定、第二条跳过');
  });

  rmSync(quotaFile, { force: true });
  received = [];
  r = await run(quotaPrompt + ' 非法值', { SYSTEMONE_HOOK_PRECHECK: 'banana' });
  check('非法开关值：告警并按默认 on 判定', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1);
    assert.match(r.stderr, /无法识别/);
  });

  rmSync(quotaFile, { force: true });
  writeFileSync(quotaFile, '{"sessions": [broken');
  received = [];
  r = await run(quotaPrompt + ' 损坏', { SYSTEMONE_HOOK_PRECHECK: 'first:1' }, { session_id: 's4' });
  check('配额文件损坏：当未限额处理（fail-open）', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 1, '损坏的配额文件应被当作空表');
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /需求预检/);
  });
  rmSync(quotaFile, { force: true });

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
