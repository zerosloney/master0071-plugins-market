#!/usr/bin/env node
// gen-verify-feature.mjs — verify-ui 特性地图生成器（2026-10-22 pstack create-verification-skill 借鉴）
// 用法：
//   node .agents/skills/verify-ui/scripts/gen-verify-feature.mjs [--check] [--json]       列出未覆盖的顶层路由
//   node .agents/skills/verify-ui/scripts/gen-verify-feature.mjs --route /suppliers       生成 features/suppliers.md 骨架
// 口径：顶层路由 = router 里一段路径（排除 /login、/、/home、含 :param 的动态路由）。
//   覆盖 = 任一 features/*.md 提到该路由（#/route 或 /route）。
//   生成只写骨架（四段 H2 + TODO），不编造驱动步骤；填完再用于实测。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// 路径收口（2026-10-27 插件化迁移）：插件内种子 features 目录经 PLUGIN_ROOT 定位（paths.mjs 单源）。
import { PLUGIN_ROOT } from '../../../scripts/paths.mjs';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const asJson = argv.includes('--json');
const check = argv.includes('--check');
const routeArg = argOf('--route');

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (root.status !== 0 || !root.stdout.trim()) {
  console.error('gen-verify-feature: 不在 git 仓库');
  process.exit(2);
}
const ROOT = root.stdout.trim();
const routerPath = path.join(ROOT, 'frontend', 'src', 'router', 'index.ts');
if (!fs.existsSync(routerPath)) {
  console.error('gen-verify-feature: 未找到 frontend/src/router/index.ts');
  process.exit(2);
}
const routes = new Set();
for (const m of fs.readFileSync(routerPath, 'utf8').matchAll(/path:\s*'([^']+)'/g)) {
  const raw = m[1];
  routes.add(raw.startsWith('/') ? raw : `/${raw}`);
}
const topLevel = [...routes].filter((r) => {
  if (r === '/' || r === '/login' || r === '/home') return false;
  if (r.includes(':')) return false;
  return r.split('/').filter(Boolean).length === 1;
}).sort();

// features 目录定位（2026-10-27 插件化迁移改道，paths.mjs「二选一、项目侧优先」同款）：
// 项目侧 .agents/skills/verify-ui/features 存在 → 只认项目自有地图；不存在 → 回退插件内
// skills/verify-ui/features（2026-10-29 起只有一份 _TEMPLATE.md 模板，不构成覆盖面——
// 特性地图是项目数据，含源产品路由与界面结构，不随插件分发）。--route 生成恒落项目侧目录。
const projectFeaturesDir = path.join(ROOT, '.agents', 'skills', 'verify-ui', 'features');
const seedFeaturesDir = path.join(PLUGIN_ROOT, 'skills', 'verify-ui', 'features');
const featuresDir = fs.existsSync(projectFeaturesDir) ? projectFeaturesDir : seedFeaturesDir;
const covered = new Set();
if (fs.existsSync(featuresDir)) {
  for (const f of fs.readdirSync(featuresDir).filter((x) => x.endsWith('.md') && x !== '_TEMPLATE.md')) {
    const text = fs.readFileSync(path.join(featuresDir, f), 'utf8');
    for (const m of text.matchAll(/#?(\/[A-Za-z0-9_./:-]+)/g)) covered.add(m[1]);
  }
}
const uncovered = topLevel.filter((r) => !covered.has(r));

if (asJson) {
  console.log(JSON.stringify({ topLevel, covered: [...covered].sort(), uncovered }, null, 2));
  process.exit(check && uncovered.length ? 1 : 0);
}
if (check) {
  if (uncovered.length) {
    console.error(`特性地图覆盖缺口（${uncovered.length} 个顶层路由未进地图）：`);
    for (const r of uncovered) console.error(`  - ${r}`);
    console.error('  处理：按核心特性优先级补 features/<slug>.md（node .agents/skills/verify-ui/scripts/gen-verify-feature.mjs --route <path> 生成骨架）。');
    process.exit(1);
  }
  console.log(`✅ 特性地图覆盖全部 ${topLevel.length} 个顶层路由`);
  process.exit(0);
}
if (routeArg) {
  const route = routeArg.startsWith('/') ? routeArg : `/${routeArg}`;
  if (!routes.has(route)) {
    console.error(`gen-verify-feature: 路由 ${route} 不在 router（先确认路径）`);
    process.exit(2);
  }
  if (covered.has(route)) {
    console.error(`gen-verify-feature: 路由 ${route} 已被特性地图覆盖——改现有文件，不新建`);
    process.exit(1);
  }
  const slug = route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'feature';
  const file = path.join(projectFeaturesDir, `${slug}.md`);
  if (fs.existsSync(file)) {
    console.error(`gen-verify-feature: 文件已存在 ${path.relative(ROOT, file)}——改现有文件，不覆盖`);
    process.exit(1);
  }
  const content = [
    `# 特性：${route}`,
    '',
    '> 生成骨架（gen-verify-feature.mjs，2026-10-22）。四段缺一不建；填完再用于实测。',
    '',
    '## 到达路径',
    '',
    `hash 路由 \`#${route}\`。入口：<TODO 侧栏/列表/按钮>。`,
    '',
    '## 驱动',
    '',
    '<TODO 用户 POV 的操作步骤；优先稳定锚点（ARIA/data-testid/路由）>。',
    '',
    '## 可观察终态',
    '',
    '<TODO 什么现象证明它工作；给 file:line 或接口/字段>。',
    '',
    '## Gotchas',
    '',
    '<TODO 前置条件、坑、已知漂移>。',
    '',
  ].join('\n');
  fs.mkdirSync(projectFeaturesDir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  console.log(`✅ 已生成 ${path.relative(ROOT, file)}——填完四段再用于实测`);
  process.exit(0);
}

console.log(`顶层路由 ${topLevel.length} 个，已覆盖 ${topLevel.length - uncovered.length} 个，缺口 ${uncovered.length} 个：`);
for (const r of uncovered) console.log(`  - ${r}`);
console.log('生成骨架：node .agents/skills/verify-ui/scripts/gen-verify-feature.mjs --route <path>');
