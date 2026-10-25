#!/usr/bin/env node
// agent-pipelines 契约检查：文件齐全、四份拷贝的关键参数一致、skill 自足、垫片声明完整。
// 这些管道由提示词驱动，没有运行时可以断言行为；这里只守住静态契约，避免四份拷贝悄悄漂移。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
for (const rel of [
  "commands/ralph-pipeline.md",
  "commands/coding-pipeline.md",
  "agents/ralph-orchestrator.md",
  "agents/coding-orchestrator.md",
]) {
  const source = read(rel);
  check(`${rel} 注入失败教训`, /失败教训/.test(source) || /fail_lessons/.test(source));
}

// A3：并行执行就绪任务——命令模板与 orchestrator 都声明"全部可执行项"委派
for (const rel of [
  "commands/ralph-pipeline.md",
  "commands/coding-pipeline.md",
  "agents/ralph-orchestrator.md",
  "agents/coding-orchestrator.md",
]) {
  const source = read(rel);
  check(`${rel} 并行委派就绪任务`, /并行|全部可执行任务|全部发出/.test(source));
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
