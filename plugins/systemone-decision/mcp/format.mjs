// format.mjs — 决策结果的归一化管线、派生、模板渲染与 Markdown 摘要。
// 各题型的答案归一化、速览判定、逐题渲染分支收拢在 question-types.mjs，这里只负责迭代与兜底。纯函数，零依赖。

import { extractDecisionByType, fillAnswerByType, renderAnswerLine } from './question-types.mjs';

/**
 * 归一化单个答案为逐题明细（answers[qid]）。题型分支见 question-types.mjs 的 ANSWER_FILLERS。
 * @param {object} question - 问题定义（含 type / criteria）
 * @param {object} answer - SystemOne 原始答案
 * @returns {object} { present, type, value?, level?, probabilities?, probability?, confidence? }
 */
export function normalizeAnswer(question, answer) {
  if (!answer || typeof answer !== 'object') {
    return { present: false };
  }
  // 题型以问题定义为准：响应回显的 type 若与所问题型错乱，按所问题型取值必然取空
  // （value/confidence 缺失），再由 isBorderlineAnswer 兜底转人工——
  // 若反过来信响应的 type，错乱答案会被当成成功判定放行（decision 与 needs_human_review 互相矛盾）
  const out = { present: true, type: question.type || answer.type };
  fillAnswerByType(out, answer, question);
  return out;
}

/**
 * 把原始 answers 归一化为速览结构：decision（归一化判定值）+ labels（可读标签）+ confidences。
 * 各题型的判定值/标签/置信度语义见 question-types.mjs 的 DECISION_EXTRACTORS。
 * @param {object} rawAnswers - SystemOne 原始 answers
 * @param {object} questions - 问题定义（提供 criteria 兜底标签）
 */
export function normalizeDecision(rawAnswers, questions = {}) {
  // 无原型对象承载（2026-10-29）：qid 来自调用方/场景 JSON，`__proto__` 作为键写入普通对象
  // 会触发原型 setter，该题的 decision/label 静默丢失，而同一响应的 answers 里有它——
  // 三个视图互相矛盾且没有任何报错。与 server.mjs 的 request/answers 同口径。
  const decision = Object.create(null);
  const labels = Object.create(null);
  const confidences = Object.create(null);

  for (const [qid, question] of Object.entries(questions)) {
    const raw = rawAnswers?.[qid];
    const type = question?.type || raw?.type;
    if (!raw || typeof raw !== 'object') continue;
    const extracted = extractDecisionByType(type, raw, question);
    if (!extracted) continue;
    decision[qid] = extracted.decision;
    labels[qid] = extracted.label;
    if (extracted.confidence !== undefined) confidences[qid] = extracted.confidence;
  }
  return { decision, labels, confidences };
}

/**
 * 计算派生字段，如 { priority: { question: 'severity', values: ['P4','P3','P2','P1'] } }。
 * 分值取整并钳制到 values 下标范围内；也支持 { question, map: {选项key: 值} } 形式。
 */
export function deriveFields(deriveSpec, decision) {
  // 派生字段名来自场景配置，同样可能是 __proto__ —— 用无原型对象承载
  const derived = Object.create(null);
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
      const picked = spec.values[clamped];
      // values 为空数组时 clamped 算出 -1、取到 undefined。绝不能把 undefined 写进 derived：
      // 模板 truthy() 只看 `name in derived`，键一存在 {d?A|B} 就无条件命中 A，
      // 派生没值却输出「命中」结论。
      if (picked === undefined) continue;
      derived[name] = picked;
    } else if (spec.map && typeof spec.map === 'object') {
      if (value == null) continue;
      // Object.hasOwn 而非直接下标（2026-10-29 修复）：`spec.map["constructor"]` 沿原型链取到
      // Object 构造函数，派生值于是变成一个函数，模板渲染出
      // `结论「function Object() { [native code] }」`。同文件 399 行早已用 hasOwn 修过判定层，
      // 取值层漏修。取不到就走 String(value) 兜底（与本分支原有语义一致）。
      const mapped = Object.hasOwn(spec.map, String(value)) ? spec.map[String(value)] : undefined;
      derived[name] = mapped ?? String(value);
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
 *   {qid?文案A|文案B|文案C} → 三态条件（真 / 假 / **未知**；不支持嵌套）
 *   {qid?文案A|文案B}   → 二态条件（真 / 假）；**未知时不输出任何文案**
 *   {qid?文案A}        → then-only 条件（为假或未知输出空）
 *   {a&b?文案A|文案B}  → 多条件与（任一为假取 B；否则任一未知则整体未知）
 *   \{ 与 \}           → 字面花括号（JSON 源里写作 "\\{" 与 "\\}"）
 *
 * 「未知」= 该题答案缺失、或值本身是 null/undefined（如模型没给 noul 概率）。
 * 第三态是 2026-10-29 修的缺陷：旧实现把 null 折成 false，`{escalate?需立即通知|无需紧急升级}`
 * 在模型没给答案时输出「无需紧急升级」——建议层凭空给出否定结论，而同一响应的
 * labels.escalate 是「无法判断」、needs_human_review 是 true，三视图自相矛盾。
 * 现在未知不再落 A/B 二元：有三态文案就用它，没有就**什么都不输出**（宁缺勿造）。
 *
 * 条件文案 A/B/C 里不要再写 {…} 占位符：条件替换先于取值替换执行，其产物会被第二遍扫描，
 * 写了会被当作占位符意外处理（用户文档见 references/scenarios.md 的建议模板语法）。
 */
export function renderTemplate(template, { labels = {}, decision = {}, confidences = {}, derived = {} } = {}) {
  if (!template) return '';
  const ctx = { labels, decision, confidences, derived };
  let out = String(template).replace(/\\([{}])/g, '\u0000$1');
  out = out.replace(
    /\{([\w&]+)\?([^{}|]*)(?:\|([^{}|]*))?(?:\|([^{}|]*))?\}/g,
    (_, names, thenText, elseText, unknownText) => {
      const state = conditionState(names.split('&'), ctx);
      if (state === true) return thenText;
      if (state === false) return elseText ?? '';
      // 未知：只有显式声明了第三条才输出，否则留空——不能拿 B 冒充「否」
      return unknownText ?? '';
    },
  );
  out = out.replace(/\{(\w+)(?:\.(\w+))?\}/g, (_, name, prop) => {
    if (prop === 'key') return stringify(decision[name]);
    if (prop === 'confidence') {
      const c = confidences[name];
      return Number.isFinite(c) ? `${(c * 100).toFixed(1)}%` : '';
    }
    if (Object.hasOwn(labels, name)) return stringify(labels[name]);
    if (Object.hasOwn(derived, name)) return stringify(derived[name]);
    // 最后一层同样要 hasOwn（2026-10-29）：`{toString}` / `{constructor}` 这类占位符直接下标
    // 会沿原型链取到函数，渲染出 `function toString() { [native code] }` 进结论。
    // 键不存在就是「没有这个值」，输出空串。
    return Object.hasOwn(decision, name) ? stringify(decision[name]) : '';
  });
  return out.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

/** 合并多个条件的判定：三值逻辑（Kleene）。
 *  任一为假 → 假（不必再看别的：`a&b` 里 a 已经否决）；否则任一未知 → 未知；全真 → 真。
 *  用三值而不是「未知当假」，才能让 `{a&b?…}` 在 b 未知时不输出「非双真」这种假结论。 */
function conditionState(names, ctx) {
  let unknown = false;
  for (const name of names) {
    const state = stateOf(name, ctx);
    if (state === false) return false;
    if (state === null) unknown = true;
  }
  return unknown ? null : true;
}

/**
 * 三态判定：boolean 直取；数字 ≥1 为真；字符串排除空串与 none/normal/no/false/0 哨兵值
 * （如审核 category 选了 none）；**null / undefined / 键不存在 = 未知**。
 *
 * 查表一律用 Object.hasOwn：模板名来自场景配置与模型输出，`constructor` / `toString`
 * 这类键走原型链会取到函数（渲染成 `function Object() { [native code] }`）。
 */
function stateOf(name, { decision, derived }) {
  if (Object.hasOwn(derived, name)) return triValue(derived[name]);
  if (Object.hasOwn(decision, name)) return triValue(decision[name]);
  return null;
}

function triValue(value) {
  if (value === null || value === undefined) return null;
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
    // type 以问题定义为准（响应缺 type 时回退响应值）：与 normalizeAnswer / normalizeDecision 保持一致，
    // 否则同一份答案在逐题行与 answers/labels 两个视图里会按不同题型渲染
    const type = question?.type || raw.type;
    // 各题型渲染分支在 question-types.mjs；未知题型兜底打印原始 JSON
    const line = renderAnswerLine(type, label, raw, question);
    lines.push(line ?? `- **${label}**：${JSON.stringify(raw)}`);
  }
  return lines;
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
      ? `- **建议复核**：需要人工复核（低置信、置信度缺失或无法判断：${lowQuestions.join('、')}）`
      : '- **建议复核**：无需人工复核'
  );
  return out.filter(Boolean).join('\n');
}
