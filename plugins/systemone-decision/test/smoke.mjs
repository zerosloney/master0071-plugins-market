// 冒烟测试：本地 mock SystemOne 端点 + 子进程 MCP 服务器端到端验证，不需要真实 API Key。
// 运行：node test/smoke.mjs（在插件根目录或任意位置均可，路径基于本文件解析）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { rejectDataPath } from '../endpoint-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, '..');
// 在临时目录跑被测插件：服务器启动会把已解析端点落盘到插件根 .endpoint.json，
// 直接跑仓库副本会污染工作区，并与 hook 冒烟测试互相串扰端点。
const runRoot = mkdtempSync(path.join(os.tmpdir(), 'systemone-smoke-'));
// 审计日志 / 场景文件夹具的落点必须**在插件根之外**：runRoot 是复制出来的插件根，
// 服务器对 SYSTEMONE_LOG_FILE 与 SYSTEMONE_SCENARIOS_FILE 有「不得落在插件安装目录内」的
// 护栏（插件安装目录跨项目共享、且随下次更新被覆盖），指到 runRoot 里会被正当拒绝。
const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'systemone-scratch-'));
cpSync(pluginRoot, runRoot, { recursive: true });
// 源目录里若留有端点共享文件（本地跑过 MCP 服务的痕迹），它会被一起复制进沙箱，
// 让「靠环境变量指端点」的用例读到陈旧端点。沙箱必须从干净状态起步。
rmSync(path.join(runRoot, '.endpoint.json'), { force: true });
const serverPath = path.join(runRoot, 'mcp', 'server.mjs');

// 宿主产品名词表：仓库已移除市场概念，只剩 .zcode-plugin 垫片一个清单目录，
// 靠目录派生会漏掉「兼容 Agent Plugins 标准或支持 Claude 式 hook，但没有专属清单目录」
// 的宿主。目录派生（<name>-plugin → name）+ 显式补充的并集才是完整词表。匹配一律忽略大小写。
const HOST_TOKENS = [
  ...new Set([
    ...readdirSync(pluginRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\..+-plugin$/.test(d.name))
      .map((d) => d.name.replace(/^\./, '').replace(/-plugin$/, '')),
    'claude',
    'codebuddy',
    'qwen',
    'omp',
    'cursor',
    'vscode',
    'copilot',
    'kiro',
    'openclaw',
  ]),
];

// 只有部分宿主才有的界面概念。与宿主名同属「模型可见面不得指名某端」的范畴——
// 「插件设置页」在 omp 等宿主下不存在，模型读到会去找一个
// 不存在的入口。宿主名查不到这种写法，所以要单独一类。
const HOST_ONLY_UI = ['设置页'];

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
    // server 侧错误分支的三个哨兵：200 但 body 非 JSON / 200 但缺 answers / 普通 5xx（无权限提示）
    if (parsed.state === 'mock:non-json') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>gateway error</body></html>');
      return;
    }
    if (parsed.state === 'mock:no-answers') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'u2-decision', request_id: 'no-answers', latency_ms: 1, usage: {} }));
      return;
    }
    if (parsed.state === 'mock:server-error') {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      res.end('internal error');
      return;
    }
    // 缺陷回归夹具：判定值缺失的畸形响应——score 缺 score 字段 / score=null，或 noul 完全没有
    // 概率字段。模型此时仍会返回 legend 或高 confidence。归一化必须把它标成「无法判断」，
    // 绝不能回退到 0 分再取 legend[0] 捏造出等级标签，否则会产出一条看起来完全正常的假判定。
    // 响应缺 type 字段：归一化三处（answers / labels / summary）都必须回退到问题定义。
    // score 同时验证 answers.level 的兜底补齐——响应不带 legend 时它必须有值。
    if (parsed.state === 'mock:type-missing') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (q.type === 'score') {
          answers[qid] = { score: 2.000796, probabilities: { '2': 0.98 }, confidence: 0.98 };
        } else if (q.type === 'choice') {
          answers[qid] = { choice: 'billing', probabilities: { billing: 0.89 }, confidence: 0.89 };
        } else {
          answers[qid] = { noul: 0.96 };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }));
      return;
    }
    // type 错乱：choice 问题收到 noul 形态的答案（confidence 还很高）。归一化必须按问题
    // 定义题型取值——choice 字段不存在 → value=null → borderline 转人工；若反过来信响应的
    // type，这条会被当 noul 成功判定放行，decision 明示「无法判断」却 needs_human_review=false。
    if (parsed.state === 'mock:type-mismatch') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        answers[qid] = q.type === 'choice' ? { type: 'noul', noul: 0.9, confidence: 0.95 } : answerFor(qid, q);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }));
      return;
    }
    // 幻觉选项 / 越界分值：模型给出判据表里不存在的 choice，或超出量表范围的 score。
    // 两者 confidence 都很高，但前者会渲染成一个不存在的选项、后者会被 deriveFields
    // 钳成最高档（如 severity 7 → P1），都必须转人工，而不是当作合法判定放行。
    if (parsed.state === 'mock:choice-hallucinated' || parsed.state === 'mock:choice-prototype' || parsed.state === 'mock:score-out-of-range') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (parsed.state === 'mock:choice-hallucinated' && q.type === 'choice') {
          answers[qid] = { type: 'choice', choice: 'vip', probabilities: { vip: 0.97 }, confidence: 0.97 };
        } else if (parsed.state === 'mock:choice-prototype' && q.type === 'choice') {
          // 原型链上的名字不是判据表里的选项：`value in criteria` 会把它当合法值放行
          answers[qid] = { type: 'choice', choice: 'constructor', probabilities: { constructor: 0.97 }, confidence: 0.97 };
        } else if (parsed.state === 'mock:score-out-of-range' && q.type === 'score') {
          answers[qid] = {
            type: 'score',
            legend: {},
            probabilities: { '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1 },
            score: 7,
            confidence: 0.95,
          };
        } else {
          answers[qid] = answerFor(qid, q);
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }));
      return;
    }
    if (parsed.state === 'mock:score-missing' || parsed.state === 'mock:score-null' || parsed.state === 'mock:noul-missing' || parsed.state === 'mock:noul-null') {
      // 每个 sentinel 只破坏它自己那道题，其余题保持正常——否则 low_confidence_questions
      // 会混进未预期的题目，断言就测不出「只标记坏题」这件事了
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if ((parsed.state === 'mock:noul-missing' || parsed.state === 'mock:noul-null') && q.type === 'noul') {
          // noul-null：Number(null) === 0，弱实现会把缺失概率捏造成置信度 1.0 的「否」
          answers[qid] = parsed.state === 'mock:noul-null' ? { type: 'noul', noul: null } : { type: 'noul' };
        } else if (parsed.state !== 'mock:noul-missing' && parsed.state !== 'mock:noul-null' && q.type === 'score') {
          const malformed = {
            type: 'score',
            legend: { '0': '轻微问题，不影响功能', '1': '部分功能受影响，但存在替代方案', '2': '核心功能不可用，没有替代方案', '3': '造成严重业务或安全影响' },
            probabilities: { '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1 },
            confidence: 0.91,
          };
          if (parsed.state === 'mock:score-null') malformed.score = null;
          answers[qid] = malformed;
        } else {
          answers[qid] = answerFor(qid, q);
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }));
      return;
    }
    // 置信度垃圾值：JSON 没有 NaN/Infinity 字面量，1e999 靠文本替换注入（解析后即 Infinity）。
    // typeof Infinity === 'number' 会漏过弱守卫；choice 的 probabilities 回退值还可能是非数字字符串。
    // 归一化必须把它们收敛成 null（与 normalizeDecision 同一套 finite 口径），noul 概率无效时
    // decision 已是「无法判断」，必须同步转人工。
    if (parsed.state === 'mock:confidence-garbage') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (q.type === 'noul') {
          answers[qid] = { type: 'noul', noul: '__INF__' };
        } else if (q.type === 'score') {
          answers[qid] = {
            type: 'score',
            legend: { '2': '核心功能不可用，没有替代方案' },
            probabilities: { '2': 0.98 },
            score: 2.000796,
            confidence: '__INF__',
          };
        } else {
          answers[qid] = { type: 'choice', choice: 'billing', probabilities: { billing: 'high' } };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }).replaceAll('"__INF__"', '1e999'));
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
    this.child = spawn(process.execPath, [serverPath], {
      // PLUGIN_DATA 决定端点共享文件落在哪；默认为空即走插件根旧路径，
      // 避免继承开发机环境导致结果漂移（需要时由调用方显式传入）。
      env: { ...process.env, PLUGIN_DATA: '', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.seen = []; // 收到的全部响应，供「不该收到响应」类断言使用
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
        this.seen.push(msg);
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

const runScenario = (client, arguments_) =>
  client.call('tools/call', { name: 'systemone_scenario', arguments: arguments_ });
const decide = (client, arguments_) => client.call('tools/call', { name: 'systemone_decide', arguments: arguments_ });
const toolResult = (r) => JSON.parse(r.result.content[0].text);

// 共享载荷的「模型可见面」（工具描述、报错文案）不得指名某个宿主。同一份
// mcp/server.mjs 跑在 ZCode / Claude Code / CodeBuddy / Qwen Code / omp 等多端，指名某一端
// 才有的东西在其他端是误导，而且不会报错、只静默失效。源代码注释不在此列：那里提宿主名
// 是解释 why 的必要信息（如超时预算的推导依据）。
//
// 宿主名用词边界匹配，只认「作为名字出现」的写法：裸子串匹配会误伤——`omp` 是
// `complexity` 的子串（agent_routing 的题量表里就有），曾导致假阳性。
// HOST_ONLY_UI 覆盖另一种写法：不含任何宿主名、但仍只存在于部分宿主。
const hostOffense = (text) => {
  const t = text || '';
  const name = HOST_TOKENS.find((x) => new RegExp(`\\b${x}\\b`, 'i').test(t));
  if (name) return `宿主名「${name}」`;
  const ui = HOST_ONLY_UI.find((x) => t.includes(x));
  return ui ? `宿主专属界面「${ui}」` : null;
};
const assertHostNeutral = (surfaces) => {
  const bad = surfaces.map(([label, text]) => [label, hostOffense(text)]).filter(([, hit]) => hit);
  assert.equal(bad.length, 0, '以下文案指名了具体宿主，在其他宿主上是误导：\n' + bad.map(([l, h]) => `  ${l} → ${h}`).join('\n'));
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

    // 列表外的协议版本不得原样回显：回显等于对任意版本都声称支持。回落到服务端
    // 支持的最新版本（口径同 worktree-ops/mcp/protocol.mjs）。
    const initFuture = await client.call('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    check('initialize 对未知协议版本回落到支持的最新版，不原样回显', () => {
      assert.equal(initFuture.result.protocolVersion, '2025-06-18');
    });

    const list = await client.call('tools/list', {});
    check('tools/list 只提供 2 个工具（控制 schema 开销）', () => {
      assert.deepEqual(
        list.result.tools.map((t) => t.name).sort(),
        ['systemone_decide', 'systemone_scenario']
      );
    });

    // 共享载荷的「模型可见面」——工具描述与报错文案——不得指名某个宿主。同一份
    // mcp/server.mjs 跑在 ZCode / Claude Code / CodeBuddy / Qwen Code / omp 等多端，指名某一端才有的
    // 入口（插件设置页、重启 ZCode）在其他端是误导，而且不会报错、只静默失效。
    // 源代码注释不在此列：那里提宿主名是解释 why 的必要信息（如超时预算的推导）。
    const errorText = async (name, args) => {
      const r = await client.call('tools/call', { name, arguments: args });
      return r.result.content.map((c) => c.text).join('\n');
    };
    const surfaces = [
      ...list.result.tools.map((t) => [`工具描述 ${t.name}`, t.description]),
      ['错误：action 非法', await errorText('systemone_scenario', { action: 'nope' })],
      ['错误：run 缺 state', await errorText('systemone_scenario', { action: 'run', scenario: 'customer_service' })],
      ['错误：未知场景', await errorText('systemone_scenario', { action: 'run', scenario: 'nope', state: 'x' })],
      ['错误：describe 缺 scenario', await errorText('systemone_scenario', { action: 'describe' })],
      ['错误：params 未知 qid', await errorText('systemone_scenario', { action: 'run', scenario: 'customer_service', state: 'x', params: { nope: {} } })],
      ['错误：params 形态非法', await errorText('systemone_scenario', { action: 'run', scenario: 'customer_service', state: 'x', params: [] })],
      ['错误：params.criteria 形态非法', await errorText('systemone_scenario', { action: 'run', scenario: 'customer_service', state: 'x', params: { department: { criteria: [] } } })],
      ['错误：confidenceThreshold 非法', await errorText('systemone_scenario', { action: 'run', scenario: 'customer_service', state: 'x', confidenceThreshold: 5 })],
      ['错误：decide 非法题型', await errorText('systemone_decide', { state: 'x', questions: { q: { type: 'bogus', instructions: 'i' } } })],
      ['错误：decide 缺 questions', await errorText('systemone_decide', { state: 'x', questions: {} })],
      ['错误：decide 缺 state', await errorText('systemone_decide', { questions: { q: { type: 'noul', instructions: 'i' } } })],
    ];
    check('宿主清单目录被正确识别（防止词表为空导致下一条空转）', () => {
      assert.ok(HOST_TOKENS.length >= 4, `词表只有 ${HOST_TOKENS.length} 项：${HOST_TOKENS}`);
      for (const expected of ['zcode', 'claude', 'codebuddy', 'qwen', 'omp', 'cursor']) {
        assert.ok(HOST_TOKENS.some((t) => t.toLowerCase() === expected), `词表缺 ${expected}：${HOST_TOKENS}`);
      }
    });
    check('共享载荷的模型可见面不含宿主产品名或宿主专属界面概念（工具描述 + 场景/参数报错）', () => {
      assertHostNeutral(surfaces);
    });

    const scenarioList = toolResult(await runScenario(client, { action: 'list' }));
    check('action=list 列出 15 个内置场景', () => {
      assert.equal(scenarioList.ok, true);
      assert.equal(scenarioList.count, 15);
      assert.deepEqual(
        scenarioList.scenarios.map((s) => s.id),
        [
          'customer_service', 'content_moderation', 'agent_routing', 'result_verification', 'sales_lead',
          'risk_control', 'recruiting', 'data_governance', 'education', 'requirements', 'software_dev',
          'test_failure', 'pr_review', 'incident_response', 'security_triage',
        ]
      );
      assert.ok(scenarioList.summary.includes('software_dev'));
    });
    const byTitle = toolResult(await runScenario(client, { action: 'list', keyword: '工单' }));
    const byAlias = toolResult(await runScenario(client, { action: 'list', keyword: '审核' }));
    check('action=list 支持 keyword 过滤（标题/别名匹配）', () => {
      assert.deepEqual(byTitle.scenarios.map((s) => s.id), ['customer_service']);
      assert.deepEqual(byAlias.scenarios.map((s) => s.id), ['content_moderation']);
    });

    const described = toolResult(await runScenario(client, { action: 'describe', scenario: 'customer_service' }));
    check('action=describe 返回问题定义与判据', () => {
      assert.equal(described.scenario, 'customer_service');
      assert.equal(described.questions.length, 3);
      const department = described.questions.find((q) => q.id === 'department');
      assert.deepEqual(Object.keys(department.criteria).sort(), ['account', 'billing', 'other', 'product', 'technical']);
      assert.ok(described.summary.includes('建议模板'));
    });

    const triage = toolResult(
      await runScenario(client, {
        action: 'run',
        scenario: 'customer_service',
        state: '订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。',
      })
    );
    check('run 归一化判定正确（逐题明细）', () => {
      assert.equal(triage.answers.department.value, 'billing');
      approx(triage.answers.department.confidence, 0.8933094143867493);
      assert.equal(triage.answers.severity.value, 2.001);
      assert.equal(triage.answers.severity.level, '核心功能不可用，没有替代方案');
      approx(triage.answers.escalate.probability, 0.9603611826896667);
      approx(triage.answers.escalate.confidence, 0.9603611826896667);
      assert.equal(triage.needs_human_review, false);
      assert.deepEqual(triage.low_confidence_questions, []);
      assert.equal(triage.meta.request_id, FIXTURE.request_id);
      assert.equal(triage.raw.answers.severity.score, 2.000796);
    });
    check('run 输出速览结构：decision / labels / derived / recommendation / summary', () => {
      assert.equal(triage.scenario, 'customer_service');
      assert.deepEqual(triage.decision, { department: 'billing', severity: 2, escalate: true });
      assert.equal(triage.labels.department, '支付、退款、账单和计费问题');
      assert.equal(triage.labels.severity, '核心功能不可用，没有替代方案');
      assert.equal(triage.labels.escalate, '是');
      assert.equal(triage.derived.priority, 'P2');
      assert.ok(triage.recommendation.includes('P2'));
      assert.ok(triage.recommendation.includes('需立即通知值班人员'));
      assert.ok(triage.summary.startsWith('## 客服运营 · 工单派单与分流'));
      assert.ok(triage.summary.includes('无需人工复核'));
    });
    check('请求打到了正确端点：认证、协议字段齐全且不泄漏本地展示字段', () => {
      assert.equal(received.length, 1);
      assert.equal(received[0].url, `/v1/systemone`);
      assert.equal(received[0].headers.authorization, 'Bearer test-key');
      assert.equal(received[0].body.model, 'u2-decision');
      assert.equal(received[0].body.state, '订单支付后超过 24 小时仍未到账，用户无法继续使用核心服务，要求立即处理。');
      assert.equal(received[0].body.questions.department.type, 'choice');
      assert.equal(received[0].body.questions.department.criteria.technical, '产品故障、集成和技术缺陷类问题');
      assert.ok(!('label' in received[0].body.questions.department), 'label 是本地展示字段，不应发给 API');
      assert.ok(!('criteria' in received[0].body.questions.escalate), 'noul 问题不应携带 criteria');
      assert.equal(received[0].body.questions.severity.criteria.length, 4);
    });

    // 回归：畸形响应（score 缺字段 / score=null）不得被当成 0 分而捏造出等级标签，
    // 也不得顺着 severity 派生出凭空的 P4 优先级——那等于凭一个坏响应把工单降级。
    // 两者都必须触发 needs_human_review：高 confidence 不代表响应结构有效。
    // 放在端点断言之后：那条断言硬编码了 received.length === 1。
    for (const [variant, sentinel] of [
      ['缺 score 字段', 'mock:score-missing'],
      ['score = null', 'mock:score-null'],
    ]) {
      const bad = toolResult(
        await runScenario(client, { action: 'run', scenario: 'customer_service', state: sentinel })
      );
      check(`畸形 score（${variant}）判为无法判断，不捏造等级标签与优先级，且触发人工复核`, () => {
        assert.equal(bad.answers.severity.value, null, 'value 不应被兜底成 0');
        assert.equal(bad.answers.severity.level, null, 'level 不得回退到 legend[0]');
        assert.equal(bad.decision.severity, null, 'decision 不得因 Number(null) 变成 0');
        assert.equal(bad.labels.severity, '无法判断');
        assert.equal(bad.derived.priority, undefined, '不得派生凭空的优先级');
        assert.ok(bad.summary.includes('无法判断'), '逐题明细必须显示无法判断');
        assert.ok(!bad.summary.includes('轻微问题，不影响功能'), '摘要里不得出现捏造的等级标签');
        assert.ok(!bad.recommendation.includes('P4'), '建议里不得出现凭空的优先级');
        assert.equal(bad.needs_human_review, true, '判定值缺失必须转人工');
        assert.deepEqual(bad.low_confidence_questions, ['severity']);
        assert.ok(bad.summary.includes('需要人工复核'), '摘要必须提示需复核');
      });
    }

    // 同类缺口：noul 完全没有概率字段时，confidence 恒为 null，原先会静默按「无需复核」放行
    const badNoul = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:noul-missing' })
    );
    check('畸形 noul（无概率字段）判为无法判断并触发人工复核', () => {
      assert.equal(badNoul.answers.escalate.probability, null);
      assert.equal(badNoul.answers.escalate.confidence, null);
      assert.equal(badNoul.decision.escalate, null);
      assert.equal(badNoul.labels.escalate, '无法判断');
      assert.equal(badNoul.needs_human_review, true);
      assert.deepEqual(badNoul.low_confidence_questions, ['escalate']);
    });

    // 同类缺口的显式 null 形态：Number(null) === 0，速览与逐题行若走 Number() 强转会把
    // 「模型没给概率」捏造成置信度 1.0 的「否」（answers 视图早有 typeof 守卫，三个视图曾互相矛盾）
    const noulNull = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:noul-null' })
    );
    check('畸形 noul（noul = null）不得捏造「否」，速览/逐题/明细三视图一致判无法判断', () => {
      assert.equal(noulNull.answers.escalate.probability, null, 'answers 视图概率必须为 null');
      assert.equal(noulNull.decision.escalate, null, 'decision 不得因 Number(null) 变成 false');
      assert.equal(noulNull.labels.escalate, '无法判断', 'label 不得捏造成「否」');
      assert.ok(!('escalate' in noulNull.confidences), 'confidences 不得出现捏造的 1.0');
      assert.ok(noulNull.summary.includes('无法判断'), '逐题行必须显示无法判断');
      assert.ok(!noulNull.summary.includes('否（0.0%）'), '逐题行不得渲染捏造的「否（0.0%）」');
      assert.equal(noulNull.needs_human_review, true);
      assert.deepEqual(noulNull.low_confidence_questions, ['escalate']);
    });

    // 同类缺口：置信度本身的垃圾值（Infinity / 非数字回退）必须收敛为 null——
    // answers 与 confidences 两个视图不得一个丢弃一个放行；置信度缺失与低于阈值
    // 同等对待（无法证明可信的判定不自动放行），三题全部转人工。
    const garbage = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:confidence-garbage' })
    );
    check('畸形置信度（Infinity/非数字回退）收敛为 null，三题全部转人工且视图一致', () => {
      assert.equal(garbage.answers.escalate.probability, null, 'noul 概率 Infinity 必须收敛为 null');
      assert.equal(garbage.answers.escalate.confidence, null);
      assert.equal(garbage.decision.escalate, null);
      assert.equal(garbage.labels.escalate, '无法判断');
      assert.equal(garbage.answers.department.confidence, null, 'probabilities 回退的非数字字符串必须收敛为 null');
      assert.equal(garbage.decision.department, 'billing', 'choice 判定值本身有效时不受影响');
      assert.equal(garbage.answers.severity.confidence, null, 'score 的 Infinity 置信度必须收敛为 null');
      assert.ok(!('department' in garbage.confidences) && !('severity' in garbage.confidences) && !('escalate' in garbage.confidences), 'answers 与 confidences 两个视图必须一致');
      assert.equal(garbage.needs_human_review, true, '置信度缺失的三题必须全部转人工');
      assert.deepEqual(garbage.low_confidence_questions, ['department', 'severity', 'escalate']);
    });

    // 同一类缺口的另两种形态：choice 幻觉出判据表里没有的选项（高 confidence 也必须转人工）、
    // score 越界（4 级量表返回 7，会被 deriveFields 钳成最高档 P1）。
    const hallucinated = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:choice-hallucinated' })
    );
    check('choice 幻觉出判据表外的选项时转人工，不把不存在的选项当判定', () => {
      assert.equal(hallucinated.answers.department.value, 'vip');
      assert.equal(hallucinated.needs_human_review, true, '幻觉选项必须转人工');
      assert.deepEqual(hallucinated.low_confidence_questions, ['department']);
    });

    // 同类的隐蔽形态：选项名取自原型链。用 `value in criteria` 判合法时
    // "constructor" / "toString" / "hasOwnProperty" 都会被当成合法选项放行（2026-10-28 修复）。
    const prototypeName = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:choice-prototype' })
    );
    check('choice 返回原型链上的名字（constructor）同样转人工，不因 in 的继承匹配被放行', () => {
      assert.equal(prototypeName.answers.department.value, 'constructor');
      assert.equal(prototypeName.needs_human_review, true, '原型链名字不是判据表内的选项，必须转人工');
      assert.ok(prototypeName.low_confidence_questions.includes('department'));
    });

    const outOfRange = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:score-out-of-range' })
    );
    check('score 越界时转人工，并暴露原始分值而不静默钳到最高档', () => {
      assert.equal(outOfRange.answers.severity.value, 7);
      assert.equal(outOfRange.needs_human_review, true, '越界分值必须转人工');
      assert.deepEqual(outOfRange.low_confidence_questions, ['severity']);
      assert.ok(outOfRange.summary.includes('需要人工复核'), '摘要必须提示需复核');
    });

    // 响应缺 type 时，三个视图（answers / labels / summary）必须一致，不能 summary 打印原始 JSON
    const typeLess = toolResult(
      await runScenario(client, {
        action: 'run',
        scenario: 'customer_service',
        state: 'mock:type-missing',
      })
    );
    check('响应缺 type 时 summary 仍按问题定义渲染，与 answers/labels 一致', () => {
      assert.equal(typeLess.answers.severity.type, 'score');
      assert.equal(typeLess.answers.severity.value, 2.001);
      // 响应不带 legend 时 answers.level 仍须有值，与 labels 一致
      assert.equal(typeLess.answers.severity.level, '核心功能不可用，没有替代方案');
      assert.ok(typeLess.summary.includes('核心功能不可用，没有替代方案'), 'summary 应走 score 分支');
      assert.ok(!typeLess.summary.includes('"score"'), 'summary 不得退化成原始 JSON');
    });

    // 回归：响应回显的 type 与所问题型错乱时，必须按问题定义取值并转人工，
    // 不得出现「decision 显示无法判断、needs_human_review 却为 false」的视图矛盾
    const mismatch = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:type-mismatch' })
    );
    check('type 错乱的答案按问题定义取空并转人工，视图一致', () => {
      assert.equal(mismatch.answers.department.type, 'choice', '归一化题型必须以问题定义为准');
      assert.equal(mismatch.answers.department.value, null, 'noul 形态的答案按 choice 取值必须取空');
      assert.equal(mismatch.decision.department, null);
      assert.equal(mismatch.labels.department, '无法判断');
      assert.equal(mismatch.needs_human_review, true, '高 confidence 的错乱答案必须转人工');
      assert.deepEqual(mismatch.low_confidence_questions, ['department']);
    });

    const aliasRun = toolResult(await runScenario(client, { action: 'run', scenario: '工单分流', state: '简单咨询类工单' }));
    check('场景支持中文别名查找', () => {
      assert.equal(aliasRun.ok, true);
      assert.equal(aliasRun.scenario, 'customer_service');
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: 'VIP 用户投诉扣费异常',
      params: { department: { criteria: { vip: 'VIP 专属通道', general: '普通通道' } } },
    });
    check('params.criteria 整体替换选项', () => {
      const last = received[received.length - 1];
      assert.deepEqual(last.body.questions.department.criteria, { vip: 'VIP 专属通道', general: '普通通道' });
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { department: { addCriteria: { vip: 'VIP 专属通道' } } },
    });
    check('params.addCriteria 在默认选项上追加、不丢默认项', () => {
      const last = received[received.length - 1];
      assert.deepEqual(
        Object.keys(last.body.questions.department.criteria).sort(),
        ['account', 'billing', 'other', 'product', 'technical', 'vip']
      );
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { severity: { instructions: '这个问题对业务的严重程度有多高？' } },
    });
    check('params.instructions 覆盖问题描述', () => {
      const last = received[received.length - 1];
      assert.equal(last.body.questions.severity.instructions, '这个问题对业务的严重程度有多高？');
      assert.equal(last.body.questions.severity.criteria.length, 4);
    });

    const badScore = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { severity: { criteria: ['只有一级'] } },
    });
    check('score 判据覆盖少于 2 级被拒绝', () => {
      assert.equal(badScore.result.isError, true);
      assert.match(badScore.result.content[0].text, /至少需要 2 个等级/);
    });

    // 边界收紧：criteria/addCriteria 的值为 null/undefined 时直接校验失败（报错指明问题 id 与键名），
    // 不再被 String 化成字面 "null"/"undefined" 混过非空校验。choice 与 score、applyParams 与
    // decide / 场景加载各路径对称生效。
    const nullCriteriaParam = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { department: { criteria: { vip: null, general: '普通通道' } } },
    });
    check('params.criteria 值为 null 被拒绝并指明问题 id 与键名', () => {
      assert.equal(nullCriteriaParam.result.isError, true);
      assert.match(nullCriteriaParam.result.content[0].text, /params\.department\.criteria/);
      assert.match(nullCriteriaParam.result.content[0].text, /vip/);
      assert.match(nullCriteriaParam.result.content[0].text, /null/);
    });

    const nullAddCriteria = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { department: { addCriteria: { vip: null } } },
    });
    check('params.addCriteria 值为 null 被拒绝并指明问题 id 与键名', () => {
      assert.equal(nullAddCriteria.result.isError, true);
      assert.match(nullAddCriteria.result.content[0].text, /params\.department\.addCriteria/);
      assert.match(nullAddCriteria.result.content[0].text, /vip/);
      assert.match(nullAddCriteria.result.content[0].text, /null/);
    });

    const nullLevelParam = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { severity: { criteria: ['低', null] } },
    });
    check('params 的 score criteria 值为 null 被拒绝并指明问题 id 与等级下标', () => {
      assert.equal(nullLevelParam.result.isError, true);
      assert.match(nullLevelParam.result.content[0].text, /params\.severity\.criteria/);
      assert.match(nullLevelParam.result.content[0].text, /第 1 级/);
      assert.match(nullLevelParam.result.content[0].text, /null/);
    });

    const nullCriteriaDecide = await decide(client, {
      state: '边界收紧探测',
      questions: { q: { type: 'choice', instructions: '?', criteria: { vip: null, general: '普通通道' } } },
    });
    check('decide 的 criteria 值为 null 被拒绝并指明键名', () => {
      assert.equal(nullCriteriaDecide.result.isError, true);
      assert.match(nullCriteriaDecide.result.content[0].text, /criteria/);
      assert.match(nullCriteriaDecide.result.content[0].text, /vip/);
      assert.match(nullCriteriaDecide.result.content[0].text, /null/);
    });

    const badQid = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { nope: { instructions: '?' } },
    });
    check('params 指向未知问题 id 时给出可覆盖清单', () => {
      assert.equal(badQid.result.isError, true);
      assert.match(badQid.result.content[0].text, /未知问题 id "nope"/);
      assert.match(badQid.result.content[0].text, /department、severity、escalate/);
    });

    const devRun = toolResult(
      await runScenario(client, {
        action: 'run',
        scenario: 'software_dev',
        state: '修复登录页在 Safari 下无法提交表单的问题',
      })
    );
    check('software_dev 场景端到端（动态答案归一化 + 派生 effort）', () => {
      assert.equal(devRun.ok, true);
      assert.equal(devRun.decision.task_type, 'bugfix');
      assert.equal(devRun.labels.task_type, '修复缺陷或报错');
      assert.equal(devRun.decision.complexity, 0);
      assert.equal(devRun.derived.effort, 'S');
      assert.equal(devRun.decision.needs_context, true);
      assert.match(devRun.recommendation, /先检索代码库/);
      assert.equal(devRun.needs_human_review, false);
    });

    const tfRun = toolResult(await runScenario(client, { action: 'run', scenario: '测试失败', state: 'e2e 下单测试在 CI 里偶发超时' }));
    check('test_failure 新场景端到端（别名 + 动态答案 + 派生 block）', () => {
      assert.equal(tfRun.ok, true);
      assert.equal(tfRun.scenario, 'test_failure');
      assert.equal(tfRun.decision.cause, 'code');
      assert.equal(tfRun.derived.block, '不阻塞');
      assert.match(tfRun.recommendation, /先原样重跑一次确认稳定性/);
    });

    const secRun = toolResult(await runScenario(client, { action: 'run', scenario: 'security_triage', state: '凌晨 3 点数据库导出接口异常告警' }));
    check('security_triage 场景默认阈值 0.8 生效（派生 verdict_label）', () => {
      assert.equal(secRun.ok, true);
      assert.equal(secRun.confidence_threshold, 0.8);
      assert.equal(secRun.derived.verdict_label, '真实威胁');
    });

    const secOverride = toolResult(
      await runScenario(client, {
        action: 'run',
        scenario: 'security_triage',
        state: '支付网关登录接口 SQL 注入告警',
        confidenceThreshold: 0.95,
      })
    );
    check('调用参数阈值覆盖场景默认并触发复核', () => {
      assert.equal(secOverride.confidence_threshold, 0.95);
      assert.equal(secOverride.needs_human_review, true);
      assert.ok(secOverride.low_confidence_questions.length > 0);
    });

    const brief = toolResult(
      await decide(client, { state: '精简模式探测', questions: { q: { type: 'noul', instructions: '是吗？' } }, format: 'brief' })
    );
    check('format=brief 只返回精简结果（无逐题明细/摘要/原始响应）', () => {
      assert.equal(brief.ok, true);
      for (const key of ['answers', 'raw', 'summary', 'meta']) {
        assert.ok(!(key in brief), `brief 不应包含 ${key}`);
      }
      assert.equal(brief.decision.q, true);
      assert.ok(brief.recommendation === '', '无模板时 recommendation 为空串');
    });

    const badFormat = await decide(client, { state: '非法格式探测', questions: { q: { type: 'noul', instructions: '是吗？' } }, format: 'compact' });
    check('非法 format 被拒绝', () => {
      assert.equal(badFormat.result.isError, true);
      assert.match(badFormat.result.content[0].text, /format 必须是/);
    });

    const emptyFormat = toolResult(
      await decide(client, { state: '空格式探测', questions: { q: { type: 'noul', instructions: '是吗？' } }, format: '' })
    );
    check('format 空串视为未配置（回退 full，与阈值同一套空值约定）', () => {
      assert.equal(emptyFormat.ok, true);
      assert.ok('answers' in emptyFormat, '回退 full 应含逐题明细');
    });

    await decide(client, { state: '缓存探测', questions: { q: { type: 'noul', instructions: '是吗？' } } });
    const afterFirst = received.length;
    const cachedRun = toolResult(
      await decide(client, { state: '缓存探测', questions: { q: { type: 'noul', instructions: '是吗？' } } })
    );
    check('相同输入命中本地缓存（cached 标记且不再发请求）', () => {
      assert.equal(received.length, afterFirst, '缓存命中不应产生新的远端请求');
      assert.equal(cachedRun.cached, true);
    });
    const cacheOff = toolResult(
      await decide(client, { state: '缓存探测二号', questions: { q: { type: 'noul', instructions: '是吗？' } } })
    );
    check('不同输入不命中缓存（cached 为 false）', () => {
      assert.equal(cacheOff.cached, false);
      assert.equal(received.length, afterFirst + 1);
    });

    const batch = toolResult(
      await runScenario(client, {
        action: 'batch',
        scenario: 'customer_service',
        states: ['批量工单一：支付失败', '批量工单二：功能咨询', '批量工单三：无法登录'],
      })
    );
    check('action=batch 批量判定（逐条归一化 + 精简形状 + 汇总）', () => {
      assert.equal(batch.ok, true);
      assert.equal(batch.count, 3);
      assert.equal(batch.failed, 0);
      assert.equal(batch.results[0].decision.department, 'billing');
      assert.equal(batch.results[0].index, 0);
      assert.ok(typeof batch.results[0].recommendation === 'string');
      assert.ok(!('raw' in batch.results[0]) && !('answers' in batch.results[0]), '批量条目必须是精简形状');
      assert.ok(batch.summary.includes('批量判定'));
    });

    const batchTooFew = await runScenario(client, { action: 'batch', scenario: 'customer_service', states: ['只有一条'] });
    check('batch 少于 2 条被拒绝', () => {
      assert.equal(batchTooFew.result.isError, true);
      assert.match(batchTooFew.result.content[0].text, /至少 2 个元素/);
    });

    const batchMixed = toolResult(
      await runScenario(client, {
        action: 'batch',
        scenario: 'customer_service',
        states: ['批量混排一', 'mock:permission-error', '批量混排二'],
      })
    );
    check('batch 单条失败不中断整体（逐条标注错误）', () => {
      assert.equal(batchMixed.failed, 1);
      assert.equal(batchMixed.results[0].ok, true);
      assert.equal(batchMixed.results[1].ok, false);
      assert.match(batchMixed.results[1].error, /HTTP 404/);
      assert.equal(batchMixed.results[2].ok, true);
    });

    // 预算耗尽分支：把整批预算注入成 0ms，所有条目必然走 budget_exhausted 标记路径——
    // 无需 mock 时钟或长睡眠即可确定性触发；已完成结果照常返回的结构契约一并验证。
    const budgetClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      SYSTEMONE_PLUGIN_BATCH_BUDGET_MS: '0',
    });
    try {
      const batchExhausted = toolResult(
        await runScenario(budgetClient, {
          action: 'batch',
          scenario: 'customer_service',
          states: ['预算工单一', '预算工单二', '预算工单三'],
        })
      );
      check('batch 预算耗尽：逐条标 budget_exhausted 并提示分批，整体仍 ok 返回', () => {
        assert.equal(batchExhausted.ok, true);
        assert.equal(batchExhausted.count, 3);
        assert.equal(batchExhausted.failed, 3);
        assert.equal(batchExhausted.budget_exhausted, true);
        for (const r of batchExhausted.results) {
          assert.equal(r.ok, false);
          assert.equal(r.budget_exhausted, true, 'budget_exhausted 是结构化标记，不依赖 error 文案');
          assert.match(r.error, /批量总预算/);
          assert.match(r.error, /分批/);
        }
        assert.match(batchExhausted.summary, /3 条失败/);
        assert.match(batchExhausted.summary, /批量预算/);
      });
    } finally {
      budgetClient.close();
    }

    const statsOff = await runScenario(client, { action: 'stats' });
    check('未启用审计日志时 stats 报错并给配置指引', () => {
      assert.equal(statsOff.result.isError, true);
      assert.match(statsOff.result.content[0].text, /SYSTEMONE_LOG_FILE/);
    });

    const unknown = await runScenario(client, { action: 'run', scenario: 'nope', state: 'x' });
    check('未知场景报错并附可用场景列表', () => {
      assert.equal(unknown.result.isError, true);
      assert.match(unknown.result.content[0].text, /未知场景 "nope"/);
      assert.match(unknown.result.content[0].text, /software_dev/);
    });

    const noState = await runScenario(client, { action: 'run', scenario: 'customer_service' });
    check('run 缺少 state 被拒绝', () => {
      assert.equal(noState.result.isError, true);
      assert.match(noState.result.content[0].text, /state/);
    });

    const noScenario = await runScenario(client, { action: 'describe' });
    check('describe 缺少 scenario 被拒绝并列出可用场景', () => {
      assert.equal(noScenario.result.isError, true);
      assert.match(noScenario.result.content[0].text, /scenario/);
      assert.match(noScenario.result.content[0].text, /customer_service/);
    });

    const d = toolResult(
      await decide(client, {
        state: '把这份 50 页 PDF 的中文合同翻译成英文',
        questions: {
          model: { type: 'choice', instructions: '应使用哪个模型？', criteria: { flash: '快且便宜', pro: '质量优先' } },
        },
      })
    );
    check('systemone_decide 通用工具走通（answers 按请求 qid 对齐 + summary）', () => {
      assert.equal(d.ok, true);
      assert.equal(d.scenario, null);
      assert.equal(d.answers.model.value, 'flash');
      assert.equal(d.answers.model.present, true);
      approx(d.answers.model.confidence, 0.9);
      assert.equal(d.decision.model, 'flash');
      assert.ok(d.summary.includes('SystemOne 通用决策'));
    });

    // confidenceThreshold 的空值陷阱：Number(null) / Number('') 都得 0，
    // 而 0 落在合法区间内，会把复核阈值静默关掉——空值必须回退默认 0.7。
    // 显式传 0 仍是合法意图（调用方主动关闭阈值判定），两者必须区分开。
    // [] / false 不是「未配置」而是畸形值：Number([]) 与 Number(false) 同样得 0，
    // 一律报错而不是兜底。
    const thresholdOf_ = async (confidenceThreshold) => {
      const r = await decide(client, {
        state: '阈值探测',
        questions: { q1: { type: 'noul', instructions: '是吗？' } },
        confidenceThreshold,
      });
      return r.result.isError ? { error: r.result.content[0].text } : toolResult(r).confidence_threshold;
    };
    const emptyThresholds = await Promise.all([undefined, null, '', '   '].map(thresholdOf_));
    check('confidenceThreshold 空值（undefined/null/空串/纯空白）回退默认 0.7', () => {
      assert.deepEqual(emptyThresholds, [0.7, 0.7, 0.7, 0.7]);
    });
    const explicitThresholds = await Promise.all([0, 0.5, 1, '0.8'].map(thresholdOf_));
    check('confidenceThreshold 显式值（含 0 与数字字符串）照原样生效', () => {
      assert.deepEqual(explicitThresholds, [0, 0.5, 1, 0.8]);
    });
    const badThresholds = await Promise.all([1.5, -0.1, 'abc', true, [], false, {}].map(thresholdOf_));
    check('confidenceThreshold 非法值（含 [] / false）返回 isError 而非静默兜底', () => {
      assert.equal(badThresholds.length, 7);
      for (const r of badThresholds) {
        assert.match(r.error, /confidenceThreshold 必须是/, `应报错，实际: ${JSON.stringify(r)}`);
      }
    });

    const bad = await decide(client, { state: 'x', questions: { q1: { type: 'essay', instructions: '?' } } });
    check('非法题型返回 isError 与明确原因', () => {
      assert.equal(bad.result.isError, true);
      assert.match(bad.result.content[0].text, /type 必须/);
    });

    const huge = await decide(client, { state: 'x'.repeat(100_001), questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('state 超过 100K 字符上限被拒绝（校验先行，不发请求）', () => {
      assert.equal(huge.result.isError, true);
      assert.match(huge.result.content[0].text, /state 过大/);
    });
    // 注：循环引用的 state 在任何 JSON-RPC 客户端序列化时就会失败，到不了服务器，无需防御

    // decide 入参上限（与场景库校验口径对齐）：超量问题 / 超长 instructions 在校验层拒绝，不发请求
    const tooManyQuestions = await decide(client, {
      state: '超量探测',
      questions: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`q${i}`, { type: 'noul', instructions: '是吗？' }])
      ),
    });
    check('decide 超过 16 个问题被拒绝（与场景库 1~16 对齐）', () => {
      assert.equal(tooManyQuestions.result.isError, true);
      assert.match(tooManyQuestions.result.content[0].text, /最多 16 个问题/);
    });
    const longInstructions = await decide(client, {
      state: '超长说明探测',
      questions: { q1: { type: 'noul', instructions: '是'.repeat(10_001) } },
    });
    check('decide 单题 instructions 超过 10000 字符被拒绝', () => {
      assert.equal(longInstructions.result.isError, true);
      assert.match(longInstructions.result.content[0].text, /instructions 过长/);
    });

    // JSON-RPC 加严：jsonrpc 字段非法 / id 类型非法的消息直接忽略，不响应也不崩
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '1.0', id: 987001, method: 'ping' })}\n`);
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' })}\n`);
    await new Promise((r) => setTimeout(r, 150));
    const pongAfterBad = await client.call('ping', {});
    check('JSON-RPC 加严：非法 jsonrpc 版本 / 非法 id 类型的消息被忽略，服务器仍存活', () => {
      assert.deepEqual(pongAfterBad.result, {});
      assert.ok(!client.seen.some((m) => m.id === 987001), 'jsonrpc=1.0 的消息不应收到响应');
      assert.ok(!client.seen.some((m) => m.id && typeof m.id === 'object'), '对象 id 的消息不应收到响应');
    });

    const perm = await decide(client, { state: 'mock:permission-error', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('模型无权限错误附带排查提示', () => {
      assert.equal(perm.result.isError, true);
      assert.match(perm.result.content[0].text, /HTTP 404/);
      assert.match(perm.result.content[0].text, /模型权限/);
      assert.match(perm.result.content[0].text, /环境变量快照/);
    });

    // server 侧响应处理错误分支（此前零覆盖）：HTTP 非 2xx 的「无提示」路径 + 200 的两类坏 body
    const serverError = await decide(client, { state: 'mock:server-error', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('普通 5xx 报 HTTP 状态错误且不带权限提示', () => {
      assert.equal(serverError.result.isError, true);
      assert.match(serverError.result.content[0].text, /HTTP 500/);
      assert.match(serverError.result.content[0].text, /internal error/);
      assert.ok(!/模型权限/.test(serverError.result.content[0].text), '正文无 permission 字样时不得误附权限排查提示');
    });
    const nonJson = await decide(client, { state: 'mock:non-json', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('HTTP 200 但响应体非 JSON 报可读错误', () => {
      assert.equal(nonJson.result.isError, true);
      assert.match(nonJson.result.content[0].text, /不是合法 JSON/);
    });
    const noAnswers = await decide(client, { state: 'mock:no-answers', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('HTTP 200 但缺 answers 字段报可读错误', () => {
      assert.equal(noAnswers.result.isError, true);
      assert.match(noAnswers.result.content[0].text, /缺少 answers 字段/);
    });

    // 超时缺口回归：服务端发完响应头后挂起不发 body——旧实现在收到响应头时就清掉 timer，
    // await res.text() 无超时保护，tools/call 会无限挂起。body 读取必须同受 timer 保护，
    // 超时后抛可区分的「响应体读取超时」错误，且不能等满宿主超时。
    const hanging = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // flushHeaders 必须显式调用：writeHead 只缓存头部，不 flush 会攒到首次写 body 才发出，
      // fetch 就还停在等响应头阶段，触发的是「请求超时」而非要回归的「响应体读取超时」分支
      res.flushHeaders();
      // 有意不 res.end()：body 永不到达
    });
    await new Promise((r) => hanging.listen(0, '127.0.0.1', r));
    const timeoutClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${hanging.address().port}/v1`,
      SYSTEMONE_PLUGIN_TIMEOUT_MS: '500',
    });
    try {
      const started = Date.now();
      const hung = await timeoutClient.call('tools/call', {
        name: 'systemone_decide',
        arguments: { state: '响应体挂起探测', questions: { q1: { type: 'noul', instructions: '是吗？' } } },
      });
      check('响应头发完但 body 挂起：读取阶段受 timer 保护并抛可区分错误', () => {
        assert.equal(hung.result.isError, true);
        assert.match(hung.result.content[0].text, /响应体读取超时（500ms）/);
        assert.ok(Date.now() - started < 10_000, `应在远小于宿主超时的时间内返回，实际 ${Date.now() - started}ms`);
      });
    } finally {
      timeoutClient.close();
      hanging.close();
    }
  } finally {
    client.close();
  }

  // 自定义场景：设置页注入 SYSTEMONE_PLUGIN_SCENARIOS（新增 legal_review + 覆盖 customer_service + 一条非法条目）
  const customScenarios = JSON.stringify([
    {
      id: 'legal_review',
      title: '法务 · 合同风险预审',
      description: '判断合同风险等级与是否需要法务介入。',
      aliases: ['法务', '合同'],
      questions: {
        risk: { type: 'score', label: '风险等级', instructions: '这份合同的风险有多高？', criteria: ['无风险', '低风险', '中风险', '高风险'] },
        clause: { type: 'choice', label: '问题条款', instructions: '主要问题出在哪类条款？', criteria: { none: '无问题条款', liability: '责任与赔偿条款', payment: '付款与结算条款', other: '其他' } },
        lawyer: { type: 'noul', label: '法务介入', instructions: '是否需要法务介入？' },
      },
      recommendation: '风险等级 {risk}。{lawyer?需法务介入|可业务自审}',
    },
    {
      id: 'customer_service',
      title: '客服运营 · 覆盖版',
      questions: {
        department: { type: 'choice', label: '受理组', instructions: '该工单应分派给哪个组？', criteria: { vip: 'VIP 专属通道', general: '普通通道' } },
        severity: { type: 'score', label: '严重程度', instructions: '严重程度是？', criteria: ['低', '高'] },
        escalate: { type: 'noul', label: '升级', instructions: '是否升级？' },
      },
    },
    { id: 'bad_one', title: '坏场景', questions: { q1: { type: 'essay', instructions: '?' } } },
    // 边界收紧：criteria 值为 null/undefined 的场景在校验层整条跳过（choice 选项与 score 等级对称），
    // 不再有机会被字符串化成字面 "null"/"undefined" 的选项或等级
    { id: 'bad_null_option', title: '空选项值', questions: { q1: { type: 'choice', instructions: '?', criteria: { vip: null, general: '普通通道' } } } },
    { id: 'bad_null_level', title: '空等级值', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', null] } } },
    // 校验器与规范化器对称：aliases 混入非字符串、derive 缺 values/map，都在校验层拦截整条跳过，
    // 不允许"校验放行、normalizeScenario/deriveFields 运行时静默丢弃"
    { id: 'bad_aliases', title: '坏别名', aliases: ['合规别名', 123], questions: { q1: { type: 'noul', instructions: '?' } } },
    { id: 'bad_derive', title: '坏派生', questions: { q1: { type: 'noul', instructions: '?' } }, derive: { x: { question: 'q1' } } },
    // derive 与 questions 的对应关系：qid 必须存在、values 只配 score / map 只配 choice、
    // values 长度须与分级数一致、空数组会让模板条件恒真——全部在校验层拦截
    { id: 'bad_qid', title: '坏派生 qid', questions: { q1: { type: 'noul', instructions: '?' } }, derive: { x: { question: 'ghost', values: ['a'] } } },
    { id: 'bad_values_type', title: 'values 挂在 choice 上', questions: { q1: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } } }, derive: { x: { question: 'q1', values: ['低', '高'] } } },
    { id: 'bad_map_type', title: 'map 挂在 score 上', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', '高'] } }, derive: { x: { question: 'q1', map: { 0: '低' } } } },
    { id: 'bad_values_len', title: 'values 长度不匹配', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', '高'] } }, derive: { x: { question: 'q1', values: ['P1', 'P2', 'P3'] } } },
    { id: 'bad_values_empty', title: 'values 空数组', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', '高'] } }, derive: { x: { question: 'q1', values: [] } } },
    // 模板增强语法：then-only 条件、AND 条件、花括号转义
    {
      id: 'tmpl_test',
      title: '模板语法测试',
      questions: {
        clause: { type: 'choice', label: '问题条款', instructions: '主要问题出在哪类条款？', criteria: { none: '无问题条款', liability: '责任条款' } },
        risk: { type: 'score', label: '风险等级', instructions: '这份合同的风险有多高？', criteria: ['无风险', '高风险'] },
        lawyer: { type: 'noul', label: '法务介入', instructions: '是否需要法务介入？' },
      },
      recommendation: '条款 {clause}，{lawyer?需法务|自审}，{risk&lawyer?双真|非双真}，\\{字面\\}',
    },
  ]);
  const customClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_PLUGIN_SCENARIOS: customScenarios,
  });
  try {
    const customList = toolResult(await runScenario(customClient, { action: 'list' }));
    check('自定义场景：新增生效、同 id 覆盖内置、非法条目被跳过', () => {
      assert.equal(customList.count, 17); // 15 内置 + legal_review + tmpl_test；customer_service 原位覆盖；bad_* 跳过
      const byId = new Map(customList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('legal_review').source, 'custom');
      assert.equal(byId.get('customer_service').source, 'custom');
      assert.equal(byId.get('software_dev').source, 'builtin');
      assert.ok(!byId.has('bad_one'));
      assert.ok(!byId.has('bad_aliases'));
      assert.ok(!byId.has('bad_derive'));
      // derive 与 questions 不对应（qid 不存在 / 题型不配 / 长度不符 / 空数组）一律整条跳过，
      // 不允许「校验放行、运行时静默产出空建议或恒真条件」
      for (const id of ['bad_qid', 'bad_values_type', 'bad_map_type', 'bad_values_len', 'bad_values_empty', 'bad_null_option', 'bad_null_level']) {
        assert.ok(!byId.has(id), `${id} 应被校验器跳过，实际混进了场景库`);
      }
      assert.ok(customList.summary.includes('（自定义）'));
    });

    const legalRun = toolResult(await runScenario(customClient, { action: 'run', scenario: '法务', state: '甲方免责条款过于宽泛的采购合同' }));
    check('自定义场景可运行（含别名查找与建议模板渲染）', () => {
      assert.equal(legalRun.ok, true);
      assert.equal(legalRun.scenario, 'legal_review');
      assert.deepEqual(legalRun.decision, { risk: 0, clause: 'none', lawyer: true });
      assert.equal(legalRun.labels.clause, '无问题条款');
      assert.equal(legalRun.recommendation, '风险等级 无风险。需法务介入');
    });

    const tmplRun = toolResult(await runScenario(customClient, { action: 'run', scenario: 'tmpl_test', state: '模板夹具合同' }));
    check('模板增强语法：then-only / AND 条件 / 花括号转义', () => {
      assert.equal(tmplRun.ok, true);
      // mock 动态答案：clause=none（falsy 哨兵）、risk=0（falsy）、lawyer=true
      assert.equal(tmplRun.recommendation, '条款 无问题条款，需法务，非双真，{字面}');
    });

    await runScenario(customClient, { action: 'run', scenario: 'customer_service', state: 'VIP 用户投诉' });
    check('同 id 覆盖后 run 使用覆盖判据', () => {
      const last = received[received.length - 1];
      assert.deepEqual(last.body.questions.department.criteria, { vip: 'VIP 专属通道', general: '普通通道' });
      assert.equal(last.body.questions.severity.criteria.length, 2);
    });
  } finally {
    customClient.close();
  }

  // 坏 JSON：解析失败时回退纯内置场景库，不致命
  const brokenClient = new McpClient({ SYSTEMONE_PLUGIN_SCENARIOS: '{"oops' });
  try {
    const brokenList = toolResult(await runScenario(brokenClient, { action: 'list' }));
    check('自定义场景 JSON 解析失败时回退内置场景库', () => {
      assert.equal(brokenList.count, 15);
      assert.equal(brokenList.scenarios.find((s) => s.id === 'customer_service').source, 'builtin');
    });
  } finally {
    brokenClient.close();
  }

  // 审计日志 + stats：专用 client 把决策逐条落盘到临时 JSONL
  const logFile = path.join(scratchRoot, 'decisions-audit.jsonl');
  const logClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_LOG_FILE: logFile,
  });
  try {
    await runScenario(logClient, { action: 'run', scenario: 'customer_service', state: '统计样本工单一' });
    await runScenario(logClient, { action: 'run', scenario: 'software_dev', state: '统计样本任务一' });
    await runScenario(logClient, { action: 'run', scenario: 'customer_service', state: '统计样本工单一' }); // 命中缓存，仍应落盘
    const stats = toolResult(await runScenario(logClient, { action: 'stats' }));
    check('action=stats 汇总审计日志（计数/复核率/缓存命中/延迟）', () => {
      assert.equal(stats.ok, true);
      assert.equal(stats.total, 3);
      assert.equal(stats.scenarios.customer_service.count, 2);
      assert.equal(stats.scenarios.customer_service.cached, 1);
      assert.equal(stats.scenarios.software_dev.count, 1);
      assert.equal(stats.cached, 1, '顶层 cached 应等于全部缓存命中数');
      assert.ok(stats.summary.includes('决策统计'));
    });
  } finally {
    logClient.close();
  }

  // 场景文件加载：SYSTEMONE_PLUGIN_SCENARIOS_FILE + 设置页 JSON 同 id 覆盖文件
  const scenarioFile = path.join(scratchRoot, 'team-scenarios.json');
  writeFileSync(
    scenarioFile,
    JSON.stringify([
      {
        id: 'team_gate',
        title: '团队发布门禁',
        description: '判断发布是否达标。',
        aliases: ['发布门禁'],
        questions: { ready: { type: 'noul', label: '是否达标', instructions: '是否达到发布标准？' } },
      },
      {
        id: 'customer_service',
        title: '客服 · 团队覆盖',
        questions: {
          department: { type: 'choice', label: '受理组', instructions: '该工单应分派给哪个组？', criteria: { team_a: '一组', team_b: '二组' } },
          severity: { type: 'score', label: '严重程度', instructions: '严重程度是？', criteria: ['低', '高'] },
          escalate: { type: 'noul', label: '升级', instructions: '是否升级？' },
        },
      },
    ])
  );
  const fileClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_PLUGIN_SCENARIOS_FILE: scenarioFile,
    SYSTEMONE_PLUGIN_SCENARIOS: JSON.stringify([
      {
        id: 'team_gate',
        title: '团队发布门禁 · 设置页覆盖',
        description: '覆盖文件里的版本。',
        questions: { ready: { type: 'noul', label: '是否达标', instructions: '是否达到发布标准？' } },
      },
    ]),
  });
  try {
    const fileList = toolResult(await runScenario(fileClient, { action: 'list' }));
    check('场景文件加载生效，设置页同 id 覆盖文件条目', () => {
      assert.equal(fileList.count, 16); // 15 内置 + team_gate（customer_service 原位覆盖）
      const byId = new Map(fileList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('team_gate').source, 'custom');
      assert.equal(byId.get('team_gate').title, '团队发布门禁 · 设置页覆盖');
      assert.equal(byId.get('customer_service').source, 'custom');
      assert.equal(byId.get('software_dev').source, 'builtin');
    });
  } finally {
    fileClient.close();
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
    // 缺 Key 报错是独立 client 产出的，不在上面 surfaces 里；它曾写着「重启 ZCode」，
    // 在其他三个宿主上是指示了一个不存在的动作，所以单独收一遍。
    check('缺 Key 报错文案不含宿主产品名或宿主专属界面概念', () => {
      assertHostNeutral([['缺 Key 报错', noKey.result.content[0].text]]);
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
      name: 'systemone_scenario',
      arguments: { action: 'run', scenario: 'customer_service', state: 'ui-config' },
    });
    const u = JSON.parse(ui.result.content[0].text);
    const last = received[received.length - 1];
    check('设置页变量优先于环境变量，留空项回退', () => {
      assert.equal(u.ok, true);
      assert.equal(last.url, '/v1/systemone');
      assert.equal(last.body.model, 'alt-decision');
    });

    // 端点共享文件：uiClient 是最后一个启动的服务进程，落盘内容应为其已解析配置
    // （设置页值胜出）；API Key 绝不落盘。
    const endpointFile = JSON.parse(readFileSync(path.join(runRoot, '.endpoint.json'), 'utf8'));
    check('启动时落盘已解析端点（设置页优先，不含 API Key）', () => {
      assert.deepEqual(Object.keys(endpointFile).sort(), ['baseUrl', 'model', 'timeoutMs']);
      assert.equal(endpointFile.baseUrl, `http://127.0.0.1:${port}/v1`);
      assert.equal(endpointFile.model, 'alt-decision');
      assert.equal(endpointFile.timeoutMs, 30000, 'PLUGIN_TIMEOUT_MS 留空应落盘默认值');
      assert.ok(!JSON.stringify(endpointFile).includes('test-key'), 'Key 不得出现在共享文件里');
    });
  } finally {
    uiClient.close();
  }

  // PLUGIN_DATA 存在时（Agent Plugins 规范提供的跨插件更新可写数据目录），
  // 端点共享文件应落在那里而不是插件根——插件更新后状态不丢，也不污染包目录。
  const dataDir = path.join(runRoot, 'plugin-data');
  const dataClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    PLUGIN_DATA: dataDir,
  });
  try {
    await dataClient.call('tools/call', {
      name: 'systemone_scenario',
      arguments: { action: 'run', scenario: 'customer_service', state: 'data-dir' },
    });
    check('PLUGIN_DATA 存在时端点共享文件落在该目录', () => {
      assert.ok(existsSync(path.join(dataDir, 'endpoint.json')), 'PLUGIN_DATA 下应有 endpoint.json');
      assert.ok(!existsSync(path.join(runRoot, '.endpoint.json')), '插件根不应再有 .endpoint.json');
    });
  } finally {
    dataClient.close();
    mock.close();
  }

  check('测试运行未污染仓库工作区（源插件目录无端点共享文件）', () => {
    assert.ok(!existsSync(path.join(pluginRoot, '.endpoint.json')));
    assert.ok(!existsSync(`${path.join(pluginRoot, '.endpoint.json')}.tmp`));
  });

  // 数据路径护栏（endpoint-config.rejectDataPath）：SYSTEMONE_LOG_FILE 过去未经校验就交给
  // writeFileSync 截断，设置项指错文件等于当场删掉用户数据。锁住五条拒绝与一条放行。
  check('数据路径护栏：相对路径 / 错扩展名 / 插件根内 / .git 内 / 控制字符均被拒，合规 .jsonl 放行', () => {
    assert.match(rejectDataPath('audit.jsonl', ['.jsonl']) || '', /绝对路径/, '相对路径应被拒（会写进插件安装目录）');
    assert.match(rejectDataPath(path.join(scratchRoot, 'notes.md'), ['.jsonl']) || '', /扩展名/, '非 .jsonl 应被拒');
    assert.match(rejectDataPath(path.join(pluginRoot, 'audit.jsonl'), ['.jsonl']) || '', /插件安装目录/, '插件根内应被拒');
    assert.match(rejectDataPath(path.join(scratchRoot, '.git', 'audit.jsonl'), ['.jsonl']) || '', /\.git/, '.git 内应被拒');
    assert.match(rejectDataPath(`${scratchRoot}\u0000audit.jsonl`, ['.jsonl']) || '', /控制字符/, '含 NUL 应被拒');
    assert.equal(rejectDataPath(path.join(scratchRoot, 'decisions-audit.jsonl'), ['.jsonl']), null, '合规路径不应被拒');
  });
  rmSync(runRoot, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });

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
