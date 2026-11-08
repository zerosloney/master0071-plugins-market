// 冒烟测试：本地 mock SystemOne 端点 + 子进程 MCP 服务器端到端验证，不需要真实 API Key。
// 运行：node test/smoke.mjs（在插件根目录或任意位置均可，路径基于本文件解析）
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { rejectDataPath, isInsecureBaseUrl, endpointLabel } from '../endpoint-config.mjs';
import { renderTemplate, deriveFields } from '../mcp/format.mjs';
import { coerceOptionMap, extractDecisionByType, renderAnswerLine, fillAnswerByType, isBorderlineAnswer } from '../mcp/question-types.mjs';
import { MODEL_PROFILE_RULES, modelProfile } from '../mcp/model-profiles.mjs';
import { BUILTIN_SCENARIOS, resolveScenarios, validateScenario } from '../mcp/scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, '..');

// 开发机上可能残留 SYSTEMONE_* 变量（场景、端点、超时、缓存 TTL、日志路径……）。
// CI 环境干净所以 CI 全绿，本地开发者只要设了其中一个就会莫名红、且极难定位：
// 例如设了 SYSTEMONE_SCENARIOS，自定义场景就顶掉了内置场景，「列出 16 个内置场景」直接失败。
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
  'SYSTEMONE_HOOK_RISK_GATE',
  'SYSTEMONE_PLUGIN_HOOK_RISK_GATE',
];
const cleanEnv = (extra = {}) => {
  const base = { ...process.env };
  for (const key of POLLUTING_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
};
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
  // hasOwn 而非真值下标：qid="__proto__" 时普通对象上的下标会沿原型链取到 Object.prototype
  //（真值），钉住测试（so-M4）就会拿到一个空壳答案而不是按题型生成的答案
  if (Object.hasOwn(FIXTURE.answers, qid)) return FIXTURE.answers[qid];
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
  // 客户端超时断开后，服务端仍会按定时器写响应：吞掉这类 socket 错误，
  // 别让未处理的 error 事件把测试进程带崩（用例里模拟的就是超时断开）。
  req.on('error', () => {});
  res.on('error', () => {});
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    received.push({ url: req.url, headers: req.headers, body: parsed });
    // 慢条目夹具：延迟 2.5s 才响应——用于验证 batch 的单条超时上限不会被整批预算吞掉
    if (parsed.state === 'mock:slow') {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return; // 客户端可能已超时断开
        res.setHeader('content-type', 'application/json');
        const slowAnswers = {};
        for (const [qid, q] of Object.entries(parsed.questions || {})) slowAnswers[qid] = answerFor(qid, q);
        res.end(JSON.stringify({ ...FIXTURE, answers: slowAnswers }));
      }, 2500);
      return;
    }
    if (parsed.state === 'mock:permission-error') {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ base_resp: { status_code: 100105, status_msg: 'model error: no model u2-decision permission' } }));
      return;
    }
    // 权限提示误报面夹具：404 的正文也可能碰巧含 permission 字样（网关/路由层文案），
    // 但 404 不是鉴权状态码——不得据此断言「Key 认证已通过但没有模型权限」
    if (parsed.state === 'mock:permission-404') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ base_resp: { status_code: 100105, status_msg: 'model error: no model u2-decision permission' } }));
      return;
    }
    // 响应侧上限夹具：上游返回异常大的响应（>100K 字符）。100K 上限只护请求侧（STATE_MAX_CHARS），
    // full 格式的 raw 在结果整形时收敛——否则上游响应整体进工具结果、撑爆宿主上下文
    if (parsed.state === 'mock:huge') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) answers[qid] = answerFor(qid, q);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers, echo: 'x'.repeat(150_000) }));
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
    // so-M1 缺陷回归夹具：上游把 score 回成空串。Number('') === 0，弱实现把它捏造成
    // 0 分再取 legend[0] 捏造等级标签、顺 severity 派生 P4，needs_human_review=false 静默放行。
    if (parsed.state === 'mock:score-coerced') {
      const answers = {};
      for (const [qid, q] of Object.entries(parsed.questions || {})) {
        if (q.type === 'score') {
          answers[qid] = {
            type: 'score',
            legend: { '0': '轻微问题，不影响功能', '1': '部分功能受影响，但存在替代方案', '2': '核心功能不可用，没有替代方案', '3': '造成严重业务或安全影响' },
            probabilities: { '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1 },
            score: '',
            confidence: 0.91,
          };
        } else {
          answers[qid] = answerFor(qid, q);
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...FIXTURE, answers }));
      return;
    }
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
    // 无原型对象承载（so-M4 依赖）：qid="__proto__" 时普通 {} 上的赋值会触发原型 setter，
    // mock 自己把这道题的答案丢掉，钉住测试就测不到真实链路了
    const answers = Object.create(null);
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
      env: cleanEnv({ PLUGIN_DATA: '', ...env }),
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

// 轮询等待子进程产出某种响应（超限行拒绝这类异步路径没有可 await 的句柄）
const waitFor = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

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

    // 协议版本必须白名单协商：客户端报一个没实现的版本时，服务端不能照单回显
    // （那等于对不支持的版本说「我支持」，客户端随后按新协议发消息，服务端按旧协议解析）。
    // 未知版本的落点是**支持集里最新的那版**（口径同 worktree-ops / ai-native-delivery 的 protocol.mjs）。
    const bogusInit = await client.call('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    const futureInit = await client.call('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    const modernInit = await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    check('initialize 只回显支持集内的协议版本，未知版本回落到支持的最新版', () => {
      assert.equal(bogusInit.result.protocolVersion, '2025-06-18', '未知版本不得被回显');
      assert.equal(futureInit.result.protocolVersion, '2025-06-18', '未来版本同样回落到支持的最新版');
      assert.equal(modernInit.result.protocolVersion, '2025-06-18', '支持集内的版本应原样回显');
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
    check('action=list 列出 16 个内置场景', () => {
      assert.equal(scenarioList.ok, true);
      assert.equal(scenarioList.count, 16);
      assert.deepEqual(
        scenarioList.scenarios.map((s) => s.id),
        [
          'customer_service', 'content_moderation', 'agent_routing', 'model_routing', 'result_verification', 'sales_lead',
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

    // so-M1：上游把 score 回成空串（""）——Number('') === 0，弱实现捏造成 0 分，
    // 取 legend[0] 捏造等级标签、顺 severity 派生 P4，needs_human_review=false 静默放行
    const coerced = toolResult(
      await runScenario(client, { action: 'run', scenario: 'customer_service', state: 'mock:score-coerced' })
    );
    check('畸形 score（score = ""）不得捏造成 0 分：无法判断 + 不派生优先级 + 转人工', () => {
      assert.equal(coerced.answers.severity.value, null, '空串不是 0 分');
      assert.equal(coerced.answers.severity.level, null, '不得回退到 legend[0]');
      assert.equal(coerced.decision.severity, null);
      assert.equal(coerced.labels.severity, '无法判断');
      assert.equal(coerced.derived.priority, undefined, '不得派生凭空的优先级');
      assert.equal(coerced.needs_human_review, true, 'score="" 必须转人工');
      assert.deepEqual(coerced.low_confidence_questions, ['severity']);
    });

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

    // 对象/数组描述此前被静默 String 化成 "[object Object]" 混进判据表——与 decide 直提路径
    // （validateOptionEntries 只收非空字符串）不同严。params 路径同样必须报错，不产垃圾选项。
    const garbageCriteria = await runScenario(client, {
      action: 'run',
      scenario: 'customer_service',
      state: '普通工单',
      params: { department: { addCriteria: { vip: {} } } },
    });
    check('params.addCriteria 对象描述被拒绝并指明问题 id 与键名（不产 "[object Object]" 选项）', () => {
      assert.equal(garbageCriteria.result.isError, true);
      assert.match(garbageCriteria.result.content[0].text, /params\.department\.addCriteria/);
      assert.match(garbageCriteria.result.content[0].text, /vip/);
      assert.ok(!/\[object Object\]/.test(garbageCriteria.result.content[0].text), '错误文案与判据表都不得出现 String 化垃圾');
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

    // model_routing 场景 + params.candidates 覆盖（候选 id 经内置能力档案展开为选项判据）。
    // 默认答案由 answerFor 按题型生成：model/effort（choice）取首选项、switch_justified（noul）固定 0.87 → true。
    const routeRun = toolResult(
      await runScenario(client, { action: 'run', scenario: 'model_routing', state: '多文件重构任务，需要选执行模型与推理档位' })
    );
    check('model_routing 场景端到端（默认 run 渲染路由建议与 true 分支）', () => {
      assert.equal(routeRun.ok, true);
      assert.equal(routeRun.scenario, 'model_routing');
      assert.deepEqual(routeRun.decision, { model: 'flagship', effort: 'low', switch_justified: true });
      assert.match(routeRun.recommendation, /^路由到 flagship:low。/, `应渲染「路由到 <model id>:<effort 档位>。」：${routeRun.recommendation}`);
      assert.ok(routeRun.recommendation.includes('切换收益大于上下文重建成本，可换模型执行'));
    });

    const routeAlias = toolResult(await runScenario(client, { action: 'run', scenario: '模型路由', state: '别名可达性探测' }));
    check('model_routing 支持中文别名「模型路由」', () => {
      assert.equal(routeAlias.ok, true);
      assert.equal(routeAlias.scenario, 'model_routing');
    });

    check('model_routing 建议模板三分支渲染（true/false/未判定）', () => {
      const tpl = BUILTIN_SCENARIOS.find((s) => s.id === 'model_routing').recommendation;
      // {model.key} / {effort.key} 从 decision 取原始选项 key（非 label）
      const render = (switchState) => renderTemplate(tpl, { decision: { model: 'glm-5.3', effort: 'high', switch_justified: switchState } });
      assert.equal(render(true), '路由到 glm-5.3:high。切换收益大于上下文重建成本，可换模型执行');
      assert.equal(render(false), '路由到 glm-5.3:high。建议沿用当前会话模型以保持连续性');
      assert.equal(render(null), '路由到 glm-5.3:high。切换必要性未判定，请人工复核');
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'model_routing',
      state: '候选模型展开探测',
      params: { model: { candidates: ['glm-5.3', 'glm-4-flash', 'totally-unknown-x'] } },
    });
    check('params.candidates 按内置能力档案展开并整体替换选项判据', () => {
      const last = received[received.length - 1];
      const criteria = last.body.questions.model.criteria;
      assert.deepEqual(Object.keys(criteria), ['glm-5.3', 'glm-4-flash', 'totally-unknown-x']);
      assert.equal(criteria['glm-5.3'], '均衡编码档：工具调用与多步编码任务表现稳');
      assert.equal(criteria['glm-4-flash'], '快速档：简单机械任务、批量处理；最快最省', 'flash 片段应命中快速档而非宽泛 glm 家族');
      assert.equal(criteria['totally-unknown-x'], '未提供能力描述：按通用模型对待，无法体现该模型相对优势');
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'model_routing',
      state: 'candidates 与 addCriteria 组合探测',
      params: { model: { candidates: ['glm-5.3', 'kimi-k2'], addCriteria: { local: '本地部署的私有模型' } } },
    });
    check('candidates 与 addCriteria 可组合（addCriteria 追加在展开结果上）', () => {
      const last = received[received.length - 1];
      assert.deepEqual(Object.keys(last.body.questions.model.criteria), ['glm-5.3', 'kimi-k2', 'local']);
    });

    await runScenario(client, {
      action: 'run',
      scenario: 'model_routing',
      state: '档位词表覆盖探测',
      params: { effort: { criteria: { minimal: '极简档', low: '低档', medium: '中档', high: '高档' } } },
    });
    check('params.criteria 覆盖 model_routing 推理档位词表', () => {
      const last = received[received.length - 1];
      assert.deepEqual(last.body.questions.effort.criteria, { minimal: '极简档', low: '低档', medium: '中档', high: '高档' });
    });

    // candidates 错误路径：类型限定 / 与 criteria 互斥 / 形状 / 查重，风格与 addCriteria 报错一致
    for (const [name, override, pattern] of [
      ['candidates 用于 noul 题', { switch_justified: { candidates: ['a', 'b'] } }, /params\.switch_justified\.candidates 仅支持 choice 问题/],
      ['candidates 与 criteria 同给', { model: { criteria: { flagship: '旗舰', fast: '快' }, candidates: ['a', 'b'] } }, /params\.model\.candidates 与 criteria 不能同时提供/],
      ['candidates 非数组', { model: { candidates: { a: 'A' } } }, /params\.model\.candidates 必须是非空字符串数组/],
      ['candidates 空数组', { model: { candidates: [] } }, /params\.model\.candidates 必须是非空字符串数组/],
      ['candidates 含空串与非字符串 id', { model: { candidates: ['glm-5.3', '   ', 7] } }, /params\.model\.candidates 必须是非空字符串数组/],
      ['candidates trim 后重复 id', { model: { candidates: ['glm-5.3', ' glm-5.3 '] } }, /params\.model\.candidates 存在重复 id/],
    ]) {
      const bad = await runScenario(client, { action: 'run', scenario: 'model_routing', state: 'x', params: override });
      check(`params.candidates 错误路径：${name}`, () => {
        assert.equal(bad.result.isError, true);
        assert.match(bad.result.content[0].text, pattern);
      });
    }

    // 数量上限不做本地预判（与 addCriteria 合并口径一致）：27 个候选由 executeDecision →
    // validateQuestions 的 choice 量表上限兜底拒绝
    const tooManyCandidates = await runScenario(client, {
      action: 'run',
      scenario: 'model_routing',
      state: 'x',
      params: { model: { candidates: Array.from({ length: 27 }, (_, i) => `model-${i}`) } },
    });
    check('candidates 超过 26 个由 executeDecision → validateQuestions 兜底拒绝', () => {
      assert.equal(tooManyCandidates.result.isError, true);
      assert.match(tooManyCandidates.result.content[0].text, /questions\.model\.criteria 选项数超过上限 26/);
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

    // 响应侧上限：100K 上限只护请求侧（STATE_MAX_CHARS），full 格式的 raw 是上游响应整体——
    // 上游异常大的响应不得原样进工具结果撑爆宿主上下文，超限截断并附注记
    const oversizeRun = toolResult(await decide(client, { state: 'mock:huge', questions: { q: { type: 'noul', instructions: '是吗？' } } }));
    check('full 格式 raw 超过 100K 字符被截断并附「已截断，原长度 N」注记', () => {
      assert.equal(oversizeRun.ok, true);
      assert.ok(oversizeRun.raw && typeof oversizeRun.raw === 'object', 'raw 超限时应是截断形态的对象');
      assert.match(String(oversizeRun.raw.note || ''), /已截断/);
      assert.ok(oversizeRun.raw.original_length > 100_000, `应记录原长度（>100K），实际：${oversizeRun.raw.original_length}`);
      assert.ok(typeof oversizeRun.raw.head === 'string' && oversizeRun.raw.head.length <= 100_000, 'head 应是原文前缀切片且有界');
      const rawLen = JSON.stringify(oversizeRun.raw).length;
      assert.ok(rawLen < 250_000, `截断后 raw 序列化长度应有界，实际 ${rawLen}`);
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

    // 空串 env = 未配置（config() / thresholdOf / formatOf 同一套约定）：Number('') === 0，
    // 曾把「宿主注入了空值」变成「缓存 TTL=0（关缓存）」与「批量预算 0ms（全部条目直接标未执行）」
    const emptyEnvClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      SYSTEMONE_PLUGIN_CACHE_TTL_MS: '',
      SYSTEMONE_CACHE_TTL_MS: '',
      SYSTEMONE_PLUGIN_BATCH_BUDGET_MS: '',
      SYSTEMONE_BATCH_BUDGET_MS: '',
    });
    try {
      await decide(emptyEnvClient, { state: '空串env缓存一号', questions: { q: { type: 'noul', instructions: '是吗？' } } });
      const emptyCacheHit = toolResult(
        await decide(emptyEnvClient, { state: '空串env缓存一号', questions: { q: { type: 'noul', instructions: '是吗？' } } })
      );
      const emptyBudgetBatch = toolResult(
        await runScenario(emptyEnvClient, { action: 'batch', scenario: 'customer_service', states: ['空串预算一', '空串预算二'] })
      );
      check('env 空串视为未配置：缓存回退默认 TTL、批量预算回退默认（不再被 Number("") 变成 0）', () => {
        assert.equal(emptyCacheHit.cached, true, '空串 TTL 应回退默认 5 分钟（缓存生效），而不是关掉缓存');
        assert.equal(emptyBudgetBatch.ok, true);
        assert.equal(emptyBudgetBatch.failed, 0, '空串预算应回退默认 25s 正常执行，而不是全部标 budget_exhausted');
        assert.equal(emptyBudgetBatch.budget_exhausted, false);
      });
    } finally {
      emptyEnvClient.close();
    }

    // 坏值毫秒变量不静默（2026-11-05）：msFromEnv 对非空非法值 stderr 告警一行后按默认回退，
    // 与 hook 侧 decision-cache.mjs 的 hookCacheTtlMs 同口径；空串/未设置保持安静（空串=未配置
    // 约定不变）。McpClient 的 stderr 是 inherit（告警直接混进测试输出、收集不到），这里单独
    // spawn 三通 stdio 的服务器子进程：既收 stderr，又用同一进程先后发两次判定验证「行为同默认」。
    const decidePairStderr = (envExtra) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [serverPath], {
          env: cleanEnv({
            PLUGIN_DATA: '',
            SYSTEMONE_API_KEY: 'test-key',
            SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
            ...envExtra,
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let errText = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c) => (errText += c));
        let buf = '';
        const responses = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c) => {
          buf += c;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) responses.push(JSON.parse(line));
          }
        });
        const args = { state: 'msFromEnv 坏值告警探测', questions: { q: { type: 'noul', instructions: '是吗？' } } };
        const call = (id) =>
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'systemone_decide', arguments: args } })}\n`);
        // 顺序发：等第一次判定返回（缓存已落）再发第二次——与 McpClient 调用方的 await 语义一致；
        // 背靠背流水线发会让第二次的缓存查找跑在第一次的 cachePut 之前，测不了「行为同默认」。
        call(1);
        let sentSecond = false;
        const wait = setInterval(() => {
          if (responses.length >= 1 && !sentSecond) {
            sentSecond = true;
            call(2);
          }
          if (responses.length >= 2) {
            clearInterval(wait);
            child.kill();
            resolve({ responses, errText });
          }
        }, 25);
        // 兜底：响应迟迟不来也要收尾，不让套件挂死
        setTimeout(() => {
          clearInterval(wait);
          child.kill();
          resolve({ responses, errText });
        }, 15000).unref();
      });

    {
      const bad = await decidePairStderr({ SYSTEMONE_CACHE_TTL_MS: 'banana' });
      check('坏值 TTL：stderr 告警且行为同默认（缓存照常生效，不静默）', () => {
        assert.equal(bad.responses.length, 2, '两次判定都应返回（坏值不毒死流程）');
        const second = JSON.parse(bad.responses[1].result.content[0].text);
        assert.equal(second.cached, true, '非法 TTL 应回退默认 300000（缓存生效），而不是被当成 0 关缓存');
        assert.match(bad.errText, /SYSTEMONE_CACHE_TTL_MS/, 'stderr 应点名坏值变量');
        assert.match(bad.errText, /无法识别/, 'stderr 应有可读的告警文案');
      });
      const empty = await decidePairStderr({ SYSTEMONE_PLUGIN_CACHE_TTL_MS: '', SYSTEMONE_CACHE_TTL_MS: '' });
      check('空串 TTL：保持安静不告警（空串=未配置约定不变，行为仍同默认）', () => {
        assert.equal(empty.responses.length, 2);
        assert.equal(JSON.parse(empty.responses[1].result.content[0].text).cached, true, '空串回退默认 TTL，缓存生效');
        assert.equal(empty.errText, '', '空串不算坏值，不得刷告警');
      });
    }

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
      assert.match(batchMixed.results[1].error, /HTTP 403/);
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

    // 单条超时必须收敛到「剩余预算按剩余条目均分」：只取 min(单条上限, 剩余预算) 时，
    // 第 1 条最坏能吃光整批预算（单条上限 30s > 整批 25s），后面 9 条全被标 budget_exhausted，
    // 用户拿到的结果只剩 1 条。mock:slow 让第 1 条延迟 2.5s 响应，稳定触发这条路径。
    const slowBatchClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      SYSTEMONE_PLUGIN_BATCH_BUDGET_MS: '3000',
    });
    try {
      const slowBatch = toolResult(
        await runScenario(slowBatchClient, {
          action: 'batch',
          scenario: 'customer_service',
          states: ['mock:slow', '慢批二', '慢批三'],
        })
      );
      check('batch 单条超时按剩余预算均分：慢条目吃不掉整批，后续条目仍拿到预算', () => {
        assert.equal(slowBatch.results[0].ok, false, '第 1 条应在均分份额内超时，而不是独占整批预算');
        assert.match(slowBatch.results[0].error, /请求超时（1000ms）/, '单条超时上限应是 3000/3 的均分份额');
        assert.equal(slowBatch.results[0].errorCode, 'timeout');
        assert.equal(slowBatch.results[1].ok, true, '第 2 条仍应拿到预算并完成判定');
        assert.equal(slowBatch.results[2].ok, true, '第 3 条仍应拿到预算并完成判定');
        assert.equal(slowBatch.budget_exhausted, false, '没有条目应因预算耗尽被跳过');
        assert.ok(slowBatch.elapsed_ms <= 3000, `整批耗时应不超过批量预算，实际 ${slowBatch.elapsed_ms}ms`);
      });
    } finally {
      slowBatchClient.close();
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

    // stdin 单行上限：宿主/网络异常时一行没有换行地无限灌入，旧实现会无限累积缓冲吃光内存。
    // 超 1MiB 的行被拒并回 JSON-RPC Parse error（id=null，行级内容无法可靠取 id），后续请求照常服务。
    // 注意先终止垃圾行再发后续请求：不换行的垃圾与后续请求会拼成同一行、一起被丢弃。
    {
      client.child.stdin.write('x'.repeat(1024 * 1024 + 1024)); // 无换行，超限
      const rejected = await waitFor(() => client.seen.some((m) => m.error), 10_000);
      client.child.stdin.write('\n'); // 终止垃圾行（旧实现按解析失败静默丢弃；新实现已在超限时拒收并清空缓冲）
      const afterHuge = await client.call('tools/list');
      check('stdin 单行超过 1MiB 上限被拒并回 JSON-RPC 错误，服务器继续处理后续请求', () => {
        const err = client.seen.find((m) => m.error);
        assert.ok(rejected && err, '超限行应收到错误响应');
        assert.equal(err.id, null, '行级超限无法可靠解析 id，按 JSON-RPC 约定回 id=null');
        assert.equal(err.error.code, -32700);
        assert.ok(afterHuge.result.tools, '超限行丢弃后后续请求照常处理');
      });
    }

    // EPIPE：宿主关停关闭 stdio 管道时挂起的 write 会抛 EPIPE——不挂 error 处理就走
    // uncaughtException 兜底（退出码 1 + 崩栈），正常关停也以失败收场。EPIPE 只意味着
    // 对端已不在：静默 exit 0（口径同 worktree-ops/mcp/protocol.mjs 既有先例）。
    {
      const epipeChild = spawn(
        process.execPath,
        [serverPath],
        { env: cleanEnv({ PLUGIN_DATA: '', SYSTEMONE_API_KEY: 'test-key', SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1` }), stdio: ['pipe', 'pipe', 'pipe'] }
      );
      epipeChild.stderr.resume();
      epipeChild.stdout.setEncoding('utf8');
      const gotInit = new Promise((resolve) => {
        epipeChild.stdout.on('data', function onData(c) {
          if (String(c).includes('"id":1')) {
            epipeChild.stdout.removeListener('data', onData);
            resolve();
          }
        });
      });
      epipeChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
      await gotInit;
      epipeChild.stdout.destroy(); // 宿主侧先关读端，再触发一次写 → 子进程 EPIPE
      await new Promise((r) => setTimeout(r, 100));
      const exited = new Promise((resolve) => epipeChild.on('exit', (code) => resolve(code)));
      epipeChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
      check('宿主关闭 stdout 后 EPIPE 静默退出 0（不走 uncaughtException 崩溃路径）', () => {
        assert.equal(code, 0, `EPIPE 应安静退出 0，实际：${code}`);
      });
      try {
        epipeChild.kill();
      } catch {}
    }

    const perm = await decide(client, { state: 'mock:permission-error', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('401/403 且正文含 permission：附「可能」句式的权限排查提示', () => {
      assert.equal(perm.result.isError, true);
      assert.match(perm.result.content[0].text, /HTTP 403/);
      assert.match(perm.result.content[0].text, /可能/, '401/403 上鉴权失败与缺模型权限不可区分，必须是「可能」句式而非断言');
      assert.match(perm.result.content[0].text, /模型权限/);
      assert.match(perm.result.content[0].text, /环境变量快照/);
    });
    const perm404 = await decide(client, { state: 'mock:permission-404', questions: { q1: { type: 'noul', instructions: '是吗？' } } });
    check('非 401/403（404）正文含 permission 不再附权限断言（提示误报面收敛）', () => {
      assert.equal(perm404.result.isError, true);
      assert.match(perm404.result.content[0].text, /HTTP 404/);
      assert.ok(!/模型权限/.test(perm404.result.content[0].text), '404 不是鉴权状态码，不得断言「Key 认证已通过但没有模型权限」——403 鉴权失败时那句话是假的');
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
    let hung;
    try {
      const started = Date.now();
      hung = await timeoutClient.call('tools/call', {
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

    // 错误契约：isError 结果必须带结构化 errorCode，调用方按码归类而不是解析中文文案。
    // batch 路径早就有 budget_exhausted 结构化标记，顶层却没有——同一份插件两套契约。
    check('isError 结果带结构化 errorCode（参数非法 / 上游错误 / 超时）', () => {
      assert.equal(unknown.result.errorCode, 'invalid_params', '未知场景属参数非法');
      assert.equal(noState.result.errorCode, 'invalid_params', '缺 state 属参数非法');
      assert.equal(serverError.result.errorCode, 'upstream_error', '上游 5xx');
      assert.equal(nonJson.result.errorCode, 'upstream_error', '响应体非 JSON');
      assert.equal(noAnswers.result.errorCode, 'upstream_error', '响应缺 answers');
      assert.equal(hung.result.errorCode, 'timeout', '响应体读取超时');
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
    // 边界收紧：criteria 值为 null/undefined 的场景在校验层整条跳过（choice 选项与 score 等级对称），
    // 不再有机会被字符串化成字面 "null"/"undefined" 的选项或等级
    { id: 'bad_null_option', title: '空选项值', questions: { q1: { type: 'choice', instructions: '?', criteria: { vip: null, general: '普通通道' } } } },
    { id: 'bad_null_level', title: '空等级值', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', null] } } },
    // 校验器与规范化器对称：aliases 混入非字符串、derive 缺 values/map，都在校验层拦截整条跳过，
    // 不允许"校验放行、normalizeScenario/deriveFields 运行时静默丢弃"
    { id: 'bad_aliases', title: '坏别名', aliases: ['合规别名', 123], questions: { q1: { type: 'noul', instructions: '?' } } },
    { id: 'bad_derive', title: '坏派生', questions: { q1: { type: 'noul', instructions: '?' } }, derive: { x: { question: 'q1' } } },
    // derive 与 questions 的对应关系：qid 必须存在、values 只配 score / map 只配 choice、
    // values 档数超过分级数、空数组会让模板条件恒真——全部在校验层拦截
    { id: 'bad_qid', title: '坏派生 qid', questions: { q1: { type: 'noul', instructions: '?' } }, derive: { x: { question: 'ghost', values: ['a'] } } },
    { id: 'bad_values_type', title: 'values 挂在 choice 上', questions: { q1: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } } }, derive: { x: { question: 'q1', values: ['低', '高'] } } },
    { id: 'bad_map_type', title: 'map 挂在 score 上', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', '高'] } }, derive: { x: { question: 'q1', map: { 0: '低' } } } },
    { id: 'bad_values_len', title: 'values 档数超过分级数', questions: { q1: { type: 'score', instructions: '?', criteria: ['低', '高'] } }, derive: { x: { question: 'q1', values: ['P1', 'P2', 'P3'] } } },
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
    // 派生档数少于分级数：4 级量表只想映射到 3 档优先级是合法表达（取前 3 档，
    // 超出部分钳到最后一档）。原先要求长度严格相等，整条场景被跳过、用户无从自查。
    {
      id: 'short_values',
      title: '派生档数少于分级数',
      questions: {
        severity: { type: 'score', label: '严重程度', instructions: '有多严重？', criteria: ['轻微', '一般', '严重', '致命'] },
      },
      derive: { priority: { question: 'severity', values: ['P3', 'P2', 'P1'] } },
      recommendation: '优先级 {priority}',
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
      assert.equal(customList.count, 19); // 16 内置 + legal_review + tmpl_test + short_values；customer_service 原位覆盖；bad_* 跳过
      const byId = new Map(customList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('legal_review').source, 'custom');
      assert.equal(byId.get('customer_service').source, 'custom');
      assert.equal(byId.get('software_dev').source, 'builtin');
      assert.ok(!byId.has('bad_one'));
      assert.ok(!byId.has('bad_aliases'));
      assert.ok(!byId.has('bad_derive'));
      // derive 与 questions 不对应（qid 不存在 / 题型不配 / 档数超过分级数 / 空数组）一律整条跳过，
      // 不允许「校验放行、运行时静默产出空建议或恒真条件」
      for (const id of ['bad_qid', 'bad_values_type', 'bad_map_type', 'bad_values_len', 'bad_values_empty', 'bad_null_option', 'bad_null_level']) {
        assert.ok(!byId.has(id), `${id} 应被校验器跳过，实际混进了场景库`);
      }
      // 被跳过的条目要说清楚「哪条、为什么」：原因随 action=list 的结果一起返回，
      // 不能只留在启动日志里（用户只看到场景凭空消失，无从自查）
      assert.ok(Array.isArray(customList.problems) && customList.problems.length > 0, '应返回被跳过场景的原因');
      assert.ok(customList.problems.some((p) => /bad_one/.test(p)), '原因里应指明被跳过的是哪条');
      assert.match(customList.summary, /条场景定义被跳过/, '摘要应提示有场景被跳过');
      assert.ok(customList.summary.includes('（自定义）'));
    });

    // 派生档数少于分级数：合法，不得整条丢弃
    const shortValuesRun = toolResult(await runScenario(customClient, { action: 'run', scenario: 'short_values', state: '派生档数夹具' }));
    check('派生 values 档数少于分级数时场景照常生效（4 级量表 → 3 档优先级）', () => {
      assert.equal(shortValuesRun.ok, true);
      assert.equal(shortValuesRun.scenario, 'short_values');
      // mock 的 severity 答案分值 2.000796 → 取整 2 → values[2]（3 档里的最后一档）
      assert.equal(shortValuesRun.derived.priority, 'P1');
      assert.equal(shortValuesRun.recommendation, '优先级 P1');
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
      assert.equal(brokenList.count, 16);
      assert.equal(brokenList.scenarios.find((s) => s.id === 'customer_service').source, 'builtin');
    });
  } finally {
    brokenClient.close();
  }

  // 未知键拦截端到端：confidence_threshold 这类拼写错此前被静默忽略（阈值静默回退默认、
  // 场景照常加载），现在校验层整条跳过并在 problems 里指明未知键与支持的键
  const typoClient = new McpClient({
    SYSTEMONE_PLUGIN_SCENARIOS: JSON.stringify([
      { id: 'typo_gate', title: '拼写错键', questions: { q: { type: 'noul', instructions: 'i' } }, confidence_threshold: 0.9 },
    ]),
  });
  try {
    const typoList = toolResult(await runScenario(typoClient, { action: 'list' }));
    check('场景含拼写错键（confidence_threshold）整条跳过并指明未知键与支持键', () => {
      assert.ok(!typoList.scenarios.some((s) => s.id === 'typo_gate'), '拼写错键的场景应被跳过，而不是静默回退默认阈值照常加载');
      assert.ok(
        typoList.problems.some((p) => p.includes('typo_gate') && p.includes('confidence_threshold') && p.includes('confidenceThreshold')),
        `problems 应指明未知键与正确拼写：${typoList.problems.join('；')}`
      );
    });
  } finally {
    typoClient.close();
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
      // 审计日志的绝对路径不得进模型上下文（带出用户名与目录结构，对判定没有增量信息）
      assert.equal(stats.log_file, path.basename(logFile), '结构化字段只回显文件名');
      assert.ok(!stats.summary.includes(logFile), '摘要不得回显绝对路径');
      assert.ok(stats.summary.includes(path.basename(logFile)), '摘要应显示文件名');
    });
  } finally {
    logClient.close();
  }

  // 轮转归档段 <file>.1 也计入 stats：轮转（appendLog 达 5MB 上限时改名保留一代归档）后，
  // 只读当前段的话每次轮转都会把更早的记录从统计里「清零」。归档有界（只保留一代），读两段即全覆盖。
  const rotLogFile = path.join(scratchRoot, 'decisions-rotated.jsonl');
  writeFileSync(
    `${rotLogFile}.1`,
    [
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', scenario: 'legacy_a', decision: { q: 'x' }, needs_human_review: true, cached: false, latency_ms: 5 }),
      '# 已达 5242880 字节上限，上一段记录轮转至（轮转标记行，stats 应按坏行跳过）',
      JSON.stringify({ ts: '2026-01-01T00:01:00.000Z', scenario: 'legacy_b', decision: { q: 'y' }, needs_human_review: false, cached: true, latency_ms: 7 }),
      '',
    ].join('\n')
  );
  const rotClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_LOG_FILE: rotLogFile,
  });
  try {
    await runScenario(rotClient, { action: 'run', scenario: 'customer_service', state: '轮转统计样本' });
    const rotStats = toolResult(await runScenario(rotClient, { action: 'stats' }));
    check('action=stats 计入轮转归档段 <file>.1（有界一代），标记行/坏行不计入', () => {
      assert.equal(rotStats.total, 3, `应 = 归档 2 条 + 当前段 1 条，实际 ${rotStats.total}`);
      assert.equal(rotStats.scenarios.legacy_a.count, 1);
      assert.equal(rotStats.scenarios.legacy_b.cached, 1);
      assert.equal(rotStats.scenarios.customer_service.count, 1);
      assert.equal(rotStats.cached, 1);
    });
  } finally {
    rotClient.close();
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
      assert.equal(fileList.count, 17); // 16 内置 + team_gate（customer_service 原位覆盖）
      const byId = new Map(fileList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('team_gate').source, 'custom');
      assert.equal(byId.get('team_gate').title, '团队发布门禁 · 设置页覆盖');
      assert.equal(byId.get('customer_service').source, 'custom');
      assert.equal(byId.get('software_dev').source, 'builtin');
    });
  } finally {
    fileClient.close();
  }

  // 环境变量入口（不带 PLUGIN_ 前缀）：README 的配置表里 SYSTEMONE_SCENARIOS 与
  // SYSTEMONE_SCENARIOS_FILE 是正式入口，此前只有 PLUGIN_ 前缀那份有测试。两者的优先级
  // 不同（PLUGIN_ 优先），但**裸名单独在场时必须单独生效**——缺这条断言的话，一次
  // 「顺手把裸名从 server.mjs 的 || 链里删掉」不会有任何测试变红。
  const envFileClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_SCENARIOS_FILE: scenarioFile,
    SYSTEMONE_SCENARIOS: JSON.stringify([
      {
        id: 'env_only',
        title: '仅环境变量',
        questions: { ok: { type: 'noul', label: '是否可接受', instructions: '是否可接受？' } },
      },
    ]),
  });
  try {
    const envList = toolResult(await runScenario(envFileClient, { action: 'list' }));
    check('裸 SYSTEMONE_SCENARIOS 与 SYSTEMONE_SCENARIOS_FILE 单独在场时生效', () => {
      assert.equal(envList.count, 18); // 16 内置 + team_gate（文件）+ env_only（环境变量 JSON）
      const byId = new Map(envList.scenarios.map((s) => [s.id, s]));
      assert.equal(byId.get('env_only').source, 'custom');
      assert.equal(byId.get('env_only').title, '仅环境变量');
      assert.equal(byId.get('team_gate').source, 'custom');
    });
  } finally {
    envFileClient.close();
  }

  // 同时在场时 PLUGIN_ 前缀优先（与 endpoint / timeout / log 的既有优先级一致）
  const bothClient = new McpClient({
    SYSTEMONE_API_KEY: 'test-key',
    SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    SYSTEMONE_SCENARIOS: JSON.stringify([
      { id: 'from_bare', title: '裸名', questions: { q: { type: 'noul', label: 'q', instructions: 'q ？' } } },
    ]),
    SYSTEMONE_PLUGIN_SCENARIOS: JSON.stringify([
      { id: 'from_plugin', title: '前缀', questions: { q: { type: 'noul', label: 'q', instructions: 'q ？' } } },
    ]),
  });
  try {
    const bothList = toolResult(await runScenario(bothClient, { action: 'list' }));
    check('PLUGIN_ 前缀优先于裸名（两者同时在场只取前缀那份）', () => {
      const ids = bothList.scenarios.map((s) => s.id);
      assert.ok(ids.includes('from_plugin'), `应含 from_plugin：${ids.join(',')}`);
      assert.ok(!ids.includes('from_bare'), `不应含 from_bare：${ids.join(',')}`);
    });
  } finally {
    bothClient.close();
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
      assert.equal(noKey.result.errorCode, 'missing_api_key', '缺 Key 必须是可区分的结构化错误码');
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
      // 2026-11-01：共享文件新增两个 hook 开关（设置页那两个开关此前只进 MCP 子进程 env、
      // hook 进程收不到，等于承诺"off 就停掉外发"却关不掉）。本夹具没设开关 → 落盘为 null。
      assert.deepEqual(Object.keys(endpointFile).sort(), ['baseUrl', 'hookPrecheck', 'hookRiskGate', 'model', 'timeoutMs']);
      assert.equal(endpointFile.baseUrl, `http://127.0.0.1:${port}/v1`);
      assert.equal(endpointFile.model, 'alt-decision');
      assert.equal(endpointFile.timeoutMs, 30000, 'PLUGIN_TIMEOUT_MS 留空应落盘默认值');
      assert.equal(endpointFile.hookPrecheck, null, '未设开关 → null（hook 侧据此回退环境变量/默认 on）');
      assert.equal(endpointFile.hookRiskGate, null);
      assert.ok(!JSON.stringify(endpointFile).includes('test-key'), 'Key 不得出现在共享文件里');
    });
  } finally {
    uiClient.close();
  }

  // PLUGIN_DATA 为相对路径时按「未提供」处理并告警、回退插件根：宿主给相对值时 MCP（cwd=插件根）
  // 与 hook（cwd=工作区）会各自把相对路径 resolve 到不同文件——共享通道静默断裂。
  // 回退插件根后两个进程至少还指向同一处（旧行为）。
  {
    const relDataDir = 'systemone-relative-plugin-data';
    const relClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      PLUGIN_DATA: relDataDir,
    });
    try {
      await relClient.call('tools/call', {
        name: 'systemone_scenario',
        arguments: { action: 'run', scenario: 'customer_service', state: 'rel-data' },
      });
      check('PLUGIN_DATA 相对路径按未提供处理：回退插件根落盘（共享通道不静默断裂）', () => {
        assert.ok(existsSync(path.join(runRoot, '.endpoint.json')), '相对 PLUGIN_DATA 应回退插件根写 .endpoint.json');
        assert.ok(!existsSync(path.resolve(relDataDir)), '不得在相对 cwd 下创建 PLUGIN_DATA 目录');
      });
    } finally {
      relClient.close();
      // 修复前的旧行为会在 cwd（=测试进程 cwd）下落相对目录：测试自造自清
      rmSync(path.resolve(relDataDir), { recursive: true, force: true });
    }
  }

  // so-M4 钉住：applyParams 的 params 覆盖路径曾用裸 {} 承载合并结果，qid="__proto__" 时
  // `merged[qid] = next` 触发原型 setter——该题静默丢出 merged 的自有键，Object.entries 就此
  // 丢题，模型收不到、判定照常返回且无任何报错。0.5.13 已修（server.mjs 改用
  // Object.create(null)），当时没有测试。这里走真实路径钉住：tools/call → action=run →
  // params 覆盖 × qid="__proto__"。JSON 串直写避免 JS 字面量的 __proto__ 特殊语义。
  // （必须排在 mock.close() 之前：钉住走的是真实判定请求）
  {
    const protoScenario = JSON.stringify([
      {
        id: 'proto_params',
        title: '原型钉住',
        description: '',
        questions: JSON.parse('{"__proto__":{"type":"noul","label":"可接受吗","instructions":"这样可接受吗？"}}'),
        derive: {},
        recommendation: '',
      },
    ]);
    const protoClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      SYSTEMONE_PLUGIN_SCENARIOS: protoScenario,
    });
    try {
      const protoRun = toolResult(
        await protoClient.call('tools/call', {
          name: 'systemone_scenario',
          arguments: {
            action: 'run',
            scenario: 'proto_params',
            state: '原型钉住',
            params: JSON.parse('{"__proto__":{"label":"覆盖后的标签"}}'),
          },
        })
      );
      check('params 覆盖 qid="__proto__"：题目不丢、answers/labels 不长出污染键（applyParams 钉住）', () => {
        assert.equal(protoRun.ok, true);
        // JSON 序列化里出现 "__proto__" 键 = 它是自有键（落进原型 setter 的键会被
        // JSON.stringify 整个丢掉）。三视图 + 原始响应一起对账。
        assert.ok(Object.hasOwn(protoRun.answers, '__proto__'), 'answers 必须含 __proto__ 题');
        assert.ok(Object.hasOwn(protoRun.labels, '__proto__'), 'labels 必须含 __proto__ 题');
        assert.ok(Object.hasOwn(protoRun.decision, '__proto__'));
        assert.ok(Object.hasOwn(protoRun.raw.answers, '__proto__'), '原始响应的 answers 必须含 __proto__ 题');
        assert.equal(protoRun.decision['__proto__'], true, 'noul=0.87 → 是');
        // 请求体里确实带了这道题（params 覆盖没有把它丢出合并表）
        const protoRequests = received.filter((r) => r.body.questions && Object.hasOwn(r.body.questions, '__proto__'));
        assert.equal(protoRequests.length, 1, '判定请求必须携带 __proto__ 题（丢题 = applyParams 落了原型 setter）');
        assert.equal(protoRequests[0].body.questions.__proto__.type, 'noul');
        // 原型干净：污染形态（赋值落 setter）会把题目变成本题对象的原型而非自有键，
        // 上面的 hasOwn 断言已钉死；这里再锚一遍测试进程内的解析产物没被污染
        assert.equal(Object.getPrototypeOf(protoRun.answers), Object.prototype);
      });
    } finally {
      protoClient.close();
    }
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

  // 不安全端点护栏（isInsecureBaseUrl + server.mjs 的拒绝分支）：非 https 且非本机回环的端点
  // 携带 Bearer Key 等于明文外泄凭据，必须在发请求前拒绝。此前该分支零测试覆盖（2026-10-28 市场审查补）。
  // 用不可达的公网 http 地址：若护栏失效而真发了请求，会因连不上而报 upstream_error/timeout，
  // 与预期的 insecure_endpoint 区分得开，断言不会假绿。
  {
    const insecureClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: 'http://insecure.example.invalid/v1',
    });
    try {
      const r = await insecureClient.call('tools/call', {
        name: 'systemone_scenario',
        arguments: { action: 'run', scenario: 'customer_service', state: 'insecure-endpoint' },
      });
      check('非 https 且非回环的端点：拒绝发请求并回报 insecure_endpoint', () => {
        assert.equal(r.result?.isError, true, '应为 isError 结果');
        // errorCode 是结果对象上的结构化字段（契约），不在中文文案里——按码断言，不按文案
        assert.equal(r.result?.errorCode, 'insecure_endpoint', `应为 insecure_endpoint：${JSON.stringify(r.result)}`);
        const text = (r.result?.content || []).map((c) => c.text).join('\n');
        assert.match(text, /不是加密端点/, `文案应说明端点不安全：${text}`);
      });
    } finally {
      insecureClient.close();
    }
    // 黑盒：userinfo 冒充回环（2026-10-29 实测漏洞）。旧判据是前缀正则，`http://localhost:8080@`
    // 命中回环前缀 → 判安全 → 请求发往 evil.example，Key 走明文。现在必须结构化拒绝。
    // 用 .invalid 域名保证即使护栏失效也连不上（不会真的把请求打到外部主机）。
    const spoofClient = new McpClient({
      SYSTEMONE_API_KEY: 'test-key',
      SYSTEMONE_BASE_URL: 'http://localhost:8080@evil.example.invalid/v1',
    });
    try {
      const r = await spoofClient.call('tools/call', {
        name: 'systemone_scenario',
        arguments: { action: 'run', scenario: 'customer_service', state: 'spoofed-loopback' },
      });
      check('userinfo 冒充回环的端点：同样拒绝发请求', () => {
        assert.equal(r.result?.isError, true, '应为 isError 结果');
        assert.equal(r.result?.errorCode, 'insecure_endpoint', `应为 insecure_endpoint：${JSON.stringify(r.result)}`);
        const text = (r.result?.content || []).map((c) => c.text).join('\n');
        // 错误文案只留 host，不得原样回显配置里的 userinfo（那可能是真口令）
        assert.ok(!text.includes('localhost:8080@evil'), `文案不得回显 userinfo：${text}`);
        assert.match(text, /evil\.example\.invalid/, `文案应点名真实 host：${text}`);
      });
    } finally {
      spoofClient.close();
    }
    // 反向锚：本机回环的 http 端点不算不安全（不得被这条护栏误伤）
    check('本机回环的 http 端点不被判为不安全', () => {
      assert.equal(isInsecureBaseUrl('http://127.0.0.1:8080/v1'), false);
      assert.equal(isInsecureBaseUrl('http://localhost:8080/v1'), false);
      assert.equal(isInsecureBaseUrl('https://api.example.com/v1'), false);
      assert.equal(isInsecureBaseUrl('http://insecure.example.invalid/v1'), true);
      assert.equal(isInsecureBaseUrl('http://10.0.0.5:8080/v1'), true, '内网明文也携 Key，仍应拒');
    });
    // 回归（2026-10-29 实测）：旧实现用前缀正则 `^http://(localhost|127.0.0.1|[::1])`，
    // 而 URL 的 userinfo 段出现在 host 之前 —— `http://localhost:8080@evil.example` 前缀命中
    // `localhost:8080`、冒号即满足分隔符，整条被判「回环、安全」，实际请求发往 evil.example。
    // 三个变体在修复前全部判 safe（实测），Bearer Key 会走明文路径外发。
    check('userinfo 冒充回环的端点被判为不安全', () => {
      assert.equal(isInsecureBaseUrl('http://localhost:8080@evil.example/v1'), true, '带端口的具体 userinfo');
      assert.equal(isInsecureBaseUrl('http://127.0.0.1:9@evil.example/v1'), true, 'IP 形态');
      assert.equal(isInsecureBaseUrl('HTTP://LOCALHOST:80@evil.example/v1'), true, '大写 scheme 与 host');
    });
    check('URL 内嵌凭据一律判为不安全（即使 host 确是回环）', () => {
      assert.equal(isInsecureBaseUrl('http://user:pw@127.0.0.1:8080/v1'), true, '口令不该出现在端点配置里');
    });
    // so-M6：注释契约是「含内嵌凭据（userinfo）的 URL 一律判不安全」，但 `https:` 早退
    // 排在了 userinfo 检查之前——https://user:pass@host 被判安全。凭据不该出现在端点
    // 配置里，这契约与 scheme 无关；https 的早退只该对「不含 userinfo」的 URL 生效。
    check('https + userinfo 同样判为不安全（早退不得跳过 userinfo 检查）', () => {
      assert.equal(isInsecureBaseUrl('https://user:pw@127.0.0.1:8080/v1'), true, 'https 回环 + userinfo');
      assert.equal(isInsecureBaseUrl('https://user:pw@evil.example/v1'), true, 'https 外部主机 + userinfo');
    });
    check('回环判定不接受「以回环开头的域名」', () => {
      assert.equal(isInsecureBaseUrl('http://127.0.0.1.evil.example/v1'), true);
      assert.equal(isInsecureBaseUrl('http://localhost.evil.example/v1'), true);
    });
    check('解析不了的串与空串按不安全处理（fail-closed）', () => {
      assert.equal(isInsecureBaseUrl('not a url'), true);
      assert.equal(isInsecureBaseUrl(''), true);
    });
    check('IPv6 回环仍被判为安全（new URL 去掉方括号后比对）', () => {
      assert.equal(isInsecureBaseUrl('http://[::1]:8080/v1'), false);
    });
    // 回归（2026-10-29）：server.mjs 有 4 处把完整 URL 拼进错误文案，内嵌口令会被原样回显
    // 给模型与宿主日志。endpointLabel 只留 scheme://host[:port]。
    check('错误文案用的端点简称不含 userinfo 与 path', () => {
      assert.equal(endpointLabel('http://localhost:8080@evil.example/v1'), 'http://evil.example');
      assert.equal(endpointLabel('http://user:pw@127.0.0.1:9000/v1'), 'http://127.0.0.1:9000');
      assert.equal(endpointLabel('https://api.example.com/v1'), 'https://api.example.com');
      assert.equal(endpointLabel('not a url'), '(unparsable baseUrl)');
    });
  }

  // 建议模板的三态判定（2026-10-29 修复）：旧实现把 null 折成 false，
  // `{escalate?需立即通知|无需紧急升级}` 在模型没给答案时输出「无需紧急升级」——
  // 建议层凭空给出否定结论，而同一响应的 labels.escalate 是「无法判断」、
  // needs_human_review 是 true，三个视图自相矛盾。
  {
    const tpl = '{escalate?需立即通知值班人员|无需紧急升级}';
    check('null 的 noul 不落「否」：无三态文案时整段留空', () => {
      assert.equal(renderTemplate(tpl, { decision: { escalate: null } }), '');
      assert.equal(renderTemplate(tpl, { decision: {} }), '', '键缺失同样是未知');
    });
    check('null 的 noul 走三态文案（若模板提供）', () => {
      assert.equal(
        renderTemplate('{escalate?需通知|无需升级|无法判断，请人工确认}', { decision: { escalate: null } }),
        '无法判断，请人工确认',
      );
    });
    check('真/假仍走原二态', () => {
      assert.equal(renderTemplate(tpl, { decision: { escalate: true } }), '需立即通知值班人员');
      assert.equal(renderTemplate(tpl, { decision: { escalate: false } }), '无需紧急升级');
    });
    check('AND 条件含未知项时不输出「非双真」这种假结论', () => {
      assert.equal(renderTemplate('{a&b?双真|非双真}', { decision: { a: true } }), '');
      assert.equal(renderTemplate('{a&b?双真|非双真}', { decision: { a: false } }), '非双真', 'a 已否决就是确定的假');
    });
    check('内置 16 个场景在答案缺失时都不输出否定结论', () => {
      for (const scenario of BUILTIN_SCENARIOS) {
        if (!scenario.recommendation) continue;
        const out = renderTemplate(scenario.recommendation, { decision: {} });
        assert.match(out, /无法判断|未判定|缺失/, `${scenario.id} 的模板在未知时给出了确定结论：${out}`);
      }
    });
    // 原型链：模板名来自场景配置，`constructor` 这类键走原型链会取到函数
    check('模板条件与取值不走原型链', () => {
      assert.equal(renderTemplate('{constructor?真|假}', { decision: {} }), '', '不存在的键是未知，不是真');
      assert.equal(renderTemplate('{toString}', { decision: {} }), '', '原型上的函数不得被渲染进结果');
    });
    // so-M5：占位符名字符集只认 ASCII（[\w&]+ / \w+），中文 qid 与带连字符的 id 不被
    // 当成占位符——原样漏进给模型与用户的建议文本，渲染层对它是静默的。
    // 名字口径 = Unicode 字母/数字 + _ - &（\p{L}\p{N}），ASCII 行为保持向后兼容。
    check('中文 qid 参与条件与取值渲染', () => {
      assert.equal(renderTemplate('{知识点?需补充|已明确}', { decision: { 知识点: true } }), '需补充');
      assert.equal(renderTemplate('{知识点?需补充|已明确}', { decision: { 知识点: false } }), '已明确');
      assert.equal(renderTemplate('结论：{知识点}', { labels: { 知识点: '明确' } }), '结论：明确');
    });
    check('带连字符的 qid 参与渲染（含 .key 取值与三态）', () => {
      assert.equal(renderTemplate('{my-qid?真|假}', { decision: { 'my-qid': true } }), '真');
      assert.equal(renderTemplate('{my-qid?真|假|未知}', { decision: { 'my-qid': null } }), '未知');
      assert.equal(renderTemplate('值：{my-qid.key}', { decision: { 'my-qid': 'x' } }), '值：x');
      assert.equal(renderTemplate('{my-qid}', { derived: { 'my-qid': '高' } }), '高');
    });
    check('ASCII 名字行为向后兼容（下划线、多条件与）', () => {
      assert.equal(renderTemplate('{snake_case?是|否}', { decision: { snake_case: true } }), '是');
      assert.equal(renderTemplate('{a_1&b?双真|非双真}', { decision: { a_1: true, b: true } }), '双真');
    });
  }

  // so-M5 配套校验层：recommendation 引用的名字必须落在本场景的 qid 或派生字段上，
  // 否则 renderTemplate 把未知名字静默渲染成空串——模板写错 qid 没有任何报错，
  // 建议文本缺一块却看不出来（derive 的 question 早有同类校验，模板引用层补齐同一道闸）。
  {
    const base = () => ({ id: 'tpl_check', title: 't', questions: { q: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } } } });
    check('validateScenario 拦截模板引用的未知问题/派生名', () => {
      const problems = validateScenario({ ...base(), recommendation: '结论 {q}，补充 {nope}' });
      assert.ok(problems.some((p) => /nope/.test(p)), `应指明未知名字 nope：${problems.join('；')}`);
      const derivedProblems = validateScenario({ ...base(), derive: { d: { question: 'q', map: { a: '高' } } }, recommendation: '{ghost} 与 {q}' });
      assert.ok(derivedProblems.some((p) => /ghost/.test(p)), `派生名与 qid 之外的名字同样要拦：${derivedProblems.join('；')}`);
    });
    check('validateScenario 放行合法引用（qid / 派生名 / .key / .confidence / & / 转义花括号）', () => {
      const problems = validateScenario({
        ...base(),
        derive: { d: { question: 'q', map: { a: '高' } } },
        recommendation: '{d} / {q} / {q.key} / {q.confidence} / {q&d?双真|非双真} / \\{字面\\}',
      });
      assert.deepEqual(problems, []);
    });
    check('validateScenario 拒绝场景对象的未知键并列出支持的键（拼写错不再静默回退默认）', () => {
      const problems = validateScenario({ id: 'x', title: 't', questions: { q: { type: 'noul', instructions: 'i' } }, confidence_threshold: 0.9 });
      assert.ok(
        problems.some((p) => p.includes('"confidence_threshold"') && p.includes('confidenceThreshold')),
        `应指明未知键与正确拼写：${problems.join('；')}`
      );
      // 支持的全部键都在合法定义里出现过，不得误伤
      const ok = validateScenario({
        id: 'x', title: 't', description: 'd', aliases: ['a'], questions: { q: { type: 'choice', label: 'l', instructions: 'i', criteria: { a: 'A', b: 'B' } } },
        derive: { dv: { question: 'q', map: { a: '高' } } }, recommendation: '{q}', confidenceThreshold: 0.9,
      });
      assert.deepEqual(ok, [], `合法键不得被拦：${ok.join('；')}`);
    });
    check('validateScenario 拒绝问题对象与派生条目里的未知键', () => {
      const qp = validateScenario({ id: 'x', title: 't', questions: { q: { type: 'choice', instructions: 'i', crieteria: { a: 'A', b: 'B' } } } });
      assert.ok(qp.some((p) => p.includes('"crieteria"') && p.includes('criteria')), `问题对象未知键应被拦：${qp.join('；')}`);
      const dp = validateScenario({
        id: 'x', title: 't',
        questions: { q: { type: 'score', instructions: 'i', criteria: ['低', '高'] } },
        derive: { d: { question: 'q', value: ['A', 'B'] } },
      });
      assert.ok(dp.some((p) => p.includes('派生') && p.includes('"value"')), `派生条目未知键应被拦：${dp.join('；')}`);
    });
    check('16 个内置场景全部通过严格键校验（内置定义无未知键）', () => {
      for (const s of BUILTIN_SCENARIOS) {
        const problems = validateScenario(s);
        assert.deepEqual(problems, [], `${s.id}：${problems.join('；')}`);
      }
    });
  }

  // criteria / spec.map 的原型链（2026-10-29 修复）：模型回 choice="constructor" 时，
  // 直接下标会取到 Object 构造函数 —— 逐题行渲染成 `function Object() { [native code] }`。
  {
    const q = { type: 'choice', criteria: { a: '选项A' } };
    check('逐题行不把原型函数当选项说明', () => {
      const line = renderAnswerLine('choice', '动作', { choice: 'constructor', confidence: 0.9, probabilities: {} }, q);
      assert.ok(!/native code/.test(line), line);
      assert.match(line, /constructor/, '取不到说明时应回退显示原始 key');
    });
    check('速览标签不把原型函数当选项说明', () => {
      const d = extractDecisionByType('choice', { choice: 'constructor' }, q);
      assert.ok(!/native code/.test(String(d?.label)), JSON.stringify(d));
    });
    check('派生字段的 map 查找不走原型链', () => {
      const derived = deriveFields({ risk: { question: 'sev', map: { Hi: '高' } } }, { sev: 'constructor' });
      assert.equal(derived.risk, 'constructor', '取不到映射值应回退原始值');
      assert.ok(!/native code/.test(renderTemplate('结论「{risk}」', { derived })));
    });
  }

  // data_governance 判据表与全局哨兵的冲突（2026-11 市场审查）：choice 返回 unknown 是
  // 「必须转人工」的哨兵值（isBorderlineAnswer），判据表里再放一个 unknown 选项等于该档
  // 永远不可用——模型如实答 unknown 就恒转人工。改用 other 档（对齐 test_failure 先例），
  // 哨兵语义本身不动。
  {
    const dg = BUILTIN_SCENARIOS.find((s) => s.id === 'data_governance');
    const rootCause = dg.questions.root_cause;
    check('data_governance 判据无 unknown 档（unknown 是转人工哨兵）；other 档可用且不转人工', () => {
      assert.ok(
        !Object.hasOwn(rootCause.criteria, 'unknown'),
        `root_cause 不得含 unknown 选项（会与全局哨兵冲突，该档恒转人工）：${JSON.stringify(rootCause.criteria)}`
      );
      assert.ok(Object.hasOwn(rootCause.criteria, 'other'), '应对齐 test_failure 先例提供 other 档承接「无法归类」');
      const q = { type: 'choice', criteria: rootCause.criteria };
      assert.equal(
        isBorderlineAnswer({ type: 'choice', value: 'other', confidence: 0.9 }, q, { choice: 'other' }),
        false,
        'other 是判据表内的合法选项，不应转人工'
      );
      assert.equal(
        isBorderlineAnswer({ type: 'choice', value: 'unknown', confidence: 0.9 }, q, { choice: 'unknown' }),
        true,
        'unknown 哨兵语义保持不变：仍必须转人工'
      );
    });
    check('coerceOptionMap 拒绝对象/数组描述（不产 "[object Object]" 垃圾选项）', () => {
      const obj = coerceOptionMap({ a: {}, b: 'B' });
      assert.ok(obj.problem && obj.problem.includes('"a"') && /对象/.test(obj.problem), `对象描述应报错并指明键名：${JSON.stringify(obj)}`);
      const arr = coerceOptionMap({ a: [], b: 'B' });
      assert.ok(arr.problem && /数组/.test(arr.problem), `数组描述应报错：${JSON.stringify(arr)}`);
      // 既有宽容口径保留：数字键/枚举值、数字描述 String 化；null/undefined 拦截不变
      assert.equal(coerceOptionMap({ 1: 'A', b: 'B' }).criteria['1'], 'A', '数字键 String 化宽容保留');
      assert.equal(coerceOptionMap({ a: 5, b: 'B' }).criteria.a, '5', '数字描述 String 化宽容保留');
      assert.ok(coerceOptionMap({ a: null, b: 'B' }).problem, 'null 描述拦截不变');
    });
  }

  // modelProfile 规则顺序敏感性（2026-11 model_routing 配套）：规则表先具体（家族型号片段）
  // 后宽泛（家族名），宽泛规则绝不能抢在前——否则 glm-4-flash 会被 glm 家族档案吞掉。
  {
    check('modelProfile 规则顺序敏感（具体片段先于宽泛家族名）', () => {
      assert.equal(modelProfile('glm-4-flash'), '快速档：简单机械任务、批量处理；最快最省');
      assert.equal(modelProfile('qwen-max'), '旗舰档：同家族最强能力，复杂任务首选');
      assert.equal(modelProfile('deepseek-r1'), '深度推理档：长链推理与难题求解，延迟高');
      assert.equal(modelProfile('gpt-4o'), '均衡档：通用编码与文本任务');
    });
    check('modelProfile 全未知 id 走中性兜底，规则表描述永不空串', () => {
      assert.equal(modelProfile('totally-unknown-x'), '未提供能力描述：按通用模型对待，无法体现该模型相对优势');
      for (const [, profile] of MODEL_PROFILE_RULES) {
        assert.ok(profile.trim() !== '', '规则表里的档案描述不得为空串');
      }
    });
  }

  // noul 概率越界（2026-10-29 修复）：旧实现只查有限性，noul=5 → probability=5、
  // confidence=5、decision=true 且**不触发转人工**（越界转人工契约被绕过，逐题行渲染 500.0%）。
  {
    const fill = (v) => {
      const out = { type: 'noul' };
      fillAnswerByType(out, { noul: v }, { type: 'noul' });
      return out;
    };
    check('noul=5 归 null 并转人工', () => {
      const a = fill(5);
      assert.equal(a.probability, null);
      assert.equal(a.confidence, null);
      assert.equal(isBorderlineAnswer(a, { type: 'noul' }, { noul: 5 }), true, '界外值必须转人工');
    });
    check('noul=-3 归 null 并转人工', () => {
      const a = fill(-3);
      assert.equal(a.probability, null);
      assert.equal(isBorderlineAnswer(a, { type: 'noul' }, { noul: -3 }), true);
    });
    check('边界值 0 与 1 仍然合法（不成越界）', () => {
      assert.equal(fill(0).probability, 0);
      assert.equal(fill(1).probability, 1);
      assert.equal(isBorderlineAnswer(fill(1), { type: 'noul' }, { noul: 1 }), false);
    });
  }

  // score 分值的类型收窄（so-M1）：Number('') === 0、Number(false) === 0、Number([]) === 0、
  // Number(true) === 1——上游把「没给分值」回成空串/布尔/数组时，Number() 强转会把它们捏造
  // 成合法分值，再取 legend[0] 捏造等级标签，needs_human_review=false 静默放行。与 noul 的
  // typeof 收窄同口径：只有有限数字与非空数字字符串可用，其余一律归 null 走转人工路径。
  {
    const LEVELS = ['轻微', '可逆', '难回滚', '不可逆'];
    const fill = (raw) => {
      const out = { type: 'score' };
      fillAnswerByType(out, raw, { type: 'score', criteria: LEVELS });
      return out;
    };
    const borderline = (raw) => isBorderlineAnswer(fill(raw), { type: 'score', criteria: LEVELS }, raw);
    check('score="" 归 null 并转人工，不捏造 0 分与等级标签', () => {
      const a = fill({ score: '', legend: { '0': '轻微问题' }, confidence: 0.91 });
      assert.equal(a.value, null);
      assert.equal(a.level, null, '不得用捏造的 0 分去取 legend[0]');
      assert.equal(borderline({ score: '', confidence: 0.91 }), true);
    });
    check('score=false / true / [] 同样归 null', () => {
      for (const raw of [false, true, []]) {
        assert.equal(fill({ score: raw, confidence: 0.9 }).value, null, `score=${JSON.stringify(raw)} 不得被 Number() 捏成分值`);
        assert.equal(borderline({ score: raw, confidence: 0.9 }), true, `score=${JSON.stringify(raw)} 必须转人工`);
      }
    });
    check('非空数字字符串 "0.8" 仍被接受（既有宽容口径保留）', () => {
      assert.equal(fill({ score: '0.8', confidence: 0.9 }).value, 0.8);
      assert.equal(borderline({ score: '0.8', confidence: 0.9 }), false);
    });
    check('score=null / 缺失字段既有行为不变（归 null）', () => {
      assert.equal(fill({ score: null, confidence: 0.9 }).value, null);
      assert.equal(fill({ confidence: 0.9 }).value, null);
    });
  }

  // 问题 id 为 __proto__ 时不得静默丢题（2026-10-29 修复）：普通对象上 `obj["__proto__"] = v`
  // 触发原型 setter，该题不进请求体也没有任何报错。
  {
    const request = Object.create(null);
    request['__proto__'] = { type: 'choice', instructions: 'x' };
    check('无原型对象承载 __proto__ 键（不进原型 setter）', () => {
      assert.deepEqual(Object.keys(request), ['__proto__']);
      assert.equal(Object.getPrototypeOf(request), null);
      assert.match(JSON.stringify(request), /"__proto__"/);
    });
  }

  // 自定义场景的问题 id 为 __proto__（2026-10-31 市场审查）：normalizeScenario 曾用裸 {}
  // 承载问题表，赋值落进原型 setter、该题静默消失，而 validateScenario 判它合法——
  // 场景能加载但少了题，运行期表现为莫名其妙的 invalid_params。JSON 串直写避免 JS 字面量
  // 的 __proto__ 特殊语义。
  {
    const { scenarios } = resolveScenarios([
      {
        label: 'custom',
        json: '[{"id":"proto-question","title":"t","description":"","questions":{"__proto__":{"type":"noul","label":"可接受吗","instructions":"可接受吗？"}},"derive":{},"recommendation":""}]',
      },
    ]);
    const loaded = scenarios.find((s) => s.id === 'proto-question');
    check('自定义场景 __proto__ 问题 id 不被静默丢弃', () => {
      assert.ok(loaded, '场景应已加载');
      assert.deepEqual(Object.keys(loaded.questions), ['__proto__']);
      assert.match(JSON.stringify(loaded.questions), /"__proto__"/);
    });
  }

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
