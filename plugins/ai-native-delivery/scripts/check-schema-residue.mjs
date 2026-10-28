#!/usr/bin/env node
/**
 * check-schema-residue.mjs — 「已删列/新增列 vs 实库」残留审计（只读）
 *
 * 用途：批次（wiki/数据维护/schema变更/*）登记的列变更与 dev 实库比对，
 *       找出「批次已删却仍在」（残留＝带外加列/批次语句静默失效）
 *       与「批次已加却不存在」（缺失＝带外删列）两类漂移。
 *
 * 起源：2026-10-12 dev 库带外加列反复回加（incident 2026-10-12-outband-column-readd-recurring）；
 *       同日发现 `LINENO` 为 T-SQL 关键字致 `DROP COLUMN LineNo` 静默不生效 —— 本脚本可一次扫出该类。
 *
 * 口径：
 *   - 取各批次 `0N-*.sql` 中**动作类**脚本：排除 `99-*`（回滚）、`*rollback*`（语义反转）、`*verify*`（核验脚本非动作）；
 *   - 逐条 `ALTER TABLE` 语句内扫描 `ADD [COLUMN]` / `DROP [COLUMN]` 的**多列清单**（顶层逗号切分；跳过 CONSTRAINT/PRIMARY/UNIQUE/… 等约束子句）；
 *   - 同（表,列）以批次目录名排序取**最后一次**动作；
 *   - `ADD` 后缺失 → 缺失；`DROP` 后仍存在 → 残留。
 *
 * 已知盲区（人工兜底，勿当全量证明）：
 *   - 动态 SQL（`EXEC(N'ALTER TABLE … DROP COLUMN …')`）解析不可见（如 2026-09-29-consignment-vmi-rollback）；
 *   - 同目录内名为 `0N-rollback-*.sql` 的回滚脚本按文件名排除（其语义为撤销 01，判定会反转）。
 *
 * 豁免（EXEMPT）：**带方向**的已判定项——只在登记的该方向上豁免，反方向仍照常报警：
 *   - `direction: 'missing'`：批次已加但实库不存在，且已人工核实为「更晚批次删除」等台账侧过时；
 *   - `direction: 'residue'`：批次已删但实库仍在，且已人工核实为「实体确实声明该列」（台账注释过时）。
 *
 * 依赖：sqlcmd（PATH 可达）与后端服务 appsettings.json 的 DBConnParameter（定位为项目适配点：
 *       SCHEMA_RESIDUE_APPSETTINGS 显式指定优先，缺省扫 backend 下各服务项目的 appsettings.json 取首个命中）。
 * 用法：node <插件根>/scripts/check-schema-residue.mjs [--verbose]
 * 退出码：0 = 无未解释残留/缺失；1 = 有；2 = 前置缺失（appsettings/sqlcmd）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './paths.mjs';

// 根锚定 git root（paths.mjs 单源）：wiki/ 是仓库级目录，子目录调用仍扫仓库根的那一份。
const root = projectRoot();
const base = path.join(root, 'wiki', '数据维护', 'schema变更');
const verbose = process.argv.includes('--verbose');
const SKIP = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'INDEX', 'CHECK', 'FOREIGN', 'NONCLUSTERED', 'CLUSTERED', 'KEY', 'COLUMN', 'ADD', 'DROP']);

// 已判定豁免（带方向；人工核过，不计入对应方向的残留/缺失信号）。
// 2026-10-27 插件化迁移：源项目已判项不随插件分发（项目级判定数据，属运行时面），各项目按
// 原「方向 + 理由」格式自行登记——['表.列', { direction: 'missing'|'residue', reason: '人工核实缘由' }]。
const EXEMPT = new Map([]);

// appsettings 定位（2026-10-27 插件化适配点）：SCHEMA_RESIDUE_APPSETTINGS 显式指定优先；
// 缺省扫 backend/*/appsettings.json 取首个命中（源项目固定「backend/material/<服务项目>/」布局不随插件分发）。
const appsettings = process.env.SCHEMA_RESIDUE_APPSETTINGS || (() => {
  const beDir = path.join(root, 'backend');
  if (!fs.existsSync(beDir)) return null;
  return fs.readdirSync(beDir, { withFileTypes: true })
      .filter((x) => x.isDirectory()).map((x) => x.name).sort()
      .map((d) => path.join(beDir, d, 'appsettings.json'))
      .find((p) => fs.existsSync(p)) || null;
})();
if (!appsettings) { console.error('未找到 backend/*/appsettings.json（可以 SCHEMA_RESIDUE_APPSETTINGS 指定）'); process.exit(2); }
const conn = JSON.parse(fs.readFileSync(appsettings, 'utf8')).DBConnParameter;
if (!conn) { console.error('appsettings.json 缺 DBConnParameter'); process.exit(2); }
const pick = (k) => (conn.match(new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]+)`, 'i')) || [])[1];
const sqlcmdArgs = ['-S', pick('Server'), '-d', pick('Database'), '-U', pick('User Id'), '-P', pick('Password'), '-h', '-1', '-W', '-f', '65001'];

const sqlcmd = (query) => execFileSync('sqlcmd', [...sqlcmdArgs, '-Q', query], { encoding: 'utf8' });

/** 顶层逗号切分（忽略括号内逗号） */
function splitTopLevel(text) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 取一条 ALTER 语句体里的目标列标识符（多列清单 + 跳过约束子句） */
function targetsOf(body) {
  const out = [];
  for (const m of body.matchAll(/\b(ADD|DROP)\s+(?:COLUMN\s+)?/gi)) {
    const tail = body.slice(m.index + m[0].length);
    for (const seg of splitTopLevel(tail)) {
      const cleaned = seg.replace(/^\s*COLUMN\s+/i, '');   // `ADD COLUMN a INT, COLUMN b INT` 的第二段
      const id = /^\s*\[?(\w+)\]?/.exec(cleaned);
      if (!id) continue;
      const name = id[1];
      if (SKIP.has(name.toUpperCase())) continue;
      out.push({ action: m[1].toUpperCase(), name });
    }
  }
  return out;
}

// 1) 解析批次登记动作（表 | 列 → 最后动作）
const acts = new Map();
const isActionFile = (x) => /^0\d-.*\.sql$/i.test(x) && !/^99-/.test(x) && !/rollback/i.test(x) && !/verify/i.test(x);
for (const d of fs.readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
  for (const f of fs.readdirSync(path.join(base, d)).filter(isActionFile).sort()) {
    const raw = fs.readFileSync(path.join(base, d, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
    // 语句体边界：分号 **或** 下一条 ALTER TABLE 起（防「无分号 + GO」写法把列记到前一张表名下）
    for (const m of raw.matchAll(/ALTER\s+TABLE\s+(?:\[?dbo\]?\.)?\[?(\w+)\]?\s+([\s\S]*?)(?=;|\bALTER\s+TABLE\b|$)/gi)) {
      const [, table, body] = m;
      for (const { action, name } of targetsOf(body)) {
        const key = `${table}|${name}`;
        const cur = acts.get(key);
        if (!cur || d >= cur.order) acts.set(key, { order: d, action, src: `${d}/${f}` });
      }
    }
  }
}

// 2) 与实库比对
const exists = (t, c) => sqlcmd(`SET NOCOUNT ON; SELECT CASE WHEN EXISTS(SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.${t}') AND name='${c}') THEN 'Y' ELSE 'N' END;`).split(/\r?\n/)[0].trim() === 'Y';
const residue = []; const missing = []; const exempted = [];
for (const [key, v] of acts) {
  const [t, c] = key.split('|');
  if (!/^[A-Za-z_]\w*$/.test(t) || !/^[A-Za-z_]\w*$/.test(c)) continue;
  const dir = v.action === 'ADD' ? 'missing' : 'residue';
  const bad = dir === 'missing' ? !exists(t, c) : exists(t, c);
  if (!bad) continue;
  const ex = EXEMPT.get(`${t}.${c}`);
  if (ex && ex.direction === dir) exempted.push([`${t}.${c}`, dir, ex.reason]);
  else (dir === 'missing' ? missing : residue).push([t, c, v.src]);
}

console.log(`[schema-residue] 扫描批次动作 ${acts.size} 项（wiki/数据维护/schema变更；排除 99-rollback / *rollback* / *verify*）`);
console.log(`[schema-residue] 残留（批次已删仍存在）${residue.length} 项 / 缺失（批次已加不存在）${missing.length} 项 / 已豁免 ${exempted.length} 项（按方向）`);
for (const [t, c, s] of residue) console.log(`  ⚠ 残留 ${t}.${c}  ← ${s}`);
for (const [t, c, s] of missing) console.log(`  ⚠ 缺失 ${t}.${c}  ← ${s}`);
if (process.argv.includes('--dump')) {
  const filter = process.argv[process.argv.indexOf('--dump') + 1];
  const re = new RegExp(filter ?? '.', 'i');
  console.log(`[schema-residue] --dump ${filter ?? '.'} 命中：`);
  for (const [k, v] of acts) if (re.test(k)) console.log(`  · ${k} ${v.action} ← ${v.src}`);
}
if (verbose) {
  console.log('[schema-residue] 豁免明细（带方向；反方向仍会报警）：');
  for (const [k, dir, reason] of exempted) console.log(`  · [${dir}] ${k} — ${reason}`);
}
process.exit(residue.length || missing.length ? 1 : 0);
