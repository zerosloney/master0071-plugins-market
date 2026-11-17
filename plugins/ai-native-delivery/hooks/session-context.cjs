#!/usr/bin/env node
// session-context.cjs — Claude Code SessionStart 会话入口路由令注入腿（经 hooks/hooks.json 接线，宿主以
// node "${CLAUDE_PLUGIN_ROOT}/hooks/session-context.cjs" 直调）。判据级移植蓝本 agentic-flow-kit
// session-context.cjs（零运行时依赖，不 import 不 spawn）。证据来源：Claude Code 官方 hooks 文档
// （2026-11 核实）——SessionStart matcher = 会话启动方式（startup|resume|clear|compact|fork），空串匹配
// 全部来源；stdin 含 source/cwd/session_id；属「Context only」事件、无决策面（不能 block），plain stdout
// 与 hookSpecificOutput.additionalContext 同样注入为 system reminder；启动时 MCP 尚不可用，只用 type:"command"。
// 与蓝本的差异（头注声明）：
//   ① 指针文案按插件实际路径改写：插件形态无 .agents/ 指针壳，规则正文单源在插件 commands/、skills/、
//      agents/、config-templates/；${CLAUDE_PLUGIN_ROOT} 由宿主运行时展开，文案用相对指法防绝对路径入注。
//   ② zh 单语：插件 manifest 无 language 字段，kit 按 manifest.language 选语言的双语分支省略，恒中文。
//   ③ kit root 解析的 FLOW_KIT_PROJECT_ROOT 环境变量优先分支省略（插件形态由宿主直调、无该注入，
//      同 usage-collect.cjs 口径），root 恒走 payload.cwd 向上找。
// 契约：
//   1) 只指路不复制规则：规则正文单源在插件目录，本腿只注入 4 行指针，禁把红线/分级表抄进注入面
//      （单源纪律 + 每会话 token 成本）。
//   2) 零写操作、零 spawn、不读 transcript；任何异常都 exit 0（外层再兜一层），不阻塞宿主会话启动。
//   3) 用户可关：项目 .agents/config/session-context.local.json 写 {"enabled":false}（用户所有——init
//      不播种、不进安装台账、升级不覆盖）；只认显式 false，缺文件 / 坏 JSON / 其它值 = 开，
//      坏配置不静默改变注入行为。
//   4) root 解析：payload.cwd || process.cwd() 向上找 .agents/install-manifest.json（hook 进程 cwd
//      不可依赖，同 usage-collect.cjs）；非插件仓 → exit 0 零输出。
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_REL = path.join('.agents', 'config', 'session-context.local.json');
const MANIFEST_REL = path.join('.agents', 'install-manifest.json');

// 4 行中文指针（单源指路，不复制规则正文；插件路径锚：skills/session-resume/SKILL.md、commands/new-task.md）
const LINES = [
  '[ai-native-delivery 会话入口路由令] 接手/续作：先读插件 skills/session-resume/SKILL.md，用机器事实（plan 勾选态 + git status）重建当前态，禁凭记忆补勾。',
  '- 新任务：走插件 commands/new-task.md——§1 两问定级（L1/L2/L3），定级后再路由动手。',
  '- 规则正文单源在插件（commands/、skills/、agents/、config-templates/）；本注入只指路，不复制红线。',
  '- 关闭本注入：项目 .agents/config/session-context.local.json 写 {"enabled":false}（用户所有，升级不覆盖）。',
];

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, MANIFEST_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// 关闭开关：只认显式 false（缺文件 / 坏 JSON / 其它值 = 开），坏配置不静默改变注入行为。
function disabled(root) {
  const local = readJson(path.join(root, LOCAL_REL));
  return Boolean(local) && local.enabled === false;
}

function emit() {
  let data = {};
  try {
    const input = fs.readFileSync(0);
    if (input.length) data = JSON.parse(input.toString('utf8')) || {};
  } catch { /* 无 stdin / 坏载荷：本腿不依赖载荷字段，按 cwd 解析 root */ }
  const root = findRoot(data.cwd || process.cwd());
  if (!root) process.exit(0); // 非插件仓：零输出
  if (disabled(root)) process.exit(0); // 显式 false：零输出
  process.stdout.write(`${LINES.join('\n')}\n`);
  process.exit(0);
}

// CLI 守卫：只在被直接执行时消费 stdin（宿主接线为直执行，node <file> 的 argv[1] 即本文件）；
// 被 require 时无副作用。注入腿恒 exit 0——外层再兜一层，任何未预期异常也不阻塞宿主会话启动。
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try { emit(); } catch { process.exit(0); }
}
