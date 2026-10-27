#!/usr/bin/env node
// kb-search.mjs 的 fixture 驱动测试
// 现场构造临时 workflow 语料（换 cwd 运行被测脚本，脚本按相对路径 'workflow/' 读盘）。
// 断言：①AND 语义与「节限定」（指定节外的内容不参与命中）；②活跃优先排序（同命中近同体积时 active 在前）；
//       ③过滤与上限（--type / --module / --status / -n）；④失败路径（非法模块、无词 → exit 1）；
//       ⑤结构缓存三路逐字节等值（cold/warm/--no-cache）；⑥增量失效（改 1 文件仅该文件重解析）；
//       ⑦口径指纹变化整份作废；⑧缓存损坏静默回退全扫。
// 用法：node .agents/scripts/kb-search.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KB = path.join(SCRIPT_DIR, '..', 'scripts', 'kb-search.mjs'); // 插件化落位（2026-10-27 迁移）
// 注入式缓存（board-kb-p1）：--cache 指向 fixture 内路径——测试不再触碰真实 .agents/cache/kb-index.json
// （旧 CACHE_FILE 直跑会清空真实开发缓存并遗留孤儿条目，审查 P2-2）
const USAGE = '用法：node .agents/scripts/kb-search.test.mjs';
const rootCache = (root) => path.join(root, 'kb-cache.json');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const doc = (fm, title, sections) =>
  `---\n${fm}\n---\n# ${title}\n\n${sections.map(([h, body]) => `## ${h}\n${body}\n`).join('\n')}\n`;

// mkfix：甲（closed，incidents）/ 乙（approved，intents）同命中近同体积（验活跃优先）；
//       丙（approved，plans）只含单词（验 AND）、其「非目标」节含标记词（验节限定）
const mkfix = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-search-test-'));
  for (const d of ['intents', 'plans', 'incidents']) fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true });
  const w = path.join(root, 'workflow');
  const hit = (tag) => [
    ['目标', `- 统一口径：编码模板与分类层级，冲突处理见 A/B${tag}`],
    ['非目标', '- MARKER_ONLY_OUTSIDE_SECTIONS（本节不参与检索，词：编码模板）'],
  ];
  fs.writeFileSync(path.join(w, 'incidents', '2026-09-01-aaa.md'), doc('状态: closed\n级别: L2\n发现: 2026-09-01\n模块: material', 'INCIDENT — 甲事故', hit('甲')), 'utf8');
  fs.writeFileSync(path.join(w, 'intents', '2026-09-21-bbb.md'), doc('状态: approved\n级别: L1\n日期: 2026-09-21\n模块: pipeline', 'INTENT — 乙需求', hit('乙')), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-20-ccc.md'), doc('状态: approved\n级别: L1\n模块: purchase', 'PLAN — 丙计划', [['目标', '- 只讲编码模板，不提另一个词'], ['非目标', '- MARKER_ONLY_OUTSIDE_SECTIONS（本节不参与检索）']]), 'utf8');
  // spec/plan 主体节语料（2026-10-13 扩面回归）：功能行为/数据流/系统改动/改动方案/任务拆解 等
  // 原白名单外节——扩面前这些节 0% 可检索（实测 specs 1% / plans 1%），本 fixture 钉住扩面不回归。
  fs.mkdirSync(path.join(w, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(w, 'specs', '2026-09-22-ddd.md'), doc('状态: approved\n级别: L2\n日期: 2026-09-22\n模块: purchase', 'SPEC — 丁规格', [
    ['功能行为', '- SPECBODY_ONLY 场景：层级优先裁决'],
    ['数据流', '- SPECBODY_ONLY 入参 templateCode → 出参 SpecConfig'],
    ['系统改动', '- SPECBODY_ONLY CodeGeneratorService.cs'],
    ['约束遵守映射', '- SPECBODY_ONLY DI-4 批次纪律'],
    ['验收判据', '- SPECBODY_ONLY 判据表逐条'],
    ['风险评估', '- SPECBODY_ONLY 存量数据偏差'],
  ]), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-23-eee.md'), doc('状态: approved\n级别: L1\n模块: purchase', 'PLAN — 戊计划', [
    ['改动方案', '- PLANBODY_ONLY 单文件改动'],
    ['任务拆解', '- PLANBODY_ONLY 三步'],
    ['执行顺序', '- PLANBODY_ONLY 先库后码'],
    ['验证计划', '- PLANBODY_ONLY 静态门 + UI 实测'],
    ['约束与风险', '- PLANBODY_ONLY 最小改动'],
  ]), 'utf8');
  // 编号节名变体（22 份存量 spec 用 `## 1. 功能行为`）——归一化后须与无编号同口径命中
  fs.writeFileSync(path.join(w, 'specs', '2026-09-24-fff.md'), doc('状态: approved\n级别: L2\n模块: purchase', 'SPEC — 己规格', [
    ['1. 功能行为', '- SPECBODY_ONLY 编号节变体'],
  ]), 'utf8');
  // wiki 侧最小语料（验结构缓存对 wiki 行数组的存取路径）
  fs.mkdirSync(path.join(root, 'wiki', '测试主题'), { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki', '测试主题', '说明.md'), '# 说明\n\n编码模板的领域知识条目。\n', 'utf8');
  return root;
};

const run = (root, args) => spawnSync(process.execPath, [KB, '--cache', rootCache(root), ...args], { cwd: root, encoding: 'utf8' });
const files = (out) => (out.match(/^📄 (workflow\/\S+)/gm) || []).map((l) => l.replace('📄 ', ''));

// ---- 场景 1：主路径——AND 语义 / 节限定 / 输出字段 / 活跃优先 ----
{
  const root = mkfix();
  const r = run(root, ['--scope', 'workflow', '编码模板', '冲突']);
  check('场景 1：检索 exit 0', r.status === 0, `exit=${r.status}\n${r.stderr}`);
  check('场景 1：AND——两词齐全才命中（甲/乙，丙被排除）', files(r.stdout).length === 2 && !r.stdout.includes('2026-09-20-ccc.md'), r.stdout);
  check('场景 1：活跃优先——approved 的乙排在 closed 的甲之前', files(r.stdout)[0]?.includes('2026-09-21-bbb.md'), files(r.stdout).join('\n'));
  check('场景 1：输出行含 状态·级别·模块', /📄 workflow\/intents\/2026-09-21-bbb\.md — approved · L1 · pipeline ·/.test(r.stdout), r.stdout);
  check('场景 1：命中带节名与行号', /\[目标\] L\d+: /.test(r.stdout), r.stdout);
  const outside = run(root, ['--scope', 'workflow', 'MARKER_ONLY_OUTSIDE_SECTIONS']);
  check('场景 1：节外内容不参与检索（仅标记词 → 无命中）', files(outside.stdout).length === 0 && /（无命中）/.test(outside.stdout), outside.stdout);
  // 扩面回归（2026-10-13）：spec/plan 主体节须可检索——扩面前这些节 0% 入索引
  const specBody = run(root, ['--scope', 'workflow', 'SPECBODY_ONLY']);
  check('场景 1b：spec 主体节可检索（功能行为/数据流/系统改动/约束遵守映射/验收判据/风险评估）',
    files(specBody.stdout).length === 2 && specBody.stdout.includes('2026-09-22-ddd.md') && specBody.stdout.includes('2026-09-24-fff.md'), specBody.stdout);
  check('场景 1b：spec 命中带节名（非 (标题)/frontmatter）', /\[功能行为\] L\d+: /.test(specBody.stdout), specBody.stdout);
  const planBody = run(root, ['--scope', 'workflow', 'PLANBODY_ONLY']);
  check('场景 1b：plan 主体节可检索（改动方案/任务拆解/执行顺序/验证计划/约束与风险）',
    files(planBody.stdout).length === 1 && planBody.stdout.includes('2026-09-23-eee.md'), planBody.stdout);
  check('场景 1b：plan 命中带节名', /\[改动方案\] L\d+: /.test(planBody.stdout), planBody.stdout);
  check('场景 1b：编号节名变体归一化（`## 1. 功能行为` 与无编号同口径命中）',
    specBody.stdout.includes('2026-09-24-fff.md'), specBody.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：过滤与上限（--type / --module / --status / -n）----
{
  const root = mkfix();
  const t = run(root, ['--scope', 'workflow', '--type', 'plans', '编码模板']);
  check('场景 2：--type plans 仅出 plans', files(t.stdout).length === 1 && files(t.stdout)[0].includes('plans/'), t.stdout);
  const m = run(root, ['--scope', 'workflow', '--module', 'pipeline', '编码模板']);
  check('场景 2：--module pipeline 仅出该模块', files(m.stdout).length === 1 && files(m.stdout)[0].includes('2026-09-21-bbb.md'), m.stdout);
  const a = run(root, ['--scope', 'workflow', '--status', 'active', '编码模板']);
  check('场景 2：--status active 排除终态', !a.stdout.includes('2026-09-01-aaa.md') && a.stdout.includes('2026-09-21-bbb.md'), a.stdout);
  const term = run(root, ['--scope', 'workflow', '--status', 'terminal', '编码模板']);
  check('场景 2：--status terminal 仅终态', term.stdout.includes('2026-09-01-aaa.md') && !term.stdout.includes('2026-09-21-bbb.md'), term.stdout);
  const n1 = run(root, ['--scope', 'workflow', '-n', '1', '编码模板']);
  check('场景 2：-n 1 只展示 1 个文件', files(n1.stdout).length === 1, n1.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：失败路径（非法模块 / 无词 / 无命中）----
{
  const root = mkfix();
  const bad = run(root, ['--module', '不存在的模块', '编码模板']);
  check('场景 3：非法 --module exit 1 且提示词表', bad.status === 1 && /未知模块/.test(bad.stderr), `exit=${bad.status}\n${bad.stderr}`);
  const empty = run(root, []);
  check('场景 3：无词 exit 1', empty.status === 1, `exit=${empty.status}`);
  const none = run(root, ['--scope', 'workflow', 'zzz-绝不存在-zzz']);
  check('场景 3：无命中 exit 0 且提示', none.status === 0 && /（无命中）/.test(none.stdout), none.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：结构缓存三路逐字节等值（cold 首建 / warm 命中 / --no-cache），workflow+wiki 双侧 ----
{
  const root = mkfix();
  const cold = run(root, ['编码模板']);                                   // 该临时根 ns 无条目 → cold
  const warm = run(root, ['编码模板']);                                   // 全命中缓存
  const nocache = run(root, ['--no-cache', '编码模板']);
  check('场景 4：cold/warm exit 0 且 warm 确有缓存回写', cold.status === 0 && warm.status === 0 && fs.existsSync(rootCache(root)), `cold=${cold.status} warm=${warm.status}`);
  check('场景 4：cold ≡ warm（逐字节）', cold.stdout === warm.stdout, `cold:\n${cold.stdout}\nwarm:\n${warm.stdout}`);
  check('场景 4：cold ≡ --no-cache（逐字节）', cold.stdout === nocache.stdout, `cold:\n${cold.stdout}\nnocache:\n${nocache.stdout}`);
  check('场景 4：双侧均有命中（workflow 3 + wiki 1）', files(cold.stdout).length === 3 && /wiki\/测试主题/.test(cold.stdout), cold.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5：增量失效——warm 后改 1 个源文件，仅该文件重解析且输出与纯扫一致 ----
{
  const root = mkfix();
  const base = run(root, ['编码模板']);
  const planP = path.join(root, 'workflow', 'plans', '2026-09-20-ccc.md');
  fs.appendFileSync(planP, '\n## 影响面\n- 新标记NEWWORD：编码模板修订\n', 'utf8');
  const after = run(root, ['编码模板', 'NEWWORD']);
  const scan = run(root, ['--no-cache', '编码模板', 'NEWWORD']);
  check('场景 5：改动文件被重解析（NEWWORD 命中该篇）', after.status === 0 && after.stdout.includes('2026-09-20-ccc.md'), after.stdout);
  check('场景 5：增量结果与纯扫逐字节一致', after.stdout === scan.stdout, `after:\n${after.stdout}\nscan:\n${scan.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6：口径指纹变化 → 整份作废重建，无旧口径残留 ----
{
  const root = mkfix();
  run(root, ['编码模板']); // 建缓存
  const j = JSON.parse(fs.readFileSync(rootCache(root), 'utf8'));
  const fpBefore = j.fp;
  j.fp = 'ffffffffffffffff';
  fs.writeFileSync(rootCache(root), JSON.stringify(j), 'utf8');
  const after = run(root, ['编码模板']);
  const scan = run(root, ['--no-cache', '编码模板']);
  check('场景 6：指纹不符 → 输出仍与纯扫逐字节一致', after.status === 0 && after.stdout === scan.stdout, `after:\n${after.stdout}\nscan:\n${scan.stdout}`);
  const j2 = JSON.parse(fs.readFileSync(rootCache(root), 'utf8'));
  check('场景 6：回写恢复正确指纹', j2.fp === fpBefore && j2.fp !== 'ffffffffffffffff', `fp=${j2.fp}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7：缓存损坏 → 静默回退全扫（不报错、输出与 --no-cache 一致） ----
{
  const root = mkfix();
  fs.mkdirSync(path.dirname(rootCache(root)), { recursive: true });
  fs.writeFileSync(rootCache(root), 'not-json{{{', 'utf8');
  const r = run(root, ['编码模板']);
  const scan = run(root, ['--no-cache', '编码模板']);
  check('场景 7：损坏缓存 exit 0（stderr 无泄漏）', r.status === 0 && !r.stderr, `exit=${r.status}\n${r.stderr}`);
  check('场景 7：损坏后输出与纯扫逐字节一致', r.stdout === scan.stdout, `r:\n${r.stdout}\nscan:\n${scan.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8：结构损坏（JSON 合法但 lines 非数组 / 元素非数组）→ 静默回退（board-kb-p1 P1-1）----
//     此前 reviveLines 直接 .map 抛 TypeError exit 1，违背「任何读写异常静默回退」声明契约
{
  for (const [tag, lines] of [['lines-字符串', 'corrupted'], ['lines-元素非数组', ['not-array']]]) {
    const root = mkfix();
    run(root, ['编码模板']); // 建缓存
    const j = JSON.parse(fs.readFileSync(rootCache(root), 'utf8'));
    const key = Object.keys(j.files).find((k) => k.endsWith('2026-09-01-aaa.md'));
    j.files[key].lines = lines;
    fs.writeFileSync(rootCache(root), JSON.stringify(j), 'utf8');
    const r = run(root, ['编码模板']);
    const scan = run(root, ['--no-cache', '编码模板']);
    check(`场景 8：结构损坏（${tag}）exit 0 静默回退`, r.status === 0 && !r.stderr, `exit=${r.status}\n${r.stderr}`);
    check(`场景 8：结构损坏（${tag}）输出与纯扫一致`, r.stdout === scan.stdout, `r:\n${r.stdout}\nscan:\n${scan.stdout}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- 场景 9：空 query（空串 / 纯空白）→ 参数错误 exit 1（board-kb-p1：includes('') 恒真曾全量命中）----
{
  const root = mkfix();
  const r1 = run(root, ['']);
  const r2 = run(root, ['  ', ' ']);
  check('场景 9：空串 query exit 1', r1.status === 1 && /检索词不能为空/.test(r1.stderr), `exit=${r1.status}\n${r1.stderr}`);
  check('场景 9：纯空白 query exit 1', r2.status === 1 && /检索词不能为空/.test(r2.stderr), `exit=${r2.status}\n${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 10：--files 文件关联检索（词元 OR + 位置词 AND 叠加）----
{
  const root = mkfix();
  // 语料补一份提及文件名 OrderDetail 的 incident
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-10-01-order-detail.md'), doc('状态: closed\n级别: L1\n发现: 2026-10-01\n模块: material', 'INCIDENT — OrderDetail 守卫', [['根因', '- frontend/src/views/OrderDetail.vue 状态守卫缺失，冲突处理见 A/B甲']]), 'utf8');
  const r1 = run(root, ['--files', 'frontend/src/views/OrderDetail.vue']);
  check('场景 10：--files 词元命中（OrderDetail）', r1.status === 0 && /order-detail|OrderDetail/.test(r1.stdout), `exit=${r1.status}\n${r1.stdout}\n${r1.stderr}`);
  const r2 = run(root, ['--files', 'frontend/src/views/NoSuch.vue']);
  check('场景 10：--files 无命中 → exit 0 不出现命中文件', r2.status === 0 && !/order-detail/i.test(r2.stdout), `exit=${r2.status}\n${r2.stdout}`);
  const r3 = run(root, ['--files', 'frontend/src/views/OrderDetail.vue', '乙需求']);
  check('场景 10：--files 与位置词叠加（AND）→ 只留交集', r3.status === 0 && !/order-detail/i.test(r3.stdout), `exit=${r3.status}\n${r3.stdout}`);
  const r4 = run(root, ['--files', 'x/index,y/AGENTS.md']);
  check('场景 10：泛化词元（index/AGENTS）→ 参数错误 exit 1', r4.status === 1 && /有效词元/.test(r4.stderr), `exit=${r4.status}\n${r4.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 11：词内空白拦截（2026-10-09 P3-1）——带引号单参数此前静默 0 命中（假阴性进 incident 回路）----
{
  const root = mkfix();
  const r1 = run(root, ['订单 导入']);
  check('场景 11a：词内含空白 → 参数错误 exit 1 且指明拆参修法',
    r1.status === 1 && /词内含空白/.test(r1.stderr) && /kb-search\.mjs 订单 导入/.test(r1.stderr), `exit=${r1.status}\n${r1.stderr}`);
  const r2 = run(root, ['订单', '导入']);
  check('场景 11b：拆独立参数（AND）正常检索 exit 0', r2.status === 0, `exit=${r2.status}\n${r2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 12：warm 不重写缓存 + --stats 只写 stderr（2026-10-22 慢搜索排查）----
{
  const root = mkfix();
  run(root, ['编码模板']); // 建缓存
  const cache = rootCache(root);
  const epoch = new Date(0);
  fs.utimesSync(cache, epoch, epoch);
  const warm = run(root, ['--stats', '编码模板']);
  check('场景 12：warm 命中不重写缓存（mtime 不变）', warm.status === 0 && fs.statSync(cache).mtimeMs < 1000, `mtime=${fs.statSync(cache).mtimeMs}\n${warm.stderr}`);
  check('场景 12：--stats 输出到 stderr 且含命中计数', /cache hit=\d+/.test(warm.stderr) && !/cache hit=/.test(warm.stdout), `stderr=${warm.stderr}`);
  check('场景 12：stdout 与不带 --stats 一致', warm.stdout === run(root, ['编码模板']).stdout, warm.stdout);
  fs.appendFileSync(path.join(root, 'workflow', 'plans', '2026-09-20-ccc.md'), '\n新增行\n');
  const dirty = run(root, ['--stats', '编码模板']);
  check('场景 12：内容变化后重写缓存', /wrote=true/.test(dirty.stderr), dirty.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log(`\n${USAGE}`);
  process.exit(1);
}
process.exit(0);
