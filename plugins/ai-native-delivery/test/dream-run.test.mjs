#!/usr/bin/env node
// dream-run.test.mjs — 离线梦境审计（Dreaming）黑盒 + 纯函数测试
// 夹具：临时目录造遥测 jsonl + workflow 冷数据/终态件语料（mtime 用 utimesSync 定格，非 git 目录走
//       mtime 回退）。断言：①CLI 写报告到 .agents/tmp/dream-report-<date>.md 且 exit 0（advisory）；
//       ②报告三段齐全（A 记忆负债聚合 / B 终态件归档建议 / C 处置建议）；③处置建议分级路由
//       （零命中→记忆负债、终态件→归档候选、被引用→先核对引用方）；④advisory 边界——除报告本身
//       外整树零改动（不移动/不改写/不删除任何文档）；⑤--report 自定义路径；⑥遥测不足 exit 0
//       不产候选；⑦未知选项 exit 2。
// 用法：node test/dream-run.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeDream, renderReport } from '../scripts/dream-run.mjs';

const DREAM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dream-run.mjs');
const DAY = 86400000;

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// mkfix：冷数据（活跃 approved，零命中，mtime 老）+ 终态件（done）+ 被引用的冷数据 + wiki 冷笔记。
const mkfix = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-run-test-'));
  const now = Date.now();
  const old = new Date(now - 200 * DAY);
  const wf = path.join(root, 'workflow');
  for (const d of ['plans', 'specs']) fs.mkdirSync(path.join(wf, d), { recursive: true });
  const doc = (status) => `---\n状态: ${status}\n级别: L1\n---\n# 文档\n`;
  const put = (rel, body, mtime) => {
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
    fs.utimesSync(path.join(root, rel), mtime, mtime);
  };
  put('workflow/plans/2026-05-01-cold-never-hit.md', doc('approved'), old);   // 零命中冷数据 → 记忆负债建议
  put('workflow/plans/2026-04-01-cold-referenced.md', doc('approved'), old);  // 被引用冷数据 → 先核对引用方
  put('workflow/specs/2026-03-01-done-spec.md', doc('done'), old);            // 终态件 → B 段归档建议 + C 段归档路由
  fs.writeFileSync(path.join(wf, 'plans', '2026-10-01-fresh.md'), doc('approved'), 'utf8'); // 热（mtime=now）
  put('workflow/plans/2026-10-01-fresh-referencer.md', doc('approved'), new Date(now - 1 * DAY)); // 引用方（引用 cold-referenced）
  fs.appendFileSync(path.join(root, 'workflow', 'plans', '2026-10-01-fresh-referencer.md'), '\n参见 2026-04-01-cold-referenced.md\n', 'utf8');
  fs.mkdirSync(path.join(root, 'wiki', '主题'), { recursive: true });
  put('wiki/主题/note-old.md', '# 笔记\n', old);
  const iso = (d) => new Date(d).toISOString();
  const telemetry = [
    // cold-never-hit 零遥测行（名实一致：命中月数 0、末次命中 —）；其余四行跨 ≥3 个自然月
    { ts: iso(now - 100 * DAY), query: '引 用', docs: ['workflow/plans/2026-04-01-cold-referenced.md'] },
    { ts: iso(now - 65 * DAY), query: '笔 记', docs: ['wiki/主题/note-old.md'] },
    { ts: iso(now - 35 * DAY), query: '引 用', docs: ['workflow/plans/2026-04-01-cold-referenced.md'] },
    { ts: iso(now - 2 * DAY), query: '热 点', docs: ['workflow/plans/2026-10-01-fresh.md'] },
  ];
  fs.mkdirSync(path.join(root, '.agents', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'cache', 'kb-usage.jsonl'),
    telemetry.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { root, now };
};

// 整树快照（排除 .agents/tmp 报告目录）——advisory「除报告外零改动」的比对基线
const snapshot = (root) => {
  const out = new Map();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel === '.agents/tmp' || rel.startsWith('.agents/tmp/')) continue;
      if (e.isDirectory()) { out.set(rel, 'dir'); stack.push(full); }
      else out.set(rel, fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
};

const run = (root, args) => spawnSync(process.execPath, [DREAM, ...args], { cwd: root, encoding: 'utf8' });

// ---- ①②③ CLI 主路径：报告三段 + 处置分级 ----
{
  const { root } = mkfix();
  const snap1 = snapshot(root);
  const r = run(root, ['--stale-days', '30']);
  check('① CLI exit 0（advisory 恒绿）且报告已写入提示', r.status === 0 && /报告已写入 .*dream-report-\d{4}-\d{2}-\d{2}\.md/.test(r.stdout), `exit=${r.status} ${r.stdout} ${r.stderr}`);
  const reportFile = fs.readdirSync(path.join(root, '.agents', 'tmp')).find((f) => f.startsWith('dream-report-'));
  check('① 报告落 <root>/.agents/tmp/（项目侧 gitignore 运行态）', Boolean(reportFile), '');
  const report = fs.readFileSync(path.join(root, '.agents', 'tmp', reportFile), 'utf8');
  check('② 报告头带 advisory 声明（不移动/不改写/不删除）',
    report.startsWith('# 离线梦境审计报告 ') && report.includes('不移动、不改写、不删除任何文档'), report.slice(0, 200));
  check('② A 段：记忆负债聚合候选入报告', report.includes('## A. 记忆负债聚合') && report.includes('冷数据候选（30 天') && report.includes('workflow/plans/2026-05-01-cold-never-hit.md'), report);
  check('② B 段：终态件归档建议点名 done 件（事实列 + 引用）',
    report.includes('## B. 终态件归档建议') && /候选\s+workflow\/specs\/2026-03-01-done-spec\.md\s+状态 done\s+末次更新 \d{4}-\d{2}-\d{2}\s+引用 0/.test(report), report);
  check('② C 段：处置建议三列事实（状态/命中月数/引用）', report.includes('## C. 冷数据候选处置建议') && /cold-never-hit\.md\s+状态 approved\s+末次命中 —\s+命中月数 0\s+引用 0/.test(report), report);
  check('③ 零命中 → 记忆负债路由', /cold-never-hit\.md\s+状态 approved\s+末次命中 —\s+命中月数 0\s+引用 0\n\s+→ 记忆负债——立档后从未被 kb-search 命中/.test(report.replace(/\r\n/g, '\n')), report);
  check('③ 被引用冷数据 → 转冷路由带引用核对提示（引用 1）',
    /2026-04-01-cold-referenced\.md[\s\S]*?引用 1\n\s+→ 曾被命中但已转冷[^\n]*仍被 1 处引用[^\n]*先核对引用方/.test(report.replace(/\r\n/g, '\n')), report);
  check('③ 终态件零引用 → B 段归档候选路由（archive-sweep 指引，不自动移动）',
    /done-spec\.md\s+状态 done\s+末次更新 \d{4}-\d{2}-\d{2}\s+引用 0\n\s+→ 终态件归档候选——可跑 archive-sweep\.mjs --execute/.test(report.replace(/\r\n/g, '\n')), report);
  check('④ advisory 边界：除 .agents/tmp/ 报告外整树零改动', JSON.stringify([...snapshot(root)]) === JSON.stringify([...snap1]), '');
  // ⑤ --report 自定义路径
  const r2 = run(root, ['--report', 'dream-custom.md']);
  check('⑤ --report 自定义路径生效', r2.status === 0 && fs.existsSync(path.join(root, 'dream-custom.md')) && fs.readFileSync(path.join(root, 'dream-custom.md'), 'utf8').includes('# 离线梦境审计报告'), r2.stdout);
  fs.rmSync(path.join(root, 'dream-custom.md'), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑥ 遥测不足：exit 0 且 A 段交代数据不充分 ----
{
  const { root } = mkfix();
  fs.writeFileSync(path.join(root, '.agents', 'cache', 'kb-usage.jsonl'), '', 'utf8');
  const r = run(root, ['--months', '3']);
  check('⑥ 空遥测 → exit 0 且 A 段数据不充分文案', r.status === 0 && /遥测数据月仅 0 个（下限 3）/.test(fs.readFileSync(path.join(root, '.agents', 'tmp', fs.readdirSync(path.join(root, '.agents', 'tmp')).find((f) => f.startsWith('dream-report-'))), 'utf8')), `exit=${r.status} ${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ 参数错误 + 纯函数 ----
{
  const { root, now } = mkfix();
  const bad = run(root, ['--unknown']);
  check('⑦ 未知选项 exit 2', bad.status === 2, `exit=${bad.status}`);
  const tel = fs.readFileSync(path.join(root, '.agents', 'cache', 'kb-usage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const a = analyzeDream({ root, rows: tel, minMonths: 1, staleDays: 30, now });
  check('⑦ analyzeDream：终态件与冷数据建议齐备',
    a.terminalDocs.length === 1 && a.terminalDocs[0].doc === 'workflow/specs/2026-03-01-done-spec.md'
    && a.suggestions.length >= 3 && a.suggestions.every((s) => typeof s.advice === 'string' && s.advice), JSON.stringify({ t: a.terminalDocs, s: a.suggestions }));
  const rendered = renderReport(a, { staleDays: 30, date: '2026-01-01' });
  check('⑦ renderReport 渲染三段且日期可注入', rendered.includes('# 离线梦境审计报告 2026-01-01') && ['## A.', '## B.', '## C.'].every((h) => rendered.includes(h)), rendered.split('\n').slice(0, 4).join('\n'));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
