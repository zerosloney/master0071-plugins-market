// workflows-check：编排脚本机器 lint（2026-09-25 workflows-linter，审查改进方向 1）
// 目的：`.agents/pipelines/_TEMPLATE.md`「解析校验先行」此前是纯 prose——role ∈ .agents/roles/、
//       step ∈ steps/、after 引用存在且无环，全靠宿主 AI 自觉；而编排脚本的书写者与执行者是同一
//       宿主 AI，缺外部裁决者。本工具把该纪律变成机器门：解析 .agents/pipelines/*.md 的 stages 表
//       逐行校验，error 级 exit 1（可挂 doctor / CI），告警级 advisory 不阻断。
//
// 检查项（error → exit 1）:
//   E1 缺 frontmatter（name/description/concurrency 口径见 _TEMPLATE.md）
//   E2 concurrency 非正整数（缺省 = 2）
//   E3 缺 stages 表（表头须含 id/after/gate 列）
//   E4 stage 缺 id 或 id 重复
//   E5 after 引用不存在的 stage
//   E6 after 依赖成环
//   E7 role 不在 .agents/roles/（词表 = 目录内 *.md 文件名）
//   E8 step 不在 .agents/pipelines/steps/（文件名即步骤名——目录即注册表）
//   E9 四形态（role/step/gate/human）不互斥：全空或同时 ≥2 个非空（`—`/`-`/空白 均视为空；human 列可选，缺列恒空）
//   E10 retries 非非负整数（空 = 0，口径同 _TEMPLATE「失败且 retries > 0 → 重派」）
// 告警（advisory，不阻断）:
//   W1 gate 含 {a,b} 花括号展开——仅 bash 展开，PowerShell/cmd 按字面路径失败（跨宿主可移植性）
//   W2 两个 role stage 的授权文件 token 完全相同且互相无 after 先序——并行 fan-out 同文件交叉写
//   W3 frontmatter 缺 name（编排脚本标识）
//   W4 human 确认门行填了 retries——用户驳回不能重派，无重试语义（视作 0）
//
// 排除：`_` 前缀文件（_TEMPLATE.md 是机制文档，正文含示例表——示例 step 名「部署验证」不在 steps/，
//       机制文档不按可执行件校验）；steps/ 子目录（是扩展点注册表，非编排脚本）。
// 表解析：取首个表头含 id+after+gate 的表格，列名归一（task / params → task、files（授权）→ files），
//        到首个非 `|` 行截止；仅此一张表——编排脚本按机制文档只允许一张 stages 表。
// 用法：node <插件根>/scripts/workflows-check.mjs [--root <目标根>] [--json]
// 默认根 = 项目 git 仓库根（paths.mjs projectRoot 锚定，不锚 cwd——子目录调用仍扫仓库根的 workflow/ 树）
// 零依赖；只报告不修复（B-b 决策口径，同 check-loop 的 advisory 面）
// 测试：node <插件根>/test/workflows-check.test.mjs（fixture + 真实仓库 baseline）
import fs from 'node:fs';
import path from 'node:path';
// 路径收口（2026-10-27 插件化迁移改道 paths.mjs）：角色契约随插件分发，词表并集见 lintWorkflows。
import { PLUGIN_ROOT, projectRoot } from './paths.mjs';

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

// 空值规范：em/en dash、裸连字符、空白均视为「未填」（stages 表通用约定）
const EMPTY_CELLS = new Set(['—', '–', '-', '']);
const normCell = (v) => { const s = String(v ?? '').trim(); return EMPTY_CELLS.has(s) ? '' : s; };

function listMdNames(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

function parseFm(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\S+):\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return fm;
}

// splitRow：`| a | b |` → ['a','b']（去首尾竖线后按 | 切）
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// cellName：表头格 → 列名（小写取首个英文词：task / params → task、files（授权） → files）
function cellName(c) {
  const m = c.toLowerCase().match(/^[a-z]+/);
  return m ? m[0] : '';
}

// parseStages：返回 stage 行数组（id/after/role/step/files/gate/human/retries + _line 行号），无表返回 null。
// human 列可选（表头缺列 = 恒空，既有 9 列脚本零改动兼容）；导出供 wf-journal.mjs 复用同一解析口径。
export function parseStages(text) {
  const lines = String(text).split(/\r?\n/);
  let headerIdx = -1;
  let colIdx = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const names = splitRow(lines[i]).map(cellName);
    if (names.includes('id') && names.includes('after') && names.includes('gate')) {
      headerIdx = i;
      colIdx = {};
      names.forEach((n, k) => { if (n && !(n in colIdx)) colIdx[n] = k; });
      break;
    }
  }
  if (headerIdx === -1) return null;
  const COLS = ['id', 'after', 'role', 'step', 'files', 'gate', 'human', 'retries'];
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) break;
    const cells = splitRow(lines[i]);
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue; // 分隔行 |----|
    if (cells.every((c) => normCell(c) === '')) continue; // 全空行
    const row = { _line: i + 1 };
    for (const c of COLS) row[c] = colIdx[c] !== undefined ? normCell(cells[colIdx[c]] ?? '') : '';
    rows.push(row);
  }
  return rows;
}

// lintWorkflowText：单文件校验（pure，词表以 Set 传入）
export function lintWorkflowText({ file, text, roles, steps }) {
  const errors = [];
  const warnings = [];
  const fm = parseFm(text);
  if (!fm) {
    errors.push('E1 缺 frontmatter（--- name / description / concurrency ---，口径见 _TEMPLATE.md）');
  } else {
    if (fm.concurrency !== undefined && fm.concurrency !== '' && !/^[1-9]\d*$/.test(fm.concurrency)) {
      errors.push(`E2 concurrency 须为正整数（现「${fm.concurrency}」，缺省 = 2）`);
    }
    if (!fm.name) warnings.push('W3 frontmatter 缺 name（编排脚本标识，_TEMPLATE.md 口径）');
  }

  const rows = parseStages(text);
  if (!rows) {
    errors.push('E3 缺 stages 表（表头须含 id / after / gate 列——三形态各至少一行的可执行编排才有效）');
    return { file, errors, warnings };
  }

  const byId = new Map();
  for (const r of rows) {
    if (!r.id) { errors.push(`E4 L${r._line} stage 缺 id`); continue; }
    if (byId.has(r.id)) errors.push(`E4 id 重复：${r.id}（L${byId.get(r.id)._line} 与 L${r._line}）`);
    else byId.set(r.id, r);
    const forms = [r.role && 'role', r.step && 'step', r.gate && 'gate', r.human && 'human'].filter(Boolean);
    if (forms.length === 0) errors.push(`E9 L${r._line} ${r.id} 四形态（role/step/gate/human）全空——须恰填一项`);
    if (forms.length > 1) errors.push(`E9 L${r._line} ${r.id} 四形态互斥违例：同时填了 ${forms.join(' + ')}`);
    if (r.role && !roles.has(r.role)) errors.push(`E7 L${r._line} ${r.id} role「${r.role}」不在角色词表（.agents/roles/ ∪ 插件 agents/；现有：${[...roles].join('、') || '无'}）`);
    if (r.step && !steps.has(r.step)) errors.push(`E8 L${r._line} ${r.id} step「${r.step}」不在 steps/（现有：${[...steps].join('、') || '无'}）`);
    if (r.retries && !/^\d+$/.test(r.retries)) errors.push(`E10 L${r._line} ${r.id} retries 须为非负整数（现「${r.retries}」，空 = 0）`);
    if (r.gate && /\{[^}]+,[^}]+\}/.test(r.gate)) warnings.push(`W1 L${r._line} ${r.id} gate 含 {a,b} 花括号展开——仅 bash 展开，PowerShell/cmd 按字面路径失败：${r.gate}`);
    if (r.human && r.retries) warnings.push(`W4 L${r._line} ${r.id} human 确认门行填了 retries「${r.retries}」——用户驳回不能重派，无重试语义（视作 0）`);
  }

  // after 引用存在性 + 成环（DFS 三色）
  const ids = new Set(byId.keys());
  const deps = new Map();
  for (const [id, r] of byId) {
    deps.set(id, r.after ? r.after.split(/[,，、\s]+/).filter(Boolean) : []);
  }
  for (const [id, ds] of deps) {
    for (const d of ds) if (!ids.has(d)) errors.push(`E5 ${id} after 引用不存在的 stage：${d}`);
  }
  const color = new Map();
  let cycle = '';
  const dfs = (id) => {
    color.set(id, 1);
    for (const d of deps.get(id) || []) {
      if (!ids.has(d)) continue;
      const c = color.get(d) || 0;
      if (c === 1) { cycle = `${d} → ${id}`; return true; }
      if (c === 0 && dfs(d)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of ids) {
    if (!color.get(id) && dfs(id)) { errors.push(`E6 after 依赖成环：${cycle}（闭环上一对）`); break; }
  }

  // W2 授权文件交叉：role stage 间完全相同 token 且互相无 after 先序（有先序 = 串行接力，不算交叉）
  if (!errors.some((e) => e.startsWith('E5') || e.startsWith('E6'))) {
    const depAll = new Map();
    const depClosure = (id) => {
      if (depAll.has(id)) return depAll.get(id);
      const s = new Set();
      depAll.set(id, s); // 先占位防递归环（E6 已排除，稳妥起见）
      for (const d of deps.get(id) || []) {
        if (!ids.has(d)) continue;
        s.add(d);
        for (const x of depClosure(d)) s.add(x);
      }
      return s;
    };
    const tokensOf = (r) => new Set((r.files || '').split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean));
    const roleRows = [...byId.values()].filter((r) => r.role && r.files);
    for (let i = 0; i < roleRows.length; i++) {
      for (let j = i + 1; j < roleRows.length; j++) {
        const a = roleRows[i];
        const b = roleRows[j];
        const shared = [...tokensOf(a)].filter((t) => tokensOf(b).has(t));
        if (!shared.length) continue;
        if (depClosure(a.id).has(b.id) || depClosure(b.id).has(a.id)) continue;
        warnings.push(`W2 role stage ${a.id} 与 ${b.id} 授权文件交叉且无 after 先序（并行 fan-out 同文件交叉写）：${shared.join('、')}`);
      }
    }
  }

  return { file, errors, warnings };
}

// lintWorkflows：扫 <root>/.agents/pipelines/（pure function，测试/doctor 共用）
// 返回 { root, roles, steps, files: [{file, errors, warnings}], errorCount, warningCount }
export function lintWorkflows({ root }) {
  const wfRoot = path.join(root, '.agents', 'pipelines');
  // roles 词表（2026-10-27 插件化迁移）：项目侧 .agents/roles/ ∪ 插件内 agents/（角色契约随插件分发，
  // 项目可另置自有角色）；steps 仍以项目侧 .agents/pipelines/steps/ 为注册表（steps 是项目扩展点）。
  const roles = new Set([
    ...listMdNames(path.join(root, '.agents', 'roles')),
    ...listMdNames(path.join(PLUGIN_ROOT, 'agents')),
  ]);
  const steps = new Set(listMdNames(path.join(wfRoot, 'steps')));
  const files = (fs.existsSync(wfRoot) && fs.statSync(wfRoot).isDirectory())
    ? fs.readdirSync(wfRoot, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
        .map((e) => e.name)
        .sort()
    : [];
  const results = files.map((f) => lintWorkflowText({
    file: f,
    text: fs.readFileSync(path.join(wfRoot, f), 'utf8'),
    roles,
    steps,
  }));
  return {
    root,
    roles: [...roles],
    steps: [...steps],
    files: results,
    errorCount: results.reduce((n, r) => n + r.errors.length, 0),
    warningCount: results.reduce((n, r) => n + r.warnings.length, 0),
  };
}

function printResult(result) {
  console.log('▶ workflows-check（.agents/pipelines/ 编排脚本 lint）');
  console.log(`  编排脚本 ${result.files.length} 份 ｜ roles 词表 ${result.roles.length} ｜ steps 词表 ${result.steps.length}`);
  for (const f of result.files) {
    if (!f.errors.length && !f.warnings.length) {
      console.log(`  ✅ ${f.file}`);
    } else {
      console.log(`  ${f.errors.length ? '❌' : '⚠️ '} ${f.file}（${f.errors.length} error / ${f.warnings.length} warning）`);
      for (const e of f.errors) console.log(`    - ${e}`);
      for (const w of f.warnings) console.log(`    - ⚠️ ${w}`);
    }
  }
  const tail = result.errorCount
    ? `❌ ${result.errorCount} error / ${result.warningCount} warning——error 须修复后才可执行编排（解析校验先行）`
    : `${result.warningCount ? `⚠️  0 error / ${result.warningCount} warning（advisory 不阻断）` : '✅ 0 error / 0 warning'}`;
  console.log(`  ${tail}`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('workflows-check.mjs');
if (isMain) {
  // 根锚定 git root（paths.mjs 单源）：--root 显式指定仍优先；编排文件在仓库根的 workflow/ 树。
  let root = projectRoot();
  let json = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--root') root = path.resolve(process.argv[++i] ?? fail('--root 缺少值'));
    else if (a === '--json') json = true;
    else fail(`未知选项：${a}（workflows-check --root <dir> / --json）`);
  }
  const result = lintWorkflows({ root });
  if (json) {
    process.stdout.write(JSON.stringify({
      root: result.root,
      files: result.files,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
    }, null, 2) + '\n');
  } else {
    printResult(result);
  }
  process.exit(result.errorCount ? 1 : 0);
}
export default lintWorkflows;
