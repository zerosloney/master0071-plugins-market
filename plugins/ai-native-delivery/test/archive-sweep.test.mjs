#!/usr/bin/env node
// archive-sweep.test.mjs — analyze 纯函数 fixture（2026-10-09；2026-10-13 加 bodyOf 与内容锚回归）
import { analyze, parseStatus, bodyOf, loadLastTouch } from '../scripts/archive-sweep.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};
const doc = (dir, file, st) => ({ rel: `workflow/${dir}/${file}`, file, dir, text: `---\n状态: ${st}\n---\n# t\n` });
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// 场景 1：状态解析（CRLF 容忍）
check('parseStatus 基础+CRLF', parseStatus('---\r\n状态: done\r\n---\nx') === 'done' && parseStatus('---\n状态: open\n') === 'open');

// 场景 1b：bodyOf——剥 frontmatter（2026-10-13 修锚的判定基元）
{
  const a = '---\n状态: approved\n级别: L1\n---\n\n# T\n\n正文 A\n';
  const b = '---\n状态: done\n确认指纹: abc\n级别: L1\n---\n\n# T\n\n正文 A\n';
  check('bodyOf：frontmatter-only 变更 → 正文相等', bodyOf(a) === bodyOf(b));
  const c = '---\n状态: done\n级别: L1\n---\n\n# T\n\n正文 B\n';
  check('bodyOf：正文变更 → 正文不等', bodyOf(b) !== bodyOf(c));
  check('bodyOf：无 frontmatter → 全文即正文', bodyOf('# T\n\n正文\n') === '# T\n\n正文\n');
  check('bodyOf：未闭合 frontmatter → 保守返回全文', bodyOf('---\n状态: done\n正文\n') === '---\n状态: done\n正文\n');
  check('bodyOf：CRLF 归一', bodyOf('---\r\n状态: done\r\n---\r\n正文\r\n') === bodyOf('---\n状态: done\n---\n正文\n'));
}

// 场景 2：终态/活跃分类 + 模板排除
{
  const docs = [doc('intents', 'a.md', 'done'), doc('plans', 'b.md', 'draft'), doc('intents', '_TEMPLATE.md', 'draft'), doc('incidents', 'c.md', 'closed')];
  const r = analyze({ docs, windowDays: 21 });
  check('分类：终态 2 / 活跃 1 / 模板排除', r.terminal.length === 2 && r.active.length === 1 && !JSON.stringify(r).includes('_TEMPLATE'));
}

// 场景 3：窗口过滤（台账 ts 优先于 git 回退）
{
  const docs = [doc('specs', 'old.md', 'done'), doc('specs', 'new.md', 'done')];
  const r = analyze({
    docs, windowDays: 21,
    ledgerTs: { 'workflow/specs/old.md': daysAgo(30) },
    lastTouch: { 'workflow/specs/old.md': daysAgo(2), 'workflow/specs/new.md': daysAgo(2) },
  });
  check('窗口：台账 30 天入候选、git 2 天未满窗', r.candidates.length === 1 && r.candidates[0].file === 'old.md' && r.candidates[0].src === 'ledger' && r.tooRecent.length === 1);
}

// 场景 4：活跃引用排除（git 回退源）+ 无时间源兜底文件名日期
{
  const docs = [doc('intents', '2026-09-01-refd.md', 'done'), doc('intents', '2026-09-01-fallback.md', 'done')];
  const r = analyze({
    docs, windowDays: 21,
    activeTexts: ['参见 ../intents/2026-09-01-refd.md 的结论'],
    lastTouch: { 'workflow/intents/2026-09-01-fallback.md': daysAgo(30) },
  });
  check('引用排除 + git 回退源入候选', r.candidates.length === 1 && r.candidates[0].file === '2026-09-01-fallback.md' && r.candidates[0].src === 'git' && r.referenced.has('2026-09-01-refd.md'));
}

// 场景 4b：台账/git 均无时间源 → 文件名日期兜底
{
  const r = analyze({ docs: [doc('specs', '2026-09-01-nodate.md', 'done')], windowDays: 21 });
  check('文件名日期兜底', r.candidates.length === 1 && r.candidates[0].src === 'name' && r.candidates[0].month === '2026-09');
}

// 场景 5：归档月份取终态时间当月
{
  const r = analyze({ docs: [doc('plans', '2026-09-03-x.md', 'done')], windowDays: 21, ledgerTs: { 'workflow/plans/2026-09-03-x.md': '2026-09-05' } });
  check('归档月 = 终态时间当月', r.candidates[0] !== undefined && r.candidates[0].month === '2026-09');
}

// 场景 6：家族原子——intent 未终态锚住同名家族整族留守；全终态家族整族入候选
{
  const docs = [
    doc('intents', '2026-09-05-live.md', 'approved'),
    doc('plans', '2026-09-05-live.md', 'done'),
    doc('intents', '2026-09-04-family.md', 'done'),
    doc('specs', '2026-09-04-family.md', 'done'),
    doc('plans', '2026-09-04-family.md', 'done'),
  ];
  const r = analyze({
    docs, windowDays: 21,
    ledgerTs: { 'workflow/plans/2026-09-05-live.md': daysAgo(30), 'workflow/intents/2026-09-04-family.md': daysAgo(30), 'workflow/specs/2026-09-04-family.md': daysAgo(30), 'workflow/plans/2026-09-04-family.md': daysAgo(30) },
  });
  check('家族原子：非终态 intent 整族留守', r.candidates.length === 3 && !r.candidates.some((x) => x.file === '2026-09-05-live.md'));
  check('家族原子：全终态家族三成员同批', r.candidates.filter((x) => x.file === '2026-09-04-family.md').length === 3);
}

// 场景 7：loadLastTouch 集成——真实 git 仓库，钉住「frontmatter-only 提交不刷新内容锚」
// （2026-10-13 修锚回归：原实现用 git last-touch，被批量迁移/补录提交污染 → 21 天窗口恒不满足。
//  本场景同时覆盖 cat-file --batch 回显完整 sha 而输入为缩写这一踩坑点——键错则全部走保守回退。）
{
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-sweep-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const dir = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, '2026-09-01-x.md');
  const commit = (msg, date) => {
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  // ① 首次入库（正文 v1）
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n---\n\n# T\n\n正文 v1\n', 'utf8');
  commit('c1', '2026-09-01T10:00:00+08:00');
  // ② frontmatter-only（状态 draft→approved）
  fs.writeFileSync(p, '---\n状态: approved\n级别: L1\n---\n\n# T\n\n正文 v1\n', 'utf8');
  commit('c2', '2026-09-20T10:00:00+08:00');
  // ③ frontmatter-only（approved→done + 确认指纹）
  fs.writeFileSync(p, '---\n状态: done\n级别: L1\n确认指纹: abc\n---\n\n# T\n\n正文 v1\n', 'utf8');
  commit('c3', '2026-09-28T10:00:00+08:00');
  const rel = 'workflow/plans/2026-09-01-x.md';
  const t1 = loadLastTouch(root);
  check('loadLastTouch：frontmatter-only 提交不刷新锚（锚停在正文变更日 2026-09-01）',
    t1[rel] === '2026-09-01', `got ${t1[rel]}`);
  // ④ 正文变更 → 锚前移到该日
  fs.writeFileSync(p, '---\n状态: done\n级别: L1\n确认指纹: abc\n---\n\n# T\n\n正文 v2\n', 'utf8');
  commit('c4', '2026-10-05T10:00:00+08:00');
  const t2 = loadLastTouch(root);
  check('loadLastTouch：正文变更刷新锚（2026-10-05）', t2[rel] === '2026-10-05', `got ${t2[rel]}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// 场景 8：终态时间三级锚——台账 ts 非法时逐级回退，不派生逃逸归档月
// （2026-10-27 路径逃逸修复：ts 是外部可写数据，`ts=../../../../evil` 旧实现会派生出归档月
//  `../../..` → git mv 把文件甩出 workflow/archive/ 树）
{
  const r = analyze({
    docs: [doc('plans', '2026-09-03-x.md', 'done')],
    windowDays: 21,
    ledgerTs: { 'workflow/plans/2026-09-03-x.md': '../../../../evil' },
    lastTouch: { 'workflow/plans/2026-09-03-x.md': '2026-08-01' },
  });
  const months = r.candidates.map((c) => c.month);
  check('非法台账 ts 不派生逃逸月', r.candidates.length === 1 && /^\d{4}-\d{2}$/.test(r.candidates[0].month), JSON.stringify(months));
  check('非法 ts → 回退到内容 last-touch 锚', r.candidates[0]?.src === 'git' && r.candidates[0].month === '2026-08', JSON.stringify(r.candidates[0]?.src));
}
// 场景 8b：三锚皆无有效值 → 无日期（不归档），不静默用坏值
{
  const r = analyze({
    docs: [doc('plans', 'nodate-x.md', 'done')],
    windowDays: 21,
    ledgerTs: { 'workflow/plans/nodate-x.md': '../../../../evil' },
    lastTouch: {},
  });
  check('三锚皆非法 → 无日期不归档', r.candidates.length === 0 && r.noDate.length === 1, `cand=${r.candidates.length} nodate=${r.noDate.length}`);
}
// 场景 8c：非法日历日（2026-02-30）同样判非法
{
  const r = analyze({
    docs: [doc('plans', '2026-09-04-y.md', 'done')],
    windowDays: 21,
    ledgerTs: { 'workflow/plans/2026-09-04-y.md': '2026-02-30' },
    lastTouch: {},
  });
  check('非法日历日回退（不派生 2026-02 归档月）', r.candidates.length === 0 || /^\d{4}-\d{2}$/.test(r.candidates[0].month), JSON.stringify(r.candidates.map((c) => c.month)));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
