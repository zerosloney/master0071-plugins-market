// install/plan.mjs — 初始化计划（plan/apply 两段式的 plan 段；2026-11 安装引擎重构）
// 职责：把 init-engine 的**全部落盘行为**描述为纯数据计划条目——无写盘副作用（只读探测目标现状
// 允许，如 gitHooksDir 的 git 查询）。裁决留给 apply.mjs，本文件只回答「要装什么、装到哪、期望哈希」。
// 条目形状 { srcAbs|content, targetRel, category, kind }，kind ∈：
//   copy             config-templates 种子纯复制（原样字节拷贝，语义同旧 copyFileSync）
//   pipelines        编排脚本种子（.agents/pipelines/ 专位，落位口径见下 ①b 注释）
//   settings         settings.json（项目侧专位 .agents/settings.json，与 config/ 平级）
//   runtime          空文件与运行时/台账目录（confirmations.jsonl、cache/、workflow/ 八子目录等）
//   skeleton         workflow/ 内联骨架文档
//   gitignore-block  .gitignore 标记块（块级合并，不进安装台账）
//   githook          git 钩子（占位符渲染后的最终正文；台账记渲染后哈希）
// category 用于 apply 报告分组（沿用旧 report 分组语义：hooks→report.hooks、gitignore→report.gitignore、
// 其余平铺进 created/skipped/updated/conflict）。
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, PLUGIN_CONFIG_TEMPLATES_DIR, engineDir, scriptPath, gitHooksDir } from '../paths.mjs';
import { hashText, hashFile } from './manifest.mjs';

export const GITIGNORE_BEGIN = '# BEGIN ai-native-delivery engine';
export const GITIGNORE_END = '# END ai-native-delivery engine';
// 插件名（2026-11 市场审查 M12）：陈旧自装钩子的「自装」判据锚。宿主版本化缓存布局
// <cache>/<市场>/<插件名>/<版本>/ 下 path.basename(PLUGIN_ROOT) 是**版本号**——升版后旧钩子
// baked 的是旧版本目录路径，按当前版本号切路径段永不命中 → 旧钩子被误判第三方，"重跑
// init-engine" 的修复指引沦为 no-op。改从 plugin.json 的 name 读（单源）；读不出回退目录名
//（源仓开发形态目录名即插件名，两者同值）。台账的 plugin/version 同源读取。
function pluginIdentity() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
    return {
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : path.basename(PLUGIN_ROOT),
      version: typeof pkg.version === 'string' ? pkg.version : '',
    };
  } catch { return { name: path.basename(PLUGIN_ROOT), version: '' }; }
}

// 本机不入库项（§5.2 入库口径表：判定/验证流水与缓存是本机机器事实；本机环境与个人模型映射不入库）
export const GITIGNORE_ENTRIES = [
  '.agents/cache/',
  '.agents/judgments.jsonl',
  '.agents/verifications.jsonl',
  '.agents/tmp/',
  '.agents/config/model-roles.local.json',
  '.agents/notes/runtime-env.local.md',
  // 台账写锁的临时锁文件（2026-11-01）：ledger-shards 与 MCP update_ledger 共用
  // `<分片>.md.lock` 做读-改-写临界区。正常路径写完即删；进程被 kill 时残留物最多留 15s
  // 就会被接管，但那一瞬间不该污染项目的 git status。
  'workflow/**/*.lock',
  // 确认分片与主台账写锁残留（2026-11-09 审查收口）：confirmations.d/ 分片锁与主账
  // confirmations.jsonl.lock 同属「进程被 kill 可短暂残留」的临时锁，不该污染 git status。
  '.agents/confirmations.d/*.lock',
  '.agents/confirmations.jsonl.lock',
];

const WORKFLOW_SUBDIRS = ['plans', 'specs', 'intents', 'incidents', 'reviews.d', 'delegations.d', 'evidence', 'archive'];
const WORKFLOW_DOCS = {
  'INDEX.md': '# workflow 索引 — 活跃层与档案\n\n> 初始化骨架（ai-native-delivery init-engine 生成）。活跃层表格可由 gen-workflow-index.mjs 重建；\n> 跨会话恢复优先用 MCP read_context（INDEX 头部 + 在途三件套 + 最近确认行）。\n',
  'papercuts.md': '# papercuts — 确认税与摩擦记录\n',
  'delegations.md': '# delegations — 委派记录\n',
  'metrics.md': '# metrics — 交付指标\n',
  'regression-checklist.md': '# regression-checklist — 回归清单\n',
};
// 运行时目录单源（2026-11-12 写前门判据移植 export）：hooks/pre-write-guard.mjs 的「执法面自保护
// 可写例外」复用同一份名单——init-engine 落什么运行时目录，写前门就放什么目录，两处永不漂移。
export const RUNTIME_DIRS = ['cache', 'loop', 'notes', 'board', 'tmp'];

function walkFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs));
  }
  return out.sort();
}

// config-templates → .agents/config 种子清单。排除：githooks/（.git/hooks 安装的模板源，非项目配置）、
// settings.json（项目侧专位在 .agents/settings.json，与 config/ 平级——§5.2 目录规范）、
// pipelines/（项目侧专位在 .agents/pipelines/——编排脚本落位口径，见下方 ①b）、
// ledger-prune/rebuild-manifest.json（2026-11-05：owner 授权修剪/重建的凭据（逐行 sha256）与授权
//   原文属**运行数据**，按「运行数据不迁」红线不随 init 种子——check-ledger-invariant 只消费
//   提交自带的 manifest（git 对象读取，工作区/插件目录一律不读），项目侧不预置即无特许通道；
//   config-templates 留档仅作格式样例，见两文件 _note）。
function configSeedFiles() {
  return walkFiles(PLUGIN_CONFIG_TEMPLATES_DIR)
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('githooks/') && rel !== 'settings.json' && !rel.startsWith('pipelines/')
      && rel !== 'ledger-prune-manifest.json' && rel !== 'ledger-rebuild-manifest.json');
}

// 钩子正文渲染（平移旧 installHooks 的实化逻辑）：种子占位符 @@ENGINE_SCRIPT@@ / @@LANE@@ 在
// 计划期实化。ENGINE_SCRIPT 用 JSON.stringify 生成字符串字面量——Windows 反斜杠路径在 JS 单引号
// 串里是转义雷（'\U' 会吞反斜杠），JSON 字面量转义是唯一稳妥写法。LANE：两钩子均走默认 hard
// 车道（§3.2 L-git：pre-commit / pre-push 都是 check-loop 硬门执法点）。CRLF 种子（core.autocrlf
// 检出）落盘前归一——钩子由 sh 启动，CRLF shebang 会断。种子未安装时占位串保持原样（语法仍
// 合法，spawn 时 fail-closed）；种子头注的散文里合法提到 @@ENGINE_SCRIPT@@（无引号），故匹配
// 必须带引号整体替换。种子缺席 → 该钩子不装（同旧 installHooks 的 continue）。
// 2026-11-11 判据移植新增两占位符（同机制、同带引号整体替换）：
//   @@DOC_BODY_DRIFT_SCRIPT@@ → check-doc-body-drift.mjs（pre-commit advisory 腿，脚本缺席时钩子内
//     existsSync 守卫只损可见性不阻断）；@@HOOK_WIRING_SCRIPT@@ → check-hook-wiring.mjs（pre-push
//     接线对账腿，条件执行：在场才跑，红即挡推送）。
// 2026-11-11 Dreaming 记忆负债链新增：@@DREAM_SCRIPT@@ → dream-run.mjs（post-commit advisory 提醒腿，
//     钩子内 existsSync 守卫缺席静默——advisory 不指死命令）。post-commit 种子不含 @@ENGINE_SCRIPT@@
//     等其余占位符，renderHook 的 replace 对未命中占位符是 no-op——同一渲染机制天然覆盖。
// 2026-11-12 L0/L1 快速道移植新增三占位符（同机制、同带引号整体替换）：
//     @@CONFIRM_ORDER_SCRIPT@@ → check-confirm-order.mjs（commit-msg 顺序门 gate 腿，fail-closed）；
//     @@PLAN_REF_SCRIPT@@ → check-commit-plan-ref.mjs（commit-msg 任务短名 advisory 腿，existsSync 守卫）；
//     @@SCOPE_RANGE_SCRIPT@@ → check-scope-range.mjs（pre-push 推送范围对账 gate 腿，fail-closed）。
function renderHook(root, name) {
  let tpl;
  try { tpl = fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'githooks', name), 'utf8'); } catch { return null; }
  // enginePath = 该钩子指向的引擎脚本（台账/doctor/报告文案共用）：执法钩子指 check-loop.mjs；
  // post-commit 的提醒腿指 dream-run.mjs（advisory，非执法）；commit-msg 的顺序门腿指 check-confirm-order.mjs。
  const engine = scriptPath(root, name === 'post-commit' ? 'dream-run.mjs' : name === 'commit-msg' ? 'check-confirm-order.mjs' : 'check-loop.mjs');
  const content = tpl.replace(/\r\n/g, '\n')
    .replace(/"@@ENGINE_SCRIPT@@"/g, JSON.stringify(engine))
    .replace(/"@@LANE@@"/g, JSON.stringify(''))
    .replace(/"@@DOC_BODY_DRIFT_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'check-doc-body-drift.mjs')))
    .replace(/"@@HOOK_WIRING_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'check-hook-wiring.mjs')))
    .replace(/"@@DREAM_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'dream-run.mjs')))
    .replace(/"@@CONFIRM_ORDER_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'check-confirm-order.mjs')))
    .replace(/"@@PLAN_REF_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'check-commit-plan-ref.mjs')))
    .replace(/"@@SCOPE_RANGE_SCRIPT@@"/g, JSON.stringify(scriptPath(root, 'check-scope-range.mjs')));
  return { engine, content };
}

/**
 * buildPlan(root)：把一次初始化的全部落盘行为描述为计划（纯数据，无写盘）。
 * 条目顺序刻意与旧 init-engine 的执行顺序一致——报告清单的排列随之不漂。
 * @returns {{root:string, hooksDir:string|null, plugin:{name:string,version:string}, warnings:string[], entries:Array}}
 */
export function buildPlan(root) {
  const entries = [];
  const warnings = [];

  // 首行判断：policyVersion 升级提示（不自动覆盖项目侧 engine.json 的**项目改动**；
  // 装户文件仍是种子原样时由 apply 的 update 通道传播升版——两通道并存，WARN 语义不变）。
  const seedEngine = JSON.parse(fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json'), 'utf8'));
  const projEngine = path.join(engineDir(root), 'config', 'engine.json');
  if (fs.existsSync(projEngine)) {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(projEngine, 'utf8')); } catch { /* 损坏交由种子守门（缺文件才补） */ }
    if (cur && Number(cur.policyVersion) !== Number(seedEngine.policyVersion)) {
      const projV = cur.policyVersion === undefined ? '缺 policyVersion（按 v1 基线）' : `policyVersion=${cur.policyVersion}`;
      warnings.push(`项目 .agents/config/engine.json ${projV} 与插件种子 ${seedEngine.policyVersion} 不同——可升级（手工对齐或删除该文件后重跑本脚本重新种子；初始化不自动覆盖项目改动）`);
    }
  }

  // ① .agents/config 全量种子
  for (const rel of configSeedFiles()) {
    const srcAbs = path.join(PLUGIN_CONFIG_TEMPLATES_DIR, ...rel.split('/'));
    entries.push({ kind: 'copy', category: 'config', srcAbs, targetRel: `.agents/config/${rel}`, hash: hashFile(srcAbs) });
  }
  // ② settings.json（项目侧专位）+ 确认账 + 运行时目录
  const settingsSrc = path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json');
  entries.push({ kind: 'settings', category: 'settings', srcAbs: settingsSrc, targetRel: '.agents/settings.json', hash: hashFile(settingsSrc) });
  entries.push({ kind: 'runtime', category: 'runtime', targetRel: '.agents/confirmations.jsonl', content: '', hash: hashText('') });
  for (const dir of ['confirmations.d', ...RUNTIME_DIRS]) {
    entries.push({ kind: 'runtime', category: 'runtime', targetRel: `.agents/${dir}/`, dir: true });
  }
  // ③ workflow/ 台账骨架
  for (const dir of WORKFLOW_SUBDIRS) {
    entries.push({ kind: 'runtime', category: 'workflow', targetRel: `workflow/${dir}/`, dir: true });
  }
  for (const [name, skeleton] of Object.entries(WORKFLOW_DOCS)) {
    entries.push({ kind: 'skeleton', category: 'workflow', targetRel: `workflow/${name}`, content: skeleton, hash: hashText(skeleton) });
  }
  // ④ .gitignore 标记块（不入安装台账——块级合并）
  entries.push({ kind: 'gitignore-block', category: 'gitignore', targetRel: '.gitignore' });
  // ⑤ git hooks（钩子目录走 gitHooksDir()：core.hooksPath 优先，否则 `git rev-parse --git-path
  // hooks`——worktree 下 .git 是文件，拼 <root>/.git/hooks 会 ENOTDIR 崩）。解析不出（非 git 仓 /
  // git 不可用）→ hooksDir=null、无钩子条目，apply 据此报「git hooks 未安装」。
  const hooksDir = gitHooksDir(root);
  if (hooksDir) {
    // pre-commit / pre-push = 执法点（check-loop hard 门）；post-commit = Dreaming advisory 提醒腿
    // （2026-11-11 移植，exit 恒 0 不阻断）；commit-msg = 顺序门执法点（2026-11-12 L0/L1 快速道移植，
    // 先确认后改代码 gate + 任务短名 advisory——同一 githook kind 与占位符实化机制，差别只在渲染内容）。
    for (const name of ['pre-commit', 'pre-push', 'post-commit', 'commit-msg']) {
      const rendered = renderHook(root, name);
      if (!rendered) continue;
      const targetAbs = path.join(hooksDir, name);
      // 台账键：相对项目根的 posix 路径（标准仓即 .git/hooks/<name>）。worktree / core.hooksPath
      // 下钩子目录在根外 → '../..' 形态键（跨盘极端下 path.relative 退化为绝对路径）——键只需
      // 本机稳定可复算，不进报告文案也不作展示用。
      const targetRel = path.relative(root, targetAbs).split(path.sep).join('/') || name;
      entries.push({ kind: 'githook', category: 'hooks', targetRel, hookName: name, enginePath: rendered.engine, content: rendered.content, hash: hashText(rendered.content) });
    }
  }
  // ⑥ 编排脚本种子 → .agents/pipelines/（①b 落位口径单源：config-templates/pipelines/_TEMPLATE.md
  // 头注、workflows-check.mjs 扫描面、autonomous-run skill 三处同源，均指 .agents/pipelines/）。
  const pipelinesSrc = path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'pipelines');
  if (fs.existsSync(pipelinesSrc)) {
    for (const rel of walkFiles(pipelinesSrc)) {
      const posix = rel.split(path.sep).join('/');
      const srcAbs = path.join(pipelinesSrc, ...rel.split(path.sep));
      entries.push({ kind: 'pipelines', category: 'pipelines', srcAbs, targetRel: `.agents/pipelines/${posix}`, hash: hashFile(srcAbs) });
    }
  }

  return { root, hooksDir: hooksDir || null, plugin: pluginIdentity(), warnings, entries };
}
