// hook 冒烟测试：本地 mock SystemOne 端点 + 子进程运行 UserPromptSubmit hook，不需要真实 API Key。
// 验证四类行为：需求不明确 → 注入结论；明确 → 静默；寒暄/缺 Key → 不发请求直接放行；接口故障 → fail-open。
// 注意：子进程必须用异步 spawn——本机部分沙箱环境下 spawnSync 子进程的 HTTP 请求会被挂起，
// 生产环境 ZCode 以异步方式拉起 hook，不受影响。
// 运行：node test/hook.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// 开发机上可能残留 SYSTEMONE_* 变量（场景、端点、超时、缓存 TTL、开关……）。
// CI 环境干净所以 CI 全绿，本地开发者只要设了其中一个就会莫名红、且极难定位：
// 例如设了 SYSTEMONE_SCENARIOS，自定义场景就顶掉了内置场景，场景数断言直接失败。
// 这里统一把这组变量清空，测试自己需要的值一律显式传入（cleanEnv 的 extra 优先）。
const POLLUTING_ENV_KEYS = [
  'PLUGIN_DATA',
  'SYSTEMONE_API_KEY',
  'UNISOUND_API_KEY',
  'SYSTEMONE_BASE_URL',
  'SYSTEMONE_PLUGIN_BASE_URL',
  'SYSTEMONE_MODEL',
  'SYSTEMONE_PLUGIN_MODEL',
  'SYSTEMONE_TIMEOUT_MS',
  'SYSTEMONE_PLUGIN_TIMEOUT_MS',
  'SYSTEMONE_SCENARIOS',
  'SYSTEMONE_PLUGIN_SCENARIOS',
  'SYSTEMONE_SCENARIOS_FILE',
  'SYSTEMONE_PLUGIN_SCENARIOS_FILE',
  'SYSTEMONE_LOG_FILE',
  'SYSTEMONE_PLUGIN_LOG_FILE',
  'SYSTEMONE_CACHE_TTL_MS',
  'SYSTEMONE_PLUGIN_CACHE_TTL_MS',
  'SYSTEMONE_BATCH_BUDGET_MS',
  'SYSTEMONE_PLUGIN_BATCH_BUDGET_MS',
  'SYSTEMONE_HOOK_PRECHECK',
  'SYSTEMONE_PLUGIN_HOOK_PRECHECK',
];
const cleanEnv = (extra = {}) => {
  const base = { ...process.env };
  for (const key of POLLUTING_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
};
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

// 一个名字的全部大小写变体（工具名的大小写由宿主决定，插件挑不了）
const caseVariants = (name) => {
  const out = [];
  const walk = (i, acc) => {
    if (i === name.length) {
      out.push(acc);
      return;
    }
    const ch = name[i];
    walk(i + 1, acc + ch.toLowerCase());
    walk(i + 1, acc + ch.toUpperCase());
  };
  walk(0, '');
  return out;
};

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
  //（与 MCP 侧 isBorderlineAnswer 同口径）
  unclearHallucinatedMissing: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 1, confidence: 0.92 },
    missing: { type: 'choice', choice: 'timeline', probabilities: { timeline: 0.96 }, confidence: 0.96 },
    proceed: { type: 'noul', noul: 0.42 },
  },
};
let scenario = 'clear';


const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    received.push(parsed);
    const answers = SCENARIOS[scenario];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'u2-decision', answers }));
  });
});

const run = (prompt, envExtra = {}, payloadExtra = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: cleanEnv({
        SYSTEMONE_API_KEY: 'test-key',
        UNISOUND_API_KEY: '',
        // 端点共享文件位置由 PLUGIN_DATA 决定；用例默认走插件根旧路径，
        // 需要时由 envExtra 显式覆盖，避免继承开发机环境导致结果漂移。
        PLUGIN_DATA: '',
        SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
        // 判定缓存默认关（用例逐一断言请求次数，缓存命中会让计数漂移）；
        // 缓存行为在文末专门小节显式开启验证。
        SYSTEMONE_CACHE_TTL_MS: process.env.SYSTEMONE_CACHE_TTL_MS ?? '0',
        ...envExtra,
      }),
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

  // 8b. 设置页的两个 hook 开关走共享文件（2026-11-01 修复）。
  // 设置页注入的 SYSTEMONE_PLUGIN_HOOK_* 只进 MCP 子进程 env，hook 进程读不到；旧实现里
  // 这两个开关在 hook 侧**没有任何通道**，而 README 把它们写成"等价环境变量""off = 停掉外发"。
  // 现在 MCP 启动时把解析结果一并落盘，hook 读共享文件——本用例是那条通道的端到端证据。
  received = [];
  writeFileSync(
    path.join(runRoot, '.endpoint.json'),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'u2-decision',
      timeoutMs: 9000,
      hookPrecheck: 'off',
    })
  );
  r = await run('帮我把这个项目优化一下，尽快弄好'); // 无任何开关环境变量
  check('设置页 hook_precheck=off 经共享文件到达 hook：不预检、不发请求', () => {
    assert.equal(r.status, 0);
    assert.equal(received.length, 0, 'off 意味着一个判定请求都不该发');
    assert.equal(String(r.stdout).trim(), '', 'off 时不应注入任何上下文');
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

  // killer 兜底：stdin 永不关闭的挂起场景（0.6.1 起风险闸整体下线，killer 回归**纯 silent
  // 自毁**——不再输出 ask 载荷转人工，挂起即静默放行；UserPromptSubmit 通道保持 fail-open 现状）。
  const killerProbe = () =>
    new Promise((resolve) => {
      const hookIoUrl = JSON.stringify(pathToFileURL(path.join(runRoot, 'hooks', 'hook-io.mjs')).href);
      const script =
        `Promise.all([import(${hookIoUrl})])`
        + `.then(([io]) => {`
        + `let clock = 0;`
        + `const opts = { now: () => (clock += 15_000), killerMs: 400 };`
        + `return io.runHook(async () => { throw new Error('stdin 挂起时 handle 不应被调用'); }, opts);`
        + `})`
        + `.catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });`;
      const child = spawn(process.execPath, ['-e', script], {
        env: cleanEnv({ PLUGIN_DATA: '', SYSTEMONE_API_KEY: '', UNISOUND_API_KEY: '' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      // 关键构造：stdin 只挂管道——不 write、不 end，复刻「stdin 永不关闭」的挂起
      // 20s 兜底（>14s：修复前的真实 killer 也要放它跑完），killer 回归为不触发时别让套件挂死
      const guard = setTimeout(() => {
        child.kill();
        setTimeout(() => resolve({ status: null, stdout, stderr }), 1000);
      }, 20_000);
      child.on('close', (status) => {
        clearTimeout(guard);
        resolve({ status, stdout, stderr });
      });
    });

  let kr = await killerProbe(false);
  check('killer 兜底 silent 策略：挂起时 exit 0 无输出（UserPromptSubmit 通道 fail-open，现状钉住）', () => {
    assert.equal(kr.status, 0, `应静默自毁（status=${kr.status}，stderr=${kr.stderr.trim()}）`);
    assert.equal(kr.stdout, '', 'silent 策略不得有任何输出（该通道输出 permissionDecision 是协议违规）');
  });

  // decide 的共享 deadline 收缩：override 小于端点延迟时必须提前中止，而不是吃满 cfg.timeoutMs。
  // 这是 requirement-clarity「stdin 耗时 + 请求 ≤ handler 15s」机制的直接断言。
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
  // 判定缓存随风险闸下线改由需求预检路径消费（decision-cache 仍在 decide-client 链路上）
  const { precheck } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'clarity.mjs')).href);
  const { precheckMode } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'precheck-quota.mjs')).href);
  const preEnv = { SYSTEMONE_API_KEY: 'test-key', UNISOUND_API_KEY: '', SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1` };
  // precheck 的 opts.mode 契约上「可缺省」，但实现里 bumpQuota(mode) 直接读 mode.mode——缺省会崩。
  // 本处按契约显式传入（生产路径的 hook 入口本就传），契约与实现的缺口另记 papercut。
  const preOpts = { mode: precheckMode(preEnv) };


  await checkA('判定缓存：相同输入第二次不发请求，不同输入照常发', async () => {
    process.env.SYSTEMONE_CACHE_TTL_MS = '300000';
    try {
      scenario = 'unclear';
      received = [];
      const first = await precheck('帮我把这个项目优化一下，尽快弄好', preEnv, preOpts);
      assert.ok(first, '首次判定应得出结论');
      assert.equal(received.length, 1, '首次判定应发出请求');
      const second = await precheck('帮我把这个项目优化一下，尽快弄好', preEnv, preOpts);
      assert.ok(second, '缓存命中应返回同一结论');
      assert.equal(received.length, 1, '相同输入第二次应命中缓存、不再发请求');
      await precheck('换个说法把项目优化一下，尽快弄好', preEnv, preOpts);
      assert.equal(received.length, 2, '不同输入不共享缓存');
    } finally {
      process.env.SYSTEMONE_CACHE_TTL_MS = '0';
    }
  });

  await checkA('判定缓存：TTL 过期后重新发请求', async () => {
    process.env.SYSTEMONE_CACHE_TTL_MS = '1';
    try {
      received = [];
      await precheck('帮我把这个项目优化一下，尽快弄好', preEnv, preOpts);
      assert.equal(received.length, 1);
      await new Promise((r) => setTimeout(r, 5)); // 等 1ms TTL 过期
      await precheck('帮我把这个项目优化一下，尽快弄好', preEnv, preOpts);
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
      const v = await precheck('帮我把这个项目优化一下，尽快弄好', preEnv, preOpts);
      assert.ok(v, '损坏缓存不应影响判定结论');
      assert.equal(received.length, 1, '损坏的缓存文件应被当作空缓存');
    } finally {
      process.env.SYSTEMONE_CACHE_TTL_MS = '0';
    }
  });

  // ---------- 缓存 TTL 开关：坏值 stderr 告警后取默认（不静默），未设置不告警 ----------

  // 子进程探针：hookCacheTtlMs 每次读 process.env，独立进程里注入变量最干净
  //（与上方 switchProbe 同一写法），顺带断言 stderr 有无告警。
  const ttlProbe = (envExtra) =>
    new Promise((resolve) => {
      const dcUrl = JSON.stringify(pathToFileURL(path.join(runRoot, 'hooks', 'decision-cache.mjs')).href);
      const script =
        `import(${dcUrl}).then((dc) => { process.stdout.write(String(dc.hookCacheTtlMs())); })`
        + `.catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });`;
      const child = spawn(process.execPath, ['-e', script], {
        env: cleanEnv({ PLUGIN_DATA: '', ...envExtra }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });

  await checkA('缓存 TTL 坏值：stderr 告警且取默认 300000（不静默走更激进缓存）', async () => {
    const neg = await ttlProbe({ SYSTEMONE_CACHE_TTL_MS: '-5' });
    assert.equal(neg.code, 0, neg.err);
    assert.equal(neg.out, '300000', '负值应取默认 TTL');
    assert.match(neg.err, /无法识别/, '负值应留 stderr 告警');
    const junk = await ttlProbe({ SYSTEMONE_PLUGIN_CACHE_TTL_MS: 'banana' });
    assert.equal(junk.out, '300000', '非数字应取默认 TTL');
    assert.match(junk.err, /无法识别/, '非数字应留 stderr 告警');
  });

  await checkA('缓存 TTL 合法值：未设置安静取默认、0=关闭、正数生效，均不告警', async () => {
    const unset = await ttlProbe({});
    assert.equal(unset.out, '300000');
    assert.equal(unset.err, '', '未设置不算坏值，不得刷告警');
    const zero = await ttlProbe({ SYSTEMONE_CACHE_TTL_MS: '0' });
    assert.equal(zero.out, '0', '0 = 关闭照旧');
    assert.equal(zero.err, '');
    const five = await ttlProbe({ SYSTEMONE_CACHE_TTL_MS: '5000' });
    assert.equal(five.out, '5000');
    assert.equal(five.err, '');
  });

  // 缓存文件位置（2026-11-05）：cacheFile 的 PLUGIN_DATA 相对路径与 endpoint-config.mjs 已修项
  // 同型——MCP 服务（cwd=插件根）与 hook（cwd=会话工作区）会把同一个相对值各自 resolve 到
  // 不同文件，缓存写进一边、另一边永远读不到，共享通道静默断裂。修法同口径：相对值 stderr
  // 告警后按「未提供」处理，回退插件根，两个进程至少还指向同一处。子进程探针注入 env 最干净。
  const cachePutProbe = (envExtra) =>
    new Promise((resolve) => {
      const dcUrl = JSON.stringify(pathToFileURL(path.join(runRoot, 'hooks', 'decision-cache.mjs')).href);
      const script =
        `import(${dcUrl}).then((dc) => { dc.cachePut('systemone-rel-data-probe', { q1: { keep: true } }); process.stdout.write('put-ok'); })`
        + `.catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });`;
      const child = spawn(process.execPath, ['-e', script], {
        env: cleanEnv({ PLUGIN_DATA: '', ...envExtra }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });

  await checkA('缓存文件位置：PLUGIN_DATA 相对路径告警后回退插件根（共享通道不随 cwd 断裂）', async () => {
    const relDir = 'systemone-rel-cache-data';
    try {
      const w = await cachePutProbe({ PLUGIN_DATA: relDir, SYSTEMONE_CACHE_TTL_MS: '300000' });
      assert.equal(w.code, 0, w.err);
      assert.equal(w.out, 'put-ok', 'cachePut 本身必须成功（fail-open 契约不受影响）');
      assert.match(w.err, /绝对路径/, '相对 PLUGIN_DATA 应留 stderr 告警');
      assert.ok(existsSync(path.join(runRoot, 'decision-cache.json')), '应回退插件根落盘（与端点共享文件同一回退位）');
      assert.ok(!existsSync(path.resolve(relDir)), '不得在相对 cwd 下创建相对 PLUGIN_DATA 目录');
    } finally {
      rmSync(path.join(runRoot, 'decision-cache.json'), { force: true });
      // 修复前的旧行为会在测试进程 cwd 下落相对目录：测试自造自清
      rmSync(path.resolve(relDir), { recursive: true, force: true });
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

  // 配额扣减时机（2026-11-05）：decide 抛错（网络失败）不得白扣配额——旧实现 bumpQuota
  // 在 decide 之前，请求失败时额度已扣、配额文件已写。
  rmSync(quotaFile, { force: true });
  received = [];
  r = await run(quotaPrompt + ' 失败不扣额', {
    SYSTEMONE_HOOK_PRECHECK: 'first:1',
    SYSTEMONE_BASE_URL: 'http://127.0.0.1:9/v1',
    SYSTEMONE_TIMEOUT_MS: '1500',
  }, { session_id: 'sfail' });
  check('配额扣减时机：判定请求失败不扣配额（文件不落盘）', () => {
    assert.equal(r.status, 0);
    assert.match(r.stderr, /预检跳过/);
    assert.equal(existsSync(quotaFile), false, '判定失败不应写配额文件');
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
