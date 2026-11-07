#!/usr/bin/env node
// agent-pipelines 契约检查：文件齐全、四份拷贝的关键参数一致、skill 自足、垫片声明完整。
// 这些管道由提示词驱动，没有运行时可以断言行为；这里只守住静态契约，避免四份拷贝悄悄漂移。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINES, attemptLimit } from "../scripts/pipelines.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const failures = [];

// Node 18 的 readdirSync 没有 recursive 选项；手写遍历，避免测试工具反向要求 Node 20+。
function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

function check(name, ok) {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function uniqueNumbers(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((m) => Number(m[1])))];
}

function budgets(source) {
  const patterns = [
    /预算\s*≤\s*\*{0,2}(\d+)\*{0,2}/g,
    /子任务总数\s*≤\s*\*{0,2}(\d+)\*{0,2}/g,
  ];
  return [...new Set(patterns.flatMap((p) => uniqueNumbers(source, p)))];
}

function frontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : "";
}

// 文件结构
const agentFiles = readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md")).sort();
check("agents/ 恰好 6 个角色文件", agentFiles.length === 6);

for (const name of ["ralph-orchestrator", "ralph-worker", "ralph-reviewer", "coding-orchestrator", "coding-builder", "coding-reviewer"]) {
  check(`agents/${name}.md 存在`, existsSync(join(root, "agents", `${name}.md`)));
}

for (const name of ["ralph-pipeline", "coding-pipeline"]) {
  check(`skills/${name}/SKILL.md 存在`, existsSync(join(root, "skills", name, "SKILL.md")));
  check(`commands/${name}.md 存在`, existsSync(join(root, "commands", `${name}.md`)));
}

for (const rel of [
  "skills/ralph-pipeline/references/worker-role.md",
  "skills/ralph-pipeline/references/reviewer-role.md",
  "skills/coding-pipeline/references/builder-role.md",
  "skills/coding-pipeline/references/reviewer-role.md",
]) {
  check(`${rel} 存在`, existsSync(join(root, rel)));
}

// agent frontmatter：名称一致、不写死模型
for (const file of agentFiles) {
  const source = read(join("agents", file));
  const fm = frontmatter(source);
  const expected = file.replace(/\.md$/, "");
  check(`agents/${file} frontmatter name 与文件名一致`, new RegExp(`name:\\s*"${expected}"`).test(fm));
  check(`agents/${file} 不写死 model`, !/^model\s*:/m.test(fm));
}

// skill frontmatter：名称与目录一致
for (const name of ["ralph-pipeline", "coding-pipeline"]) {
  const fm = frontmatter(read(join("skills", name, "SKILL.md")));
  check(`skills/${name} frontmatter name 与目录一致`, new RegExp(`name:\\s*${name}`).test(fm));
}

// 四份拷贝的关键参数一致
const pipelines = {
  ralph: {
    files: [
      "commands/ralph-pipeline.md",
      "skills/ralph-pipeline/SKILL.md",
      "agents/ralph-orchestrator.md",
    ],
    maxCycles: 10,
    stallMax: 3,
    budget: 8,
  },
  coding: {
    files: [
      "commands/coding-pipeline.md",
      "skills/coding-pipeline/SKILL.md",
      "agents/coding-orchestrator.md",
    ],
    maxCycles: 8,
    stallMax: 2,
    budget: 6,
  },
};

for (const [pipeline, spec] of Object.entries(pipelines)) {
  for (const rel of spec.files) {
    const source = read(rel);
    const cycles = uniqueNumbers(source, /MAX_CYCLES\s*=\s*(\d+)/g);
    const stalls = uniqueNumbers(source, /STALL_MAX\s*=\s*(\d+)/g);
    const caps = budgets(source);
    check(`${rel} MAX_CYCLES 一致 (${spec.maxCycles})`, cycles.length > 0 && cycles.every((n) => n === spec.maxCycles));
    check(`${rel} STALL_MAX 一致 (${spec.stallMax})`, stalls.length > 0 && stalls.every((n) => n === spec.stallMax));
    check(`${rel} 拆分预算一致 (${spec.budget})`, caps.length > 0 && caps.every((n) => n === spec.budget));
  }
  const failuresDefault = uniqueNumbers(read(spec.files[0]), /max_failures[^\n]*?(\d+)/g);
  check(`${pipeline} max_failures 默认值出现且为 3`, failuresDefault.includes(3));
}

// skill 自足：标准入口不引用非标准目录
for (const name of ["ralph-pipeline", "coding-pipeline"]) {
  const dir = join(root, "skills", name);
  const files = walkFiles(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(name, f));
  for (const rel of files) {
    const source = read(join("skills", rel));
    check(`skills/${rel} 不链接 agents/ 或 commands/`, !/\]\(\.{0,2}\/?(agents|commands)\//.test(source));
  }
}

// 垫片必须声明 standard skills，否则对应宿主拿不到可移植入口
for (const shim of [".codex-plugin/plugin.json", ".zcode-plugin/plugin.json", ".omp-plugin/plugin.json"]) {
  const manifest = JSON.parse(read(shim));
  check(
    `${shim} 声明 skills`,
    (typeof manifest.skills === "string" && manifest.skills.length > 0) ||
      (Array.isArray(manifest.skills) && manifest.skills.length > 0),
  );
  // 宿主加载矩阵的静态部分：声明了路径就必须真实存在，避免垫片指向空目录。
  for (const field of ["skills", "commands", "agents"]) {
    const value = manifest[field];
    const paths = Array.isArray(value) ? value : value ? [value] : [];
    for (const declared of paths) {
      const rel = String(declared).replace(/^\.\//, "");
      check(`${shim} ${field} 路径存在: ${declared}`, existsSync(join(root, rel)));
    }
  }
}

// 版本一致
const version = JSON.parse(read("plugin.json")).version;
for (const shim of [".codex-plugin/plugin.json", ".zcode-plugin/plugin.json", ".omp-plugin/plugin.json"]) {
  check(`${shim} 版本与根清单一致 (${version})`, JSON.parse(read(shim)).version === version);
}

// Reviewer 必须要求可复核证据，否则 PASS 只是口头结论
for (const rel of [
  "agents/ralph-reviewer.md",
  "agents/coding-reviewer.md",
  "skills/ralph-pipeline/references/reviewer-role.md",
  "skills/coding-pipeline/references/reviewer-role.md",
]) {
  check(`${rel} 要求审查证据`, /evidence|证据/.test(read(rel)));
}

// A2：失败教训回填——委派执行者时必须注入 fail_history 摘要
// skill 与 command 是同一协议的两套入口，必须同步检查防止行为漂移
for (const rel of [
  "commands/ralph-pipeline.md",
  "commands/coding-pipeline.md",
  "agents/ralph-orchestrator.md",
  "agents/coding-orchestrator.md",
  "skills/ralph-pipeline/SKILL.md",
  "skills/coding-pipeline/SKILL.md",
]) {
  const source = read(rel);
  check(`${rel} 注入失败教训`, /失败教训/.test(source) || /fail_lessons/.test(source));
}

// A3：并行执行就绪任务——命令模板、orchestrator 与 skill 都声明"全部可执行项"委派
for (const rel of [
  "commands/ralph-pipeline.md",
  "commands/coding-pipeline.md",
  "agents/ralph-orchestrator.md",
  "agents/coding-orchestrator.md",
  "skills/ralph-pipeline/SKILL.md",
  "skills/coding-pipeline/SKILL.md",
]) {
  const source = read(rel);
  check(`${rel} 并行委派就绪任务`, /并行|全部可执行任务|全部发出/.test(source));
}

// Orchestrator 必须能派发子代理 + 跑脚本。
// 白名单缺派发工具或 Bash 时，文档要求的「用子代理执行 + 用 scripts/ 判门禁」根本跑不起来
// （审计确认过 coding-orchestrator 的白名单两者都缺，与正文自相矛盾）。
// 工具名沿用仓库既有约定：白名单里已有的是 Claude Code 风格工具名（Read/Grep/Glob/…），
// 仓库文档里的派发工具名是 `Task`（ZCode 叫 `task`）。
const toolNamesOf = (rel) => {
  const source = read(rel);
  const block = source.match(/^tools:\r?\n((?:\s*-\s*\S+\r?\n?)+)/m);
  return block ? [...block[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]) : [];
};
const orchestratorTools = toolNamesOf("agents/coding-orchestrator.md");
check("agents/coding-orchestrator.md 声明 tools 白名单", orchestratorTools.length > 0);
check("agents/coding-orchestrator.md tools 含子代理派发工具 Task", orchestratorTools.includes("Task"), orchestratorTools.join(", "));
check("agents/coding-orchestrator.md tools 含 Bash（跑 scripts/ 门禁脚本）", orchestratorTools.includes("Bash"), orchestratorTools.join(", "));

// 状态文件默认路径：脚本默认值必须与全部文档声明的 <pipeline>-pipeline.json 一致
for (const rel of ["scripts/state.mjs", "scripts/render.mjs", "scripts/graph.mjs"]) {
  const source = read(rel);
  check(`${rel} 默认状态路径为 <pipeline>-pipeline.json`, source.includes("`${pipeline}-pipeline.json`"));
  check(`${rel} 不含旧默认路径 <pipeline>.json`, !source.includes("`${pipeline}.json`"));
}
for (const rel of [
  "README.md",
  "skills/ralph-pipeline/SKILL.md",
  "skills/coding-pipeline/SKILL.md",
  "commands/ralph-pipeline.md",
  "commands/coding-pipeline.md",
]) {
  check(`${rel} 状态路径写法与脚本默认值一致`, /\.loop-cli\/state\/(ralph|coding)-pipeline\.json/.test(read(rel)));
}

// 可视化渲染：render.mjs 存在，且命令模板声明了可视化入口
check("scripts/render.mjs 存在", existsSync(join(root, "scripts", "render.mjs")));
check("scripts/serve.mjs 存在", existsSync(join(root, "scripts", "serve.mjs")));
for (const rel of ["commands/ralph-pipeline.md", "commands/coding-pipeline.md"]) {
  const source = read(rel);
  check(`${rel} 声明可视化命令`, /render\.mjs/.test(source));
  check(`${rel} 可视化支持 .html 输出`, /\.html/.test(source));
  check(`${rel} 声明实时看板命令`, /serve\.mjs/.test(source));
}

// A4：角色文件的注入段落必须与 references 的角色契约一致（2026-10-28 市场审查）
// 背景：`agents/` 与 `skills/<pipeline>/references/` 是同一角色契约的两份载体——前者被加载
// agents/ 的宿主（omp）用，后者被可移植宿主（Codex 等不加载 agents/）靠 Orchestrator 注入用。
// 两份的「Orchestrator 必须注入这些段落」清单此前靠人工同步，实测漂移过：coding-builder.md 与
// coding-reviewer.md 都漏了 `=== Critical Checkpoints ===`（该段是 DONE 判据之一，缺了 builder 就
// 收不到硬门禁清单）。这里把「同角色的两份段落清单必须逐项一致」变成机器对账。
const SECTION_RE = /^===\s*(.+?)\s*===$/gm;
const sectionsOf = (rel) => [...read(rel).matchAll(SECTION_RE)].map((m) => m[1].trim());
for (const [agentRel, refRel] of [
  ["agents/coding-builder.md", "skills/coding-pipeline/references/builder-role.md"],
  ["agents/coding-reviewer.md", "skills/coding-pipeline/references/reviewer-role.md"],
  ["agents/ralph-worker.md", "skills/ralph-pipeline/references/worker-role.md"],
  ["agents/ralph-reviewer.md", "skills/ralph-pipeline/references/reviewer-role.md"],
]) {
  const a = sectionsOf(agentRel);
  const r = sectionsOf(refRel);
  check(`${agentRel} 声明了注入段落`, a.length > 0);
  check(`${refRel} 声明了注入段落`, r.length > 0);
  const missingInAgent = r.filter((s) => !a.includes(s));
  const missingInRef = a.filter((s) => !r.includes(s));
  check(
    `${agentRel} ↔ ${refRel} 注入段落一致`,
    missingInAgent.length === 0 && missingInRef.length === 0,
    `agents 缺 ${JSON.stringify(missingInAgent)}；references 缺 ${JSON.stringify(missingInRef)}`,
  );
}

// A4 补强：角色文件正文的关键契约 token 必须双侧齐备（2026-11 一致性审计盲区）
// 背景：上面的对账只比 `=== … ===` 注入段落标记清单，正文规则漂移检测不到——实测发生过
// agents 版漏掉输入完整性守卫（`reason="missing_input"`）、输出字段名 `check_results` 未跟上
// references 的 `verification`，两处都是段落清单齐全、正文单侧漂移。两份载体的措辞
// legitimately 不同，不做全文等价；这里对账每对文件都必须共有的核心契约 token
// （反引号标识符与 `字段="值"` 模式），集合按各角色实际正文精选、宁少勿滥。
for (const [agentRel, refRel, tokens] of [
  [
    "agents/coding-builder.md",
    "skills/coding-pipeline/references/builder-role.md",
    // 输出 JSON 的机器可路由字段 + 范围红线
    ["forbidden_scope", "root_cause_group", "verification", "scope_drift"],
  ],
  [
    "agents/coding-reviewer.md",
    "skills/coding-pipeline/references/reviewer-role.md",
    // 输入完整性守卫 + 验证复核字段 + 归并规则 + 零证据禁令 + verdict 枚举
    ['verdict="REJECT"', 'scope_drift="FAIL"', 'reason="missing_input"', "verification", "root_cause_group", "NEEDS_FIX", "scripts_gap"],
  ],
  [
    "agents/ralph-worker.md",
    "skills/ralph-pipeline/references/worker-role.md",
    // 任务判据 + 上报协议（PASS/FAIL 原样上报）+ 输出 JSON 字段
    ["accept_criteria", "verification: PASS", "verification: FAIL", "task_id", "verification_cmd"],
  ],
  [
    "agents/ralph-reviewer.md",
    "skills/ralph-pipeline/references/reviewer-role.md",
    // 输入完整性守卫 + 判据复核字段 + verdict 枚举 + 证据格式
    ['verdict="REJECT"', 'reason="missing_input"', "accept_criteria", "verification", "NEEDS_FIX", "task_id", "file:line"],
  ],
]) {
  const missingInAgent = tokens.filter((t) => !read(agentRel).includes(t));
  const missingInRef = tokens.filter((t) => !read(refRel).includes(t));
  const missing = [
    missingInAgent.length > 0 ? `agents 版缺 ${JSON.stringify(missingInAgent)}` : "",
    missingInRef.length > 0 ? `references 版缺 ${JSON.stringify(missingInRef)}` : "",
  ]
    .filter(Boolean)
    .join("；");
  check(
    `${agentRel} ↔ ${refRel} 正文关键契约 token 双侧齐备${missing ? `（${missing}）` : ""}`,
    missingInAgent.length === 0 && missingInRef.length === 0,
  );
}

// A5：orchestrator 的背压数值契约锚定到脚本单源（2026-11 一致性审计盲区）
// 背景：equivalence.mjs 只锚定 commands+SKILL 文档；两个 agents/ orchestrator 文件里的
// MAX_CYCLES / STALL_MAX / max_failures / max_attempts 是手写拷贝——前三者此前最多被本文件
// 上方硬编码参数表（与脚本常量是两份源）间接覆盖，max_failures / max_attempts 则完全无校验。
// 这里直接 import scripts/pipelines.mjs 的常量对账：文档数值 ↔ 脚本实际值。
// max_failures 默认值单源在 state.mjs init，提取方式与 equivalence.mjs 相同。
const failuresMatch = read("scripts/state.mjs").match(/max_failures:\s*(\d+)/);
check("scripts/state.mjs init max_failures 默认存在", Boolean(failuresMatch));
const maxFailuresDefault = failuresMatch ? Number(failuresMatch[1]) : -1;
for (const [pipeline, rel] of Object.entries({ ralph: "agents/ralph-orchestrator.md", coding: "agents/coding-orchestrator.md" })) {
  const spec = PIPELINES[pipeline];
  const source = read(rel);
  const cycles = uniqueNumbers(source, /MAX_CYCLES\s*=\s*(\d+)/g);
  const stalls = uniqueNumbers(source, /STALL_MAX\s*=\s*(\d+)/g);
  const factors = [...source.matchAll(/MAX_CYCLES=\d+\s*×\s*(0\.\d+)/g)].map((m) => Number(m[1]));
  const failureDefaults = [...source.matchAll(/max_failures`?（默认\s*(\d+)）/g)].map((m) => Number(m[1]));
  const attemptDefaults = [...source.matchAll(/max_attempts`?（默认\s*(\d+)）/g)].map((m) => Number(m[1]));
  check(`${rel} MAX_CYCLES 与 PIPELINES.${pipeline}.maxCycles 一致 (${spec.maxCycles})`, cycles.length > 0 && cycles.every((n) => n === spec.maxCycles));
  check(`${rel} STALL_MAX 与 PIPELINES.${pipeline}.stallMax 一致 (${spec.stallMax})`, stalls.length > 0 && stalls.every((n) => n === spec.stallMax));
  check(`${rel} 预算折算系数与 PIPELINES.${pipeline}.factor 一致 (${spec.factor})`, factors.length > 0 && factors.every((n) => n === spec.factor));
  check(`${rel} max_failures 默认与 state.mjs init 一致 (${maxFailuresDefault})`, failureDefaults.length > 0 && failureDefaults.every((n) => n === maxFailuresDefault));
  check(`${rel} max_attempts 默认与 attemptLimit 一致 (${attemptLimit})`, attemptDefaults.length > 0 && attemptDefaults.every((n) => n === attemptLimit));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
