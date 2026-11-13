// dev-tour-model.test.mjs — 开发全景图解析模型测试（node:test + node:assert，零新依赖）
// 被测：scripts/dev-tour-model.mjs（buildTour + renderModelJson）与 gen-dev-tour.mjs CLI 壳。
// 确定性口径：模型级测试统一经 buildTour({ git }) 注入 git 实际面（collectGit 同形状 payload），
// 不依赖真实 git 工作树状态；CLI 级测试只断言退出码 / stderr 文案 / stdout 可解析等文档面结论。
// fixtures 契约：skills/dev-tour/SKILL.md「数据契约」节；期望快照同目录 <fixture>.model.json，
// 由 renderModelJson 产出（仅 generatedAt 归一为固定值）。再生成：UPDATE_SNAPSHOTS=1 node --test test/dev-tour-model.test.mjs
//
// 分批计划（dev-tour 移植工单 B + C）：12 组 fixture 全量随迁——B 首批编号步骤 / 任务拆解 checkbox +
// 路径猜测 / 层词臂 4 组，C 补齐 h3 批次 / L1 单文件 / 裸中段路径 / 伪路径防护 / 并集标签 / 表格行 /
// 失约定位 / 层兜底 8 组；13 组模型用例 + 5 个 CLI 用例（共 18 用例）全部激活。脱敏词根映射（与源仓逐行对齐）：
// 物资→订单 / 出库→工单 / 入库→录入 / Widgets→Catalog / widgets→catalog / inbound→entry /
// Outbound*→Workorder* / MaterialPush*→SampleSync*。「裸中段路径」「伪路径防护」「并集标签」三组的
// 路径断言依赖插件仓真实跟踪文件（scripts/install/{plan,apply,manifest}.mjs、scripts/gen-dev-tour.mjs、
// skills/dev-tour/SKILL.md、skills/review-method/golden-set.md），快照在 git add 之后的跟踪态下生成锁死；
// 日后这些跟踪文件增删须 UPDATE_SNAPSHOTS=1 重生成（见各用例内注记）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTour, renderModelJson } from '../scripts/dev-tour-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures', 'dev-tour');
const GEN = path.join(ROOT, 'scripts', 'gen-dev-tour.mjs');
const FIXED_TS = '2020-01-01T00:00:00.000Z';

function tour(docName, git) {
  const model = buildTour({
    root: ROOT,
    docPath: `test/fixtures/dev-tour/${docName}`,
    base: 'HEAD',
    git,
  });
  model.generatedAt = FIXED_TS; // 快照唯一的时间源，归一后逐字节可比
  return model;
}

function assertSnapshot(model, docName) {
  const file = path.join(FIXTURES, docName.replace(/\.md$/, '.model.json'));
  const actual = renderModelJson(model) + '\n';
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.writeFileSync(file, actual, 'utf8');
    return;
  }
  // 本机 core.autocrlf=true 会把快照工作区副本 smudge 成 CRLF；JSON 快照比较不看行尾。
  // 仅本地测试文件修正，避免把行尾噪声带进提交。
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, expected, `快照不一致：${path.basename(file)}`);
}

const byPath = (model, p) => model.files.find((f) => f.path === p) || null;

// CLI 用例走子进程（gen-dev-tour 真跑 collectGit）——异步 spawn + 并发起跑压总时长（<3s 门）。
// 一律传 --root 锚定插件根：不随调用方 cwd 漂移，路径解析与模型级用例同仓同形，结果确定。
function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ status: -1, stdout, stderr: String(e.message) }));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// ---- 注入 git 面（collectGit 返回同形状；路径均为合成中性词根，与插件仓真实跟踪文件无碰撞，
//      见 fixtures 同名 .md；脱敏词根映射：物资→订单 / 出库→工单 / Widgets→Catalog /
//      入库→录入 / Outbound*→Workorder* / Material*→SampleSync*）----
const GIT_BASE = { available: true, base: 'HEAD', baseSha: 'a1b2c3d4e5f6', note: '', basePaths: [] };
const GIT_NUMBERED = {
  ...GIT_BASE,
  files: {
    // 文档已登记 → 合并进计划面记录（状态/行数/diff 落地）
    'backend/Catalog/WorkorderController.cs': { status: 'modified', actual: true, additions: 42, deletions: 8, diff: 'diff --git a/backend/Catalog/WorkorderController.cs b/backend/Catalog/WorkorderController.cs\n@@ -12,6 +12,14 @@' },
    'frontend/src/views/catalog/workorder-plan.vue': { status: 'new', actual: true, additions: 96, deletions: 0, diff: 'diff --git a/frontend/src/views/catalog/workorder-plan.vue b/frontend/src/views/catalog/workorder-plan.vue\nnew file mode 100644\n--- /dev/null\n+++ b/frontend/src/views/catalog/workorder-plan.vue' },
    'backend/Catalog/OldWorkorderService.cs': { status: 'deleted', actual: true, additions: 0, deletions: 64 },
    // 文档未登记 → 「文档外实际改动」
    'scripts/zz-catalog/rogue-sync.ps1': { status: 'modified', actual: true, additions: 3, deletions: 1 },
  },
};
const GIT_TASKS = {
  ...GIT_BASE,
  files: {
    'backend/Catalog/WorkorderItemDto.cs': { status: 'new', actual: true, additions: 38, deletions: 0 },
    'backend/Catalog/WorkorderService.cs': { status: 'modified', actual: true, additions: 21, deletions: 4 },
    'scripts/zz-catalog/rogue-sync.ps1': { status: 'modified', actual: true, additions: 5, deletions: 2 },
  },
};
const GIT_EMPTY = { ...GIT_BASE, files: {} };

test('编号步骤：步骤×文件归属 + 执行顺序依赖子句 + 文档外改动', () => {
  const m = tour('plan-numbered-steps.md', GIT_NUMBERED);

  // 步骤数与标题（T4 之后是 git 对账产物「文档外实际改动」）
  assert.equal(m.steps.length, 5);
  assert.deepEqual(m.steps.map((s) => s.title), ['后端接口', '应用服务', '前端页面', '全链路验证', '文档外实际改动']);
  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2', 'T3', 'T4', 'X']);

  // 步骤 → 文件归属
  const filesOf = (id) => m.steps.find((s) => s.id === id).files;
  assert.deepEqual(filesOf('T1'), ['backend/Catalog/WorkorderController.cs']);
  assert.deepEqual(filesOf('T2'), ['backend/Catalog/WorkorderAppService.cs', 'backend/Catalog/OldWorkorderService.cs']);
  assert.deepEqual(filesOf('T3'), ['frontend/src/views/catalog/workorder-plan.vue', 'frontend/src/api/catalog/workorderPlan.ts']);
  assert.deepEqual(filesOf('T4'), ['tests/Catalog/WorkorderPlanTests.cs']); // 验证计划 → 验证步骤收口
  assert.deepEqual(filesOf('X'), ['scripts/zz-catalog/rogue-sync.ps1']);
  assert.equal(m.steps.find((s) => s.id === 'X').source, 'git');

  // git 状态合并：修改/新增/删除/仅计划
  assert.equal(byPath(m, 'backend/Catalog/WorkorderController.cs').status, 'modified');
  assert.equal(byPath(m, 'frontend/src/views/catalog/workorder-plan.vue').status, 'new');
  assert.equal(byPath(m, 'backend/Catalog/OldWorkorderService.cs').status, 'deleted');
  const plannedOnly = byPath(m, 'backend/Catalog/WorkorderAppService.cs');
  assert.equal(plannedOnly.status, 'planned');
  assert.equal(plannedOnly.actual, false);
  assert.equal(plannedOnly.badge, '计划');

  // 依赖归一：数字/Tn/区间/「全部」→ step.id；箭头链行不产边；不可解析引用计数并定位到行
  assert.deepEqual(m.deps, {
    edges: [
      { from: 'T1', to: 'T3' },
      { from: 'T2', to: 'T3' },
      { from: 'T3', to: 'T4' },
    ],
    source: 'exec-order',
    unresolved: 1,
    unresolvedItems: [{ line: 35, title: '88 依赖 1' }],
  });
  assert.deepEqual(m.parseHealth.issues, [{ line: 35, title: '88 依赖 1', kind: 'dep-unresolved' }]);

  // 解析健康度：4 步全部直认（source=steps），无层兜底
  assert.equal(m.parseHealth.total, 4);
  assert.equal(m.parseHealth.direct, 4);
  assert.deepEqual(m.parseHealth.bySource, { steps: 4 });
  assert.equal(m.parseHealth.layersFallback, false);
  assert.equal(m.parseHealth.hitRate, 1);

  // 文档面字段
  assert.equal(m.doc.title, '编号步骤样例：工单计划跟踪');
  assert.equal(m.doc.purpose, '把工单计划页做成可跟踪的最小闭环。');
  assert.deepEqual(m.doc.links, [{ label: '2020-01-01-catalog-demo.md', path: 'workflow/intents/2020-01-01-catalog-demo.md' }]);
  assert.deepEqual(m.doc.upstream, []); // 链接目标不存在 → 不读上游
  assert.equal(m.gates.length, 2);
  assert.deepEqual(m.evidence, { windowStart: '2099-12-31', rows: [], totalInWindow: 0 });
  assert.equal(m.base.sha, 'a1b2c3d4e5f6');
  assert.equal(m.note, '');

  assertSnapshot(m, 'plan-numbered-steps.md');
});

test('任务拆解：checkbox 变体 + 判据/留痕 + 任务行内依赖 + 未分步归集', () => {
  const m = tour('plan-task-checkboxes.md', GIT_TASKS);

  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2', 'T3', 'X', 'U']);
  assert.deepEqual(m.steps.map((s) => s.status), ['todo', 'todo', 'done', 'warn', 'todo']);
  assert.deepEqual(m.steps.map((s) => s.source), ['tasks', 'tasks', 'tasks', 'git', 'fallback']);

  // 判据 → summary；留痕 → detail
  const t1 = m.steps.find((s) => s.id === 'T1');
  assert.equal(t1.summary, '字段齐全并通过编译');
  assert.ok(t1.detail.some((d) => d.includes('留痕：实体迁移脚本执行记录')));
  assert.equal(m.steps.find((s) => s.id === 'T3').summary, '页面提交工单成功');

  // 未分步（文档提到但归不进步骤）与文档外实际改动各自归集
  assert.deepEqual(m.steps.find((s) => s.id === 'U').files, ['backend/Catalog/UntouchedService.cs']);
  assert.deepEqual(m.steps.find((s) => s.id === 'X').files, ['scripts/zz-catalog/rogue-sync.ps1']);

  // 任务行内依赖：T1→T3 被传递归约（T1→T2→T3 可推出）；未解析引用定位到行
  assert.deepEqual(m.deps, {
    edges: [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T3' },
    ],
    source: 'task-rows',
    unresolved: 1,
    unresolvedItems: [{ line: 26, title: '- 依赖：4（联调批次）' }],
  });
  assert.deepEqual(m.parseHealth.issues, [{ line: 26, title: '- 依赖：4（联调批次）', kind: 'dep-unresolved' }]);

  assert.equal(m.parseHealth.total, 4);
  assert.equal(m.parseHealth.direct, 3);
  assert.deepEqual(m.parseHealth.bySource, { tasks: 3, fallback: 1 });
  assert.equal(m.parseHealth.hitRate, 0.75);
  assert.equal(m.parseHealth.layersFallback, false);

  assert.equal(byPath(m, 'backend/Catalog/WorkorderItemDto.cs').status, 'new');
  assert.equal(byPath(m, 'backend/Catalog/WorkorderService.cs').status, 'modified');
  assert.equal(byPath(m, 'backend/Catalog/WorkorderItem.cs').badge, '计划');

  assertSnapshot(m, 'plan-task-checkboxes.md');
});

test('路径猜测：裸文件名多候选打分命中 → pathGuess 标志 + pathGuesses 计量', () => {
  // 候选来自插件仓真实跟踪文件的 skills/*/SKILL.md（同名多候选，稳定依赖 HEAD 跟踪集，与
  // 工作树状态无关）；文档只写裸名 + 步骤上下文含 dream → 唯一命中 skills/dream/SKILL.md。
  // 注意：candidates 计数含本工单新增的 skills/dev-tour/SKILL.md（快照在 git add 之后的
  // 跟踪态下生成锁死；日后技能集增删须 UPDATE_SNAPSHOTS=1 重生成）。
  const m = tour('plan-path-guess.md', GIT_EMPTY);

  const rec = byPath(m, 'skills/dream/SKILL.md');
  assert.ok(rec, '应解析到 skills/dream 目录的 SKILL.md');
  assert.equal(rec.pathGuess, true);
  assert.ok(!byPath(m, 'skills/verify-ui/SKILL.md'), '打分应唯一命中 skills/dream');
  assert.deepEqual(m.steps.find((s) => s.id === 'T1').files, ['skills/dream/SKILL.md']);
  assert.deepEqual(m.parseHealth.pathGuesses, {
    total: 1,
    items: [{ path: 'skills/dream/SKILL.md', step: 'T1', candidates: 8 }],
  });
  assert.deepEqual(m.parseHealth.issues, []);

  assertSnapshot(m, 'plan-path-guess.md');
});

test('层词臂收紧：恰一步骤含层词才绑并打 pathGuess；多义不绑留未分步', () => {
  const m = tour('plan-layer-word-unique.md', GIT_EMPTY);

  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2', 'T3', 'U']);
  const filesOf = (id) => m.steps.find((s) => s.id === id).files;
  assert.deepEqual(filesOf('T1'), ['frontend/src/views/catalog/entry-list.vue']);
  assert.deepEqual(filesOf('T2'), ['frontend/src/views/catalog/entry-drawer.vue']);
  // 层词臂绑定的孤儿文件进步骤文件列表（绑定即显示）
  assert.deepEqual(filesOf('T3'), ['backend/Catalog/EntryAlign.sql', 'backend/Catalog/OrphanAlign.sql']);

  // T1/T2 正文都含「前端」→ 层词臂多义不绑，留「未分步」可见（steps 仅含 U）
  const orphan = byPath(m, 'frontend/src/views/catalog/orphan-page.vue');
  assert.ok(orphan, '背景节登记的孤儿前端文件应在模型内');
  assert.deepEqual(orphan.steps, ['U']);
  assert.equal(orphan.pathGuess, false);
  assert.deepEqual(m.steps.find((s) => s.id === 'U').files, ['frontend/src/views/catalog/orphan-page.vue']);

  // 恰 T3 一个步骤正文含「数据库」→ 绑定且 pathGuess 可见、计入 pathGuesses
  const align = byPath(m, 'backend/Catalog/OrphanAlign.sql');
  assert.ok(align, '孤儿对齐脚本应在模型内');
  assert.deepEqual(align.steps, ['T3']);
  assert.equal(align.pathGuess, true);
  assert.deepEqual(m.parseHealth.pathGuesses, {
    total: 1,
    items: [{ path: 'backend/Catalog/OrphanAlign.sql', step: 'T3', candidates: 1 }],
  });

  assert.equal(m.parseHealth.total, 4);
  assert.equal(m.parseHealth.direct, 3);
  assert.deepEqual(m.parseHealth.bySource, { tasks: 3, fallback: 1 });

  assertSnapshot(m, 'plan-layer-word-unique.md');
});

// ==================== 工单 C 补齐：8 组模型用例 + 1 组默认路径回归（fixture 同批随迁） ====================

const GIT_BATCHES = {
  ...GIT_BASE,
  files: { 'backend/Catalog/Part.cs': { status: 'modified', actual: true, additions: 12, deletions: 3 } },
};
const GIT_L1 = {
  ...GIT_BASE,
  files: { 'backend/Catalog/SampleSyncService.cs': { status: 'modified', actual: true, additions: 9, deletions: 1 } },
};

test('h3 批次小标题：改动方案下的 ### 批次 N 自动成站', () => {
  const m = tour('plan-h3-batches.md', GIT_BATCHES);

  assert.deepEqual(m.steps.map((s) => s.id), ['1', '2']);
  assert.deepEqual(m.steps.map((s) => s.title), ['领域模型整理', '查询服务']);
  assert.deepEqual(m.steps.map((s) => s.source), ['headings', 'headings']);
  assert.deepEqual(m.steps[0].files, ['backend/Catalog/Part.cs', 'backend/Catalog/PartItem.cs']);
  assert.deepEqual(m.steps[1].files, ['backend/Catalog/PartQueryService.cs', 'frontend/src/api/catalog/part.ts']);
  assert.equal(byPath(m, 'backend/Catalog/Part.cs').status, 'modified');
  assert.deepEqual(m.deps, { edges: [], source: '', unresolved: 0, unresolvedItems: [] });
  assert.deepEqual(m.parseHealth.issues, []);
  assert.deepEqual(m.parseHealth.bySource, { headings: 2 });
  assert.equal(m.parseHealth.layersFallback, false);

  assertSnapshot(m, 'plan-h3-batches.md');
});

test('L1 单文件：改动方案顶层路径条目每条自动成一站', () => {
  const m = tour('plan-l1-single-file.md', GIT_L1);

  assert.deepEqual(m.steps.map((s) => s.id), ['S1', 'S2']);
  assert.deepEqual(m.steps.map((s) => s.title), ['SampleSyncService.cs', 'SampleSyncOptions.cs']);
  assert.deepEqual(m.steps.map((s) => s.source), ['blocks', 'blocks']);
  assert.deepEqual(m.steps[0].files, ['backend/Catalog/SampleSyncService.cs']);
  assert.deepEqual(m.steps[1].files, ['backend/Catalog/SampleSyncOptions.cs']);
  assert.equal(byPath(m, 'backend/Catalog/SampleSyncService.cs').status, 'modified');
  assert.deepEqual(m.parseHealth.bySource, { blocks: 2 });
  assert.equal(m.parseHealth.direct, 0);
  assert.equal(m.parseHealth.hitRate, 0);
  assert.equal(m.parseHealth.layersFallback, false);

  assertSnapshot(m, 'plan-l1-single-file.md');
});

// ※锚定（重锚定记录）：源仓用 frontend/src/views/purchase/{pml,contractTemplate}/ 与 pml/shared.ts，
// 插件仓无前端树，按当刻跟踪集改锚 scripts/install/{plan,apply}.mjs（T1）与 scripts/install/manifest.mjs
//（T2）——裸写 token 经确定性后缀消解落到 HEAD 真实跟踪文件，非猜测；这三个文件增删须
// UPDATE_SNAPSHOTS=1 重锁快照。
test('裸中段路径采集：未反引号标题里的真实中段路径入模，杂型 token 拒收', () => {
  // 裸写 token 仅当 含 / + 代码扩展名 + 消解到仓库真实文件 才收；if/else、Success/Error 无扩展名 → 拒收
  const m = tour('plan-bare-mid-path.md', GIT_EMPTY);

  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2']);
  const filesOf = (id) => m.steps.find((s) => s.id === id).files;
  assert.deepEqual(filesOf('T1'), ['scripts/install/plan.mjs', 'scripts/install/apply.mjs']);
  assert.deepEqual(filesOf('T2'), ['scripts/install/manifest.mjs']);

  const rec = byPath(m, 'scripts/install/plan.mjs');
  assert.ok(rec, '裸写中段路径应消解到真实文件入模');
  assert.deepEqual(rec.steps, ['T1']);
  assert.equal(rec.pathGuess, false); // 确定性后缀消解，不是猜测
  assert.equal(rec.badge, '计划');
  assert.ok(!m.files.some((f) => /if\/else|Success\/Error/.test(f.path)), 'if/else 类杂型 token 不得入模');

  assert.equal(m.parseHealth.direct, 2);
  assert.deepEqual(m.parseHealth.pathGuesses, { total: 0, items: [] });

  assertSnapshot(m, 'plan-bare-mid-path.md');
});

// ※锚定（重锚定记录）：源仓 T1 用 frontend/src/views/purchase/pml/index.vue + frontend/src/api 目录锚，
// 插件仓按当刻跟踪集改锚 scripts/gen-dev-tour.mjs + `scripts/install` 目录锚（HEAD 真实跟踪文件）；
// T2 两个未落库 token 在插件仓同样不落库，原样保留语义不变。gen-dev-tour.mjs 增删须重锁快照。
test('伪路径防护：目录反推与锚点拼接必须落到真实文件，未落库 token 原样可见', () => {
  const m = tour('plan-fake-path-guard.md', GIT_EMPTY);

  const filesOf = (id) => m.steps.find((s) => s.id === id).files;
  assert.deepEqual(filesOf('T1'), ['scripts/gen-dev-tour.mjs']);
  const rec = byPath(m, 'scripts/gen-dev-tour.mjs');
  assert.ok(rec && rec.pathGuess === false);

  // tracked 文件 rp===raw 即已解析：不再被锚点二次拼接出翻倍伪路径
  assert.ok(!m.files.some((f) => String(f.path).includes('scripts/install/scripts')), '锚点拼接不得翻倍');

  // 未落库 token：原样入模（可见的未解析），不得被目录反推/后缀回退伪造到真实文件
  const dtos = byPath(m, 'Dtos/Inventory/SampleCheckRuleDtos.cs');
  assert.ok(dtos, '未落库短路径应原样保留');
  assert.ok(!m.files.some((f) => /Application\/Dtos\/Inventory\/SampleCheckRuleDtos\.cs$/.test(f.path)), '目录反推不得伪造 backend 全路径');
  const perf = byPath(m, 'tmp/perf/save-baseline.mjs');
  assert.ok(perf, 'tmp/perf 未落库路径应原样保留');
  assert.ok(
    m.files.every((f) => !/save-baseline\.mjs$/.test(f.path) || f.path === 'tmp/perf/save-baseline.mjs'),
    '目录后缀回退不得跨目录冒名',
  );

  assertSnapshot(m, 'plan-fake-path-guard.md');
});

// ※锚定（重锚定记录）：源仓 S4/S5 锚 workflow/specs/*.md 与 workflow/regression-checklist.d/*.md，
// 插件仓无 workflow 树，按当刻跟踪集改锚 skills/dev-tour/SKILL.md（S4）与
// skills/review-method/golden-set.md（S5）两个真实 doc 文件；增删须 UPDATE_SNAPSHOTS=1 重锁快照。
test('并集标签：任务行 S1+S2 拆成员集，块标签按成员交集命中，括注标签成锚', () => {
  const m = tour('plan-union-label.md', GIT_EMPTY);

  assert.deepEqual(m.steps.map((s) => s.id), ['S1', 'S3', 'S4']);
  assert.deepEqual(m.steps.map((s) => s.source), ['tasks', 'tasks', 'tasks']);
  assert.deepEqual(m.steps.map((s) => s.title), ['删除冗余分支', '调整列序', '收口：回归清单与文档']);
  const filesOf = (id) => m.steps.find((s) => s.id === id).files;
  // 父文件行被 S1/S2 缩进锚继承 → 并集步骤 S1（成员 S1+S2）收该文件
  assert.deepEqual(filesOf('S1'), ['backend/Catalog/UnionService.cs']);
  assert.deepEqual(filesOf('S3'), ['backend/Catalog/UnionColumn.cs']);
  assert.deepEqual(filesOf('S4'), ['skills/dev-tour/SKILL.md', 'skills/review-method/golden-set.md']);
  // 无失约：S1-S5 锚全部对齐，无未分步
  assert.deepEqual(m.parseHealth.issues, []);
  assert.ok(!m.steps.some((s) => s.id === 'A' || s.id === 'U' || s.id === 'X'));

  assertSnapshot(m, 'plan-union-label.md');
});

test('表格行路径：批次子节表格按标签对齐步骤，无锚表格进未分步可见', () => {
  const m = tour('plan-table-rows.md', GIT_EMPTY);

  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2']);
  assert.deepEqual(m.steps.find((s) => s.id === 'T1').files, ['backend/Catalog/TableProbe.cs', 'backend/Catalog/TableProbeDtos.cs']);
  assert.deepEqual(m.steps.find((s) => s.id === 'T2').files, ['frontend/src/views/catalog/table-probe.vue']);
  assert.equal(byPath(m, 'backend/Catalog/TableProbe.cs').badge, '计划');
  assert.deepEqual(m.parseHealth.issues, []);
  assert.equal(m.parseHealth.direct, 2);

  assertSnapshot(m, 'plan-table-rows.md');
});

test('解析失约定位：锚点失约 + 依赖未解析 → issues 两条且行号正确', () => {
  const m = tour('plan-issues.md', GIT_EMPTY);

  // T9 块无对齐步骤 → 「改动面（未分步）」归集 + block-unmatched 定位；依赖：9 → dep-unresolved 定位
  assert.deepEqual(m.steps.map((s) => s.id), ['T1', 'T2', 'A']);
  assert.deepEqual(m.steps.find((s) => s.id === 'A').files, ['backend/Catalog/GhostBatch.cs']);
  assert.deepEqual(m.deps, {
    edges: [], source: 'task-rows', unresolved: 1,
    unresolvedItems: [{ line: 14, title: '- 依赖：9（未排批次）' }],
  });
  assert.deepEqual(m.parseHealth.issues, [
    { line: 14, title: '- 依赖：9（未排批次）', kind: 'dep-unresolved' },
    { line: 23, title: 'T9：幽灵批次', kind: 'block-unmatched' },
  ]);
  assert.deepEqual(m.parseHealth.pathGuesses, { total: 0, items: [] });

  assertSnapshot(m, 'plan-issues.md');
});

test('层兜底：全文无步骤标题时按架构层分组并置 layersFallback', () => {
  const m = tour('plan-layers-fallback.md', GIT_EMPTY);

  assert.deepEqual(m.steps.map((s) => s.id), ['S1', 'S2', 'S3']);
  assert.deepEqual(m.steps.map((s) => s.title), ['前端', '应用层', '测试']);
  assert.deepEqual(m.steps.map((s) => s.source), ['layers', 'layers', 'layers']);
  assert.deepEqual(m.steps[0].files, ['frontend/src/styles/catalog/theme.scss']);
  assert.deepEqual(m.steps[1].files, ['backend/Catalog/ThemeOptions.cs']);
  assert.deepEqual(m.steps[2].files, ['tests/Catalog/ThemeTests.cs']);
  assert.equal(m.parseHealth.direct, 0);
  assert.equal(m.parseHealth.total, 3);
  assert.deepEqual(m.parseHealth.bySource, { layers: 3 });
  assert.equal(m.parseHealth.layersFallback, true);
  assert.deepEqual(m.deps, { edges: [], source: '', unresolved: 0, unresolvedItems: [] });
  assert.deepEqual(m.parseHealth.issues, [{ line: 1, title: '未发现结构化步骤标题（## 步骤 / ## 任务拆解 / ### 批次 N）', kind: 'layers-fallback' }]);
  assert.ok(!m.steps.some((s) => s.id === 'X' || s.id === 'U'));

  assertSnapshot(m, 'plan-layers-fallback.md');
});

test('默认路径回归：不注入 opts.git 时仍走 collectGit，文档面解析不变', () => {
  const m = buildTour({ root: ROOT, docPath: 'test/fixtures/dev-tour/plan-layers-fallback.md', base: 'HEAD' });
  assert.equal(m.doc.title, '解析失败样例：零散主题调整');
  assert.deepEqual(m.steps.map((s) => s.title), ['前端', '应用层', '测试']);
  assert.equal(m.parseHealth.layersFallback, true);
});

describe('CLI（gen-dev-tour 子进程，并发起跑压总时长）', { concurrency: 4 }, async () => {
  test('CLI --json：正常 fixture 输出可解析模型（exit 0）', async () => {
    const r = await runNode([GEN, path.join(FIXTURES, 'plan-numbered-steps.md'), '--no-diff', '--json', '--root', ROOT]);
    assert.equal(r.status, 0);
    const model = JSON.parse(r.stdout);
    assert.equal(model.doc.title, '编号步骤样例：工单计划跟踪');
    assert.equal(model.parseHealth.layersFallback, false);
  });

  test('CLI --strict + 路径猜测：advisory 放行（exit 0），命中行计「路径猜测 1 处」并产出 HTML', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tour-test-'));
    try {
      const out = path.join(outDir, 'snapshot.html');
      const r = await runNode([GEN, path.join(FIXTURES, 'plan-path-guess.md'), '--no-diff', '--strict', '--out', out, '--root', ROOT]);
      assert.equal(r.status, 0, `stderr: ${r.stderr.slice(0, 300)}`);
      assert.ok(r.stdout.includes('解析命中：直认 1/1 步'), r.stdout.slice(0, 300));
      assert.ok(r.stdout.includes('路径猜测 1 处'), r.stdout.slice(0, 300));
      assert.ok(fs.existsSync(out));
      assert.ok(fs.readFileSync(out, 'utf8').includes('__TOUR_DATA__') === false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('CLI --strict：层兜底 fixture 拒绝产出（exit 1）', async () => {
    const r = await runNode([GEN, path.join(FIXTURES, 'plan-layers-fallback.md'), '--no-diff', '--strict', '--root', ROOT]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('拒绝产出'), `stderr 应含「拒绝产出」，实际：${r.stderr.slice(0, 200)}`);
  });

  test('CLI --json --strict：层兜底 fixture 拒产优先于 JSON（exit 1，stdout 无模型）', async () => {
    const r = await runNode([GEN, path.join(FIXTURES, 'plan-layers-fallback.md'), '--no-diff', '--json', '--strict', '--root', ROOT]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('拒绝产出'), `stderr 应含「拒绝产出」，实际：${r.stderr.slice(0, 200)}`);
    assert.equal(r.stdout.trim(), '', `stdout 不应输出 JSON，实际：${r.stdout.slice(0, 200)}`);
  });

  test('CLI：issues 逐条到行打印（advisory，--strict 仍 exit 0）', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-tour-test-'));
    try {
      const out = path.join(outDir, 'snapshot.html');
      const r = await runNode([GEN, path.join(FIXTURES, 'plan-issues.md'), '--no-diff', '--strict', '--out', out, '--root', ROOT]);
      assert.equal(r.status, 0, `stderr: ${r.stderr.slice(0, 300)}`);
      assert.ok(r.stderr.includes('⚠ 第 14 行：- 依赖：9（未排批次）：依赖引用未解析到步骤'), r.stderr.slice(0, 400));
      assert.ok(r.stderr.includes('⚠ 第 23 行：T9：幽灵批次：文件块锚点未对齐任何步骤'), r.stderr.slice(0, 400));
      assert.ok(fs.existsSync(out));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
