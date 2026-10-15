// 需求明确度预检的宿主无关内核：各端共用同一份门限、三问定义与结论文案，改这里全端
// 同时生效。Claude 式 UserPromptSubmit 的 stdin/stdout 协议留在 hooks/requirement-clarity.mjs。
// 契约：precheck(text, env) 返回结论文本，判定为"明确"/寒暄/缺 Key 时返回 null，
// 网络或响应异常一律 throw —— 由调用方 fail-open，绝不阻塞用户输入。
// 门限与插件 README「需求明确度预检」一致：clarity ≤ 1 或 proceed < 0.6。
// 低置信度不改门限，只在命中的结论里附注——硬信号归 hook，软怀疑归 Agent。
// 配置解析 / 请求 / 归一化共用 hooks/decide-client.mjs（与风险闸同一份）。

import { config, decide, scoreOf, choiceOf, noulOf } from './decide-client.mjs';

export const GATE = { clarityMax: 1, proceedMin: 0.6 };
const CASUAL = /^(好的?|好吧|可以|是的?|对滴?|行|嗯+|哦+|不了|不用了?|再见|收到|继续|谢谢|多谢|麻烦了|辛苦了|ok|okay|yes|thanks?|thank you)[!。.，,～~！?\s]*$/i;

const QUESTIONS = {
  clarity: {
    type: 'score',
    instructions: '该开发任务的需求明确程度是？',
    criteria: [
      '模糊：目标都不清楚',
      '偏低：目标清楚但范围或关键约束不明',
      '较高：目标范围清楚，细节可自行决策',
      '明确：目标、范围、验收都清楚',
    ],
  },
  missing: {
    type: 'choice',
    instructions: '当前最需要澄清的信息是？',
    criteria: {
      goal: '目标/预期结果',
      scope: '范围与边界',
      acceptance: '验收标准',
      constraint: '技术约束或依赖',
      none: '无明显缺失',
    },
  },
  proceed: {
    type: 'noul',
    instructions: '不做额外澄清就推进，返工风险是否可接受？',
  },
};

function verdictLine(clarity, missing, proceed) {
  const conf = [clarity.confidence, missing.confidence, proceed.confidence].filter((c) => c !== null);
  const low =
    conf.length > 0 && Math.min(...conf) < 0.7 ? `（注意：本次判定最低置信度 ${Math.min(...conf).toFixed(2)}，偏低）` : '';
  const miss =
    missing.value === 'none'
      ? '未识别出明显缺失，但推进返工风险偏高'
      : `最需要澄清：${missing.value}（${QUESTIONS.missing.criteria[missing.value] || ''}）`;
  return (
    `[SystemOne 需求预检] 该需求判定为不明确：明确度 ${clarity.score.toFixed(1)}/3${clarity.level ? `（${clarity.level}）` : ''}；` +
    `${miss}；不澄清就推进的可接受概率 ${proceed.probability.toFixed(2)}。` +
    `建议先按上述维度向用户澄清，再开始实现，不要直接动手。${low}`
  );
}

/**
 * @param {unknown} text - 用户提交的原始输入
 * @param {Record<string, string|undefined>} [env] - 供应商配置来源，默认进程环境
 * @param {object} [opts] - { timeoutMs } 共享 deadline 的剩余预算，透传给 decide
 * @returns {Promise<string|null>} 结论文本；无需提醒时返回 null
 */
export async function precheck(text, env = process.env, opts = {}) {
  const prompt = typeof text === 'string' ? text.trim() : '';
  // <10 字符的输入描述不出可判定的任务（CASUAL 挡不住的短指令如「修复它」），也省一次判定请求
  if (prompt.length < 10 || CASUAL.test(prompt)) return null; // 空输入 / 寒暄捷径
  const cfg = config(env);
  if (!cfg.apiKey) return null; // 未配置 Key，静默跳过
  const answers = await decide(prompt, cfg, QUESTIONS, opts.timeoutMs);
  const clarity = answers ? scoreOf(answers.clarity) : null;
  const missing = answers ? choiceOf(answers.missing) : null;
  const proceed = answers ? noulOf(answers.proceed) : null;
  if (!clarity || !missing || !proceed) return null; // 响应不完整，fail-open
  if (clarity.score > GATE.clarityMax && proceed.probability >= GATE.proceedMin) return null; // 明确，零噪音
  return verdictLine(clarity, missing, proceed);
}
