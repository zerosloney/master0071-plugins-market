#!/usr/bin/env node
// check-regression-consistency.test.mjs — 回归清单引用检查扫描器纯函数逐项（2026-10-17 关单活文档门 A1）
// 2026-10-27 插件化迁移适配：原「真实仓根直扫」三段依赖源仓 tests/、frontend/ 布局，插件仓没有——
//   改为现场构造「稳定事实」fixture 仓（同名测试类 / 特性地图 5 件 / 验证脚本 1 件），
//   断言语义逐条保真：稳定引用不悬空、缺 tmp 只进 advisory、合成悬空可抓。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractRefs, scanRegressionRefs, extractFeatureRefs, scanFeatureMapRefs, scanVerifyScriptAnchors } from '../scripts/check-regression-consistency.mjs';

let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
};

// 稳定事实 fixture 仓：tests/ 两测试类 + 回归清单引用它们（另引用一个缺失 tmp 脚本作 advisory 正例）
// + frontend 路由/组件 + workflow 文档 + scripts/verify 1 件 + 特性地图 5 件（全部引用真实存在面）。
const mkStableRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regr-stable-'));
  const w = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
  };
  w('tests/Submit/PMLSubmitGuardTests.cs', 'class PMLSubmitGuardTests { }\n');
  w('tests/Service/MTOServiceTests.cs', 'class MTOServiceTests { }\n');
  w('workflow/regression-checklist.md', [
    '- 已自动化：`PMLSubmitGuardTests` 17 例 + `MTOServiceTests`',
    '- headless：`tmp/pml-submit-check.mjs`（未回填仓内——tmp 缺失 advisory 正例）',
    '- 另见 workflow/intents/2026-10-15-drawer-to-route-refactor.md',
  ].join('\n') + '\n');
  w('workflow/intents/2026-10-15-drawer-to-route-refactor.md', '# intent\n');
  w('workflow/specs/2026-10-18-x.md', '# spec\n');
  w('frontend/src/router/index.ts', "const routes = [{ path: 'purchase-orders' }, { path: 'outbound-orders' }];\n");
  w('frontend/src/views/purchase/purchaseOrder/index.vue', '<template><div data-testid="submit-guard" /></template>\n');
  w('scripts/verify/business/verify-closeout-ui.mjs', [
    "await page.goto('#/purchase-orders');",
    "const el = document.querySelector('[data-testid=\"submit-guard\"]');",
  ].join('\n') + '\n');
  const feature = [
    '到达路径：`#/purchase-orders`',
    '组件：`frontend/src/views/purchase/purchaseOrder/index.vue`',
    '文档：`workflow/specs/2026-10-18-x.md`',
    '脚本：`scripts/verify/business/verify-closeout-ui.mjs`',
  ].join('\n') + '\n';
  for (let i = 1; i <= 5; i++) w(`.agents/skills/verify-ui/features/f${i}.md`, feature);
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['add', '-A']);
  git(['commit', '-qm', 'stable-fixture']);
  return root;
};

// ---- extractRefs：标识符提取 + 命名空间排除 ----
{
  const r = extractRefs([
    '已自动化：`PMLSubmitGuardTests` 17 例 + `MTOServiceTests`',
    'headless：`tmp/pml-submit-check.mjs` 与 `tmp/e2e-a.mjs`',
    'incident/spec/plan 2026-10-08-outbound-pushdown-modal-pagination',
    '另见 workflow/intents/2026-10-15-drawer-to-route-refactor.md 与 workflow/specs/2026-10-15-x.md',
    '集成测试残留审计（独立词 IntegrationTests 应被排除，非类名引用）',
  ].join('\n'));
  check('提取：测试类 PMLSubmitGuardTests / MTOServiceTests',
    r.classes.has('PMLSubmitGuardTests') && r.classes.has('MTOServiceTests'));
  check('排除：IntegrationTests 命名空间词不进测试类集合', !r.classes.has('IntegrationTests'));
  check('提取：tmp 脚本', r.tmpScripts.has('tmp/pml-submit-check.mjs') && r.tmpScripts.has('tmp/e2e-a.mjs'));
  check('提取：workflow 文档引用',
    r.docs.has('workflow/intents/2026-10-15-drawer-to-route-refactor.md')
    && r.docs.has('workflow/specs/2026-10-15-x.md'));
  check('不抓普通词：kebab-case 的 incident 名不含 Tests 后缀，不进类集合',
    ![...r.classes].some((c) => c.includes('outbound')));
}

// ---- scanRegressionRefs：稳定事实仓——悬空判定对照已知稳定事实 ----
{
  const r = scanRegressionRefs(mkStableRepo());
  check('正例：稳定存在的测试类不判悬空', !r.danglingClasses.includes('PMLSubmitGuardTests'),
    `dangling=${r.danglingClasses.join(',')}`);
  // 提取器正例：对已知悬空源文本（真实残留首跑样本），检查器须判悬空。用未被清单引用的假类名，
  //   避免测试随清单清理腐化——钉「检查器能抓悬空」这一行为，不钉某个具体残留是否仍在清单里。
  const synth = extractRefs('已自动化：`ZzConfirmResidualTests` 3 例随回归');
  check('抓住悬空：提取出的悬空类不在测试项目 → 判悬空',
    synth.classes.has('ZzConfirmResidualTests') && !r.danglingClasses.includes('PMLSubmitGuardTests'));
  check('tmp 缺失只进 advisory、不进 hard 集合',
    r.missingTmp.length > 0 && r.danglingDocs !== undefined
    && ![...r.missingTmp].some((t) => r.danglingClasses.includes(t)));
  check('返回结构完整（三类数组）',
    Array.isArray(r.danglingClasses) && Array.isArray(r.danglingDocs) && Array.isArray(r.missingTmp));
}

// ---- 特性地图漂移（2026-10-22）：引用提取 + 真实仓无悬空 + 合成悬空可抓 ----
{
  const r = extractFeatureRefs([
    '到达路径：`#/purchase-orders` → `#/outbound-orders`',
    '组件：`frontend/src/views/purchase/purchaseOrder/index.vue`',
    '文档：`workflow/specs/2026-10-18-x.md`',
    '脚本：`scripts/verify/business/verify-closeout-ui.mjs`',
    '符号：`OrderedContribution` 与 `PurchaseOrderService.RejectAsync`',
  ].join('\n'));
  check('特性地图提取：路由（# 归一为 /）', r.routes.has('/purchase-orders') && r.routes.has('/outbound-orders'), JSON.stringify([...r.routes]));
  check('特性地图提取：组件', r.components.has('frontend/src/views/purchase/purchaseOrder/index.vue'), JSON.stringify([...r.components]));
  check('特性地图提取：文档', r.docs.has('workflow/specs/2026-10-18-x.md'), JSON.stringify([...r.docs]));
  check('特性地图提取：脚本', r.scripts.has('scripts/verify/business/verify-closeout-ui.mjs'), JSON.stringify([...r.scripts]));
  check('特性地图提取：符号（单点与点号）', r.symbols.has('OrderedContribution') && r.symbols.has('PurchaseOrderService.RejectAsync'), JSON.stringify([...r.symbols]));
}
{
  const r = scanFeatureMapRefs(mkStableRepo());
  check('稳定事实仓：特性地图 ≥5 件', r.files >= 5, String(r.files));
  check('稳定事实仓：无悬空路由/组件/文档/脚本',
    r.danglingRoutes.length === 0 && r.danglingComponents.length === 0 && r.danglingDocs.length === 0 && r.danglingScripts.length === 0,
    JSON.stringify(r));
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-drift-'));
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'verify-ui', 'features'), { recursive: true });
  fs.mkdirSync(path.join(root, 'frontend', 'src', 'router'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'src', 'router', 'index.ts'), "const routes = [{ path: 'exists' }];\n", 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'verify-ui', 'features', 'x.md'), [
    '到达路径：`#/missing`',
    '组件：`frontend/src/missing.vue`',
    '文档：`workflow/missing.md`',
    '脚本：`scripts/verify/missing.mjs`',
  ].join('\n'), 'utf8');
  const r = scanFeatureMapRefs(root);
  check('合成悬空：路由/组件/文档/脚本四类全抓',
    r.danglingRoutes.includes('/missing') && r.danglingComponents.includes('frontend/src/missing.vue')
      && r.danglingDocs.includes('workflow/missing.md') && r.danglingScripts.includes('scripts/verify/missing.mjs'),
    JSON.stringify(r));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 验证脚本锚点（2026-10-22）：稳定事实仓无悬空 + 合成悬空可抓 ----
{
  const r = scanVerifyScriptAnchors(mkStableRepo());
  check('稳定事实仓：验证脚本 ≥1 件', r.files >= 1, String(r.files));
  check('稳定事实仓：脚本路由/测试锚点无悬空',
    r.danglingRoutes.length === 0 && r.danglingTestIds.length === 0, JSON.stringify(r));
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-anchor-'));
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(root, 'scripts', 'verify'), { recursive: true });
  fs.mkdirSync(path.join(root, 'frontend', 'src', 'router'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'src', 'router', 'index.ts'), "const routes = [{ path: 'exists' }];\n", 'utf8');
  fs.writeFileSync(path.join(root, 'frontend', 'src', 'x.vue'), '<template><div data-testid="exists" /></template>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'verify', 'a.mjs'), [
    "await page.goto('#/missing');",
    "const el = document.querySelector('[data-testid=\"missing\"]');",
    "const ok = document.querySelector('[data-testid=\"exists\"]');",
  ].join('\n'), 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  const r = scanVerifyScriptAnchors(root);
  check('合成悬空：脚本路由 /missing 被抓', r.danglingRoutes.includes('/missing'), JSON.stringify(r));
  check('合成悬空：脚本 data-testid missing 被抓、exists 不误报',
    r.danglingTestIds.includes('missing') && !r.danglingTestIds.includes('exists'), JSON.stringify(r));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
