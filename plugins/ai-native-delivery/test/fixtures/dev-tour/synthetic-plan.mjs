#!/usr/bin/env node
// synthetic-plan.mjs — 开发全景图规模压测合成器（零依赖；压测工具，非 node:test 用例，不进 ci.yml）
// 自源仓 .agents/tests/tools/gen-synthetic-plan.mjs 迁移（词根映射：物资→订单，路径面改插件仓）。
// 用法：
//   node <插件根>/test/fixtures/dev-tour/synthetic-plan.mjs <N>       # 生成 N 步合成 plan → <系统临时目录>/ai-native-delivery-tour-perf/synthetic-<N>.md
//   node <插件根>/test/fixtures/dev-tour/synthetic-plan.mjs --bench   # N=10/30/60 三档：注入 git 面（300 修改文件，走
//                                                                      # buildTour opts.git 缝合，不往真仓库造任何状态）跑
//                                                                      # buildTour 计时 + gen-dev-tour 生成静态 HTML 记录体积
// 产物只落 os.tmpdir()/ai-native-delivery-tour-perf/（插件安装形态无源仓的 .agents/cache/ 忽略项，落系统临时
// 目录确保绝不进版本库）；实测数字登记 skills/dev-tour/SKILL.md「适用规模」节。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT_DIR = path.join(os.tmpdir(), 'ai-native-delivery-tour-perf');
const BENCH_N = [10, 30, 60];
const PAYLOAD_FILES = 300;
const FILES_PER_STEP = [3, 4, 5, 4, 3]; // 每步 3~5 个文件循环

function planText(n) {
  const lines = [];
  lines.push('---', '标题: 合成压测计划', '状态: 起草中', '级别: L2', '模块: 订单', '日期: 2099-12-31', '---');
  lines.push('', `# PLAN — 合成压测：${n} 步 × 文件`, '');
  lines.push('## 任务拆解');
  for (let i = 1; i <= n; i++) {
    lines.push(`- [ ] ${i}. T${i} 合成步骤${i}：性能压测用合成说明`);
    lines.push('  - 判据：合成判据通过');
  }
  lines.push('', '## 改动方案');
  const files = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`- **T${i}**：文件组${i}`);
    const cnt = FILES_PER_STEP[(i - 1) % FILES_PER_STEP.length];
    for (let k = 0; k < cnt; k++) {
      const p = i % 3 === 1 ? `backend/perf/Mod${i}/PerfService${i}_${k}.cs`
        : i % 3 === 2 ? `frontend/src/views/perf/Page${i}${k}.vue`
        : `frontend/src/api/perf/api${i}_${k}.ts`;
      files.push(p);
      lines.push(`  - \`${p}\`：合成改动说明`);
    }
  }
  lines.push('', '## 执行顺序');
  const clauses = [];
  for (let i = 2; i <= n; i++) clauses.push(`${i} 依赖 ${i - 1}`);
  lines.push(`依赖：${clauses.join('；')}`);
  lines.push('', '## 验证计划');
  lines.push('- `tests/perf/PerfSmokeTests.cs` 全绿');
  lines.push('- 手工：合成冒烟');
  return { text: lines.join('\n') + '\n', files };
}

// 300 个修改文件：优先取文档登记路径（练习计划面合并），不足补文档外 filler（练习「文档外实际改动」归集）
function gitPayload(docFiles, total) {
  const files = {};
  for (const p of docFiles.slice(0, total)) files[p] = { status: 'modified', actual: true, additions: 10, deletions: 2 };
  let i = 0;
  while (Object.keys(files).length < total) {
    files[`scripts/perf-filler/fill${i}.ps1`] = { status: 'modified', actual: true, additions: 3, deletions: 1 };
    i++;
  }
  return files;
}

function writePlan(n) {
  const { text } = planText(n);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const doc = path.join(OUT_DIR, `synthetic-${n}.md`);
  fs.writeFileSync(doc, text, 'utf8');
  return doc;
}

if (process.argv[2] === '--bench') {
  const modelUrl = pathToFileURL(path.join(ROOT, 'scripts', 'dev-tour-model.mjs'));
  const { buildTour } = await import(modelUrl.href);
  const rows = [];
  for (const n of BENCH_N) {
    const doc = writePlan(n);
    const { files } = planText(n);
    const payload = { available: true, base: 'HEAD', baseSha: 'perf00000000', note: '', basePaths: [], files: gitPayload(files, PAYLOAD_FILES) };
    let ms = 0;
    let model = null;
    for (let round = 0; round < 3; round++) {
      const t0 = performance.now();
      model = buildTour({ root: ROOT, docPath: doc, base: 'HEAD', git: payload });
      ms = Math.max(ms, performance.now() - t0); // 3 轮取最大（悲观界）
    }
    const html = path.join(OUT_DIR, `synthetic-${n}.html`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-dev-tour.mjs'), doc, '--no-diff', '--out', html, '--root', ROOT], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`gen-dev-tour 失败（N=${n}）：${String(r.stderr).slice(0, 300)}`);
      process.exit(1);
    }
    const size = fs.statSync(html).size;
    rows.push({ n, steps: model.steps.length, files: model.files.length, ms: Math.round(ms), size });
    console.log(`N=${n} · ${model.steps.length} 步 × 300 文件 → build ${Math.round(ms)} ms`);
    console.log(`      HTML：${html} · ${(size / 1024).toFixed(0)} KB · 模型文件 ${model.files.length}`);
  }
  console.log('拐点判断：以上为实测范围（' + BENCH_N.join('/') + ' 档）；超出范围未验证。');
  process.exit(0);
}

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1) {
  console.error('用法：node synthetic-plan.mjs <N> | --bench');
  process.exit(1);
}
console.log(writePlan(n));
