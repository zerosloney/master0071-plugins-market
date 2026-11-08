// model-profiles.mjs — 模型能力档案：params.<qid>.candidates 把候选模型 id 展开成 choice
// 选项判据时，用它把 id 翻译成「这个模型擅长什么」的一段描述——决策模型面对一串裸 id
// 无法比较候选，配上能力定位才能按任务意图选型。
// 纯数据 + 单函数，零依赖。规则顺序敏感：先具体（家族型号片段）后宽泛（家族名），
// 第一条命中即返回——glm-4-flash 必须命中靠前的 flash「快速档」，而不是靠后的 glm「均衡编码档」。

// 每条规则 = [匹配子串（或子串数组，任一命中即采用）, 能力档案描述]。
export const MODEL_PROFILE_RULES = [
  ['opus', '旗舰最强推理档：复杂架构决策、极难调试；质量最高但贵且慢'],
  ['sonnet', '均衡档：日常编码与多步任务主力，质量与速度兼顾'],
  ['haiku', '快速档：简单机械任务、批量处理；最快最省'],
  ['gpt-5', '旗舰推理档：复杂推理与长任务，成本较高'],
  ['gpt-4', '均衡档：通用编码与文本任务'],
  [['o3', 'o4'], '深度推理档：数学/规划/长链推理强，延迟高'],
  [['r1', 'reasoner'], '深度推理档：长链推理与难题求解，延迟高'],
  [['flash', 'mini', 'turbo', 'air', 'lite'], '快速档：简单机械任务、批量处理；最快最省'],
  [['max', 'ultra'], '旗舰档：同家族最强能力，复杂任务首选'],
  ['glm', '均衡编码档：工具调用与多步编码任务表现稳'],
  ['qwen', '均衡档：通用编码与文本任务'],
  ['deepseek', '均衡编码档：代码生成与调试性价比高'],
  ['gemini', '均衡档：多模态与长上下文较好'],
  ['kimi', '均衡档：超长上下文处理较好'],
];

// 全部规则未命中时的中性兜底：不编造能力，明说没有档案——
// 让决策模型按通用模型对待，而不是拿一个似是而非的定位误导选型。
const UNKNOWN_PROFILE = '未提供能力描述：按通用模型对待，无法体现该模型相对优势';

/**
 * 按模型 id（小写子串匹配）查能力档案描述；永不返回空串。
 * @param {string} id - 模型 id（如 "glm-4-flash"、"deepseek-r1"）
 * @returns {string}
 */
export function modelProfile(id) {
  const needle = typeof id === 'string' ? id.toLowerCase() : '';
  for (const [matches, profile] of MODEL_PROFILE_RULES) {
    const list = Array.isArray(matches) ? matches : [matches];
    if (list.some((m) => needle.includes(m))) return profile;
  }
  return UNKNOWN_PROFILE;
}
