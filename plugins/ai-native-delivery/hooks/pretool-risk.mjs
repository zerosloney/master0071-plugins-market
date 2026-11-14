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
//   输入截断 / 坏 JSON / 空 stdin → fail-closed：转 ask（命令不可信，尾巴里可藏破坏性命令；
//     空 stdin 2026-11-05 收尾批：读不到任何输入同样按不可信处理，与非 JSON 同向 fail-closed；
//     非对象 JSON 2026-11-08 补：合法 JSON 但非 {tool_name,...} 对象形态，同向 fail-closed）；
//   任何异常 → stderr 告警 + 转 ask（2026-10-31 收紧：静默 exit 0 会凭 hook 自身故障放行
//     本该命中 deny 的命令；ask 只加确认、不硬阻塞工具调用）。
// 清单来源：项目侧 .agents/settings.json（permissions.deny / ask，§5.2）→ 插件种子
// （config-templates/settings.json）→ 代码内最小兜底；其中 **deny 取「内置地板 ∪ 来源追加」，
// 被治理项目只能加严、不能放宽**（ask 仍可被项目侧整体接管）。
// 匹配语义：deny/ask 两条都按「子串命中 **或** 词元全含」判定，deny 优先于 ask。
//   - 子串：`cd app && git push -f` 这类链式命令照样命中；
//   - 词元全含：规则的每个词都出现在命令里即命中（不限相邻、不限顺序）。补的是参数位置差异——
//     `git push --force` 是子串，但 `git push origin main --force`、`git push -C x` 这类把选项
//     写在参数之后/之中时子串对不上，规则就静默漏判（2026-10-28 实测：最常见的 force 写法恰好漏）。
//   - 短选项簇先展开（2026-11-01 补）：git 的 `-uf` 等价 `-u -f`，不展开的话规则里的 `-f`
//     与 `-n` 都对不上，deny 地板被一个字符形态整体绕过（详见 expandCluster 注释）。
//     两边都是确定性清单匹配，不做语义猜测；词元判据要求规则至少两个词，避免单词规则满盘命中。
// 曾有第三个 `allow` 清单（2026-10-28 移除）：它排在判定链末端、命中后返回 null，与「清单外
// 静默放行」完全等价，是条空转配置；而它的内容（git commit / git push / node / npm run）会让
// 读者误以为这些命令已被预先批准，还与 implementer「禁提交推送」的角色契约直接冲突。
// 测试：node test/hook.test.mjs（deny 阻断 / 普通放行 / 损坏时地板执法 / deny 不可下调 / matcher 同口径）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findProjectRoot, PLUGIN_CONFIG_TEMPLATES_DIR } from '../scripts/paths.mjs';

const STDIN_MAX_CHARS = 100_000; // 与 systemone hook-io 同上限：截断即转 ask（fail-closed）

// 只对 shell 类工具生效（与 systemone risk-gate 同一份单源名单——宿主对终端类工具的常见命名
// 全覆盖）。SHELL_TOOL_NAMES 是**单源名单**：hooks.json / .codex-plugin 的 matcher 与本内核都从
// 它机器对账（test/hook.test.mjs ⑧）。注意两道门必须同口径：matcher 决定**本 hook 会不会被调
// 到**，本内核决定**调到了之后管不管**。2026-10-28 市场审查实测到这里脱节（matcher 只写
// `Bash|Shell|Terminal` 三个名，宿主把命令交给 Command/Run/exec/pwsh 类工具时本 hook 根本不被
// 调用，风险闸对那类调用零告警失灵）。
const SHELL_TOOL_NAMES = [
  'bash', 'shell', 'terminal', 'command', 'cmd', 'exec', 'process', 'run',
  'powershell', 'pwsh', 'zsh', 'fish',
];
const SHELL_TOOL = new RegExp(`(^|[_\\-.\\s])(?:${SHELL_TOOL_NAMES.join('|')})([_\\-.\\s]|$)`, 'i');
// 粘连词尾形态（2026-11-05 市场审查修复，移植 systemone risk-gate.mjs 的 SHELL_TOOL_TAIL）：
// matcher 是子串正则，`nushell` / `myshell` / `fishshell` 里的 shell 会被它命中并拉起 hook，
// 而上面的边界字符类要求关键词两侧是分隔符——内核判「非 shell 工具」静默放行，整类免检且
// 零信号。补一条「关键词作为整个工具名的词尾（前面是字母前缀）」的形态：方向安全，只会扩大
// 管辖（多拦/多问一次），不会让 shell 工具漏出，与拆驼峰（normalizeToolName）同一性质。
// fish 不进词尾形态：shellfish / catfish 这类英语词以 fish 结尾，会把非 shell 工具误收；
// 由此留下「matcher 命中但内核不认」的残余缝（如 shellfish），由 applies 不认时的 stderr
// 告警兜底（见 main 的管辖外分支）。
const SHELL_TOOL_TAIL = new RegExp(`[a-z](?:${SHELL_TOOL_NAMES.filter((n) => n !== 'fish').join('|')})$`, 'i');
// matcher 命中的近似判定：matcher 按同一份名单做子串匹配，内核不知道宿主的 matcher 长什么样，
// 用「名字含关键词子串」作代理——命中而内核不认时 stderr 一行告警，让缺口可见。
const SHELL_TOOL_SUBSTRING = new RegExp(`(?:${SHELL_TOOL_NAMES.join('|')})`, 'i');

// 驼峰宿主名先拆词再匹配（2026-10-28）：matcher 是子串正则，`RunCommand` / `ExecuteCommand` /
// `BashTool` 都会被它命中并调用 hook；但 `Command` 前是大写 R、后是小写 T，两侧都不是边界，
// 于是内核对不上、落进「非 shell 工具」静默放行——闸门看着在，实际不管这类调用。
// 它与 2026-10-27 修的「matcher 太窄导致 hook 根本不被调用」是同一个洞的两个方向：
// 那次只把 matcher 拉到与内核同宽，没锁「matcher 更宽时内核必须兜住」。
// 拆词只作为**补充**判据：先按原样匹配（`basH` 这类大小写变体原样就命中），失败再拆驼峰重试。
// 只拆词不原样匹配会把 `basH` 拆成 `bas H` 反而漏掉——这正是加上第二条判据的原因。
const normalizeToolName = (toolName) => String(toolName).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
// 先按原样匹配（`basH` 这类大小写变体原样就命中），失败再拆驼峰重试，最后认粘连词尾形态——
// 四条形态全不命中才算不管辖（与 systemone risk-gate.applies 同构）。
const applies = (toolName) => {
  if (typeof toolName !== 'string') return false;
  const normalized = normalizeToolName(toolName);
  return (
    SHELL_TOOL.test(toolName) ||
    SHELL_TOOL.test(normalized) ||
    SHELL_TOOL_TAIL.test(toolName) ||
    SHELL_TOOL_TAIL.test(normalized)
  );
};

// 代码内最小兜底（插件种子 settings.json 也缺失时的最后防线——deny 面永不因缺文件变空）
// `--no-verify` 单列（2026-10-29 市场审查补）：它是从 shell 层**单方面解除**已安装 git hook 的
// 唯一开关。插件装的 pre-push 种子钩子 + 本 hook 是「两层拦截」，其中一层能被一条参数关掉，
// 那层拦截就不成立。push 与 commit 两条实际路径都要点出来，其余工具的 `--no-verify` 不归这里管。
// `git commit -n` 单列（2026-11-01 市场审查补）：`--no-verify` 其实有两个名字——
// `git commit -h` 显示 `-n, --no-verify bypass pre-commit and commit-msg hooks`，所以"唯一开关"
// 当时是假的，短写形态把这一层照样关掉。注意 **push 的 `-n` 是 `--dry-run`**（`git push -h`：
// `-n, --[no-]dry-run`），不解除任何东西，因此不进地板——把它加进去只会制造误拦。
// export（2026-11 doctor 工单）：scripts/doctor.mjs 单源 import 本清单做安装自检的文件级地板基线。
// 只加 export，值与匹配逻辑不动。地板不可下调的执法语义见 loadLists（deny = 地板 ∪ 来源追加）。
export const BUILTIN = {
  deny: [
    'git reset --hard',
    'git push --force',
    'git push -f',
    'git push --no-verify',
    'git commit --no-verify',
    'git commit -n',
    'drop database',
  ],
  ask: ['git checkout', 'git clean', 'git branch -D', 'rm -rf'],
};

// Windows 可执行后缀剥离（2026-11-05 市场审查修复）：deny 地板曾被 `git.exe` 形态整体绕过——
// 子串判据 `c.includes(r)` 被 `.exe` 断开（`git.exe push -f` 不含 `git push -f`），词元判据切出的
// token 是 `git.exe`、与规则词 `git` 对不上。修在归一化层（子串与词元两条判据共用的唯一入口）：
// 剥掉词元尾巴上的可执行后缀（.exe/.bat/.cmd，大小写不敏感；只剥「整个词元的尾巴」，如
// `backup.exe.bak` 这种 .exe 在词中的不动），两条判据同时恢复，不加任何特例分支。方向
// fail-safe：归一化只会让判据更容易命中（被治理项目写 `deny: ["psexec.exe"]` 这类后缀规则
// 也随之与裸名等价），不会让已拦的漏网。
const EXE_SUFFIX = /\.(exe|bat|cmd)(?=[\s;&|()]|$)/g;
const norm = (s) => String(s).toLowerCase().replace(EXE_SUFFIX, '').replace(/\s+/g, ' ').trim();

// 引号与 shell 转义字符归一（2026-10-29 引号；2026-11-08 转义字符补，市场审查 C2）：引号变体
// `git push "--force"` 切出来的词元带引号，与规则里的 `--force` 对不上，deny 地板被整条绕过
// （实测三种写法全部静默放行）。shell 本身就会剥引号，判据看的是「命令实际长什么样」，保留引号
// 等于让判据看一个不存在的命令。同层再剥 `\` 与 `^`：反斜杠转义由 shell 消化（`printf '%s\n' \-f`
// 输出 `-f`），git 收到的就是完整选项——此前注释称「`\--force` 是 shell 里非法的选项写法、git 会
// 拒绝」是错的，`git push \-f` 旧判据实测整条静默放行；cmd.exe 宿主（hooks.json matcher 覆盖）
// 另有 `^` 转义符，`git push ^-^f` 同样绕过。剥除放在 unquote 同层：子串与词元两条判据共用这一
// 入口，命令与规则两侧同时看到干净形态（`-\f` 剥后成 `-f`，短簇展开逻辑可正常处理）。
// 方向 fail-safe：归一化只会让判据更容易命中（已拦的不会漏网），不会少拦。
const UNQUOTE = /["'`^\\]/g;
const unquote = (s) => String(s).replace(UNQUOTE, '');

// 短选项簇展开（2026-11-01 市场审查修复）：git 的短选项可以合写，`-uf` 等价 `-u -f`、
// `-nam` 等价 `-n -a -m`。此前判据把整串当一个词元，规则里的 `-f` / `-n` 都对不上，
// 子串判据同样落空（`git push -uf` 不含 `git push -f`）——于是「不可下调的 deny 地板」被
// 一个字符形态整体绕过（实测 `git push -uf`、`git push -uf origin HEAD`、`cd app && git push -uf`、
// `git commit -n`、`git commit -nam` 全部静默放行，而长写与引号变体全判 deny；
// `git push -fu` 当时能命中纯属运气——`git push -f` 恰好是它的子串）。
// 这与 0.1.10 修的引号变体是同一个开关的第二张脸，SECURITY.md 把这类「看起来有闸、实际没有」
// 列为正面靶子。命令侧与规则侧**都要**展开：只展命令侧的话，规则 `rm -rf` 遇命令 `rm -fr`
// 仍判不中。
// 只动「单个 - 开头、体部是纯字母数字、长度 > 1」的形态；`--x`（长选项）、裸 `-`、`-3`
// 这类单字符值一律按原样保留。方向是 fail-safe：展开只会让判据更容易命中，不会少拦。
const expandCluster = (tok) => {
  if (tok.length < 2 || tok[0] !== '-' || tok[1] === '-') return [tok];
  const body = tok.slice(1);
  if (body.length < 2 || !/^[a-z0-9]+$/i.test(body)) return [tok];
  return body.split('').map((c) => `-${c}`);
};

// 词元化：按空白与 shell 分隔符切，供「词元全含」判据使用（保留 `--flag` 原样，去引号后
// 再切——否则 `"--force"` 会带着引号成为一个独立词元）。
const tokensOf = (s) => norm(unquote(s)).split(/[\s;&|()]+/).filter(Boolean).flatMap(expandCluster);

// 长选项唯一前缀缩写命中（2026-11-08 市场审查补，C1）：git 接受长选项的**无歧义唯一前缀缩写**——
// `git reset --har HEAD~1` 与 `--hard` 等价、`--no-veri` ≡ `--no-verify`。旧词元判据只做精确
// 等值，缩写形态把 deny 地板整体绕过（实测多种写法静默放行）。双向前缀：
//   - 命令侧用缩写（`--har` 对规则词 `--hard`）→ w.startsWith(t)；
//   - 命令侧带更长后缀（`--hard-x` 对规则词 `--hard`）→ t.startsWith(w)，
//     与既有子串判据 c.includes(r) 的 fail-safe 方向一致。
//     （2026-11-09 市场审查修订：此处曾以「`--force-with-lease` 命中规则词 `--force`」为该方向
//     的例证，但 git force 安全变体已显式豁免——deny 地板防的是**无保护覆盖他人提交**，
//     force-with-lease 自带租约保护、不具该风险面，`--force-with-lease` / `--force-if-includes`
//     在 matchList 入口先被中和，不再经此前缀路径命中，见下方 SAFE_FORCE_RE。）
// 前缀模糊对两侧都设长度下限（2026-11-08 设计调整）：规则词 w 与命令侧词元 t 都要求「-- 开头且
// 长度 > 3」——裸 `--` 分隔符（len 2）与 `--x`（len 3）不参与，否则 `git reset -- file.txt` 这类
// 日常命令会被 `--hard`.startsWith(`--`) 拉进前缀命中而误拦（实测不可接受）；git 对超短长选项
// 缩写几乎必然判歧义拒绝，由此留下的漏拦面可忽略，子串判据不受影响。
// 方向 fail-safe：相对旧判据（纯精确等值），命中只会更多不会更少——已拦的不会漏网。
const tokenHit = (tokens, w) => {
  if (tokens.has(w)) return true;
  if (!w.startsWith('--') || w.length <= 3) return false;
  for (const t of tokens) {
    if (t.startsWith('--') && t.length > 3 && (t.startsWith(w) || w.startsWith(t))) return true;
  }
  return false;
};

// git force 安全变体中和（2026-11-09 市场审查）：`--force-with-lease` / `--force-if-includes`
// 是覆盖推送的**带保护**形态（租约校验远端引用未被他人更新才推），deny 地板（git push --force）
// 防的是「无保护覆盖他人提交」，安全变体不具该风险面，显式豁免（不 deny 也不 ask）。中和只做在
// matchList 的两条判据入口（tokensOf 本身不动——规则词解析也走它）：
//   - 子串判据先把安全变体（含 `=值` 段）从归一化命令里剥掉；值段字符类排除空白与 `;&|()`，
//     后续语句不被吞——`git push --force-with-lease=main;git reset --hard` 中和后仍以
//     `git reset --hard` 命中地板；
//   - 词元判据过滤掉安全变体形态的词元（否则 tokenHit 的 t.startsWith(w) 把 `--force-with-lease`
//     当 `--force` 的更长前缀命中）。
// 组合形态仍拦：`git push --force --force-with-lease` 中和后剩裸 `--force` → deny 不变。
const SAFE_FORCE_RE = /--force-(?:with-lease|if-includes)(?:=[^\s;&|()]*)?/gi;
const SAFE_FORCE_TOKEN = /^--force-(?:with-lease|if-includes)(?:=|$)/;
// 规则命中：子串命中，或（规则 ≥2 个词且每个词都作为词元出现）。
// 后者补「选项位置」差异——`git push --force` 是子串，`git push origin main --force` 不是；
// 而后者正是最常见的 force 写法。词元判据不求相邻/顺序：代价是极少数跨语句组合会多拦一次
// （如 `git push a; rm --force x`），方向是 fail-safe（多问一次/多拦一次），可接受。
function matchList(command, rules) {
  // 面板评审 C-013：SAFE_FORCE 中和只作用于内置地板规则——项目侧追加的规则按原始命令匹配，
  // 否则项目点名 `git push --force-with-lease` 的 deny/ask 永不生效（豁免不得覆盖用户清单）。
  const floorSet = new Set([...BUILTIN.deny, ...BUILTIN.ask].map((r) => norm(unquote(r))));
  const cRaw = norm(unquote(command));
  const cNeut = cRaw.replace(SAFE_FORCE_RE, '');
  const tokensRaw = new Set(tokensOf(command));
  const tokensNeut = new Set([...tokensRaw].filter((t) => !SAFE_FORCE_TOKEN.test(t)));
  for (const rule of rules || []) {
    const r = norm(unquote(rule));
    if (!r) continue;
    const isFloor = floorSet.has(r);
    const c = isFloor ? cNeut : cRaw;
    const tokens = isFloor ? tokensNeut : tokensRaw;
    if (c.includes(r)) return rule;
    const words = tokensOf(rule);
    if (words.length >= 2 && words.every((w) => tokenHit(tokens, w))) return rule;
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

// ask 决策体构造器（2026-11-05 收敛）：判定分支的 ask（输入不完整 / 缺 command）、顶层 catch 的
// 故障转 ask、stdin 挂起 killer 的兜底 ask 输出同一载荷形态——一处定义、多处复用，避免各分支
// 手写对象后形态漂移。
const askDecision = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  },
});

// 决策体输出（2026-11-05 收尾批）：write 返回 false 时旧实现只等 once('drain')——宿主已死
// （读端已关）则 drain 永不来，进程悬到宿主 15s 超时被杀。等 drain 的同时挂一次性 error，
// 先到者胜：EPIPE = 对端已不在，静默 exit 0（口径同 mcp/server.mjs 的 stdout error 处理）；
// 其余错误 stderr 留痕后按失败退出，不给「写成功」的假象。onExit 在「写完即退」与「drain 后退」
// 两路都会走（stdinKiller 的 stderr 诊断依赖这一点），error 臂独走。
const writeAndExit = (text, onExit = () => process.exit(0)) => {
  if (!text || process.stdout.write(text)) onExit();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    process.stdout.removeListener('error', onError);
    onExit();
  };
  const onError = (err) => {
    if (settled) return;
    settled = true;
    process.stdout.removeListener('drain', finish);
    if (err && err.code === 'EPIPE') process.exit(0);
    process.stderr.write(`[ai-native-delivery hook] stdout 写入失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  };
  process.stdout.once('drain', finish);
  process.stdout.once('error', onError);
};

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

// stdin 本地 deadline（2026-11-05 市场审查修复）：readStdin 只等 end/close/error，宿主喂半截
// 不关管时本 hook 会挂到宿主 15s 超时被杀——无决策体 = 静默放行，而「stdin 到得慢」恰是输入
// 最不可信的那一次。置 14s 共享预算 killer（hooks.json timeout 15s，留 1s 收尾余量，与 systemone
// hook-io.mjs 同口径）：stdin 之后的清单加载/匹配全是本地即时计算，这一道 deadline 即整个
// hook 进程的预算。触发时先向 stdout 输出 ask 决策体（与判定分支同一构造器，赶在宿主超时前
// 送达）、stderr 留一行诊断再退——把「挂起=静默放行」变成「挂起=人工确认」。
// AI_NATIVE_HOOK_KILLER_MS 为测试注入口（同 AI_NATIVE_HOOK_FAULT_INJECT 惯例，生产不设）：
// 把预算压缩到毫秒级，挂起场景无需真等 14s。
const HOOK_BUDGET_MS = 14_000;
const stdinKillerMs = () => {
  const raw = Number(process.env.AI_NATIVE_HOOK_KILLER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : HOOK_BUDGET_MS;
};
const stdinKiller = () => {
  const text = JSON.stringify(
    askDecision('[ai-native-delivery 风险闸] hook 输入读取超时（stdin 未在共享预算内完成），无法做清单匹配——请向用户展示命令并确认后再执行。'),
  );
  // 同步写完再退（复用顶层 writeAndExit 的 drain/error 竞速）：宿主 15s 超时前必须送达 ask
  const diagThenExit = () => {
    process.stderr.write('[ai-native-delivery hook] stdin 未在共享预算内完成读取，兜底输出 ask 转人工\n');
    process.exit(0);
  };
  writeAndExit(text, diagThenExit);
};

async function main() {
  const killer = setTimeout(stdinKiller, stdinKillerMs());
  let raw;
  let truncated;
  try {
    ({ raw, truncated } = await readStdin());
  } finally {
    clearTimeout(killer);
  }
  let input = {};
  let jsonBroken = false;
  // 空 stdin（2026-11-05 收尾批）：raw.trim() 为空 = 宿主没喂任何输入——input={} 曾让判定落进
  // 「非 shell 工具」静默放行，与坏 JSON/截断转 ask 的 fail-closed 方向相反。空输入同样不可信
  // （连 tool_name 都不存在），与两者同向处理。
  const emptyInput = !truncated && raw.trim() === '';
  if (!truncated && !emptyInput) {
    // 坏 JSON 与截断同向处理（2026-10-27 修复）：两者都意味着「命令不可信、读不出来」。
    //   此前坏 JSON 被 catch 成 {} → tool_name='' → 判为「非 shell 工具」→ 静默放行——与截断
    //   转 ask 的 fail-closed 方向相反：宿主喂入非 JSON 时高风险 shell 命令可直接放行且无任何痕迹。
    try { input = JSON.parse(raw); } catch { input = {}; jsonBroken = true; }
  }
  // 合法 JSON 但非对象（2026-11-08 市场审查 M1 补）：`123` / `[1]` / `"x"` 这类标量/数组形态
  // 同样读不出 tool_name——此前落进「非 shell 工具」静默放行（实测 stdin `123` → 空输出 exit 0），
  // null 则经 TypeError 顶层 catch 才转 ask——与坏 JSON/截断/空输入的 fail-closed 方向三向不一致。
  // 并入同一不可信分支（null 读取属性即抛 TypeError，本判定必须先于 tool_name 读取）：宿主协议
  // 下 PreToolUse 输入必须是 {tool_name, tool_input} 对象，其余形态与「读不出命令」同向不可信。
  const notAnObject = input === null || typeof input !== 'object' || Array.isArray(input);
  // 管辖外（非 shell 工具）与输入不可信的走向：
  //   输入不可信（截断 / 坏 JSON / 空 stdin / 非对象 JSON）→ fail-closed 转 ask，**先于非 shell 判定**——
  //     宿主已用 matcher 把本 hook 限定在 shell 工具上，输入不可信时连 tool_name 都读不出，
  //     不能拿「读不出名字」当「非 shell 工具」静默放行；
  //   非 shell 工具 → 静默放行；shell 工具但缺 command 字段 → fail-closed 转 ask。
  if (truncated || jsonBroken || emptyInput || notAnObject) {
    const why = truncated ? '输入截断' : emptyInput ? 'hook 输入为空' : 'hook 输入不是合法 JSON';
    return askDecision(`[ai-native-delivery 风险闸] ${notAnObject ? 'hook 输入不是合法的工具调用对象' : `hook 输入不完整（${why}）`}，无法做清单匹配——请向用户展示命令并确认后再执行。`);
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const command = commandOf(input.tool_input);
  // 宿主 shell 辅助工具（2026-11-09 审查收口）：BashOutput / KillShell 这类「读既有会话输出 /
  // 终止会话」的工具不携带 command，旧流程里词族命中 applies → 缺 command → 每次转 ask——
  // 它们本身不执行命令，风险面在启动该 shell 的那次调用上已判过；按非管辖静默放行，免每次
  // 读输出弹确认（fail-safe 方向不变：真正执行命令的 shell 工具仍带 command 走清单判据）。
  if (/^(?:bash[_ ]?output|kill[_ ]?shell)$/i.test(toolName)) return null;
  if (!applies(toolName)) {
    // 兜底信号（2026-11-05 市场审查修复，移植 systemone risk-gate assess 同款）：matcher 是子串
    // 正则、比内核宽。名字含 shell 词族但内核不认的形态（如 shellfish——shell 在词中间，词尾
    // 形态不收）——宿主既然拉起了 hook，多半是按「这是 shell 工具」的意图匹配的，内核放行不能
    // 一声不吭：至少 stderr 留一行，让「matcher 命中但内核不认」的缺口可见，而不是整类免检零信号。
    if (SHELL_TOOL_SUBSTRING.test(toolName)) {
      process.stderr.write(
        `[ai-native-delivery hook] 工具 "${toolName}" 命中 matcher 但风险闸内核不认（非 shell 管辖形态），已静默放行；若是 shell 类工具请反馈\n`,
      );
    }
    return null;
  }
  if (command === null) {
    return askDecision('[ai-native-delivery 风险闸] hook 输入不完整（缺 command 字段），无法做清单匹配——请向用户展示命令并确认后再执行。');
  }

  // 测试注入口（2026-10-31，同 verify.mjs --test-cmd 的夹具通道惯例）：内部故障路径无法从
  // 外部自然触发（settings 损坏已被地板执法降级处理），顶层 catch 的转 ask 行为由
  // test/hook.test.mjs 经此开关锁住。生产不设此环境变量。
  if (process.env.AI_NATIVE_HOOK_FAULT_INJECT === '1') {
    throw new Error('fault injection (test only)');
  }

  const root = findProjectRoot();
  // root 判不出时不静默（2026-11-09 审查收口）：仅用插件模板清单执法，项目侧追加项不生效——
  // 方向 fail-safe（内置地板恒在），但降级必须可见（其余降级路径均有 WARN，此前独此一处无声）。
  if (root === null) {
    process.stderr.write('[ai-native-delivery hook] 未解析到项目根（非 git 仓库或 git 不可用），仅用插件模板清单执法——项目侧追加清单不生效\n');
  }
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

// CLI 门（isMain 前置，对齐 scripts/init-engine.mjs / gen-host-manifests.mjs 先例）：本文件被
// scripts/doctor.mjs import BUILTIN 清单时不得拉起 stdin 读取——main() 顶层直跑会让导入方挂到
// stdin EOF（stdinKiller 14s 还会 process.exit 掉导入方进程）。宿主 / 测试以
// `node pretool-risk.mjs` 直跑时 argv[1] 即本文件，门内逻辑照常，行为不变。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((out) => {
      writeAndExit(out ? JSON.stringify(out) : '');
    })
    .catch((e) => {
      // 内部故障转 ask（2026-10-31 市场审查）：能走到清单加载/匹配，输入已是「shell 工具 + 有
      // 命令」——静默 exit 0 等于让一条本会命中 deny 的命令凭 hook 自身故障放行，与「输入不可信
      // 转 ask」的 fail-closed 方向相反。ask 不阻断（宿主只加一次确认），「绝不硬阻塞」的契约仍守。
      const msg = e && e.message ? e.message : String(e);
      process.stderr.write(`[ai-native-delivery hook] 风险闸内部故障，转 ask 由用户确认：${msg}\n`);
      writeAndExit(JSON.stringify(
        askDecision(`[ai-native-delivery 风险闸] hook 内部故障（${msg}）——无法完成清单匹配，请向用户展示命令并确认后再执行。`),
      ));
    });
}
