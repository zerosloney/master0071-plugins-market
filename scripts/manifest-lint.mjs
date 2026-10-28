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

if (problems.length) {
  console.error(`✗ 垫片一致性检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 垫片一致性检查通过（${plugins.length} 插件 × 4 份清单）`);
