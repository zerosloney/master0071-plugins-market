// 冒烟测试：本地 mock SystemOne 端点 + 子进程 MCP 服务器端到端验证，不需要真实 API Key。
// 运行：node test/smoke.mjs（在插件根目录或任意位置均可，路径基于本文件解析）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, '..');
const serverPath = path.join(pluginRoot, 'mcp', 'server.mjs');

// 宿主产品名词表：从各宿主清单目录名派生（.zcode-plugin → zcode），新增宿主建了
// <name>-plugin/ 目录就自动纳入。匹配一律忽略大小写。
const HOST_TOKENS = readdirSync(pluginRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\..+-plugin$/.test(d.name))
  .map((d) => d.name.replace(/^\./, '').replace(/-plugin$/, ''));

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
    // 幻觉选项 / 越界分值：模型给出判据表里不存在的 choice，或超出量表范围的 score。
    // 两者 confidence 都很高，但前者会渲染成一个不存在的选项、后者会被 deriveFields
    // 钳成最高档（如 severity 7 → P1），都必须转人工，而不是当作合法判定放行。
    if (parsed.state === 'mock:choice-hallucinated' || parsed.state === 'mock:score-out-of-range') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (parsed.state === 'mock:choice-hallucinated' && q.type === 'choice') {
          answers[qid] = { type: 'choice', choice: 'vip', probabilities: { vip: 0.97 }, confidence: 0.97 };
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
    if (parsed.state === 'mock:score-missing' || parsed.state === 'mock:score-null' || parsed.state === 'mock:noul-missing') {
      // 每个 sentinel 只破坏它自己那道题，其余题保持正常——否则 low_confidence_questions
      // 会混进未预期的题目，断言就测不出「只标记坏题」这件事了
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (parsed.state === 'mock:noul-missing' && q.type === 'noul') {
          answers[qid] = { type: 'noul' };
        } else if (parsed.state !== 'mock:noul-missing' && q.type === 'score') {
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

const runScenario = (client, arguments_) =>
  client.call('tools/call', { name: 'systemone_scenario', arguments: arguments_ });
const decide = (client, arguments_) => client.call('tools/call', { name: 'systemone_decide', arguments: arguments_ });
const toolResult = (r) => JSON.parse(r.result.content[0].text);

// 共享载荷的「模型可见面」（工具描述、报错文案）不得指名某个宿主。同一份
// mcp/server.mjs 跑在 ZCode / ChatGPT Codex / CodeBuddy / omp 等多端，指名某一端才有的
// 东西在其他端是误导，而且不会报错、只静默失效。源代码注释不在此列：那里提宿主名
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

    const list = await client.call('tools/list', {});
    check('tools/list 只提供 2 个工具（控制 schema 开销）', () => {
      assert.deepEqual(
        list.result.tools.map((t) => t.name).sort(),
        ['systemone_decide', 'systemone_scenario']
      );
    });

    // 共享载荷的「模型可见面」——工具描述与报错文案——不得指名某个宿主。同一份
    // mcp/server.mjs 跑在 ZCode / ChatGPT Codex / CodeBuddy / omp 等多端，指名某一端才有的
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
      for (const expected of ['zcode', 'omp', 'codex', 'codebuddy']) {
        assert.ok(HOST_TOKENS.some((t) => t.toLowerCase() === expected), `词表缺 ${expected}：${HOST_TOKENS}`);
      }
    });
    check('共享载荷的模型可见面不含宿主产品名或宿主专属界面概念（工具描述 + 场景/参数报错）', () => {
      assertHostNeutral(surfaces);
    });

    const scenarioList = toolResult(await runScenario(client, { action: 'list' }));
    check('action=list 列出 11 个内置场景', () => {
      assert.equal(scenarioList.ok, true);
      assert.equal(scenarioList.count, 11);
      assert.deepEqual(
        scenarioList.scenarios.map((s) => s.id),
        [
          'customer_service', 'content_moderation', 'agent_routing', 'result_verification', 'sales_lead',
          'risk_control', 'recruiting', 'data_governance', 'education', 'requirements', 'software_dev',
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

    const perm = await decide(client, { state: 'mock:permission-error', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('模型无权限错误附带排查提示', () => {
      assert.equal(perm.result.isError, true);
      assert.match(perm.result.content[0].text, /HTTP 404/);
      assert.match(perm.result.content[0].text, /模型权限/);
      assert.match(perm.result.content[0].text, /环境变量快照/);
    });
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
  ]);
  const customClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_PLUGIN_SCENARIOS: customScenarios,
  });
  try {
    const customList = toolResult(await runScenario(customClient, { action: 'list' }));
    check('自定义场景：新增生效、同 id 覆盖内置、非法条目被跳过', () => {
      assert.equal(customList.count, 12); // 11 内置 + legal_review；customer_service 原位覆盖；bad_one 跳过
      const byId = new Map(customList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('legal_review').source, 'custom');
      assert.equal(byId.get('customer_service').source, 'custom');
      assert.equal(byId.get('software_dev').source, 'builtin');
      assert.ok(!byId.has('bad_one'));
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
      assert.equal(brokenList.count, 11);
      assert.equal(brokenList.scenarios.find((s) => s.id === 'customer_service').source, 'builtin');
    });
  } finally {
    brokenClient.close();
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
