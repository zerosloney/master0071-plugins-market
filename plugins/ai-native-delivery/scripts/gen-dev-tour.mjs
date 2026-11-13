#!/usr/bin/env node
// gen-dev-tour.mjs — 把 plan/spec 的「步骤 × 改动文件」渲染成可交互开发全景图
// 用法：
//   node <插件根>/scripts/gen-dev-tour.mjs workflow/plans/<name>.md
//   node <插件根>/scripts/gen-dev-tour.mjs <doc> --out .agents/cache/tours/x.html
//   node <插件根>/scripts/gen-dev-tour.mjs <doc> --base origin/main      # 对比已提交的整段改动
//   node <插件根>/scripts/gen-dev-tour.mjs <doc> --json                  # 只打印模型，不写 HTML
// 根锚定（插件化适配）：--root 显式优先（原样采信，同 ledgerRoot explicit 口径）；缺省
// paths.mjs projectRoot() = 使用项目 git 仓库根。默认输出 <项目>/.agents/cache/tours/<type>-<name>.html
//（init-engine 的 .gitignore 标记块覆盖 .agents/cache/，本地快照不进版本库）。
// 实时版（workflow-board-server / auto-tour）暂未随插件分发——v1 只产 file:// 静态快照。
// 口径：文档 = 计划面（步骤/文件），git = 实际面（--base 之后的工作树），两者按路径合并；
//       实际改了但文档没登记的文件进「文档外实际改动」步骤，不静默丢弃。
// 零依赖；HTML 模板单源 <插件根>/board/dev-tour.html，静态快照只在 __TOUR_DATA__ 处注入模型。
import fs from 'node:fs';
import path from 'node:path';
import { buildTour } from './dev-tour-model.mjs';
import { PLUGIN_ROOT, projectRoot } from './paths.mjs';

const TEMPLATE = path.join(PLUGIN_ROOT, 'board', 'dev-tour.html');

const USAGE = `用法：node <插件根>/scripts/gen-dev-tour.mjs <workflow 文档.md> [选项]

把 plan/spec 的步骤与改动文件渲染为单文件 HTML：左侧文件树 / 中间全景图·时序图·数据流图·流程图 / 右侧步骤变更说明。

选项：
  --root <path>      使用项目仓库根（缺省锚定当前目录的 git 仓库根，非 git 目录回退当前目录）
  --out <path>       输出 HTML 路径（默认 <项目>/.agents/cache/tours/<type>-<name>.html）
  --base <ref>       git 对比基线（默认 HEAD = 当前工作树未提交改动；已提交任务可传 origin/main 或 <sha>）
  --all              实际面包含所有改动文件（默认只收 backend/frontend/tests/db/sql/scripts/tools/integration）
  --include-docs     实际面额外包含 workflow/wiki/.agents 文档改动
  --no-diff          不嵌入 diff（快照更小；右侧只显示文件与行数）
  --max-diff-lines   单文件 diff 最多嵌入行数（默认 160）
  --json             只打印数据模型（供调试/脚本消费）
  --scope-report     只打印「文档外实际改动」清单（advisory，恒 exit 0；供关单对账）
  --strict           解析层兜底 / 无步骤 / 实现步骤无文件条目时 exit 1（供门禁化调用；默认 advisory）
  --help             打印本说明

示例：
  node <插件根>/scripts/gen-dev-tour.mjs workflow/plans/synthetic-plan-edit-list.md
  node <插件根>/scripts/gen-dev-tour.mjs workflow/plans/synthetic-plan-push.md --base HEAD~20
  node <插件根>/scripts/gen-dev-tour.mjs workflow/specs/synthetic-spec-sample.md --json`;

function parseArgs(argv) {
  const out = {
    doc: '', root: '', out: '', base: 'HEAD', all: false, includeDocs: false,
    withDiff: true, maxDiffLines: 160, json: false, help: false, strict: false, scopeReport: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') out.root = argv[++i] || '';
    else if (a === '--out') out.out = argv[++i] || '';
    else if (a === '--base') out.base = argv[++i] || 'HEAD';
    else if (a === '--all') out.all = true;
    else if (a === '--include-docs') out.includeDocs = true;
    else if (a === '--no-diff') out.withDiff = false;
    else if (a === '--max-diff-lines') out.maxDiffLines = Math.max(20, Number(argv[++i]) || 160);
    else if (a === '--json') out.json = true;
    else if (a === '--scope-report') out.scopeReport = true;
    else if (a === '--strict') out.strict = true;
    else if (a.startsWith('-')) { console.error(`❌ 未知参数：${a}\n\n${USAGE}`); process.exit(1); }
    else if (!out.doc) out.doc = a;
    else { console.error(`❌ 只接受一个文档参数（多余：${a}）\n\n${USAGE}`); process.exit(1); }
  }
  return out;
}

function escJsonForScript(v) {
  // 防止文档内容里的 </script> 提前闭合；JSON 仍是合法 JS 字面量
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function defaultOut(root, docPath, model) {
  const base = path.basename(docPath, '.md').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '-');
  const type = model.doc.type.toLowerCase();
  return path.join(root, '.agents', 'cache', 'tours', `${type}-${base}.html`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.doc) { console.log(USAGE); process.exit(args.help ? 0 : 1); }
  // 根锚定（插件化适配）：--root 显式优先；缺省使用项目 git 仓库根（projectRoot，非 git 目录回退 cwd）
  const ROOT = args.root ? path.resolve(args.root) : (projectRoot() || process.cwd());
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`❌ 模板缺失：${path.relative(ROOT, TEMPLATE)}（引擎文件不完整）`);
    process.exit(1);
  }
  let model;
  try {
    model = buildTour({
      root: ROOT,
      docPath: args.doc,
      base: args.base,
      includeAll: args.all,
      includeDocs: args.includeDocs,
      withDiff: args.withDiff,
      maxDiffLines: args.maxDiffLines,
    });
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  // 关单范围对账（2026-11-11）：打印「文档外实际改动」清单——advisory 恒 exit 0，与 --strict 互不干扰；
  // 供 closeout 序列 §1 验证节调用（口径：非空先解释或回填 plan 再关单）。
  if (args.scopeReport) {
    const x = model.steps.find((s) => s.id === 'X' && s.source === 'git');
    const rows = (x ? x.files : []).map((p) => {
      const f = model.files.find((g) => g.path === p) || {};
      return `  - ${p} · ${f.badge || f.status || '修改'} · +${f.additions || 0}/-${f.deletions || 0}`;
    });
    if (!rows.length) console.log('文档外实际改动：无');
    else {
      console.log(`文档外实际改动：${rows.length} 处（先解释或回填 plan 再关单）`);
      for (const line of rows) console.log(line);
    }
    return;
  }

  // 解析健康度（2026-11-09）：文档标题跑偏时静默降级的可观测面；--strict 时层兜底/无步骤直接拒产
  // （exit 1），默认 advisory 只提示。2026-11-10 修正：拒产判定先于 --json 出口——
  // --json --strict 组合下拒绝产出且不输出模型，解析正常时 --json 行为不变。
  const ph = model.parseHealth || {};
  if (args.strict && (ph.layersFallback || !ph.total)) {
    console.error('❌ --strict：解析命中不达标（层兜底或无步骤），拒绝产出');
    process.exit(1);
  }

  // 每步文件门（2026-11-11）：实现步骤必须有「- 文件：」条目，否则全景图只能把文件归到附录。
  // 纯验证步骤（单测 / UI 实测 / 静态门）天然没有代码文件，按标题豁免；A/U 是归集步，不参与。
  const VERIFY_STEP_RE = /(单测|集成测试|测试收口|冒烟|UI 实测|静态门|门禁|验证步骤)/;
  const zeroImpl = model.steps.filter((s) => s.id !== 'A' && s.id !== 'U' && !(s.files || []).length && !VERIFY_STEP_RE.test(s.title || ''));
  if (zeroImpl.length) {
    const names = zeroImpl.map((s) => `${s.id} ${String(s.title).split('：')[0]}`).join('、');
    if (args.strict) {
      console.error(`❌ --strict：${zeroImpl.length} 个实现步骤没有文件条目（${names}）——在任务下补「- 文件：路径」，纯验证步骤请在标题写明「验证步骤」`);
      process.exit(1);
    }
    console.error(`   ⚠ ${zeroImpl.length} 个实现步骤没有文件条目（${names}）——建议在任务下补「- 文件：…」`);
  }

  if (args.json) { console.log(JSON.stringify(model, null, 2)); return; }
  const bs = ph.bySource || {};
  console.log(`   解析命中：直认 ${ph.direct ?? '?'}/${ph.total ?? '?'} 步` +
    (bs.blocks ? ` · 改动块归集 ${bs.blocks}` : '') +
    (bs.layers ? ` · 层兜底 ${bs.layers}` : '') +
    (bs.fallback ? ` · 未分步 ${bs.fallback}` : '') +
    (ph.pathGuesses && ph.pathGuesses.total ? ` · 路径猜测 ${ph.pathGuesses.total} 处` : '') +
    (ph.zeroFileSteps ? ` · 无文件步骤 ${ph.zeroFileSteps}` : '') +
    (model.deps && model.deps.edges.length ? ` · 依赖边 ${model.deps.edges.length}` : ''));
  if (model.deps && model.deps.unresolved) {
    console.error(`   ⚠ 依赖子句有 ${model.deps.unresolved} 处引用未解析到步骤（检查执行顺序节编号与任务编号是否一致）`);
  }
  if (ph.layersFallback) {
    console.error('   ⚠ 步骤未被结构化识别（走了架构层兜底）——规范 `## 任务拆解` / `## 改动方案` 标题后重生成更准');
  }
  // 解析失约定位（2026-11-10）：issues 逐条到行，advisory——不参与 --strict 拒产判定。
  const ISSUE_LABEL = {
    'step-no-files': '步骤无对齐文件块（改动方案缺该步的文件条目）',
    'block-unmatched': '文件块锚点未对齐任何步骤（编号/标题与任务拆解不一致）',
    'dep-unresolved': '依赖引用未解析到步骤（编号与步骤序号/Tn 不一致）',
    'layers-fallback': '全文无结构化步骤标题，按架构层兜底分组',
  };
  for (const it of (ph.issues || [])) {
    console.error(`   ⚠ 第 ${it.line} 行：${it.title}：${ISSUE_LABEL[it.kind] || it.kind}`);
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  if (!tpl.includes('__TOUR_DATA__')) {
    console.error('❌ 模板缺少 __TOUR_DATA__ 锚点');
    process.exit(1);
  }
  const html = tpl
    .replace('__TOUR_DATA__', escJsonForScript(model))
    .replace('__TOUR_FILE__', 'null')
    .replace('__TOUR_MODE__', '"snapshot"');

  const outPath = path.resolve(ROOT, args.out || defaultOut(ROOT, model.doc.path, model));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  const docs = model.files.filter((f) => f.layer === 'doc').length;
  console.log(`✅ 开发全景已生成：${path.relative(ROOT, outPath)}`);
  console.log(`   文档：${model.doc.type} · ${model.doc.title}`);
  console.log(`   范围：${model.steps.length} 步 · ${model.stats.files} 个产品文件` +
    `（新增 ${model.stats.new} / 修改 ${model.stats.modified} / 删除 ${model.stats.deleted} / 计划 ${model.stats.planned}）` +
    ` · +${model.stats.additions}/-${model.stats.deletions} 行` + (docs ? ` · ${docs} 个文档` : ''));
  if (model.note) console.log(`   ⚠ ${model.note}`);
  if (model.base.note) console.log(`   ⚠ git 基线 ${model.base.ref}：${model.base.note}`);
  console.log(`   打开快照：file://${outPath.replace(/\\/g, '/')}`);
}

main();
