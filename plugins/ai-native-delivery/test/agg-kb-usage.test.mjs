#!/usr/bin/env node
// agg-kb-usage.test.mjs — 冷数据聚合（Dreaming 记忆负债）黑盒 + 纯函数测试
// 夹具：临时目录造 workflow/wiki 语料 + 遥测 jsonl（命中/未命中混合，mtime 用 utimesSync 定格；
//       非 git 目录 → git log 失败走 mtime 回退，lastTouch 可确定性断言）。断言：
//       ①数据月不足不产候选（年轻遥测不造假候选）；②命中近/内容新者不入选；③长期未命中且未更新者
//       入选（workflow 活跃态 + wiki 两侧）；④终态件/_TEMPLATE/INDEX/drafts-archive 不入扫描面；
//       ⑤候选行燃料口径（候选 <名> + 末次命中/末次更新/命中月数，与 agg-judgments --retire-candidates
//       并排可读）；⑥未知选项 exit 2。
// 用法：node test/agg-kb-usage.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectColdCandidates, renderCold } from '../scripts/agg-kb-usage.mjs';

const AGG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'agg-kb-usage.mjs');
const DAY = 86400000;

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// mkfix：3 候选 + 2 在役 + 4 排除面的最小语料。时间锚 = 相对 now（跨月界稳定）：
//   冷 = 200 天前 mtime；热 = 1 天前 mtime；遥测行分布 now-100/-65/-35/-2 天（≥3 个自然月）。
const mkfix = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-kb-usage-test-'));
  const now = Date.now();
  const old = new Date(now - 200 * DAY);
  const fresh = new Date(now - 1 * DAY);
  const wf = path.join(root, 'workflow');
  for (const d of ['plans', 'intents', 'incidents']) fs.mkdirSync(path.join(wf, d), { recursive: true });
  const doc = (status) => `---\n状态: ${status}\n级别: L1\n---\n# 文档\n`;
  const put = (rel, body, mtime) => {
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
    fs.utimesSync(path.join(root, rel), mtime, mtime);
  };
  put('workflow/plans/2026-08-01-cold-doc.md', doc('approved'), old);          // 曾命中但已转冷 → 候选
  put('workflow/plans/2026-10-01-hot-doc.md', doc('approved'), fresh);         // 内容新 + 近期命中 → 不入选
  put('workflow/intents/2026-08-02-never-hit.md', doc('draft'), old);          // 零命中记忆负债 → 候选（命中月数 0）
  put('workflow/incidents/2026-09-03-recent-hit.md', doc('open'), old);        // 内容旧但近期被命中 → 不入选
  put('workflow/plans/2026-07-01-terminal-cold.md', doc('done'), old);         // 终态件：不在活跃扫描面（归档走 archive-sweep）
  put('workflow/plans/_TEMPLATE.md', doc('draft'), old);                       // 模板排除
  fs.mkdirSync(path.join(root, 'wiki', '主题'), { recursive: true });
  put('wiki/主题/note-old.md', '# 笔记\n', old);                               // wiki 冷数据 → 候选
  put('wiki/INDEX.md', '# 索引\n', old);                                       // 索引排除
  fs.mkdirSync(path.join(root, 'wiki', 'drafts-archive'), { recursive: true });
  put('wiki/drafts-archive/x.md', '# 归档草稿\n', old);                        // drafts-archive 排除
  const iso = (d) => new Date(d).toISOString();
  const telemetry = [
    { ts: iso(now - 100 * DAY), query: '冷 门', docs: ['workflow/plans/2026-08-01-cold-doc.md'] },
    { ts: iso(now - 65 * DAY), query: '事故', docs: ['workflow/incidents/2026-09-03-recent-hit.md'] },
    { ts: iso(now - 35 * DAY), query: '热 点', docs: ['workflow/plans/2026-10-01-hot-doc.md'] },
    { ts: iso(now - 2 * DAY), query: '热 点', docs: ['workflow/plans/2026-10-01-hot-doc.md', 'workflow/incidents/2026-09-03-recent-hit.md'] },
  ];
  fs.mkdirSync(path.join(root, '.agents', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'cache', 'kb-usage.jsonl'),
    telemetry.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { root, now };
};

const run = (root, args) => spawnSync(process.execPath, [AGG, ...args], { cwd: root, encoding: 'utf8' });

// ---- ① 纯函数：数据月不足不产候选 ----
{
  const { root } = mkfix();
  const cold = collectColdCandidates({ root, rows: [], minMonths: 3, staleDays: 30 });
  check('① 零遥测 → 数据不充分不产候选', cold.sufficient === false && cold.dataMonths === 0 && cold.candidates.length === 0, JSON.stringify(cold));
  check('① renderCold 数据不足文案（继续积累运行记录）',
    renderCold(cold, 30).includes('数据不充分') && renderCold(cold, 30).includes('继续积累运行记录'), renderCold(cold, 30));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② CLI：候选面与排除面 ----
{
  const { root } = mkfix();
  const r = run(root, ['--stale-days', '30']);
  check('② CLI exit 0（含候选正常路径）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('② 冷数据候选头（90→30 天阈值 + 裁决路由文案）',
    r.stdout.includes('冷数据候选（30 天未命中且未更新') && r.stdout.includes('裁决走主智能体/用户'), r.stdout);
  check('② workflow 曾命中转冷者入选（命中月数 1）', /候选\s+workflow\/plans\/2026-08-01-cold-doc\.md\s+末次命中 \d{4}-\d{2}-\d{2}\s+末次更新 \d{4}-\d{2}-\d{2}\s+命中月数 1/.test(r.stdout), r.stdout);
  check('② 零命中记忆负债入选（末次命中 —、命中月数 0）',
    /候选\s+workflow\/intents\/2026-08-02-never-hit\.md\s+末次命中 —/.test(r.stdout) && /never-hit\.md.*命中月数 0/.test(r.stdout), r.stdout);
  check('② wiki 冷数据入选', /候选\s+wiki\/主题\/note-old\.md/.test(r.stdout), r.stdout);
  check('② 热文档不入选（近期命中 + 内容新）', !r.stdout.includes('2026-10-01-hot-doc.md'), r.stdout);
  check('② 近期被命中的旧文档不入选（命中维度救回）', !r.stdout.includes('2026-09-03-recent-hit.md'), r.stdout);
  check('② 终态件不入扫描面（归档走 archive-sweep）', !r.stdout.includes('2026-07-01-terminal-cold.md'), r.stdout);
  check('② 模板/索引/归档草稿排除', !r.stdout.includes('_TEMPLATE') && !r.stdout.includes('INDEX.md') && !r.stdout.includes('drafts-archive'), r.stdout);
  check('② 扫描计数行（活跃 4 + wiki 1 = 5，候选 3）', /（扫描 5 份 workflow\/wiki 文档，候选 3 份）/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ CLI：数据月下限守卫 + 参数错误 ----
{
  const { root } = mkfix();
  const r = run(root, ['--months', '99']);
  check('③ 数据月不足 → exit 0 且不产候选文案', r.status === 0 && /遥测数据月仅 \d+ 个（下限 99）/.test(r.stdout) && r.stdout.includes('数据不充分'), `exit=${r.status} ${r.stdout}`);
  const bad = run(root, ['--unknown']);
  check('③ 未知选项 exit 2', bad.status === 2, `exit=${bad.status}`);
  const bad2 = run(root, ['--stale-days', '0']);
  check('③ 非正整数阈值 exit 2', bad2.status === 2, `exit=${bad2.status}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ 纯函数：候选排序与参数注入（root/rows/now 全参数化，dream-run 复用面） ----
{
  const { root, now } = mkfix();
  const tel = fs.readFileSync(path.join(root, '.agents', 'cache', 'kb-usage.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const cold = collectColdCandidates({ root, rows: tel, minMonths: 1, staleDays: 30, now });
  const docs = cold.candidates.map((c) => c.doc);
  check('④ 候选按路径字典序排序', JSON.stringify(docs) === JSON.stringify([...docs].sort((a, b) => a.localeCompare(b))) && docs.length === 3, JSON.stringify(docs));
  // 阈值收严到 300 天：夹具全部文档（mtime ≤200 天 / 遥测 ≤100 天）都不足 300 天 → 候选清零 + 渲染「无」
  const strict = collectColdCandidates({ root, rows: tel, minMonths: 1, staleDays: 300, now });
  check('④ staleDays 300 → 夹具无足够老的文档，候选 0', strict.candidates.length === 0, JSON.stringify(strict.candidates));
  check('④ renderCold 空候选渲染「无」+ 扫描计数行', renderCold(strict, 300).includes('  无') && renderCold(strict, 300).includes('候选 0 份'), renderCold(strict, 300));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
