// format.mjs — 决策结果的归一化、派生、模板渲染与 Markdown 摘要。纯函数，零依赖。

/**
 * 取出可用的 score 数值，无效时返回 null。
 * 绝不能用 `?? 0` 或直接 `Number()` 兜底：`null ?? 0` 得 0，而 `Number(null) === 0`，
 * 两者都会把「模型没给分值」悄悄变成 0 分，再经 legend[0] 捏造出一个最低等级标签，
 * 产出一条看起来完全正常、confidence 还很高的假判定。所有 score 读取都必须走这里。
 * @param {object} answer - SystemOne 原始答案
 * @returns {number | null}
 */
function finiteScore(answer) {
  const raw = answer ? answer.score : undefined;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一化单个答案为逐题明细（answers[qid]）。
 * @param {object} question - 问题定义（含 type / criteria）
 * @param {object} answer - SystemOne 原始答案
 * @returns {object} { present, type, value?, level?, probabilities?, probability?, confidence? }
 */
export function normalizeAnswer(question, answer) {
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
    const score = finiteScore(answer);
    out.value = score === null ? null : Math.round(score * 1000) / 1000;
    out.level = score === null ? null : (answer.legend || {})[String(Math.round(score))] ?? null;
    out.probabilities = answer.probabilities || {};
    out.confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
  }
  return out;
}

/**
 * 把原始 answers 归一化为速览结构：decision（归一化判定值）+ labels（可读标签）+ confidences。
 * choice → 选项 key；score → 取整分值；noul → boolean（≥0.5 为真）。
 * @param {object} rawAnswers - SystemOne 原始 answers
 * @param {object} questions - 问题定义（提供 criteria 兜底标签）
 */
export function normalizeDecision(rawAnswers, questions = {}) {
  const decision = {};
  const labels = {};
  const confidences = {};

  for (const [qid, question] of Object.entries(questions)) {
    const raw = rawAnswers?.[qid];
    const type = question?.type || raw?.type;
    if (!raw || typeof raw !== 'object') continue;

    if (type === 'choice') {
      const key = raw.choice ?? null;
      decision[qid] = key;
      labels[qid] = key != null ? (question?.criteria?.[key] ?? raw.choice ?? String(key)) : '无法判断';
      if (Number.isFinite(Number(raw.confidence))) confidences[qid] = Number(raw.confidence);
      continue;
    }
    if (type === 'score') {
      const score = finiteScore(raw);
      const idx = score === null ? null : Math.round(score);
      decision[qid] = idx;
      const legend = raw.legend || {};
      const scale = Array.isArray(question?.criteria) ? question.criteria : [];
      labels[qid] = idx != null ? (legend[String(idx)] ?? scale[idx] ?? String(idx)) : '无法判断';
      if (Number.isFinite(Number(raw.confidence))) confidences[qid] = Number(raw.confidence);
      continue;
    }
    if (type === 'noul') {
      const v = Number(raw.noul);
      const flag = Number.isFinite(v) ? v >= 0.5 : null;
      decision[qid] = flag;
      labels[qid] = flag === null ? '无法判断' : flag ? '是' : '否';
      if (Number.isFinite(v)) confidences[qid] = flag ? v : 1 - v;
      continue;
    }
  }
  return { decision, labels, confidences };
}

/**
 * 计算派生字段，如 { priority: { question: 'severity', values: ['P4','P3','P2','P1'] } }。
 * 分值取整并钳制到 values 下标范围内；也支持 { question, map: {选项key: 值} } 形式。
 */
export function deriveFields(deriveSpec, decision) {
  const derived = {};
  for (const [name, spec] of Object.entries(deriveSpec || {})) {
    if (!spec || typeof spec !== 'object' || typeof spec.question !== 'string') continue;
    const value = decision?.[spec.question];
    if (Array.isArray(spec.values)) {
      // 判空必须显式做：Number(null) === 0，缺分值会被钳到 values[0] 派生出
      // 一个凭空而来的最低档（如 severity 未知 → priority P4）
      if (value === null || value === undefined) continue;
      const idx = Number(value);
      if (!Number.isFinite(idx)) continue;
      const clamped = Math.min(Math.max(Math.round(idx), 0), spec.values.length - 1);
      derived[name] = spec.values[clamped];
    } else if (spec.map && typeof spec.map === 'object') {
      if (value == null) continue;
      derived[name] = spec.map[String(value)] ?? String(value);
    }
  }
  return derived;
}

/**
 * 渲染建议模板。支持：
 *   {qid}              → 可读标签（choice=选项说明，score=分级说明，noul=是/否）
 *   {qid.key}          → 原始值（choice=选项 key，score=取整分值，noul=true/false）
 *   {qid.confidence}   → 置信度百分比
 *   {derivedName}      → 派生字段
 *   {qid?文案A|文案B}   → 条件文案（noul 为真 / 分值 ≥1 / choice 非空且非 none 类哨兵值时取 A；不支持嵌套）
 */
export function renderTemplate(template, { labels = {}, decision = {}, confidences = {}, derived = {} } = {}) {
  if (!template) return '';
  const ctx = { labels, decision, confidences, derived };
  let out = String(template);
  out = out.replace(/\{(\w+)\?([^{}]*)\|([^{}]*)\}/g, (_, name, thenText, elseText) =>
    truthy(name, ctx) ? thenText : elseText
  );
  out = out.replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, name, prop) => {
    if (prop === 'key') return stringify(decision[name]);
    if (prop === 'confidence') {
      const c = confidences[name];
      return Number.isFinite(c) ? `${(c * 100).toFixed(1)}%` : '';
    }
    if (name in labels) return stringify(labels[name]);
    if (name in derived) return stringify(derived[name]);
    return stringify(decision[name]);
  });
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 判定值是否视为"真"：boolean 直取；数字 ≥1 为真；
 * 字符串排除空串与 none/normal/no/false/0 哨兵值（如审核 category 选了 none）。
 */
function truthy(name, { decision, derived }) {
  if (name in derived) {
    const v = derived[name];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v >= 1;
    return !FALSY_TOKENS.includes(String(v).toLowerCase());
  }
  const value = decision[name];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value >= 1;
  if (typeof value === 'string') return !FALSY_TOKENS.includes(value.toLowerCase());
  return Boolean(value);
}

const FALSY_TOKENS = ['', 'none', 'normal', 'no', 'false', '0'];

function stringify(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** 把原始 answers 渲染为 Markdown 逐题行（带问题显示名、置信度与前三概率分布）。 */
export function formatAnswerLines(questions, rawAnswers) {
  const lines = [];
  for (const [qid, question] of Object.entries(questions || {})) {
    const raw = rawAnswers?.[qid];
    if (!raw || typeof raw !== 'object') {
      lines.push(`- **${question?.label || qid}**：无法判断（响应缺失）`);
      continue;
    }
    const label = question?.label || qid;
    if (raw.type === 'choice') lines.push(choiceLine(label, raw, question));
    else if (raw.type === 'score') lines.push(scoreLine(label, raw, question));
    else if (raw.type === 'noul') lines.push(noulLine(label, raw));
    else lines.push(`- **${label}**：${JSON.stringify(raw)}`);
  }
  return lines;
}

function choiceLine(label, answer, question) {
  const { choice, confidence, probabilities } = answer;
  const text = choice != null ? (question?.criteria?.[choice] ?? choice) : '无法判断';
  return `- **${label}**：${text}（置信度 ${fmtPct(confidence)}｜分布 ${topProbs(probabilities, 3)}）`;
}

function scoreLine(label, answer, question) {
  const { confidence, legend, probabilities } = answer;
  const score = finiteScore(answer);
  const idx = score === null ? null : Math.round(score);
  const text =
    idx != null
      ? (legend?.[String(idx)] ?? (Array.isArray(question?.criteria) ? question.criteria[idx] : undefined) ?? String(idx))
      : '无法判断';
  const raw = score === null ? '' : ` ${score.toFixed(2)}`;
  return `- **${label}**：${text}${raw}（置信度 ${fmtPct(confidence)}｜分布 ${topProbs(probabilities, 3)}）`;
}

function noulLine(label, answer) {
  const v = Number(answer.noul);
  if (!Number.isFinite(v)) return `- **${label}**：无法判断`;
  return `- **${label}**：${v >= 0.5 ? '是' : '否'}（${(v * 100).toFixed(1)}%）`;
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '?';
}

function topProbs(probabilities, n = 3) {
  const entries = Object.entries(probabilities || {})
    .filter(([, p]) => Number.isFinite(Number(p)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, n);
  if (!entries.length) return '—';
  return entries.map(([k, p]) => `${k}=${(Number(p) * 100).toFixed(1)}%`).join(' ');
}

/** 生成整个决策结果的 Markdown 摘要。 */
export function buildSummary({ title, model, requestId, latencyMs, lines = [], recommendation, needsReview, lowQuestions = [] }) {
  const out = [`## ${title}`];
  if (model) {
    out.push(`- **决策服务**：${model}${requestId ? `（请求 ${requestId}，延迟 ${latencyMs}ms）` : ''}`);
  }
  out.push(...lines);
  if (recommendation) out.push(`- **建议**：${recommendation}`);
  out.push(
    needsReview
      ? `- **建议复核**：需要人工复核（低置信或无法判断：${lowQuestions.join('、')}）`
      : '- **建议复核**：无需人工复核'
  );
  return out.filter(Boolean).join('\n');
}
