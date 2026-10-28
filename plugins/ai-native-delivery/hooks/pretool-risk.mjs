#!/usr/bin/env node
// pretool-risk.mjs — PreToolUse hook：shell 类命令风险闸，deny / ask 两清单静态匹配
//（设计文档 §3.2 L-hook 层。接线照本仓 systemone-decision/hooks/pretool-risk.mjs 的宿主协议；
// 与其「判定模型三问」不同，本闸是确定性清单匹配——无网络、无模型、零依赖，15s 超时绰绰有余）。
// 契约（严格照 systemone hook 的宿主协议）：
//   stdin = hook JSON（取 tool_name / tool_input 字段）；
//   deny → stdout 输出 hookSpecificOutput.permissionDecision='deny'（宿主阻断），exit 0；
//   ask  → 同格式 permissionDecision='ask'（宿主向用户确认），exit 0；
//   其余（非 shell 工具 / 取不到命令 / 清单外）→ 静默 exit 0；
//   settings.json 损坏（不可解析 / permissions 形状非法 / deny 键缺失）→ stderr WARN +
//     **按内置 deny 地板继续执法**（2026-10-28 收紧：此前整体 fail-open 放行，等于「把配置文件
//     写坏」就能解除风险闸）；ask 回退内置默认；
//   输入截断 / 坏 JSON → fail-closed：转 ask（命令不可信，尾巴里可藏破坏性命令）；
//   任何异常 → stderr 后 exit 0，绝不阻塞工具调用。
// 清单来源：项目侧 .agents/settings.json（permissions.deny / ask，§5.2）→ 插件种子
// （config-templates/settings.json）→ 代码内最小兜底；其中 **deny 取「内置地板 ∪ 来源追加」，
// 被治理项目只能加严、不能放宽**（ask 仍可被项目侧整体接管）。
// 匹配语义：deny/ask 两条都按「子串命中 **或** 词元全含」判定，deny 优先于 ask。
//   - 子串：`cd app && git push -f` 这类链式命令照样命中；
//   - 词元全含：规则的每个词都出现在命令里即命中（不限相邻、不限顺序）。补的是参数位置差异——
//     `git push --force` 是子串，但 `git push origin main --force`、`git push -C x` 这类把选项
//     写在参数之后/之中时子串对不上，规则就静默漏判（2026-10-28 实测：最常见的 force 写法恰好漏）。
//     两边都是确定性清单匹配，不做语义猜测；词元判据要求规则至少两个词，避免单词规则满盘命中。
// 曾有第三个 `allow` 清单（2026-10-28 移除）：它排在判定链末端、命中后返回 null，与「清单外
// 静默放行」完全等价，是条空转配置；而它的内容（git commit / git push / node / npm run）会让
// 读者误以为这些命令已被预先批准，还与 implementer「禁提交推送」的角色契约直接冲突。
// 测试：node test/hook.test.mjs（deny 阻断 / 普通放行 / 损坏时地板执法 / deny 不可下调 / matcher 同口径）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, PLUGIN_CONFIG_TEMPLATES_DIR } from '../scripts/paths.mjs';

const STDIN_MAX_CHARS = 100_000; // 与 systemone hook-io 同上限：截断即转 ask（fail-closed）

// 只对 shell 类工具生效（与 systemone risk-gate 同一正则——宿主对终端类工具的常见命名全覆盖）。
// 注意两道门必须同口径：hooks.json / .codex-plugin 的 matcher 决定**本 hook 会不会被调到**，
// 本正则决定**调到了之后管不管**。2026-10-28 市场审查实测到这里脱节（matcher 只写
// `Bash|Shell|Terminal` 三个名，宿主把命令交给 Command/Run/exec/pwsh 类工具时本 hook 根本不被
// 调用，风险闸对那类调用零告警失灵）。由 test/hook.test.mjs ⑧ 机器对账，别再靠注释同步。
const SHELL_TOOL = /(^|[_\-.\s])(bash|shell|terminal|command|cmd|exec|process|run|powershell|pwsh|zsh|fish)([_\-.\s]|$)/i;

// 驼峰宿主名先拆词再匹配（2026-10-28）：matcher 是子串正则，`RunCommand` / `ExecuteCommand` /
// `BashTool` 都会被它命中并调用 hook；但 `Command` 前是大写 R、后是小写 T，两侧都不是边界，
// 于是内核对不上、落进「非 shell 工具」静默放行——闸门看着在，实际不管这类调用。
// 它与 2026-10-27 修的「matcher 太窄导致 hook 根本不被调用」是同一个洞的两个方向：
// 那次只把 matcher 拉到与内核同宽，没锁「matcher 更宽时内核必须兜住」。
// 拆词只作为**补充**判据：先按原样匹配（`basH` 这类大小写变体原样就命中），失败再拆驼峰重试。
// 只拆词不原样匹配会把 `basH` 拆成 `bas H` 反而漏掉——这正是加上第二条判据的原因。
const normalizeToolName = (toolName) => String(toolName).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const applies = (toolName) =>
  typeof toolName === 'string' && (SHELL_TOOL.test(toolName) || SHELL_TOOL.test(normalizeToolName(toolName)));

// 代码内最小兜底（插件种子 settings.json 也缺失时的最后防线——deny 面永不因缺文件变空）
const BUILTIN = {
  deny: ['git reset --hard', 'git push --force', 'git push -f', 'drop database'],
  ask: ['git checkout', 'git clean', 'git branch -D', 'rm -rf'],
};

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// 词元化：按空白与 shell 分隔符切，供「词元全含」判据使用（保留 `--flag` 原样，不去引号——
// 引号包裹的 `"--force"` 切出来带引号，宁漏勿误，那类写法仍走子串判据）。
const tokensOf = (s) => norm(s).split(/[\s;&|()]+/).filter(Boolean);

// 规则命中：子串命中，或（规则 ≥2 个词且每个词都作为词元出现）。
// 后者补「选项位置」差异——`git push --force` 是子串，`git push origin main --force` 不是；
// 而后者正是最常见的 force 写法。词元判据不求相邻/顺序：代价是极少数跨语句组合会多拦一次
// （如 `git push a; rm --force x`），方向是 fail-safe（多问一次/多拦一次），可接受。
function matchList(command, rules) {
  const c = norm(command);
  const tokens = new Set(tokensOf(command));
  for (const rule of rules || []) {
    const r = norm(rule);
    if (!r) continue;
    if (c.includes(r)) return rule;
    const words = tokensOf(rule);
    if (words.length >= 2 && words.every((w) => tokens.has(w))) return rule;
  }
  return null;
}

// 清单来源：项目侧 .agents/settings.json（§5.2）→ 插件种子 config-templates/settings.json → 代码内
// 最小兜底。但 **deny 面有一道不可下调的内置地板**（2026-10-28 市场审查修复）：
//   此前「清单单源」= 项目侧文件一在场，deny 面就整体换成项目侧那一份。被治理的仓库正是 agent
//   能写文件的仓库：自写 `permissions:{deny:["x"],ask:[]}` 就能把 git reset --hard / rm -rf 这类
//   拦阻清零，或把 settings.json 写成非法 JSON 触发 fail-open 整体解除——「两层拦截」中的一层
//   可由被治理对象单方面解除，这不是治理引擎该有的信任边界。
//   现在：deny = 内置地板 ∪ 该来源的追加项（只能加不能删）；文件损坏/不可解析不再整体放行，
//   而是 WARN + 按地板继续执法。ask 仍单源（ask 只是多问一句，项目自定合理，语义与既有测试不变）。
function loadLists(root) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const floor = () => ({ deny: [...BUILTIN.deny], ask: [...BUILTIN.ask], source: 'builtin-default' });
  const degraded = (why, file) => ({
    ...floor(),
    warn: `${why}（${file}）——deny 面按内置地板继续执法，ask 回退内置默认`,
  });
  const candidates = [
    ...(root ? [path.join(root, '.agents', 'settings.json')] : []),
    path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      return degraded('JSON 不可解析', file);
    }
    const p = parsed && typeof parsed === 'object' ? parsed.permissions : null;
    if (!p || typeof p !== 'object') return degraded('permissions 形状非法', file);
    const deny = arr(p.deny);
    for (const b of BUILTIN.deny) {
      if (!deny.some((d) => norm(d) === norm(b))) deny.push(b); // 地板项不可被项目侧删掉
    }
    const lists = { deny, ask: Array.isArray(p.ask) ? arr(p.ask) : [...BUILTIN.ask], source: file };
    if (!Array.isArray(p.deny)) lists.warn = 'deny 键缺失或非数组' + `（${file}）` + '——按内置地板执法';
    return lists;
  }
  return floor();
}

function commandOf(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const raw = input.command ?? input.cmd ?? input.script ?? input.execution_input;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (truncated) return;
      raw += c;
      if (raw.length >= STDIN_MAX_CHARS) {
        truncated = true;
        raw = raw.slice(0, STDIN_MAX_CHARS);
        process.stdin.destroy(); // destroy() 只触发 close：超大残流立即收尾
      }
    });
    process.stdin.once('end', () => resolve({ raw, truncated }));
    process.stdin.once('close', () => resolve({ raw, truncated }));
    process.stdin.once('error', () => resolve({ raw, truncated }));
  });
}

async function main() {
  const { raw, truncated } = await readStdin();
  let input = {};
  let jsonBroken = false;
  if (!truncated) {
    // 坏 JSON 与截断同向处理（2026-10-27 修复）：两者都意味着「命令不可信、读不出来」。
    //   此前坏 JSON 被 catch 成 {} → tool_name='' → 判为「非 shell 工具」→ 静默放行——与截断
    //   转 ask 的 fail-closed 方向相反：宿主喂入非 JSON 时高风险 shell 命令可直接放行且无任何痕迹。
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; jsonBroken = true; }
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const command = commandOf(input.tool_input);
  // 管辖外（非 shell 工具）与输入不可信的走向：
  //   输入不可信（截断 / 坏 JSON）→ fail-closed 转 ask，**先于非 shell 判定**——
  //     宿主已用 matcher 把本 hook 限定在 shell 工具上，输入不可信时连 tool_name 都读不出，
  //     不能拿「读不出名字」当「非 shell 工具」静默放行；
  //   非 shell 工具 → 静默放行；shell 工具但缺 command 字段 → fail-closed 转 ask。
  if (truncated || jsonBroken) {
    const why = truncated ? '输入截断' : 'hook 输入不是合法 JSON';
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `[ai-native-delivery 风险闸] hook 输入不完整（${why}），无法做清单匹配——请向用户展示命令并确认后再执行。`,
      },
    };
  }
  if (!applies(toolName)) return null;
  if (command === null) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: '[ai-native-delivery 风险闸] hook 输入不完整（缺 command 字段），无法做清单匹配——请向用户展示命令并确认后再执行。',
      },
    };
  }

  const root = findProjectRoot();
  const lists = loadLists(root);
  if (lists.warn) process.stderr.write(`[ai-native-delivery hook] ${lists.warn}\n`);

  const denyHit = matchList(command, lists.deny);
  if (denyHit) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[ai-native-delivery 风险闸] 命中 deny 清单「${denyHit}」（清单源 ${lists.source}，内置地板不可下调）——高风险/破坏性命令已阻断；如确需执行请由用户手动运行。`,
      },
    };
  }
  const askHit = matchList(command, lists.ask);
  if (askHit) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `[ai-native-delivery 风险闸] 命中 ask 清单「${askHit}」（清单源 ${lists.source}）——有一定风险，请先向用户确认再执行。`,
      },
    };
  }
  return null; // 清单外：静默放行（清单闸只拦已知风险，不做语义猜测）
}

main()
  .then((out) => {
    const text = out ? JSON.stringify(out) : '';
    if (!text || process.stdout.write(text)) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
  })
  .catch((e) => {
    process.stderr.write(`[ai-native-delivery hook] 风险闸跳过：${e && e.message ? e.message : e}\n`);
    process.exit(0);
  });
