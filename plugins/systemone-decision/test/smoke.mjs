// 冒烟测试：本地 mock SystemOne 端点 + 子进程 MCP 服务器端到端验证，不需要真实 API Key。
// 运行：node test/smoke.mjs（在插件根目录或任意位置均可，路径基于本文件解析）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'mcp', 'server.mjs');

// 用户文档示例中的真实响应结构作为 fixture
const FIXTURE = {
  model: 'u2-decision',
  request_id: '4682848d-ba43-4e8b-9687-be6cbe4b17a6',
  latency_ms: 322,
  answers: {
    department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.893309, technical: 0.106691 }, confidence: 0.8933094143867493 },
    escalate: { type: 'noul', noul: 0.9603611826896667 },
    severity: {
      type: 'score',
      legend: { '0': '轻微问题，不影响功能', '1': '部分功能受影响，但存在替代方案', '2': '核心功能不可用，没有替代方案', '3': '造成严重业务或安全影响' },
      probabilities: { '0': 0.001159, '1': 0.003149, '2': 0.98943, '3': 0.006263 },
      score: 2.000796,
      confidence: 0.9894295334815979,
    },
  },
  usage: { input_tokens: 335 },
};

// 按请求中的问题动态生成答案：已知 qid 用 fixture 原值，其余按题型套模板，
// 以此同时校验"发出的问题被正确序列化 + answers 按请求 qid 对齐"。
function answerFor(qid, q) {
  if (FIXTURE.answers[qid]) return FIXTURE.answers[qid];
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria || {});
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / Math.max(keys.length - 1, 1)]));
    return { type: 'choice', choice: keys[0], probabilities, confidence: 0.9 };
  }
  if (q.type === 'score') {
    const levels = q.criteria || [];
    const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 0.9 : 0.1 / Math.max(levels.length - 1, 1)]));
    const legend = Object.fromEntries(levels.map((c, i) => [String(i), c]));
    return { type: 'score', legend, probabilities, score: 0.2, confidence: 0.9 };
  }
  return { type: 'noul', noul: 0.87 };
}

const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    received.push({ url: req.url, headers: req.headers, body: parsed });
    if (parsed.state === 'mock:permission-error') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ base_resp: { status_code: 100105, status_msg: 'model error: no model u2-decision permission' } }));
      return;
    }
    const answers = {};
    for (const [qid, q] of Object.entries(parsed.questions || {})) answers[qid] = answerFor(qid, q);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...FIXTURE, answers }));
  });
});

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
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
        if (msg.id !== undefined && this.pending.has(msg.id)) {
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

const approx = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `期望 ${actual} ≈ ${expected}`);

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
  const client = new McpClient({ SYSTEMONE_API_KEY: 'test-key', SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1` });

  try {
    const init = await client.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    check('initialize 返回 serverInfo 与协议版本', () => {
      assert.equal(init.result.serverInfo.name, 'systemone-decision');
      assert.equal(init.result.protocolVersion, '2024-11-05');
    });

    const list = await client.call('tools/list', {});
    check('tools/list 提供 5 个工具', () => {
      assert.deepEqual(
        list.result.tools.map((t) => t.name).sort(),
        ['agent_route', 'content_moderate', 'systemone_decide', 'ticket_triage', 'verify_result']
      );
    });

    const toolResult = (r) => JSON.parse(r.result.content[0].text);

    const triage = await client.call('tools/call', {
      name: 'ticket_triage',
      arguments: { ticket: '订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。' },
    });
    const t = toolResult(triage);
    check('ticket_triage 归一化判定正确', () => {
      assert.equal(t.answers.department.value, 'billing');
      approx(t.answers.department.confidence, 0.8933094143867493);
      assert.equal(t.answers.severity.value, 2.001);
      assert.equal(t.answers.severity.level, '核心功能不可用，没有替代方案');
      approx(t.answers.escalate.probability, 0.9603611826896667);
      approx(t.answers.escalate.confidence, 0.9603611826896667);
      assert.equal(t.needs_human_review, false);
      assert.equal(t.meta.request_id, FIXTURE.request_id);
      assert.equal(t.raw.answers.severity.score, 2.000796);
    });
    check('请求打到了正确端点并携带认证与请求体', () => {
      assert.equal(received.length, 1);
      assert.equal(received[0].url, `/v1/systemone`);
      assert.equal(received[0].headers.authorization, 'Bearer test-key');
      assert.equal(received[0].body.model, 'u2-decision');
      assert.equal(received[0].body.state, '订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。');
      assert.equal(received[0].body.questions.department.type, 'choice');
      assert.equal(received[0].body.questions.escalate.type, 'noul');
      assert.equal(received[0].body.questions.severity.type, 'score');
    });

    const decide = await client.call('tools/call', {
      name: 'systemone_decide',
      arguments: {
        state: '把这份 50 页 PDF 的中文合同翻译成英文',
        questions: {
          model: { type: 'choice', instructions: '应使用哪个模型？', criteria: { flash: '快且便宜', pro: '质量优先' } },
        },
      },
    });
    const d = toolResult(decide);
    check('systemone_decide 通用工具走通（answers 按请求 qid 对齐）', () => {
      assert.equal(d.answers.model.value, 'flash');
      assert.equal(d.answers.model.present, true);
      approx(d.answers.model.confidence, 0.9);
    });

    const bad = await client.call('tools/call', {
      name: 'systemone_decide',
      arguments: { state: 'x', questions: { q1: { type: 'essay', instructions: '?' } } },
    });
    check('非法题型返回 isError 与明确原因', () => {
      assert.equal(bad.result.isError, true);
      assert.match(bad.result.content[0].text, /type 必须/);
    });

    const perm = await client.call('tools/call', {
      name: 'systemone_decide',
      arguments: { state: 'mock:permission-error', questions: { q1: { type: 'noul', instructions: '是吗？' } } },
    });
    check('模型无权限错误附带排查提示', () => {
      assert.equal(perm.result.isError, true);
      assert.match(perm.result.content[0].text, /HTTP 404/);
      assert.match(perm.result.content[0].text, /模型权限/);
      assert.match(perm.result.content[0].text, /环境变量快照/);
    });
  } finally {
    client.close();
  }

  // 缺 Key 场景：清空两个 Key 环境变量
  const noKeyClient = new McpClient({ SYSTEMONE_API_KEY: '', UNISOUND_API_KEY: '' });
  try {
    const noKey = await noKeyClient.call('tools/call', {
      name: 'systemone_decide',
      arguments: { state: 'x', questions: { q1: { type: 'noul', instructions: '是吗？' } } },
    });
    check('缺 API Key 返回 isError 与配置指引', () => {
      assert.equal(noKey.result.isError, true);
      assert.match(noKey.result.content[0].text, /SYSTEMONE_API_KEY/);
    });
  } finally {
    noKeyClient.close();
  }

  // 插件设置页注入变量（SYSTEMONE_PLUGIN_*）优先于同名环境变量；留空回退环境变量
  const uiClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: 'http://127.0.0.1:1/unreachable', // 若被使用，请求会失败
    SYSTEMONE_PLUGIN_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_PLUGIN_MODEL: 'alt-decision',
    SYSTEMONE_PLUGIN_TIMEOUT_MS: '',
  });
  try {
    const ui = await uiClient.call('tools/call', {
      name: 'systemone_decide',
      arguments: { state: 'ui-config', questions: { q1: { type: 'noul', instructions: '是吗？' } } },
    });
    const u = JSON.parse(ui.result.content[0].text);
    const last = received[received.length - 1];
    check('设置页变量优先于环境变量，留空项回退', () => {
      assert.equal(u.answers.q1.present, true);
      assert.equal(last.url, '/v1/systemone');
      assert.equal(last.body.model, 'alt-decision');
    });
  } finally {
    uiClient.close();
    mock.close();
  }

  if (failed) {
    console.error('\n冒烟测试存在失败项');
    process.exit(1);
  }
  console.log('\n冒烟测试全部通过');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
