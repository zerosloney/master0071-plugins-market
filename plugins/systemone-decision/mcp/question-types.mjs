// question-types.mjs — 题型（choice / noul / score）知识的唯一来源。
// 题型清单与判别、criteria 的校验与规整、请求序列化、describe 渲染、答案归一化、
// 速览判定/标签、逐题 Markdown 渲染、复核规则、派生模式配对全部收拢在此：
// 新增题型只改这个文件（外加场景定义），server / scenarios / format 不再多文件散改。
// 纯函数，零依赖。

// ---------- 题型清单与判别 ----------

export const SUPPORTED_TYPES = ['choice', 'noul', 'score'];

const VALID_TYPES = new Set(SUPPORTED_TYPES);

/** 是否为合法题型。 */
export function isSupportedType(type) {
  return typeof type === 'string' && VALID_TYPES.has(type);
}

/** 与 decide 侧校验同一套非空口径：非空白字符串。 */
export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// ---------- criteria：校验与字符串化 ----------

// choice/score 量表的硬上下限。decide 侧（validateQuestions）与场景加载（validateScenario）
// 原有两套上下限不一致，收拢后谁严以谁为准：choice 2~26（26 对齐字母表）、score 2~255。
const CHOICE_MIN_OPTIONS = 2;
const CHOICE_MAX_OPTIONS = 26;
const SCORE_MIN_LEVELS = 2;
const SCORE_MAX_LEVELS = 255;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 校验一道题的 criteria。收拢 decide 侧 validateQuestions 与场景加载 validateScenario
 * 重复的规则，两侧谁严以谁为准、行为不放松：
 *   choice = 普通对象 {选项ID: 描述}，2~26 个选项，键与值都必须是非空字符串；
 *   score  = 字符串数组 [等级描述, ...]，2~255 级，每级非空字符串；
 *   noul   = 无 criteria，无需校验。
 * 边界收紧：值为 null / undefined 时直接判非法并指明键名——它们此前会被 String 化成
 * 字面 "null"/"undefined" 混过非空校验（如 params 里写 {vip: null} 生成叫 "null" 的选项）。
 * @param {object} question - 问题定义 { type, criteria? }
 * @returns {string[]} 问题列表（不带问题 id 前缀），空数组表示合法
 */
export function validateCriteria(question) {
  const type = question?.type;
  if (type === 'choice') return validateChoiceCriteria(question.criteria);
  if (type === 'score') return validateScoreCriteria(question.criteria);
  return [];
}

function validateChoiceCriteria(criteria) {
  if (!isPlainObject(criteria) || Object.keys(criteria).length === 0) {
    return ['必须是非空对象 {选项ID: 选项描述}'];
  }
  const count = Object.keys(criteria).length;
  if (count < CHOICE_MIN_OPTIONS) return [`至少需要 ${CHOICE_MIN_OPTIONS} 个选项`];
  if (count > CHOICE_MAX_OPTIONS) return [`选项数超过上限 ${CHOICE_MAX_OPTIONS}`];
  return validateOptionEntries(criteria);
}

function validateScoreCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length < SCORE_MIN_LEVELS) {
    return [`必须是长度 ≥${SCORE_MIN_LEVELS} 的分级标签数组（至少需要 ${SCORE_MIN_LEVELS} 个等级描述）`];
  }
  if (criteria.length > SCORE_MAX_LEVELS) {
    return [`等级数超过上限 ${SCORE_MAX_LEVELS}`];
  }
  const problems = [];
  criteria.forEach((v, i) => {
    const problem = valueProblem(`第 ${i} 级`, v);
    if (problem) problems.push(problem);
  });
  return problems;
}

// 单个取值校验：非空字符串；null/undefined 单独点名（边界收紧点）
function valueProblem(where, v) {
  if (v === null || v === undefined) return `${where}的描述必须是非空字符串，不能是 null/undefined`;
  if (!isNonEmptyString(v)) return `${where}的描述必须是非空字符串`;
  return null;
}

function validateOptionEntries(criteria) {
  const problems = [];
  for (const [k, v] of Object.entries(criteria)) {
    if (!isNonEmptyString(k)) {
      problems.push(`选项 ID 必须是非空字符串（收到 ${JSON.stringify(k)}）`);
      continue;
    }
    const problem = valueProblem(`选项 "${k}"`, v);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * 选项映射（criteria / addCriteria）的规整：键值 String 化以容忍 JSON 里的数字键/枚举值，
 * 但 null / undefined 先于字符串化拦截并指明键名（边界收紧），字符串化后仍须非空。
 * @param {object} map - {选项ID: 描述}
 * @returns {{ criteria?: object, problem?: string }} problem 存在时表示校验失败
 */
export function coerceOptionMap(map) {
  if (!isPlainObject(map) || Object.keys(map).length === 0) {
    return { problem: '必须是非空对象 {选项ID: 选项描述}' };
  }
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined) {
      return { problem: `选项 "${k}" 的描述不能是 null/undefined` };
    }
  }
  const criteria = Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k), String(v)]));
  for (const [k, v] of Object.entries(criteria)) {
    if (!isNonEmptyString(k)) return { problem: '选项 ID 必须是非空字符串' };
    if (!isNonEmptyString(v)) return { problem: `选项 "${k}" 的描述必须是非空字符串` };
  }
  return { criteria };
}

/**
 * params 覆盖 criteria 的校验与规整（run/batch 的 params 路径专用）：
 *   choice = 选项映射，coerceOptionMap 口径（数量上下限由 executeDecision → validateQuestions 兜底）；
 *   score  = 等级数组，至少 2 级，逐级 String 化；
 *   noul   = 没有 criteria（调用方先用 hasCriteria 拦截）。
 * @param {string} type - 题型
 * @param {unknown} criteria - params 传入的 criteria
 * @returns {{ criteria?: object | string[], problem?: string }}
 */
export function coerceParamsCriteria(type, criteria) {
  if (type === 'choice') return coerceOptionMap(criteria);
  if (type === 'score') {
    if (!Array.isArray(criteria) || criteria.length < SCORE_MIN_LEVELS) {
      return { problem: `至少需要 ${SCORE_MIN_LEVELS} 个等级描述` };
    }
    // null/undefined 先于字符串化拦截：String(null) === 'null' 会混过下面的非空校验（边界收紧）
    const nullIdx = criteria.findIndex((v) => v === null || v === undefined);
    if (nullIdx >= 0) return { problem: `第 ${nullIdx} 级的描述不能是 null/undefined` };
    const leveled = criteria.map((v) => String(v));
    const badIdx = leveled.findIndex((v) => !isNonEmptyString(v));
    if (badIdx >= 0) return { problem: `第 ${badIdx} 级的描述必须是非空字符串` };
    return { criteria: leveled };
  }
  return { problem: '该题型没有 criteria' };
}

/**
 * 按题型把 criteria 规整成内部/请求使用的形状：键值统一 String 化。
 * 仅在 validateCriteria 通过后调用；noul 返回 undefined。
 */
export function stringifyCriteria(type, criteria) {
  if (type === 'choice') {
    return Object.fromEntries(Object.entries(criteria).map(([k, v]) => [String(k), String(v)]));
  }
  if (type === 'score') {
    return criteria.map((v) => String(v));
  }
  return undefined;
}

// ---------- 题型能力：criteria 携带、addCriteria、派生模式 ----------

/** noul 无判据：请求序列化时剥掉 criteria。 */
export function hasCriteria(type) {
  return type !== 'noul';
}

/** addCriteria（choice 专属）：只有 choice 支持在选项表上追加选项。 */
export function supportsAddCriteria(type) {
  return type === 'choice';
}

/**
 * 派生取值模式与题型的配对：values 按分值下标取值只配 score，map 按选项键取值只配 choice。
 * @param {string} type - 题型
 * @param {'values' | 'map'} mode - 派生取值模式
 */
export function supportsDerive(type, mode) {
  if (mode === 'values') return type === 'score';
  if (mode === 'map') return type === 'choice';
  return false;
}

// ---------- 请求序列化 ----------

/** 按题型裁剪请求体：noul 不携带 criteria。label 等本地展示字段由调用方先行剥离。 */
export function toRequestQuestion(q) {
  return hasCriteria(q.type)
    ? { type: q.type, instructions: q.instructions, criteria: q.criteria }
    : { type: q.type, instructions: q.instructions };
}

// ---------- describe 渲染 ----------

/** 把一道题的 criteria 渲染成 describe 用的一行说明：choice=`k=v；…`，score=`0=等级；…`，noul=概率说明。 */
export function describeCriteria(q) {
  if (q.type === 'choice') {
    return Object.entries(q.criteria || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('；');
  }
  if (q.type === 'score') {
    return (q.criteria || []).map((v, i) => `${i}=${v}`).join('；');
  }
  return '（0~1 概率）';
}

// ---------- 答案读取：finite 口径 ----------

/**
 * 取出可用的 score 数值，无效时返回 null。
 * 绝不能用 `?? 0` 或直接 `Number()` 兜底：`null ?? 0` 得 0，而 `Number(null) === 0`，
 * 两者都会把「模型没给分值」悄悄变成 0 分，再经 legend[0] 捏造出一个最低等级标签，
 * 产出一条看起来完全正常、confidence 还很高的假判定。所有 score 读取都必须走这里。
 * @param {object} answer - SystemOne 原始答案
 * @returns {number | null}
 */
export function finiteScore(answer) {
  const raw = answer ? answer.score : undefined;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 取出可用的 confidence 数值，无效时返回 null。与 finiteScore 同理：`Number(null) === 0`
 * 会被 isFinite 判真，把「模型没给置信度」渲染成 0.0%，所以先做 typeof 收窄再取值。
 * @param {object} answer - SystemOne 原始答案
 * @returns {number | null}
 */
export function finiteConfidence(answer) {
  const c = answer ? answer.confidence : undefined;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

// ---------- 答案归一化（逐题明细 answers[qid]） ----------

/**
 * 各题型的答案归一化分支：只负责往 out 上填自己的字段。
 * choice → value/probabilities/confidence；noul → probability/confidence；score → value/level/probabilities/confidence。
 */
const ANSWER_FILLERS = {
  choice(out, answer) {
    out.value = answer.choice ?? null;
    out.probabilities = answer.probabilities || {};
    // probabilities 回退值同样只认有限数字：字符串（如 "high"）或 Infinity 会静默绕过阈值比较
    const fallback = (answer.probabilities || {})[answer.choice];
    out.confidence = finiteConfidence(answer) ?? (Number.isFinite(fallback) ? fallback : null);
  },
  noul(out, answer) {
    // noul 无独立 confidence 字段，用概率的决断度 max(p, 1-p) 代替。
    // typeof Infinity === 'number'（JSON 里 1e999 即是），必须同时 isFinite，否则
    // Infinity 概率会同时漏过阈值比较与复核判定，决策却已显示「无法判断」
    const p = typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? answer.noul : null;
    out.probability = p;
    out.confidence = p === null ? null : Math.max(p, 1 - p);
  },
  score(out, answer, question) {
    const score = finiteScore(answer);
    out.value = score === null ? null : Math.round(score * 1000) / 1000;
    // 兜底顺序与速览 labels 一致（legend → 量表标签），否则响应没带 legend 时
    // answers.x.level 为 null 而 labels.x 有值，同一份结果两个视图互相矛盾
    out.level =
      score === null
        ? null
        : lookupScoreLabel(Math.round(score), answer.legend, question) ?? null;
    out.probabilities = answer.probabilities || {};
    out.confidence = finiteConfidence(answer);
  },
};

/** 按答案题型给 out 填充题型专属字段；未知题型不填（调用方保持原样返回）。 */
export function fillAnswerByType(out, answer, question) {
  const fill = ANSWER_FILLERS[out.type];
  if (fill) fill(out, answer, question);
}

/**
 * score 等级标签查找的公共头部：legend → 问题量表，找不到返回 undefined。
 * 尾部兜底（?? null / ?? String(idx)）由调用方按各自视图决定。
 */
function lookupScoreLabel(idx, legend, question) {
  return legend?.[String(idx)] ?? (Array.isArray(question?.criteria) ? question.criteria[idx] : undefined);
}

// ---------- 速览判定（decision / labels / confidences） ----------

/**
 * 各题型的速览判定。choice → 选项 key；score → 取整分值；noul → boolean（≥0.5 为真）。
 * confidence 为 null/undefined 时缺省（调用方不写入 confidences）。
 */
const DECISION_EXTRACTORS = {
  choice(raw, question) {
    const key = raw.choice ?? null;
    const c = finiteConfidence(raw);
    return {
      decision: key,
      label: key != null ? (question?.criteria?.[key] ?? raw.choice ?? String(key)) : '无法判断',
      confidence: c === null ? undefined : c,
    };
  },
  score(raw, question) {
    const score = finiteScore(raw);
    const idx = score === null ? null : Math.round(score);
    const c = finiteConfidence(raw);
    return {
      decision: idx,
      label: idx != null ? (lookupScoreLabel(idx, raw.legend, question) ?? String(idx)) : '无法判断',
      confidence: c === null ? undefined : c,
    };
  },
  noul(raw) {
    // typeof 收窄而非 Number() 强转：Number(null) === 0 会把「模型没给概率」捏造成
    // 置信度 1.0 的「否」（decision/labels/confidences 三个速览视图一起失真）。
    // 与 finiteScore / finiteConfidence / hooks/decide-client.noulOf 同口径的边界收紧。
    const v = typeof raw.noul === 'number' && Number.isFinite(raw.noul) ? raw.noul : null;
    const flag = v === null ? null : v >= 0.5;
    return {
      decision: flag,
      label: flag === null ? '无法判断' : flag ? '是' : '否',
      confidence: flag === null ? undefined : flag ? v : 1 - v,
    };
  },
};

/** 按题型抽取速览判定；未知题型返回 null（调用方跳过该题）。 */
export function extractDecisionByType(type, raw, question) {
  const extract = DECISION_EXTRACTORS[type];
  return extract ? extract(raw, question) : null;
}

// ---------- 逐题 Markdown 渲染 ----------

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

const LINE_RENDERERS = {
  choice(label, answer, question) {
    const { choice, confidence, probabilities } = answer;
    const text = choice != null ? (question?.criteria?.[choice] ?? choice) : '无法判断';
    return `- **${label}**：${text}（置信度 ${fmtPct(confidence)}｜分布 ${topProbs(probabilities, 3)}）`;
  },
  score(label, answer, question) {
    const { confidence, legend, probabilities } = answer;
    const score = finiteScore(answer);
    const idx = score === null ? null : Math.round(score);
    const text =
      idx != null ? (lookupScoreLabel(idx, legend, question) ?? String(idx)) : '无法判断';
    const raw = score === null ? '' : ` ${score.toFixed(2)}`;
    return `- **${label}**：${text}${raw}（置信度 ${fmtPct(confidence)}｜分布 ${topProbs(probabilities, 3)}）`;
  },
  noul(label, answer) {
    // 与 DECISION_EXTRACTORS.noul 同口径：typeof 收窄——Number(null) === 0 会把缺失概率
    // 渲染成「否（0.0%）」，逐题行必须与 decision/answers 视图一致地说「无法判断」
    const v = typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? answer.noul : null;
    if (v === null) return `- **${label}**：无法判断`;
    return `- **${label}**：${v >= 0.5 ? '是' : '否'}（${(v * 100).toFixed(1)}%）`;
  },
};

/** 按题型渲染逐题 Markdown 行；未知题型返回 null（调用方兜底打印原始 JSON）。 */
export function renderAnswerLine(type, label, raw, question) {
  const render = LINE_RENDERERS[type];
  return render ? render(label, raw, question) : null;
}

// ---------- 复核规则 ----------

/**
 * 即使置信度达标也必须转人工复核的情形（question 为该题定义，判据以其为准；raw 为原始答案）：
 *   1. 判定值不可用——任一题型缺失或非法（choice 无选项、noul 无概率、score 无分值）。
 *      模型对结构性坏响应同样会给高 confidence，照单全收等于凭坏数据做决策。
 *   2. choice 返回 uncertain / unknown 哨兵值。
 *   3. noul 概率落在 0.45~0.55 模糊区间（正反两向都说不准）。
 *   4. choice 选中的选项不在判据表内——模型幻觉出的选项，confidence 可能很高，
 *      甚至根本没给（null），不能当作合法判定。
 *   5. score 分值取整后落在分级量表范围外——越界高分会被派生字段钳成最高档，
 *      等于凭一个坏响应把工单升到最高优先级。
 */
export function isBorderlineAnswer(a, question, raw) {
  if (a.type === 'choice') {
    if (a.value === null || a.value === 'uncertain' || a.value === 'unknown') return true;
    const allowed = question?.criteria;
    // Object.hasOwn 而非 `in`：后者沿原型链匹配，模型吐出 "constructor" / "toString" /
    // "hasOwnProperty" 时会被当成合法选项放行——正是本函数要拦的「幻觉选项」中最容易蒙对的
    // 那一类。与 hooks/risk-gate.mjs 的判定同口径（2026-10-28 市场审查对齐）。
    if (allowed && !Object.hasOwn(allowed, a.value)) return true;
  }
  if (a.type === 'noul' && (a.probability === null || (a.probability > 0.45 && a.probability < 0.55))) return true;
  if (a.type === 'score') {
    if (a.value === null) return true;
    const levels = question?.criteria;
    // 用原始 score 取整，与速览 decision / 派生字段走同一个下标，
    // 避免 answers.value（保留 3 位小数）与 decision 取整结果在 .5 边界上不一致
    const idx = Math.round(Number(raw?.score));
    if (Array.isArray(levels) && (idx < 0 || idx >= levels.length)) return true;
  }
  return false;
}
