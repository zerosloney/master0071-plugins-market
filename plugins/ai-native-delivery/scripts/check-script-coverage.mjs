#!/usr/bin/env node
// check-script-coverage.mjs — 引擎脚本测试覆盖对账（消费端版，2026-10-23 P1；2026-10-27 插件化修复）
// 背景：2026-10-22 退役的 §20 判据挂载在包源路径 templates/_agents/scripts（本仓消费端恒不触发）；
// 退役理由成立但覆盖需求未消失。本脚本按**真实面**重判：扫引擎脚本目录的 *.mjs（排除 *.test.mjs），
// 覆盖判定 = ① 同名 .test.mjs 存在（direct）；② 豁免表 indirect 指向的测试存在；③ 豁免表 exempt（理由必填）。
//
// 形态感知（2026-10-27 插件化修复）：扫描面按部署形态落位——
//   source-repo 形态：脚本 <root>/.agents/scripts/，测试同目录，豁免表 <root>/.agents/config/scripts-test-exempt.txt
//   plugin      形态：脚本 <plugin>/scripts/，      测试 <plugin>/test/，豁免表 <plugin>/config-templates/scripts-test-exempt.txt
// 规范键（canonical key）恒为源仓形态的 `.agents/scripts/<name>`——豁免表与判据口径保持保真，
// 只有「键 → 实际文件」的解析随形态变化。
// 修复前：ROOT 锚在插件市场仓根（path.resolve(SCRIPT_DIR,'..','..')）且扫 `.agents/scripts`——
//   插件形态下该目录恒不存在 → scanCoverage 返 skipped:true → §28 段静默跳过（假绿）。
// 用法：node <插件根>/scripts/check-script-coverage.mjs [--strict]
// 退出码：默认 0（WARN 消费方判）；--strict 且存在 uncovered/malformed → 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, PLUGIN_SCRIPTS_DIR, PLUGIN_CONFIG_TEMPLATES_DIR, findProjectRoot } from './paths.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// ROOT 解析（2026-10-27 插件化改道，与 check-query-contract / gen-effective-policy 同口径）：
//   项目 git 根（findProjectRoot）→ 旧锚 <script>/../..（源仓形态行为不变）。
// 旧锚在插件形态下=插件目录的上级（市场仓 plugins/）——虽不参与判定（插件面走 PLUGIN_*），
// 但留着当默认值等于埋雷：谁传一次就落到别人的目录。
const ROOT = findProjectRoot() || path.resolve(SCRIPT_DIR, '..', '..');
const SCRIPTS_DIR = '.agents/scripts';
const EXEMPTIONS = '.agents/config/scripts-test-exempt.txt';
// 规范键前缀：豁免表与判据口径恒用源仓形态路径（保真），只有解析随形态变化。
const KEY_PREFIX = `${SCRIPTS_DIR}/`;

// 形态解析：项目侧自带引擎脚本副本（源仓形态 / 测试夹具）→ 用项目侧面；否则用插件内面。
export function resolveLayout(root = ROOT) {
  const projectScripts = path.join(root, SCRIPTS_DIR);
  if (fs.existsSync(projectScripts)) {
    return {
      mode: 'source-repo',
      scriptsDir: projectScripts,
      testDir: projectScripts,
      exemptionsFile: path.join(root, EXEMPTIONS),
    };
  }
  return {
    mode: 'plugin',
    scriptsDir: PLUGIN_SCRIPTS_DIR,
    testDir: path.join(PLUGIN_ROOT, 'test'),
    exemptionsFile: path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'scripts-test-exempt.txt'),
  };
}

// 规范键 → 实际文件：键恒为 `.agents/scripts/<basename>`（豁免表登记口径），按形态解析落位。
const resolveScript = (layout, canonical) => path.join(layout.scriptsDir, path.basename(canonical));
const resolveTest = (layout, canonical) => path.join(layout.testDir, path.basename(canonical));

function loadExemptions(file) {
  const map = new Map();
  const malformed = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { map, malformed: [`豁免表缺失：${EXEMPTIONS}（exempt/indirect 登记无处可读）`] };
  }
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map((s) => s.trim());
    const [mode, target, a, b] = parts;
    const where = `第 ${idx + 1} 行`;
    if (!target) { malformed.push(`${where}：缺少脚本路径`); return; }
    if (mode === 'exempt') {
      if (parts.length < 3 || !a) { malformed.push(`${where}：exempt 缺理由（${target}）`); return; }
    } else if (mode === 'indirect') {
      if (parts.length < 4 || !a || !b) { malformed.push(`${where}：indirect 须「脚本 | 测试文件 | 理由」（${target}）`); return; }
    } else {
      malformed.push(`${where}：未知模式「${mode || ''}」（只认 exempt / indirect）`);
      return;
    }
    if (map.has(target)) { malformed.push(`${where}：脚本重复登记（${target}）`); return; }
    map.set(target, mode === 'exempt' ? { mode, reason: a } : { mode, test: a, reason: b });
  });
  return { map, malformed };
}

export function scanCoverage(root = ROOT, { exemptionsFile = null } = {}) {
  const layout = resolveLayout(root);
  const exemptions = exemptionsFile || layout.exemptionsFile;
  if (!fs.existsSync(layout.scriptsDir)) {
    return {
      rows: [], uncovered: [], malformed: [], skipped: true, mode: layout.mode,
      counts: { direct: 0, indirect: 0, exempt: 0, uncovered: 0, total: 0 },
    };
  }
  const scripts = fs.readdirSync(layout.scriptsDir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${KEY_PREFIX}${f}`);
  const { map, malformed } = loadExemptions(exemptions);
  const rows = [];
  for (const rel of scripts) {
    const direct = rel.replace(/\.mjs$/, '.test.mjs');
    if (fs.existsSync(resolveTest(layout, direct))) { rows.push({ path: rel, status: 'direct', detail: direct }); continue; }
    const ex = map.get(rel);
    if (ex && ex.mode === 'indirect') {
      if (!fs.existsSync(resolveTest(layout, ex.test))) {
        malformed.push(`间接测试不存在：${rel} → ${ex.test}`);
        rows.push({ path: rel, status: 'uncovered', detail: `indirect 指向缺失：${ex.test}` });
      } else {
        rows.push({ path: rel, status: 'indirect', detail: `${ex.test}（${ex.reason}）` });
      }
      continue;
    }
    if (ex && ex.mode === 'exempt') { rows.push({ path: rel, status: 'exempt', detail: ex.reason }); continue; }
    rows.push({ path: rel, status: 'uncovered', detail: '' });
  }
  for (const rel of map.keys()) {
    if (!scripts.includes(rel)) malformed.push(`豁免登记指向不存在的脚本：${rel}（stale 条目须删除）`);
  }
  const uncovered = rows.filter((r) => r.status === 'uncovered');
  const counts = {
    direct: rows.filter((r) => r.status === 'direct').length,
    indirect: rows.filter((r) => r.status === 'indirect').length,
    exempt: rows.filter((r) => r.status === 'exempt').length,
    uncovered: uncovered.length,
    total: rows.length,
  };
  return { rows, uncovered, malformed, counts, mode: layout.mode };
}

function main() {
  const r = scanCoverage(ROOT);
  console.log(`[脚本覆盖对账] 形态 ${r.mode}｜${r.counts.total} 个脚本：直接 ${r.counts.direct} / 间接 ${r.counts.indirect} / 豁免 ${r.counts.exempt} / 缺失 ${r.counts.uncovered}`);
  for (const u of r.uncovered) console.log(`  [缺失] ${u.path}${u.detail ? ` —— ${u.detail}` : ''}`);
  for (const m of r.malformed) console.log(`  [豁免表非法] ${m}`);
  if (r.uncovered.length || r.malformed.length) {
    console.error('\n处置：补同名 .test.mjs，或在 .agents/config/scripts-test-exempt.txt 登记 indirect（测试须存在）或 exempt（理由必填）。');
    if (process.argv.includes('--strict')) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
