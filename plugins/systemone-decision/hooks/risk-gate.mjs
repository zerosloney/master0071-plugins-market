// risk-gate.mjs — PreToolUse 风险闸的宿主无关内核：对 shell 类工具调用做放行/确认/拒绝判定。
// 与 clarity.mjs 同一契约：判定为"放行"、只读捷径、非 shell 工具或缺 Key 时返回 null
// （调用方 fail-open 放行），网络或响应异常一律 throw。判定为确认/拒绝时返回
// { decision: 'ask' | 'deny', reason }。stdin/stdout 协议在 hooks/pretool-risk.mjs。
// 配置解析 / 请求 / 归一化共用 hooks/decide-client.mjs（与需求预检同一份）。

import { config, decide, scoreOf, choiceOf, noulOf } from './decide-client.mjs';

// 门限：拒绝 = 判定为 deny，或（高风险 且 不可逆）；确认 = 判定 confirm，或中风险以上，或不可逆。
// 低置信度不改门限，只在命中的理由里附注——硬信号归 hook，软怀疑归用户与 Agent。
export const GATE = { riskDenyMin: 3, riskConfirmMin: 2, irreversibleMin: 0.5 };

// 只对 shell 类工具启动判定：其余工具（读写文件、搜索）单次风险低且调用频繁，
// 每次都发判定请求不可接受。名称匹配覆盖各宿主对终端类工具的常见命名。
const SHELL_TOOL = /(^|[_\-.])(bash|shell|terminal|command|cmd|exec|process|run)([_\-.]|$)/i;

// 明显只读的命令捷径：不发判定请求直接放行（与 clarity 的寒暄捷径同一思路）
const READONLY =
  /^(ls|dir|pwd|cat|head|tail|grep|rg|find|which|type|echo|whoami|date|git (status|log|diff|show|branch|remote|config --get)|node -v|npm (ls|view|outdated))\b/i;

// 链式/重定向/命令替换：出现任一符号，整条命令就不再「明显只读」。首 token 白名单再准也
// 不作数——`echo start; rm -rf build`、`ls && rm -rf x`、`cat a > b` 都会绕过白名单直接放行。
const COMPOUND = /[;&|><`]|\$\(|\n/;
// find 的副作用开关：-delete / -exec / -execdir / -ok 会删改文件，不算只读。
const FIND_MUTATES = /\s-(delete|exec|execdir|ok)\b/i;

/** 首 token 命中只读白名单、且整条命令无链式副作用时才走捷径（省一次判定请求）。 */
function isReadonlyShortcut(command) {
  if (COMPOUND.test(command)) return false;
  if (/^find\b/i.test(command)) return !FIND_MUTATES.test(command);
  return READONLY.test(command);
}

const QUESTIONS = {
  verdict: {
    type: 'choice',
    label: '放行判定',
    instructions: '该命令是否应当放行执行？',
    criteria: {
      allow: '低风险，直接放行',
      confirm: '有一定风险或处于灰区，先向用户确认再执行',
      deny: '高风险或破坏性操作，不应执行',
    },
  },
  risk: {
    type: 'score',
    label: '破坏性等级',
    instructions: '该命令的破坏性/不可逆程度是？',
    criteria: [
      '只读或完全可回滚',
      '可逆的写操作',
      '难以回滚的写操作',
      '不可逆删除或影响生产/远程资源',
    ],
  },
  irreversible: {
    type: 'noul',
    label: '不可逆',
    instructions: '该命令的后果是否不可逆或难以回滚？',
  },
};

/** 该工具是否属于风险闸的管辖范围（shell 类）。 */
export function applies(toolName) {
  return typeof toolName === 'string' && SHELL_TOOL.test(toolName);
}

function commandOf(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const raw = input.command ?? input.cmd ?? input.script ?? input.execution_input;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * @param {string} toolName - 宿主传入的工具名
 * @param {unknown} toolInput - 工具入参（取 command / cmd / script 字段，退化序列化整体）
 * @param {Record<string, string|undefined>} [env] - 供应商配置来源，默认进程环境
 * @param {object} [opts] - { timeoutMs } 共享 deadline 的剩余预算，透传给 decide
 * @returns {Promise<{decision: 'ask'|'deny', reason: string} | null>} null = 放行（不拦截）
 */
export async function assess(toolName, toolInput, env = process.env, opts = {}) {
  if (!applies(toolName)) return null;
  const command = commandOf(toolInput);
  if (isReadonlyShortcut(command)) return null;
  const cfg = config(env);
  if (!cfg.apiKey) return null; // 未配置 Key，静默放行
  const answers = await decide(`工具：${toolName}\n命令：${command}`, cfg, QUESTIONS, opts.timeoutMs);
  const verdict = answers ? choiceOf(answers.verdict) : null;
  const risk = answers ? scoreOf(answers.risk) : null;
  const irreversible = answers ? noulOf(answers.irreversible) : null;
  if (!verdict || !risk || !irreversible) return null; // 响应不完整，fail-open
  const p = irreversible.probability;
  const deny = verdict.value === 'deny' || (risk.score >= GATE.riskDenyMin && p >= GATE.irreversibleMin);
  const confirm = !deny && (verdict.value === 'confirm' || risk.score >= GATE.riskConfirmMin || p >= GATE.irreversibleMin);
  if (!deny && !confirm) return null; // 放行，零噪音
  const conf = [verdict.confidence, risk.confidence, irreversible.confidence].filter((c) => c !== null);
  const low =
    conf.length > 0 && Math.min(...conf) < 0.7 ? `（注意：本次判定最低置信度 ${Math.min(...conf).toFixed(2)}，偏低）` : '';
  const reason =
    `[SystemOne 风险闸] 该命令判定为${deny ? '高风险，拒绝执行' : '需先确认再执行'}：` +
    `破坏性 ${risk.score.toFixed(1)}/3${risk.level ? `（${risk.level}）` : ''}；不可逆概率 ${p.toFixed(2)}；` +
    `模型判定 ${verdict.value}。${deny ? '建议阻止该命令并向用户说明风险，或让用户手动执行。' : '建议先向用户展示命令并确认后再执行。'}${low}`;
  return { decision: deny ? 'deny' : 'ask', reason };
}
