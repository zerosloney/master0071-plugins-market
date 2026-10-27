#!/usr/bin/env node
// gen-engine-map.mjs — 生成式引擎地图（2026-10-21 门禁极小化第 3 批 W2）
// 用途：一页冷启动地图——引擎怎么执行、几个卡口、几道门、台账在哪、机制状态如何，
//       全部从单源**现场取数**渲染到 .agents/notes/engine-map.md。禁手写（手写地图自己会漂，
//       同 narrative-claims 哲学）；--check 防漂移：改引擎后须重生成随同提交。
// 单源：.githooks/ 文件清单｜verify.mjs GATES（spawn --list，即时不执行门）｜
//       check-loop.mjs SECTIONS（lane 计数）｜mechanism-registry.md（parseRegistry 复用）｜
//       commands/skills/roles 目录清单。静态文字仅「执行模型/卡口职责/台账用途」三段说明性内容。
// 用法：node .agents/scripts/gen-engine-map.mjs [--check] [--root <仓库根>]
// 测试：node .agents/scripts/gen-engine-map.test.mjs（临时夹具根：生成/一致/漂移三态）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseRegistry, STATUSES } from './mechanism-retire-watch.mjs';
// 路径收口（2026-10-27 插件化迁移改道 paths.mjs）：脚本本体落插件 scripts/；check-loop 段表走
// scriptPath、机制台账走 configDir（项目侧优先回退插件内种子）；命令/技能/角色载体项目侧优先、
// 回退插件内（模型侧载体随插件分发）。
import { PLUGIN_SCRIPTS_DIR, PLUGIN_ROOT, findProjectRoot, scriptPath, configDir } from './paths.mjs';

const SCRIPT_DIR = PLUGIN_SCRIPTS_DIR;
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''; };
// 默认根（2026-10-27 插件化迁移，与 verify.mjs 同口径）：--root > git root > 插件根。
const ROOT = path.resolve(argOf('--root') || findProjectRoot() || PLUGIN_ROOT);
const MAP_REL = path.join('.agents', 'notes', 'engine-map.md');

// ---- 单源取数 ----
function readText(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
const listDir = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
};
// 只列目录（2026-10-24 复核 P1）：技能面此前直接列全部条目，未跟踪的 tfs-pr.zip 被当成第 23 个技能
// 写进地图，干净检出上 --check 必红（生成物依赖工作区脏文件，不可复现）。只用于目录型载体。
const listSubdirs = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
};

function verifyGateIds() {
  const verify = path.join(SCRIPT_DIR, 'verify.mjs');
  const r = spawnSync(process.execPath, [verify, '--list'], {
    encoding: 'utf8', env: { ...process.env, CHECK_LOOP_ROOT: ROOT, RUN_E2E: '' },
  });
  return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
}

function loopSections() {
  // 段表单源定位（2026-10-27 插件化迁移改道）：项目侧 .agents/scripts/check-loop.mjs 优先，回退插件内本体。
  const p = scriptPath(ROOT, 'check-loop.mjs');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (text === null) return null;
  const out = [];
  for (const m of text.matchAll(/\{\s*lane:\s*'(hard|hygiene)'\s*,\s*run:\s*(\w+)\s*\}/g)) out.push({ lane: m[1], id: m[2] });
  return out;
}

function registrySummary() {
  // 机制台账定位（2026-10-27 插件化迁移改道）：configDir 回退链——项目侧 .agents/config/ 优先，
  // 回退插件内 config-templates 种子；两处皆缺 → 段落整体省略（生成物不写死「无台账」）。
  const p = path.join(configDir(ROOT), 'mechanism-registry.md');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (text === null) return null;
  const rows = parseRegistry(text);
  const by = (s) => rows.filter((r) => r.status === s);
  const revisits = rows.filter((r) => /复评\s*\d{4}-\d{2}-\d{2}/.test(r.deadline))
    .map((r) => ({ name: r.name, date: String(r.deadline).match(/复评\s*(\d{4}-\d{2}-\d{2})/)[1] }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const [ACTIVE, PENDING, RETIRED] = STATUSES;
  return {
    total: rows.length, active: by(ACTIVE).length, retired: by(RETIRED).length, pending: by(PENDING).length,
    retiredNames: by(RETIRED).map((r) => r.name), revisits,
  };
}

// ciSummary：CI 触发面与各分支实跑面（2026-10-27 修「漂移门恒真」）
// 动机：本页此前的 CI 行是**硬编码字符串**，与 azure-pipelines.yml 无任何取数关系——yml 改了
// （2026-10-26 恢复 develop 触发）而「engine-map --check」仍恒绿，漂移门对真漂移完全无感。
// 改为现场解析 yml：trigger 分支列表 + 各 step 的 condition 分支 + 实际命令。
function ciSummary() {
  const text = readText('azure-pipelines.yml');
  if (text === null) return null;
  const branches = [];
  const tIdx = text.indexOf('trigger:');
  if (tIdx >= 0) {
    const inc = text.indexOf('include:', tIdx);
    if (inc >= 0) {
      for (const line of text.slice(inc + 'include:'.length).split(/\r?\n/)) {
        const m = line.match(/^\s*-\s*([A-Za-z0-9_./-]+)\s*$/);
        if (m) { branches.push(m[1]); continue; }
        if (line.trim() && !/^\s*-/.test(line)) break;
      }
    }
  }
  const steps = [];
  for (const chunk of text.split(/^\s*-\s*(?:task|checkout):/m).slice(1)) {
    const name = (chunk.match(/displayName:\s*(.+)/) || [])[1];
    const branch = (chunk.match(/condition:\s*eq\(variables\['Build\.SourceBranch'\],\s*'refs\/heads\/([^']+)'\)/) || [])[1];
    const args = (chunk.match(/arguments:\s*(.+)/) || [])[1];
    const cmd = (args || name || '').trim();
    if (!cmd) continue;
    steps.push({ cmd, branch: branch || null });
  }
  if (!branches.length) return null;
  const perBranch = branches.map((b) => {
    const runs = steps.filter((s) => !s.branch || s.branch === b).map((s) => s.cmd);
    return `${b} 直推 = ${runs.length ? runs.join(' + ') : '（无 CI 步）'}`;
  });
  return `trigger = ${branches.join(' + ')}；${perBranch.join('；')}（本页现场取数 azure-pipelines.yml；口径登记 runtime-env §6.5）`;
}

// 卡口职责说明（键 = .githooks 文件名；未登记者按通用行渲染——钩子清单仍来自单源）
const HOOK_DESC = {
  'pre-commit': '硬拦：台账不变量（触及才跑）+ 四业务守卫 + 常驻面体积预算 + commit-check（--no-build）；advisory 五门已撤（2026-10-21）',
  'pre-push': 'check-loop hard 段扫描（--rev 按推送树）+ commit-check --range 范围条件构建',
  'pre-merge-commit': '合并提交转发 pre-commit（--full 全量构建面）',
  'commit-msg': '提交信息规范（Conventional Commits）',
  'post-commit': '领先 upstream 提示（勤推小步）',
};

function buildMap() {
  const hooks = listDir(path.join('.githooks'));
  const gates = verifyGateIds();
  const secs = loopSections();
  const reg = registrySummary();
  const ci = ciSummary();
  // 模型侧载体目录定位（2026-10-27 插件化迁移改道）：命令/技能/角色随插件分发——项目侧 .agents/<x>
  // 存在则优先（项目自有扩展面），否则列插件内本体；.githooks / azure-pipelines.yml 仍为项目侧单源。
  const carrierDir = (projectRel, pluginRel) => {
    const p = path.join(ROOT, projectRel);
    return fs.existsSync(p) ? p : path.join(PLUGIN_ROOT, pluginRel);
  };
  const listAbs = (abs) => (fs.existsSync(abs) ? fs.readdirSync(abs).sort() : []);
  const listAbsSubdirs = (abs) => (fs.existsSync(abs)
    ? fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : []);
  const cmds = listAbs(carrierDir(path.join('.agents', 'commands'), 'commands')).filter((f) => f.endsWith('.md'));
  const skills = listAbsSubdirs(carrierDir(path.join('.agents', 'skills'), 'skills'));
  const roles = listAbs(carrierDir(path.join('.agents', 'roles'), 'agents')).filter((f) => f.endsWith('.md'));

  const L = [];
  L.push('# 引擎地图（生成物，勿手改）');
  L.push('');
  L.push('> 生成器 `node .agents/scripts/gen-engine-map.mjs`（单源现场取数；`--check` 防漂移——改引擎后重生成随同提交）。');
  L.push('> 一页冷启动地图：接手会话/新协作者读本页替代全仓考古；明细按 §维护 的单源指针下钻。');
  L.push('');
  L.push('## 执行模型（一段）');
  L.push('');
  L.push('本引擎无常驻进程：**文档即状态机**（`workflow/` 四目录，frontmatter `状态: draft→approved→done` 由 confirm-doc 迁移）+ **git 钩子即执法点** + **脚本即确定性验证器** + **AI 即执行体**（读命令/技能/角色契约行动）。质量分工：确定性脚本管事实（确认过没有/验证过没有/红线判低），模型管判断（定级/根因/设计/复核）。');
  L.push('');
  L.push('## 执法卡口');
  L.push('');
  L.push(`git 钩子 ${hooks.length} 个：`);
  L.push('');
  L.push('| 钩子 | 跑什么 |');
  L.push('|---|---|');
  for (const h of hooks) L.push(`| ${h} | ${HOOK_DESC[h] || '（见钩子头注——本地图未登记职责说明）'} |`);
  L.push(`| CI（azure-pipelines） | ${ci || '（未找到 azure-pipelines.yml——CI 触发面未知）'} |`);
  L.push('');
  L.push(`## verify 门表（${gates.length} 门，单源 verify.mjs GATES；--scope 按 diff 面裁剪）`);
  L.push('');
  L.push(gates.map((g) => `\`${g}\``).join(' · '));
  L.push('');
  if (secs) {
    const hard = secs.filter((s) => s.lane === 'hard');
    const hyg = secs.filter((s) => s.lane === 'hygiene');
    L.push(`## check-loop 段（${secs.length} 段 = hard ${hard.length} + hygiene ${hyg.length}；单源 check-loop.mjs SECTIONS）`);
    L.push('');
    L.push(`- **hard 车道**（默认关单/pre-push 扫）：${hard.map((s) => s.id).join('、')}`);
    L.push(`- **hygiene 车道**（--hygiene/--all 才扫）：${hyg.length} 段（索引/宿主/词表/指标/委派等 WARN——月检道）`);
    L.push('');
  }
  if (reg) {
    L.push(`## 机制台账状态（${reg.total} 行，单源 mechanism-registry.md）`);
    L.push('');
    L.push(`现役 ${reg.active} / 已退役 ${reg.retired} / 待退役 ${reg.pending}${reg.retiredNames.length ? `；已退役：${reg.retiredNames.join('、')}` : ''}`);
    if (reg.revisits.length) {
      L.push('');
      L.push(`owner-fiat 复评挂号称 ${reg.revisits.length}（retire-watch 规则④到期自动催办）：${reg.revisits.map((r) => `${r.name}(${r.date})`).join('、')}`);
    }
    L.push('');
  }
  L.push('## 模型侧载体');
  L.push('');
  L.push(`- **命令** ${cmds.length} 篇（commands/，常驻指令面；2026-10-27 起随插件分发，项目侧 .agents/commands/ 存在时列项目自有）：${cmds.join('、')}`);
  L.push(`- **技能** ${skills.length} 个（skills/，按需加载；项目侧 .agents/skills/ 存在时列项目自有）：${skills.join('、')}`);
  L.push(`- **角色** ${roles.length} 个（agents/，子代理契约；项目侧 .agents/roles/ 存在时列项目自有）：${roles.map((r) => r.replace(/\.md$/, '')).join('、')}`);
  L.push('');
  L.push('## 数据与台账面');
  L.push('');
  L.push('| 台账 | 用途 |');
  L.push('|---|---|');
  L.push('| `.agents/verifications.jsonl` | verify 绿凭证（钉 headShort + 24h 窗；--scope 行带面与基线） |');
  L.push('| `.agents/judgments.jsonl` | check-loop 每次运行 per-rule WARN/BLOCK 落账（retire-watch 供数） |');
  L.push('| `.agents/confirmations.jsonl` + `confirmations.d/` | 确认链（append-only，指纹 sha256，提交时刻增量执法） |');
  L.push('| `.agents/trust-mode-audit.jsonl` | 自治授权升降级（prev-sha256 链） |');
  L.push('| `workflow/reviews.d/` | 复核事件级台账（采纳/拒绝/误报） |');
  L.push('| `workflow/papercuts.d/` | 摩擦与消债台账 |');
  L.push('| `workflow/delegations.md` | 委派/自做结果 + 月度聚合快照（扩容门供数） |');
  L.push('| `workflow/metrics.md` | 月度指标（incident/门禁成本/复核效果——GENERATED 区） |');
  L.push('');
  L.push('## 维护');
  L.push('');
  L.push('- 改任何单源（钩子/GATES/SECTIONS/台账/目录）后：`node .agents/scripts/gen-engine-map.mjs` 重生成随同提交；CI/hygiene 可跑 `--check` 防漂移。');
  L.push('- 环境事实单源 `.agents/notes/runtime-env.md` §6；机制明细与退役阈值单源 `.agents/config/mechanism-registry.md`；门禁成本 `workflow/metrics.md`。');
  L.push('');
  return L.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = buildMap();
  const mapPath = path.join(ROOT, MAP_REL);
  if (argv.includes('--check')) {
    const cur = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8').replace(/\r/g, '') : null;
    if (cur === out.replace(/\r/g, '')) {
      console.log('[engine-map] ✅ 与单源一致');
      process.exit(0);
    }
    console.error('❌ engine-map.md 与单源漂移——重生成：node .agents/scripts/gen-engine-map.mjs');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, out);
  console.log(`[engine-map] ✅ 已生成 ${MAP_REL}（钩子/门/段/机制行现场取数）`);
}
