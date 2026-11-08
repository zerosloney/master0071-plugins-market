// 协议交叉契约测试：MCP 侧（mcp/server.mjs 的 callSystemone）与 hook 侧（hooks/decide-client.mjs 的 decide）
// 是同一 SystemOne 协议的两份传输层——两边各自注明「改协议形状时必须两处同步」，但此前没有任何
// 断言比较过两侧发出的请求体：一边改了字段名/URL/请求体形状，另一边照旧，两边各自单测都绿，
// 线上却是「MCP 通了、hook 静默失效」。这里对同一 mock 端点分别驱动两侧，逐字段比对请求体。
// 运行：node test/contract.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// 在临时目录跑被测插件：MCP 服务启动会把已解析端点落盘到插件根 .endpoint.json，
// 直接跑仓库副本会污染工作区，也让 hook 侧读到共享文件、绕过环境变量。
const runRoot = mkdtempSync(path.join(os.tmpdir(), 'systemone-contract-'));
cpSync(path.join(here, '..'), runRoot, { recursive: true });
rmSync(path.join(runRoot, '.endpoint.json'), { force: true });
const serverPath = path.join(runRoot, 'mcp', 'server.mjs');

// 两边喂同一份输入：state 与 questions 都必须一模一样，差异只能来自传输层
const STATE = '契约对齐探测：同一个业务上下文';
const QUESTIONS = {
  q1: { type: 'noul', instructions: '这项任务是否应当今天完成？' },
  q2: { type: 'choice', instructions: '该请求应分派给哪个组？', criteria: { billing: '账单与计费', technical: '技术故障' } },
  q3: { type: 'score', instructions: '该操作的破坏性有多高？', criteria: ['只读', '可回滚的写', '难回滚的写', '不可逆'] },
};

const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'u2-decision', request_id: 'contract', latency_ms: 1, answers: { q1: { type: 'noul', noul: 0.8 } } }));
  });
});

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PLUGIN_DATA: '', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.nextId = 1;
    this.pending = new Map();
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  close() {
    this.child.kill();
  }
}

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

const main = async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const client = new McpClient({ SYSTEMONE_API_KEY: 'contract-key', SYSTEMONE_BASE_URL: baseUrl });
  try {
    // 场景库契约：工具描述与 action=list 都必须暴露 model_routing——清单漂移等于模型在
    // 工具描述里看不到新场景入口。list 是本地操作，不发 HTTP，不影响后续 received 计数断言。
    const tools = await client.call('tools/list', {});
    check('systemone_scenario 工具描述包含 model_routing', () => {
      const tool = tools.result.tools.find((t) => t.name === 'systemone_scenario');
      assert.ok(tool, 'systemone_scenario 工具应存在');
      assert.ok(tool.description.includes('model_routing'), '工具描述的内置场景清单应含 model_routing');
    });
    const listRes = await client.call('tools/call', { name: 'systemone_scenario', arguments: { action: 'list' } });
    check('action=list 含 model_routing', () => {
      const parsed = JSON.parse(listRes.result.content[0].text);
      assert.ok(
        parsed.scenarios.some((s) => s.id === 'model_routing'),
        `list 应含 model_routing：${parsed.scenarios.map((s) => s.id).join('、')}`
      );
    });

    // MCP 侧：走公开工具入口（systemone_decide），跑的是生产路径的序列化
    const mcpRes = await client.call('tools/call', {
      name: 'systemone_decide',
      arguments: { state: STATE, questions: QUESTIONS },
    });
    check('MCP 侧判定走通（拿到结果）', () => {
      assert.equal(mcpRes.result.isError, undefined, JSON.stringify(mcpRes.result.content?.[0]?.text ?? ''));
    });
    assert.equal(received.length, 1, 'MCP 侧应发出一次请求');
    const mcpReq = received[0];

    // hook 侧：走 hooks/decide-client.mjs 的 decide()——与两个 hook 内核同一条路径
    const { decide, config } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'decide-client.mjs')).href);
    const hookCfg = config({
      SYSTEMONE_API_KEY: 'contract-key',
      SYSTEMONE_BASE_URL: baseUrl,
    });
    const answers = await decide(STATE, hookCfg, QUESTIONS);
    check('hook 侧判定走通（拿到答案）', () => {
      assert.ok(answers && answers.q1, 'hook 侧应拿到答案');
    });
    assert.equal(received.length, 2, 'hook 侧应发出一次请求');
    const hookReq = received[1];

    // 逐字段比对两侧发出的请求：形状、URL、认证头、请求体都必须一致
    check('两侧请求 URL 与方法一致（同一端点、同一条 /systemone 路径）', () => {
      assert.equal(hookReq.url, mcpReq.url, 'URL 路径不一致');
      assert.equal(hookReq.method, mcpReq.method, 'HTTP 方法不一致');
    });
    check('两侧认证头一致（同一 Bearer 形态）', () => {
      assert.equal(mcpReq.headers.authorization, 'Bearer contract-key');
      assert.equal(hookReq.headers.authorization, mcpReq.headers.authorization, '认证头不一致');
    });
    check('两侧请求体逐字段相同（model / state / questions）', () => {
      assert.deepStrictEqual(Object.keys(hookReq.body).sort(), Object.keys(mcpReq.body).sort(), '请求体顶层字段不同');
      assert.equal(hookReq.body.model, mcpReq.body.model, 'model 不一致');
      assert.equal(hookReq.body.state, mcpReq.body.state, 'state 不一致');
      assert.deepStrictEqual(hookReq.body.questions, mcpReq.body.questions, 'questions 结构不一致');
      // 逐题再比一遍：题型、判据、说明都不能少
      for (const qid of Object.keys(QUESTIONS)) {
        assert.ok(mcpReq.body.questions[qid], `MCP 侧缺问题 ${qid}`);
        assert.deepStrictEqual(hookReq.body.questions[qid], mcpReq.body.questions[qid], `问题 ${qid} 两侧不一致`);
      }
      // noul 题不携带 criteria（本地展示与判据不该外发给 noul 题）
      assert.ok(!('criteria' in mcpReq.body.questions.q1), 'noul 题不应携带 criteria');
    });

    // ---------- 决策缓存 key 组成对账（有意差异，钉住防漂移） ----------
    // MCP 侧（mcp/server.mjs cacheKey）= model + state + questions，**不含 baseUrl**：
    // 它是进程内内存缓存，端点来自启动时的环境变量快照、进程存活期内不变，无需参与 key。
    // hook 侧（hooks/decision-cache.mjs cacheKey）= sha256(baseUrl + model + state + questions)：
    // 它是跨进程共享文件缓存，文件可能跨端点配置存续，端点必须参与防「换供应商后串旧答案」。
    // README「本地缓存」（MCP）与「hook 判定缓存」两节分别记载了这组组成——一侧改 key 组成
    // 而另一侧不知情，属于静默漂移，这里从两个方向钉住。
    // MCP 侧 cacheKey 未导出、server.mjs import 即挂 stdio 主循环，无法作为模块调用——
    // 按 agent-pipelines test/contract.mjs 的源码锚定思路做静态提取对账；hook 侧可直接调用真实实现。
    {
      const serverSource = readFileSync(path.join(here, '..', 'mcp', 'server.mjs'), 'utf8');
      const cacheKeyFn = serverSource.match(/function cacheKey\(model, state, request\) \{\s*return `([^`]*)`;/);
      check('MCP 缓存 key 组成 = model + state + questions、不含 baseUrl（源码锚定）', () => {
        assert.ok(cacheKeyFn, 'server.mjs 的 cacheKey 函数形状变了（签名或模板字符串），请同步更新本对账锚点');
        const tpl = cacheKeyFn[1];
        assert.ok(tpl.includes('${model}'), 'MCP key 必须含 model');
        assert.ok(tpl.includes('${stableStringify(state)}'), 'MCP key 必须含 state（stableStringify）');
        assert.ok(tpl.includes('${stableStringify(request)}'), 'MCP key 必须含 questions（stableStringify）');
        assert.ok(!tpl.includes('baseUrl'), 'MCP key 有意不含 baseUrl（进程内缓存、端点启动后不变）；若要加入，先同步 README 两处缓存说明与本对账');
        // 调用点锚定：首参是 cfg.model 而非别的字段
        assert.ok(/cacheKey\(cfg\.model, state, questions\)/.test(serverSource), 'callSystemone 应用 cfg.model 参与 key');
      });
      const hookCacheSource = readFileSync(path.join(runRoot, 'hooks', 'decision-cache.mjs'), 'utf8');
      const { cacheKey: hookCacheKey } = await import(pathToFileURL(path.join(runRoot, 'hooks', 'decision-cache.mjs')).href);
      check('hook 缓存 key 组成含 baseUrl + model（真实实现调用），与 MCP 侧差异是有意的', () => {
        const a = hookCacheKey({ baseUrl: 'https://a.example/v1', model: 'm' }, STATE, QUESTIONS);
        const b = hookCacheKey({ baseUrl: 'https://b.example/v1', model: 'm' }, STATE, QUESTIONS);
        assert.notEqual(a, b, 'hook key 必须随端点变化（跨进程共享文件，防换供应商串答案）');
        const c = hookCacheKey({ baseUrl: 'https://a.example/v1', model: 'other' }, STATE, QUESTIONS);
        assert.notEqual(a, c, 'hook key 必须随模型变化');
        assert.ok(hookCacheSource.includes('baseUrl: cfg.baseUrl'), 'decision-cache 源码应锚定含 baseUrl 字段');
        assert.ok(/JSON\.stringify\(\{ baseUrl/.test(hookCacheSource), 'hook key 序列化对象应以 baseUrl 开头（静态锚定）');
      });
    }
  } finally {
    client.close();
    mock.close();
  }
  rmSync(runRoot, { recursive: true, force: true });
  if (failed) {
    console.error('\n协议交叉契约测试存在失败项');
    process.exit(1);
  }
  console.log('\n协议交叉契约测试全部通过');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
