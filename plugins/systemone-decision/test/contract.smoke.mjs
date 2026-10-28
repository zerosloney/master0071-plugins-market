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
