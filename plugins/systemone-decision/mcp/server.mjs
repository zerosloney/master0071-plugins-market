#!/usr/bin/env node
// systemone-decision MCP server — stdio JSON-RPC, zero dependencies, requires Node >= 18.
// 供应商配置见插件 README.md：SYSTEMONE_API_KEY / SYSTEMONE_BASE_URL / SYSTEMONE_MODEL / SYSTEMONE_TIMEOUT_MS。
// stdout 只输出 JSON-RPC 消息，诊断信息一律走 stderr。

const SERVER_INFO = { name: 'systemone-decision', version: '0.1.1' };
const SUPPORTED_TYPES = ['choice', 'noul', 'score'];

class ToolError extends Error {}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function snippet(s) {
  const t = String(s);
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

function config() {
  // 配置优先级：ZCode 插件设置页（注入 SYSTEMONE_PLUGIN_*，空串视为未配置）> 环境变量 > 内置默认
  const timeoutRaw = Number(process.env.SYSTEMONE_PLUGIN_TIMEOUT_MS || process.env.SYSTEMONE_TIMEOUT_MS);
  return {
    apiKey: process.env.SYSTEMONE_API_KEY || process.env.UNISOUND_API_KEY || '',
    baseUrl: (process.env.SYSTEMONE_PLUGIN_BASE_URL || process.env.SYSTEMONE_BASE_URL || 'https://maas-api.unisound.com/v1').replace(/\/+$/, ''),
    model: process.env.SYSTEMONE_PLUGIN_MODEL || process.env.SYSTEMONE_MODEL || 'u2-decision',
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30000,
  };
}

// ---------- 信任边界校验：发给外部 API 的请求体在此统一校验 ----------

function validateState(state) {
  if (typeof state !== 'string' && (state === null || typeof state !== 'object')) {
    throw new ToolError('state 必须是字符串、对象或数组');
  }
  if (typeof state === 'string' && state.trim() === '') {
    throw new ToolError('state 不能是空字符串');
  }
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new ToolError('questions 必须是 {问题ID: 问题对象} 映射，且至少包含一个问题');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new ToolError('questions 至少包含一个问题');
  }
  for (const [qid, q] of entries) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new ToolError(`questions.${qid} 必须是对象`);
    }
    if (!SUPPORTED_TYPES.includes(q.type)) {
      throw new ToolError(`questions.${qid}.type 必须是 ${SUPPORTED_TYPES.join(' / ')}，收到: ${JSON.stringify(q.type)}`);
    }
    if (!isNonEmptyString(q.instructions)) {
      throw new ToolError(`questions.${qid}.instructions 必须是非空字符串`);
    }
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length === 0) {
        throw new ToolError(`questions.${qid}.criteria 必须是非空对象 {选项ID: 选项描述}`);
      }
      if (Object.keys(c).length > 255) {
        throw new ToolError(`questions.${qid}.criteria 选项数超过上限 255`);
      }
      for (const [k, v] of Object.entries(c)) {
        if (!isNonEmptyString(k) || !isNonEmptyString(v)) {
          throw new ToolError(`questions.${qid}.criteria 每个选项的 ID 和描述必须是非空字符串`);
        }
      }
    }
    if (q.type === 'score') {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length === 0) {
        throw new ToolError(`questions.${qid}.criteria 必须是非空数组 [等级描述, ...]，索引即分值`);
      }
      if (c.length > 255) {
        throw new ToolError(`questions.${qid}.criteria 等级数超过上限 255`);
      }
      for (const v of c) {
        if (!isNonEmptyString(v)) {
          throw new ToolError(`questions.${qid}.criteria 的每个等级描述必须是非空字符串`);
        }
      }
    }
  }
}

// ---------- 供应商接入点：换厂商只改环境变量，不动这里 ----------

async function callSystemone(state, questions) {
  const cfg = config();
  if (!cfg.apiKey) {
    throw new ToolError(
      '缺少 API Key：请设置环境变量 SYSTEMONE_API_KEY（或 UNISOUND_API_KEY）后重启 ZCode。' +
        'Key 只能走环境变量（插件设置页不支持保存密钥），unisound 的 Key 在 https://maas.unisound.com/admin/project/api-key 管理。'
    );
  }
  const url = `${cfg.baseUrl}/systemone`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) {
      throw new ToolError(`systemone 请求超时（${cfg.timeoutMs}ms）：POST ${url}`);
    }
    throw new ToolError(`systemone 请求失败：POST ${url}，原因：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (/permission/i.test(text)) {
      hint =
        `。提示：Key 认证已通过，但没有 ${cfg.model} 模型权限——` +
        '请到 MaaS 控制台确认该 Key 所属项目已开通对应模型；' +
        '若是刚更换过 SYSTEMONE_API_KEY，注意运行中的进程持有启动时的环境变量快照，需重启宿主程序后生效';
    }
    throw new ToolError(`systemone HTTP ${res.status}：${snippet(text)}（POST ${url}）${hint}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ToolError(`systemone 响应不是合法 JSON：${snippet(text)}`);
  }
  if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
    throw new ToolError(`systemone 响应缺少 answers 字段：${snippet(text)}`);
  }
  return data;
}

// ---------- 响应归一化 ----------

function normalizeAnswer(question, answer) {
  if (!answer || typeof answer !== 'object') {
    return { present: false };
  }
  const out = { present: true, type: answer.type || question.type };
  if (out.type === 'choice') {
    out.value = answer.choice ?? null;
    out.probabilities = answer.probabilities || {};
    out.confidence =
      typeof answer.confidence === 'number' ? answer.confidence : (answer.probabilities || {})[answer.choice] ?? null;
  } else if (out.type === 'noul') {
    // noul 无独立 confidence 字段，用概率的决断度 max(p, 1-p) 代替
    const p = typeof answer.noul === 'number' ? answer.noul : null;
    out.probability = p;
    out.confidence = p === null ? null : Math.max(p, 1 - p);
  } else if (out.type === 'score') {
    out.value = typeof answer.score === 'number' ? Math.round(answer.score * 1000) / 1000 : null;
    out.level = (answer.legend || {})[String(Math.round(answer.score ?? 0))] ?? null;
    out.probabilities = answer.probabilities || {};
    out.confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
  }
  return out;
}

function metaOf(data) {
  return {
    model: data.model,
    request_id: data.request_id,
    latency_ms: data.latency_ms,
    usage: data.usage,
  };
}

async function runDecision(state, questions, threshold) {
  validateState(state);
  validateQuestions(questions);
  const data = await callSystemone(state, questions);
  const answers = {};
  const low = [];
  for (const [qid, q] of Object.entries(questions)) {
    const a = normalizeAnswer(q, data.answers[qid]);
    answers[qid] = a;
    if (a.present && a.confidence !== null && a.confidence < threshold) low.push(qid);
  }
  return {
    answers,
    needs_human_review: low.length > 0,
    low_confidence_questions: low,
    confidence_threshold: threshold,
    meta: metaOf(data),
    raw: data,
  };
}

function thresholdOf(args) {
  if (args.confidenceThreshold === undefined) return 0.7;
  const t = Number(args.confidenceThreshold);
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    throw new ToolError('confidenceThreshold 必须是 0~1 之间的数字');
  }
  return t;
}

function requireText(args, key, what) {
  const v = args[key];
  if (!isNonEmptyString(v)) {
    throw new ToolError(`${key} 必须是非空字符串（${what}）`);
  }
  return v;
}

// ---------- 预设默认判据（调用方可整体覆盖） ----------

const SEVERITY_LEVELS = [
  '轻微问题，不影响功能',
  '部分功能受影响，但存在替代方案',
  '核心功能不可用，没有替代方案',
  '造成严重业务或安全影响',
];

const TICKET_DEPARTMENTS = {
  technical: '产品故障、集成和技术缺陷类问题',
  billing: '支付、退款、账单和计费问题',
  account: '账号、登录、权限和安全问题',
  product: '产品功能咨询、使用帮助和需求建议',
  other: '无法归入以上类别的其他问题',
};

const MODERATION_ACTIONS = {
  approve: '内容合规，直接通过',
  review: '存在可疑内容，转人工复审',
  reject: '内容明显违规，拒绝发布或屏蔽',
};

const MODERATION_CATEGORIES = {
  none: '无违规内容',
  spam_ads: '垃圾广告或灌水',
  fraud: '欺诈、诈骗',
  pornography: '色情低俗',
  violence: '暴力血腥',
  insult: '辱骂或人身攻击',
  politics: '政治敏感内容',
  privacy: '泄露隐私或机密信息',
  other: '其他违规',
};

const RISK_LEVELS = ['无风险', '轻微风险，不影响使用者', '中等风险，需要处理', '严重风险，须立即处置'];

const AGENT_ROSTER = {
  generalist: '通用助手：日常问答、简单事务处理',
  coder: '编码助手：代码编写、调试、重构、技术问题',
  researcher: '研究助手：信息检索、资料汇总、深度调研',
  data_analyst: '数据分析助手：数据处理、统计分析、图表制作',
  writer: '写作助手：文案、文档、创意写作',
};

const COMPLEXITY_LEVELS = [
  '简单任务，一步即可完成',
  '中等任务，需要少量推理或工具调用',
  '复杂任务，需要多步推理和多次工具调用',
  '极复杂任务，需要长期规划或多智能体协作',
];

const VERIFY_ISSUES = {
  none: '未发现问题',
  factual_error: '存在事实性错误',
  incomplete: '遗漏了任务要求',
  hallucination: '编造了不存在的内容、数据或引用',
  unsafe: '存在安全或合规风险',
  format: '格式或形式不符合要求',
};

const QUALITY_LEVELS = [
  '质量差，需要重做',
  '质量一般，存在明显缺陷',
  '质量良好，仅有可接受的小问题',
  '质量优秀，可直接采用',
];

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'systemone_decide',
    description:
      '通用决策（SystemOne 协议）：一次请求对同一业务上下文提出多个结构化问题（choice 单选 / noul 概率 / score 评分），' +
      '返回带概率分布和置信度的判定。工单分流、内容审核、Agent 路由、结果校验以外的自定义决策场景用它。',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: ['string', 'object', 'array'],
          description: '业务上下文：工单文本、对话数组或结构化对象，非字符串会被序列化后送入模型',
        },
        questions: {
          type: 'object',
          description:
            '问题映射 {问题ID: 问题对象}。问题对象：{type: "choice", instructions, criteria: {选项ID: 描述}} | ' +
            '{type: "noul", instructions}（回答是/否类，返回 0~1 概率）| {type: "score", instructions, criteria: [等级描述...]}（索引即分值）',
        },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['state', 'questions'],
    },
    handler: async (args) => runDecision(args.state, args.questions, thresholdOf(args)),
  },
  {
    name: 'ticket_triage',
    description: '工单分流：判断工单归属团队（单选）、严重程度（评分）、是否需要立即升级/通知值班（概率），一次调用全部返回。',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: '工单内容（用户描述、对话记录等）' },
        departments: {
          type: 'object',
          description: '可选，覆盖默认团队判据，格式 {团队ID: 团队职责描述}；提供即整体替换默认值',
          additionalProperties: { type: 'string' },
        },
        severity_levels: { type: 'array', items: { type: 'string' }, description: '可选，覆盖默认严重程度等级描述（索引即分值）' },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['ticket'],
    },
    handler: async (args) =>
      runDecision(
        requireText(args, 'ticket', '工单内容'),
        {
          department: { type: 'choice', instructions: '该工单应分派给哪个团队处理？', criteria: args.departments || TICKET_DEPARTMENTS },
          severity: { type: 'score', instructions: '该工单的严重程度是？', criteria: args.severity_levels || SEVERITY_LEVELS },
          escalate: { type: 'noul', instructions: '该工单是否需要立即升级或通知值班人员处理？' },
        },
        thresholdOf(args)
      ),
  },
  {
    name: 'content_moderate',
    description: '内容审核：判断处置动作（通过/复审/拒绝）、违规类型（单选）、风险等级（评分），一次调用全部返回。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '待审核内容（文章、评论、消息等）' },
        actions: {
          type: 'object',
          description: '可选，覆盖默认处置动作，格式 {动作ID: 动作描述}；提供即整体替换默认值',
          additionalProperties: { type: 'string' },
        },
        categories: {
          type: 'object',
          description: '可选，覆盖默认违规类型，格式 {类型ID: 类型描述}；提供即整体替换默认值',
          additionalProperties: { type: 'string' },
        },
        risk_levels: { type: 'array', items: { type: 'string' }, description: '可选，覆盖默认风险等级描述（索引即分值）' },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['content'],
    },
    handler: async (args) =>
      runDecision(
        requireText(args, 'content', '待审核内容'),
        {
          action: { type: 'choice', instructions: '应如何处置该内容？', criteria: args.actions || MODERATION_ACTIONS },
          category: { type: 'choice', instructions: '该内容的主要违规类型是？', criteria: args.categories || MODERATION_CATEGORIES },
          risk: { type: 'score', instructions: '该内容的风险等级是？', criteria: args.risk_levels || RISK_LEVELS },
        },
        thresholdOf(args)
      ),
  },
  {
    name: 'agent_route',
    description: 'Agent 路由：为任务选择执行 Agent（单选）、评估复杂度（评分）、判断是否需要转交人工（概率），一次调用全部返回。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述（可含上下文、对话历史、约束条件）' },
        agents: {
          type: 'object',
          description: '可选，覆盖默认 Agent 名册，格式 {AgentID: 能力描述}；提供即整体替换默认值。建议传入实际可用的 Agent 列表',
          additionalProperties: { type: 'string' },
        },
        complexity_levels: { type: 'array', items: { type: 'string' }, description: '可选，覆盖默认复杂度等级描述（索引即分值）' },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['task'],
    },
    handler: async (args) =>
      runDecision(
        requireText(args, 'task', '任务描述'),
        {
          agent: { type: 'choice', instructions: '该任务应交给哪个 Agent 执行？', criteria: args.agents || AGENT_ROSTER },
          complexity: { type: 'score', instructions: '该任务的复杂度是？', criteria: args.complexity_levels || COMPLEXITY_LEVELS },
          needs_human: { type: 'noul', instructions: '该任务是否高风险或超出 Agent 能力，需要转交人工处理？' },
        },
        thresholdOf(args)
      ),
  },
  {
    name: 'verify_result',
    description: '结果校验：给定原始任务和待检结果，判断是否满足要求（概率）、主要问题（单选）、质量等级（评分），一次调用全部返回。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '原始任务/要求（判定基准）' },
        result: { type: 'string', description: '待校验的结果（Agent 输出、模型回答等）' },
        issues: {
          type: 'object',
          description: '可选，覆盖默认问题类型，格式 {问题ID: 问题描述}；提供即整体替换默认值',
          additionalProperties: { type: 'string' },
        },
        quality_levels: { type: 'array', items: { type: 'string' }, description: '可选，覆盖默认质量等级描述（索引即分值）' },
        confidenceThreshold: { type: 'number', description: '低置信度判定阈值，默认 0.7' },
      },
      required: ['task', 'result'],
    },
    handler: async (args) => {
      const task = requireText(args, 'task', '原始任务');
      const result = requireText(args, 'result', '待校验结果');
      return runDecision(
        { task, result },
        {
          passed: { type: 'noul', instructions: '该结果是否正确满足了任务的全部要求？' },
          main_issue: { type: 'choice', instructions: '该结果的主要问题是？', criteria: args.issues || VERIFY_ISSUES },
          quality: { type: 'score', instructions: '该结果的质量等级是？', criteria: args.quality_levels || QUALITY_LEVELS },
        },
        thresholdOf(args)
      );
    },
  },
];

// ---------- stdio JSON-RPC 主循环 ----------

function reply(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function dispatch(msg) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      return {
        protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const params = msg.params || {};
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) {
        throw new RpcError(-32602, `未知工具: ${params.name}`);
      }
      try {
        const result = await tool.handler(params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        if (e instanceof ToolError) {
          return { content: [{ type: 'text', text: `工具 ${tool.name} 失败：${e.message}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `工具 ${tool.name} 异常：${e.message || e}` }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') continue;
    if (msg.id === undefined || msg.id === null) continue; // notification，无需响应
    dispatch(msg)
      .then((result) => reply({ jsonrpc: '2.0', id: msg.id, result }))
      .catch((e) => {
        const code = e instanceof RpcError ? e.code : -32603;
        reply({ jsonrpc: '2.0', id: msg.id, error: { code, message: e.message || String(e) } });
      });
  }
});
process.stdin.on('end', () => process.exit(0));

process.on('uncaughtException', (e) => {
  process.stderr.write(`[systemone-decision] uncaught: ${e.stack || e}\n`);
});
