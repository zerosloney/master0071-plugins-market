#!/usr/bin/env node
// check-regression-consistency — 回归清单 + verify-ui 特性地图的引用存在性检查（2026-10-17 关单活文档门，A1；
//   2026-10-22 扩特性地图漂移：features/*.md 引用的路由/组件/文档/脚本必须还在，符号只做 advisory）
// 动机：独立复核反复抓到「回归清单/wiki 残留旧口径」这类活文档债（规格内断言失效、被删测试仍被
//   引用），却只在复核阶段可见。把「清单引用的资产还在吗」前移到关单 + 提交双闸，让残留当场被拦。
// 口径（弱档 / 存在性，不猜语义）：清单条目是自由文本，无法机器对账语义，故只校验「引用指向的
//   资产在仓库里仍存在、未改名/删除」。能抓「删了带外列但清单还说有」「测试类改名后清单未跟」；
//   抓不到「值口径变了但符号还在」——那是强档语义对账，自由文本无结构化契约，显式不做。
// 特性地图（verify-ui features/）：地图是验证的源，不是验证的果——路由/组件/文档/脚本引用悬空
//   即漂移；「驱动步骤还能不能走通」仍需实测，机器不假装能证明行为。
// 检查面（由复核抓到的残留类型定）：
//   ① *Tests.cs 测试类 —— 在测试项目里确实存在（守卫被删/改名即引用悬空）
//   ② tmp/*.mjs 脚本 —— 仅 advisory：tmp/ 在 .gitignore 第 67 行，脚本易失，不作为关单硬拦（防
//      「脚本被本地清掉但条目仍有效」恒误报），只提示「清单引用了一个当前不在的 tmp 脚本」
//   ③ workflow/*.md 文档 —— 引用的 intent/spec/plan/incident 文件名确实存在
// 落点：
//   - check-loop 新段 s27（hygiene）—— 提交时可见
//   - confirm-doc.mjs 关单（docs→done / incidents→closed）前置 —— 关单时拦，防残留进归档
// 用法：node .agents/scripts/check-regression-consistency.mjs [--root <仓库根>]
//   exit 0 = 无悬空引用；exit 1 = 存在悬空测试类/文档引用；tmp 缺失只警告不拦。
// 测试：node .agents/scripts/check-regression-consistency.test.mjs（扫描器纯函数逐项）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 提取清单里引用的标识符（纯函数）。
//   classes: `*Tests` 类名（门禁/单测/集成用例的标准命名）
//   tmpScripts: `tmp/.../*.mjs` 临时验证脚本（e2e/headless 走查产物）
//   docs: `workflow/.../*.md` 流程文档（intent/spec/plan/incident 引用）
// 刻意不含表名/字段名——SQL 标识符在自由文本里误报率过高（MM_/frontend/ 等常见词会被误抓）。
// 命名空间词排除（修真实误报）：`IntegrationTests` 是 tests/ 的项目目录名，清单叙述「集成测试残留
//   审计」时以独立词出现，并非类名引用——但它以 Tests 结尾会被类名正则误抓，故显式排除（真实测试类
//   不会取这个名，它永远是目录/命名空间）。这是唯一的已知系统性误报。
export function extractRefs(text) {
  const classes = new Set();
  const tmpScripts = new Set();
  const docs = new Set();
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]*Tests\b/g)) {
    if (m[0] !== 'IntegrationTests') classes.add(m[0]);
  }
  for (const m of text.matchAll(/\btmp\/[A-Za-z0-9_./-]+\.mjs\b/g)) tmpScripts.add(m[0]);
  for (const m of text.matchAll(/\bworkflow\/[A-Za-z0-9_./-]+\.md\b/g)) docs.add(m[0]);
  return { classes, tmpScripts, docs };
}

// 收集测试项目里实际存在的测试类名（纯函数）。
// 测试项目根：tests/ 下各 *Tests 测试项目（类名扫描面，项目按自有布局落位）。
// 类名 = 文件名去 .cs（C# 一文件一类型约定）。fixture 目录可能不存在——返回空集，调用方按悬空判。
function collectTestClasses(root) {
  const names = new Set();
  const testsDir = path.join(root, 'tests');
  if (!fs.existsSync(testsDir)) return names;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.cs$/i.test(e.name) && /Tests?\.cs$/i.test(e.name)) {
        names.add(e.name.replace(/\.cs$/i, ''));
      }
    }
  };
  walk(testsDir);
  return names;
}

// 主检查（纯函数）。读回归清单主文件 + 全部分片，对照仓库实际资产。
// 返回 { danglingClasses, danglingDocs, missingTmp } —— 均为排序后的字符串数组。
export function scanRegressionRefs(root) {
  const wf = path.join(root, 'workflow');
  const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  let text = readIf(path.join(wf, 'regression-checklist.md'));
  const shardDir = path.join(wf, 'regression-checklist.d');
  if (fs.existsSync(shardDir)) {
    for (const f of fs.readdirSync(shardDir)) {
      if (f.endsWith('.md')) text += '\n' + readIf(path.join(shardDir, f));
    }
  }
  const refs = extractRefs(text);
  const existing = collectTestClasses(root);
  const danglingClasses = [...refs.classes].filter((c) => !existing.has(c)).sort();
  const danglingDocs = [...refs.docs].filter((d) => !fs.existsSync(path.join(root, d))).sort();
  const missingTmp = [...refs.tmpScripts].filter((s) => !fs.existsSync(path.join(root, s))).sort();
  return { danglingClasses, danglingDocs, missingTmp };
}

// ---- 特性地图漂移（verify-ui features/，2026-10-22）----
// 地图是验证的源：它引用的路由/组件/文档/脚本必须还在。机器只查「引用存在性」；
// 「驱动步骤是否还能走通」仍需实测（月度/关单抽验），机器不假装能证明行为。
// 符号（`OrderedContribution` / `Service.Method`）只做 advisory——自由文本里的代码符号
// 可能来自生成物/外部库，硬拦误报率高。
export function extractFeatureRefs(text) {
  const routes = new Set();
  const components = new Set();
  const docs = new Set();
  const scripts = new Set();
  const symbols = new Set();
  for (const m of text.matchAll(/#\/[A-Za-z0-9_./:-]+/g)) {
    const r = m[0].replace(/^#/, '').replace(/[.,;)]+$/, '');
    routes.add(r.length > 1 ? r.replace(/\/+$/, '') : r);
  }
  for (const m of text.matchAll(/\bfrontend\/src\/[A-Za-z0-9_./-]+\.(?:vue|ts|js)\b/g)) components.add(m[0]);
  for (const m of text.matchAll(/\bworkflow\/[A-Za-z0-9_./-]+\.md\b/g)) docs.add(m[0]);
  for (const m of text.matchAll(/\bscripts\/verify\/[A-Za-z0-9_./-]+\.mjs\b/g)) scripts.add(m[0]);
  for (const m of text.matchAll(/`([A-Z][A-Za-z0-9_]{5,}(?:\.[A-Za-z0-9_]+)*)`/g)) symbols.add(m[1]);
  return { routes, components, docs, scripts, symbols };
}

// 路由表：frontend/src/router/index.ts 的 path 字面量（相对路径补 /）。
function collectRouterRoutes(root) {
  const p = path.join(root, 'frontend', 'src', 'router', 'index.ts');
  if (!fs.existsSync(p)) return null;
  const routes = new Set();
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/path:\s*'([^']+)'/g)) {
    const raw = m[1];
    routes.add(raw.startsWith('/') ? raw : `/${raw}`);
  }
  return routes;
}

// 符号存在性：单点符号一次 git grep 扫 backend/ + frontend/；点号符号（Type.Member）先找同名
// 类型文件（Type.cs/ts/js/vue）再查成员名——避免把 `Service.Method` 当字面量搜导致假悬空。
function missingSymbols(root, symbols) {
  if (!symbols.length) return [];
  const simple = symbols.filter((s) => !s.includes('.'));
  const qualified = symbols.filter((s) => s.includes('.'));
  const missing = [];
  if (simple.length) {
    const args = ['grep', '-h', '-F'];
    for (const s of simple) args.push('-e', s);
    args.push('--', 'backend', 'frontend');
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    const hay = String(r.stdout || '');
    for (const s of simple) if (!hay.includes(s)) missing.push(s);
  }
  for (const s of qualified) {
    const member = s.split('.').pop();
    const r = spawnSync('git', ['grep', '-l', '-F', '--', member, '--', 'backend', 'frontend'], { cwd: root, encoding: 'utf8' });
    const files = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
    // 成员名在仓库任何位置存在即不判悬空（类型文件可能拆分/部分类/外部库）；成员完全不存在才是漂移信号。
    if (!files.length) missing.push(s);
  }
  return missing.sort();
}

// 主检查（纯函数）：读 features/*.md，对照路由表 / 文件系统 / 符号面。
export function scanFeatureMapRefs(root) {
  const dir = path.join(root, '.agents', 'skills', 'verify-ui', 'features');
  const empty = { danglingRoutes: [], danglingComponents: [], danglingDocs: [], danglingScripts: [], missingSymbols: [], files: 0 };
  if (!fs.existsSync(dir)) return empty;
  const router = collectRouterRoutes(root);
  const routes = new Set();
  const components = new Set();
  const docs = new Set();
  const scripts = new Set();
  const symbols = new Set();
  let files = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    files++;
    const r = extractFeatureRefs(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const x of r.routes) routes.add(x);
    for (const x of r.components) components.add(x);
    for (const x of r.docs) docs.add(x);
    for (const x of r.scripts) scripts.add(x);
    for (const x of r.symbols) symbols.add(x);
  }
  return {
    danglingRoutes: router ? [...routes].filter((r) => !router.has(r)).sort() : [],
    danglingComponents: [...components].filter((c) => !fs.existsSync(path.join(root, c))).sort(),
    danglingDocs: [...docs].filter((d) => !fs.existsSync(path.join(root, d))).sort(),
    danglingScripts: [...scripts].filter((s) => !fs.existsSync(path.join(root, s))).sort(),
    missingSymbols: missingSymbols(root, [...symbols]),
    files,
  };
}

// ---- 验证脚本锚点（scripts/verify/**/*.mjs，2026-10-22）----
// 脚本里的 #/路由 与 data-testid 必须还在路由表/源码里——文件存在不等于脚本还能跑。
// advisory：脚本可能引用外部/动态路由，硬拦误报率高。
export function scanVerifyScriptAnchors(root) {
  const dir = path.join(root, 'scripts', 'verify');
  if (!fs.existsSync(dir)) return { danglingRoutes: [], danglingTestIds: [], files: 0 };
  const router = collectRouterRoutes(root);
  const routes = new Set();
  const testIds = new Set();
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/i.test(e.name)) continue;
      files++;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/#\/[A-Za-z0-9_./:-]+/g)) {
        const r = m[0].replace(/^#/, '').replace(/[.,;)]+$/, '');
        routes.add(r.length > 1 ? r.replace(/\/+$/, '') : r);
      }
      for (const m of text.matchAll(/data-testid=["']([^"']+)["']/g)) testIds.add(m[1]);
    }
  };
  walk(dir);
  const danglingRoutes = router ? [...routes].filter((r) => !router.has(r)).sort() : [];
  const danglingTestIds = [...testIds].filter((id) => {
    const a = spawnSync('git', ['grep', '-l', '-F', '--', `data-testid="${id}"`, '--', 'frontend/src'], { cwd: root, encoding: 'utf8' });
    const b = spawnSync('git', ['grep', '-l', '-F', '--', `data-testid='${id}'`, '--', 'frontend/src'], { cwd: root, encoding: 'utf8' });
    return a.status !== 0 && b.status !== 0;
  }).sort();
  return { danglingRoutes, danglingTestIds, files };
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-regression-consistency.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法：node .agents/scripts/check-regression-consistency.mjs [--root <仓库根>]');
      process.exit(0);
    }
  }
  const r = scanRegressionRefs(root);
  for (const t of r.missingTmp) {
    console.log(`ℹ️  清单引用的临时脚本当前不在（tmp/ 易失，不拦）：${t}`);
  }
  const fm = scanFeatureMapRefs(root);
  for (const s of fm.missingSymbols) {
    console.log(`ℹ️  特性地图引用的符号未在 backend/frontend 找到（advisory，可能是生成物/外部库）：${s}`);
  }
  const sa = scanVerifyScriptAnchors(root);
  for (const r of sa.danglingRoutes) {
    console.log(`ℹ️  验证脚本引用的路由不在 router（advisory）：${r}`);
  }
  for (const t of sa.danglingTestIds) {
    console.log(`ℹ️  验证脚本引用的 data-testid 不在 frontend/src（advisory）：${t}`);
  }
  const problems = [];
  for (const c of r.danglingClasses) problems.push(`悬空测试类：${c}`);
  for (const d of r.danglingDocs) problems.push(`悬空流程文档：${d}`);
  for (const x of fm.danglingRoutes) problems.push(`特性地图悬空路由：${x}`);
  for (const x of fm.danglingComponents) problems.push(`特性地图悬空组件：${x}`);
  for (const x of fm.danglingDocs) problems.push(`特性地图悬空文档：${x}`);
  for (const x of fm.danglingScripts) problems.push(`特性地图悬空脚本：${x}`);
  if (problems.length) {
    console.error(`\n❌ 活文档引用了不存在的资产（${problems.length} 处）——残留未清：`);
    for (const p of problems) console.error('  - ' + p);
    console.error('  处理：删除/改写清单或特性地图里已过时的条目（维护规则 4），或恢复被误删的资产。');
    process.exit(1);
  }
  console.log(`✅ 活文档引用一致：回归清单无悬空测试类/文档；特性地图 ${fm.files} 件无悬空路由/组件/文档/脚本；验证脚本 ${sa.files} 件锚点无悬空${r.missingTmp.length ? `（${r.missingTmp.length} 个 tmp 脚本缺失仅提示）` : ''}`);
  process.exit(0);
}
