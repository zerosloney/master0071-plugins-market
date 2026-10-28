#!/usr/bin/env node
// 垫片一致性检查（市场级，2026-10-28 市场审查）。
// 五个插件各有四份清单：plugin.json（Agent Plugins 标准，权威）+ 三份宿主垫片。
// 它们由不同轮次写成，约定逐渐分叉："./skills/" 与 "./skills" 混用、部分 zcode 垫片缺
// homepage/repository/license、hooks 指针写成 "hooks" 而非 "./hooks"、skills 用显式数组
// 钉死两个目录（未来新增 skill 静默不加载）、author 缺 url。这些差异不会报错，只会在某个
// 宿主上静默少加载东西——所以用机器对账，不靠人眼。
//
//   node scripts/manifest-lint.mjs
//
// 退出码非 0 表示有不一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIMS = ['.codex-plugin', '.omp-plugin', '.zcode-plugin'];
// 每份清单都必须带的元数据键（author 额外要求 url，见下）
const META = ['homepage', 'repository', 'license', 'keywords'];

const plugins = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'plugins', e.name, 'plugin.json')))
  .map((e) => e.name)
  .sort();

const problems = [];
const fail = (msg) => problems.push(msg);
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

for (const plugin of plugins) {
  const manifestRel = `plugins/${plugin}/plugin.json`;
  const manifest = read(manifestRel);

  // 标准清单承担权威元数据：engines 只在这里声明（垫片是宿主专用，不重复）
  if (!manifest.engines || !manifest.engines.node) {
    fail(`${manifestRel}: 缺 engines.node（Node 下限必须显式声明，否则宿主无法预检）`);
  }
  if (!manifest.author || !manifest.author.url) fail(`${manifestRel}: author 缺 url`);

  for (const shim of SHIMS) {
    const rel = `plugins/${plugin}/${shim}/plugin.json`;
    if (!fs.existsSync(path.join(ROOT, rel))) { fail(`${rel}: 清单不存在`); continue; }
    const m = read(rel);

    // 身份三键必须与标准清单一致（版本另有 release.mjs --check 逐处校验，这里只兜 name）
    if (m.name !== manifest.name) fail(`${rel}: name=${m.name} 与标准清单 ${manifest.name} 不一致`);
    if (!m.author || !m.author.url) fail(`${rel}: author 缺 url`);

    // 元数据齐全：宿主市场列表只渲染垫片，缺 homepage/repository/license 就显示成无出处作品
    for (const key of META) {
      if (m[key] === undefined) fail(`${rel}: 缺 ${key}`);
    }

    // 能力指针只允许目录形式，且不带尾斜杠（"./skills/" 与 "./skills" 混用会让规范实现各执一词）
    if ('skills' in m) {
      if (m.skills !== './skills') fail(`${rel}: skills=${JSON.stringify(m.skills)}，约定为 "./skills"（目录形式，别钉死具体子目录）`);
    }
    // hooks 指针为字符串时必须与 skills 同形（"hooks" 曾与 "./skills" 并存）
    if (typeof m.hooks === 'string' && m.hooks !== './hooks') {
      fail(`${rel}: hooks=${JSON.stringify(m.hooks)}，字符串形态应为 "./hooks"`);
    }
  }
}

// ── skill 名唯一性（2026-10-28 市场审查）───────────────────────────────────
// 宿主按 frontmatter 的 `name` 解析 skill，且多数宿主是**扁平命名空间**：两个插件提供同名
// skill 时，一个会被静默覆盖、或第二个插件被安装器拒绝。此前 pstack 与 ai-native-delivery
// 都提供 `show-me-your-work`，实现还不同（log.sh + bash/perl vs decision-log.mjs + Node），
// 谁赢另一个插件的内部流程就静默失去留痕步骤——而这类流程恰好是无人值守长跑，丢了也发现不了。
// 已把 ai-native 那份更名为 decision-log；这里加机器检查防再次相撞。
// 同时校验 name 与目录名一致：宿主的发现规则是 skills/<dir>/SKILL.md，两者不一致时调用名不可预期。
const skills = [];
for (const plugin of plugins) {
  const dir = path.join(ROOT, 'plugins', plugin, 'skills');
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const fm = fs.readFileSync(skillMd, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = fm && fm[1].match(/^name:\s*(.+)$/m);
    skills.push({ plugin, dir: entry.name, name: name ? name[1].trim() : '(缺 frontmatter name)' });
  }
}
for (const s of skills) {
  if (s.name !== s.dir) {
    fail(`plugins/${s.plugin}/skills/${s.dir}/SKILL.md: name=${JSON.stringify(s.name)} 与目录名不一致（宿主按目录发现、按 name 调用）`);
  }
}
const byName = new Map();
for (const s of skills) byName.set(s.name, [...(byName.get(s.name) || []), `${s.plugin}/${s.dir}`]);
for (const [name, owners] of byName) {
  if (owners.length > 1) {
    fail(`skill 名 ${JSON.stringify(name)} 被多个插件声明：${owners.join(' + ')}——扁平命名空间下会互相覆盖，或第二个插件被安装器拒绝`);
  }
}

if (problems.length) {
  console.error(`✗ 垫片一致性检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 垫片一致性检查通过（${plugins.length} 插件 × 4 份清单；${skills.length} 个 skill 名唯一）`);
