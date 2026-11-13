// hosts.mjs — 宿主垫片注册表（纯数据，2026-11 宿主 manifest 单源生成器引入）
// 职责：声明三个宿主垫片（.zcode-plugin / .codex-plugin / .omp-plugin）各自的形态差异，
//       供 gen-host-manifests.mjs 从「根 plugin.json + hooks/hooks.json」单源渲染。
// 不变式：共享字段（name/version/author/homepage/repository/license/keywords）**不在本文件出现字面量**，
//       运行时从根 plugin.json 读；宿主私有文案（短描述 / interface / category）从现有垫片原样搬入。
// 新增宿主 = 本表加一行 + gen-host-manifests.mjs 无需改动（渲染器按本表数据驱动）。

// 宿主垫片共用的短描述（三份垫片现文案逐字相同，原样搬入；改文案请同步重生成垫片）
export const SHORT_DESCRIPTION = 'AI-Native 交付治理引擎：三层闭环（任务级硬闭环 / 状态收敛闭环 / 治理进化闭环）——L0/L1/L2/L3 风险泳道 + check-loop 硬门 6 段 + 台账三件套 + 判定账进化；台账为项目级资产，一律落使用项目 git 仓库根。';

// codex 宿主 interface 块（市场展示面，原样搬自 .codex-plugin/plugin.json，不改文案）
const INTERFACE_CODEX = {
  displayName: 'AI-Native Delivery',
  shortDescription: 'AI-Native 交付治理：风险泳道定级 + 硬门关单闸 + 台账审计',
  longDescription: '把交付治理做成三层闭环：任务级硬闭环（L0 极简道与两问定级进 L1/L2/L3 泳道、check-loop 硬门 6 段、关单与 pre-push 物理闸门）、状态收敛闭环（台账三件套 + INDEX + 收敛对账 + 台账卫生）、治理进化闭环（judgment-ledger 计数、退役候选、门禁段数棘轮、实测墙钟预算）。台账与三本审计账为项目级资产，一律落使用项目 git 仓库根。',
  developerName: 'master0071',
  category: 'Developer Tools',
  capabilities: ['Read', 'Write'],
  websiteURL: 'https://github.com/zerosloney/master0071-plugins-market',
  defaultPrompt: [
    '先给这个任务定级（≤5 文件小改走 L0 极简道，否则两问定级 L1/L2/L3）再开工',
    '关单前跑一遍硬门校验与收敛对账',
  ],
};

// MCP 声明形态：
//   inline-claude-root → 内联 mcpServers 对象，路径用 ${CLAUDE_PLUGIN_ROOT}（zcode / omp）
//   pointer-mcp-json   → 字符串指针 "./mcp.json"（codex）
// hooks 声明形态：
//   pointer              → 字符串指针 "./hooks"（zcode）
//   inline-from-hooks-json → 内联对象，**整块取自 hooks/hooks.json**（codex——matcher/command/timeout
//                            不做第二份拷贝，改风险闸先改 hooks.json 再重生成）
//   none                 → 不声明 hooks 键（omp 宿主不拉 PreToolUse，README「宿主差异」有明文）
export const HOSTS = [
  {
    id: 'zcode',
    dir: '.zcode-plugin',
    order: ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'mcpServers', 'skills', 'commands', 'agents', 'hooks'],
    descriptionKind: 'short',
    mcp: 'inline-claude-root',
    hooks: 'pointer',
    points: ['skills', 'commands', 'agents', 'hooks'],
    extra: {},
  },
  {
    id: 'codex',
    dir: '.codex-plugin',
    order: ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'mcpServers', 'skills', 'hooks', 'interface'],
    descriptionKind: 'short',
    mcp: 'pointer-mcp-json',
    hooks: 'inline-from-hooks-json',
    points: ['skills'],
    extra: { interface: INTERFACE_CODEX },
  },
  {
    id: 'omp',
    dir: '.omp-plugin',
    order: ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'category', 'mcpServers', 'skills', 'commands', 'agents'],
    descriptionKind: 'short',
    mcp: 'inline-claude-root',
    hooks: 'none',
    points: ['skills', 'commands', 'agents'],
    extra: { category: 'productivity' },
  },
];
