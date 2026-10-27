#!/usr/bin/env node
// check-script-coverage.mjs — 引擎脚本测试覆盖对账（消费端版，2026-10-23 P1）
// 背景：2026-10-22 退役的 §20 判据挂载在包源路径 templates/_agents/scripts（本仓消费端恒不触发）；
// 退役理由成立但覆盖需求未消失。本脚本按本仓真实面重判：扫 .agents/scripts/*.mjs（排除 *.test.mjs），
// 覆盖判定 = ① 同名 .test.mjs 存在（direct）；② 豁免表 indirect 指向的测试存在；③ 豁免表 exempt（理由必填）。
// 豁免表：.agents/config/scripts-test-exempt.txt（行格式见该文件头；exempt/indirect 必带理由）。
// 用法：node .agents/scripts/check-script-coverage.mjs [--strict]
// 退出码：默认 0（WARN 消费方判）；--strict 且存在 uncovered/malformed → 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const SCRIPTS_DIR = '.agents/scripts';
const EXEMPTIONS = '.agents/config/scripts-test-exempt.txt';

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

export function scanCoverage(root = ROOT, { exemptionsFile = EXEMPTIONS } = {}) {
  const dir = path.join(root, SCRIPTS_DIR);
  if (!fs.existsSync(dir)) {
    return {
      rows: [], uncovered: [], malformed: [], skipped: true,
      counts: { direct: 0, indirect: 0, exempt: 0, uncovered: 0, total: 0 },
    };
  }
  const scripts = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${SCRIPTS_DIR}/${f}`);
  const { map, malformed } = loadExemptions(path.join(root, exemptionsFile));
  const rows = [];
  for (const rel of scripts) {
    const direct = rel.replace(/\.mjs$/, '.test.mjs');
    if (fs.existsSync(path.join(root, direct))) { rows.push({ path: rel, status: 'direct', detail: direct }); continue; }
    const ex = map.get(rel);
    if (ex && ex.mode === 'indirect') {
      if (!fs.existsSync(path.join(root, ex.test))) {
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
  return { rows, uncovered, malformed, counts };
}

function main() {
  const r = scanCoverage(ROOT);
  console.log(`[脚本覆盖对账] ${r.counts.total} 个脚本：直接 ${r.counts.direct} / 间接 ${r.counts.indirect} / 豁免 ${r.counts.exempt} / 缺失 ${r.counts.uncovered}`);
  for (const u of r.uncovered) console.log(`  [缺失] ${u.path}${u.detail ? ` —— ${u.detail}` : ''}`);
  for (const m of r.malformed) console.log(`  [豁免表非法] ${m}`);
  if (r.uncovered.length || r.malformed.length) {
    console.error('\n处置：补同名 .test.mjs，或在 .agents/config/scripts-test-exempt.txt 登记 indirect（测试须存在）或 exempt（理由必填）。');
    if (process.argv.includes('--strict')) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
