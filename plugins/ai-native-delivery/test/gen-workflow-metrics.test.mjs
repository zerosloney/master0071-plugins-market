#!/usr/bin/env node
// gen-workflow-metrics.mjs 的 fixture 驱动测试
// 现场构造临时语料（换 cwd 运行被测脚本，脚本按相对路径读 workflow/ 与 .agents/config/rule-budgets.txt）。
// 断言：①主路径——类型聚合/活跃终态/模块已填/常驻面峰值/INDEX 活跃行；②同月重跑 upsert 不重复、跨月按月升序；
//       ③失败路径——非法 --month / 未知参数 exit 1。
// 用法：node .agents/scripts/gen-workflow-metrics.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(SCRIPT_DIR, '..', 'scripts', 'gen-workflow-metrics.mjs'); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/
const USAGE = '用法：node .agents/scripts/gen-workflow-metrics.test.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const doc = (fm, title) => `---\n${fm}\n---\n# ${title}\n`;

const mkfix = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-workflow-metrics-test-'));
  for (const d of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const w = path.join(root, 'workflow');
  fs.writeFileSync(path.join(w, 'intents', '2026-09-21-a.md'), doc('状态: approved\n级别: L1\n日期: 2026-09-21\n模块: pipeline', 'INTENT — 甲'), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-21-a.md'), doc('状态: approved\n级别: L1\n模块: pipeline', 'PLAN — 甲'), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-19-b.md'), doc('状态: done\n级别: L1\n模块: material', 'PLAN — 乙'), 'utf8');
  fs.writeFileSync(path.join(w, 'incidents', '2026-09-18-c.md'), doc('状态: closed\n级别: L2\n发现: 2026-09-18', 'INCIDENT — 丙'), 'utf8');
  fs.writeFileSync(path.join(w, 'intents', '_TEMPLATE.md'), doc('状态: draft\n级别: L1', 'INTENT — 模板'), 'utf8');
  fs.writeFileSync(path.join(w, 'INDEX.md'), '# index fixture\n\n## 活跃（2）\n\n| 类型 |\n|---|\n', 'utf8');
  // 预算表：AGENTS.md 120B / 上限 100 → 峰值 120%；commands 单篇与合计都远低于上限
  fs.writeFileSync(path.join(root, '.agents', 'config', 'rule-budgets.txt'), [
    '# fixture 预算表',
    'AGENTS.md 100',
    '.agents/commands/*.md 50',
    '.agents/commands/ 100',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(120), 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'commands', 'plan.md'), 'y'.repeat(10), 'utf8');
  return root;
};

const run = (root, args) => spawnSync(process.execPath, [GEN, ...args], { cwd: root, encoding: 'utf8' });
const readMetrics = (root) => fs.readFileSync(path.join(root, 'workflow', 'metrics.md'), 'utf8');

// ---- 场景 1：主路径——一行算对 ----
{
  const root = mkfix();
  const r = run(root, ['--month', '2026-09']);
  const md = fs.existsSync(path.join(root, 'workflow', 'metrics.md')) ? readMetrics(root) : '';
  check('场景 1：生成 exit 0 且落盘 workflow/metrics.md', r.status === 0 && md.length > 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 1：行含 4（活跃 2 / 终态 2）+ 模块 3/4', /\| 2026-09 \| 4（活跃 2 \/ 终态 2） \| .* \| 3\/4 \|/.test(md), md);
  check('场景 1：常驻面峰值取最紧项（120.0% AGENTS.md）', /峰值 120\.0% AGENTS\.md/.test(md), md);
  check('场景 1：常驻面合计 = AGENTS.md + commands 逐文件（130B → 0.1 KB）', /0\.1 KB（峰值/.test(md), md);
  check('场景 1：INDEX 活跃行解析（2 行）', /（2 行） \|/.test(md), md);
  check('场景 1：_TEMPLATE.md 不计入（4 篇而非 5 篇）', !/\| 5（/.test(md), md);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：同月重跑 upsert 不重复；跨月按月升序 ----
{
  const root = mkfix();
  run(root, ['--month', '2026-09']);
  run(root, ['--month', '2026-09']);
  let md = readMetrics(root);
  const funnelMark = '## 闭环漏斗';
  const attrMark = '## 产品与质量维度';
  const bodyPart = md.slice(0, md.includes(funnelMark) ? md.indexOf(funnelMark) : undefined);
  const n09 = (bodyPart.match(/^\| 2026-09 \|/gm) || []).length;
  // 漏斗段止于第三表表头（2026-10-11 incident-attribution 新增第三表；否则会把归因行误计入漏斗计数）
  const funnelPart = md.includes(funnelMark)
    ? md.slice(md.indexOf(funnelMark), md.includes(attrMark) ? md.indexOf(attrMark) : undefined)
    : '';
  const n09f = (funnelPart.match(/^\| 2026-09 \|/gm) || []).length;
  check('场景 2：同月重跑只保留一行（体量表分段计数）', n09 === 1, `${n09} 行\n${md}`);
  check('场景 2：漏斗表同月 upsert 不重复', n09f === 1, `${n09f} 行\n${md}`);
  run(root, ['--month', '2026-08']);
  md = readMetrics(root);
  const i08 = md.indexOf('| 2026-08 |');
  const i09 = md.indexOf('| 2026-09 |');
  check('场景 2：跨月两行且按月升序', i08 > -1 && i09 > -1 && i08 < i09, md);
  check('场景 2：HEADER 手工说明保留（生成区外内容不丢）', md.includes('# workflow 规模与规则面月度快照'), md);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：失败路径 + --dry-run 不写盘 ----
{
  const root = mkfix();
  const bad = run(root, ['--month', '2026-9']);
  check('场景 3：非法 --month exit 1', bad.status === 1 && /须为 YYYY-MM/.test(bad.stderr), `exit=${bad.status}\n${bad.stderr}`);
  const unk = run(root, ['--bogus']);
  check('场景 3：未知参数 exit 1', unk.status === 1 && /未知参数/.test(unk.stderr), `exit=${unk.status}\n${unk.stderr}`);
  const dry = run(root, ['--dry-run']);
  check('场景 3：--dry-run 不写盘且打印将写入行', dry.status === 0 && /将写入行/.test(dry.stdout) && !fs.existsSync(path.join(root, 'workflow', 'metrics.md')), dry.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：预算表 glob 词表收口——单 * 前缀+后缀匹配；多 * / 目录段 * 警告跳过（2026-09-24）----
{
  const root = mkfix();
  fs.writeFileSync(path.join(root, '.agents', 'commands', 'zeta.md'), 'z'.repeat(500), 'utf8'); // 非 pl 前缀：不得被 pl*.md 吃进
  fs.writeFileSync(path.join(root, '.agents', 'config', 'rule-budgets.txt'), [
    '# fixture 预算表（glob 词表收口）',
    'AGENTS.md 100',
    '.agents/commands/pl*.md 9999',
    '.agents/commands/**.md 9999',
    '.agents/*/cmd.md 9999',
    '',
  ].join('\n'), 'utf8');
  const r = run(root, ['--month', '2026-09']);
  const md = fs.existsSync(path.join(root, 'workflow', 'metrics.md')) ? readMetrics(root) : '';
  check('场景 4：exit 0（词表外条目跳过不阻断）', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 4：单 * 按前缀+后缀匹配（pl*.md 只吃 plan.md 10B，zeta.md 500B 不计入）', /\.agents\/commands\/pl\*\.md（单篇最大）\s+10\s+\/\s+9999/.test(r.stdout), r.stdout);
  check('场景 4：常驻面合计随之正确（120+10=130B → 0.1 KB）', /0\.1 KB（峰值/.test(md) && /常驻面合计：0\.1 KB/.test(r.stdout), `${md}\n${r.stdout}`);
  check('场景 4：多 * 与目录段 * 各警告跳过', (r.stderr || '').includes('**.md') && (r.stderr || '').includes('.agents/*/cmd.md'), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 闭环漏斗（2026-10-02 ledger-funnel-metrics；口径定义式 = specs/2026-10-02-ledger-funnel-metrics.md）----
const LROW = (o = {}) => JSON.stringify({
  ts: '2026-10-02T00:00:00.000Z', doc: 'workflow/intents/demo.md', stage: 'approved',
  fingerprint: 'b'.repeat(64), prev: 'draft', source: 'chat-delegated', quote: '确认', ...o,
});
// mkfixLedger：在 mkfix 基础上写台账（LROW 已是 JSON 字符串，直接 join——勿再 stringify 双重编码）
const mkfixLedger = (lines) => {
  const root = mkfix();
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), lines.join('\n') + '\n', 'utf8');
  return root;
};
{
  // L1：一次通过（approved→done 同月）→ 收口 1 / 完整链 1 / 一次通过 1 / 周期 1.0 天
  const root = mkfixLedger([
    LROW({ ts: '2026-10-01T00:00:00.000Z' }),
    LROW({ ts: '2026-10-02T00:00:00.000Z', stage: 'done', prev: 'approved' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L1 确认链一次通过、无 git 时间则中位为 —：| 2026-10 | 1 | 1 | 0（0%） | 1 | 0 | — | 2 |',
    r.status === 0 && /\| 2026-10 \| 1 \| 1 \| 0（0%） \| 1 \| 0 \| — \| 2 \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L2：revert 行（回退后重走）→ 返工件
  const root = mkfixLedger([
    LROW({ ts: '2026-10-01T00:00:00.000Z', stage: 'revert-draft', fingerprint: 'n/a', prev: 'approved' }),
    LROW({ ts: '2026-10-02T00:00:00.000Z' }),
    LROW({ ts: '2026-10-03T00:00:00.000Z', stage: 'done', prev: 'approved' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L2 revert 行 → 返工件 1（无 git 时间则中位 —）',
    r.status === 0 && /\| 2026-10 \| 1 \| 1 \| 0（0%） \| 0 \| 1 \| — \| 3 \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L3：重确认（两次 approved）→ 返工件
  // （两次指纹不同——台账统一视图按 doc|stage|fingerprint 去重取末次，同键行折叠为一次确认，
  //   故 fixture 以「重确认前内容有修订」建模真实返工形态；预期行不受影响：仍 3 行 / 2.0 天 / 返工 1）
  const root = mkfixLedger([
    LROW({ ts: '2026-10-01T00:00:00.000Z' }),
    LROW({ ts: '2026-10-02T00:00:00.000Z', fingerprint: 'c'.repeat(64), quote: '重确认' }),
    LROW({ ts: '2026-10-03T00:00:00.000Z', stage: 'done', prev: 'approved' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L3 两次 approved → 返工件 1（无 git 时间则中位 —）',
    r.status === 0 && /\| 2026-10 \| 1 \| 1 \| 0（0%） \| 0 \| 1 \| — \| 3 \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L4：协议前（首行即终态，无 approved）→ 协议前 1（不计一次通过分母）
  const root = mkfixLedger([
    LROW({ ts: '2026-10-02T00:00:00.000Z', stage: 'done', prev: 'approved' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L4 协议前 → | 1 | 0 | 1（100%） ⚠️ | 0 | 0 |，无 git 时间不写 0.0',
    r.status === 0 && /\| 2026-10 \| 1 \| 0 \| 1（100%） ⚠️ \| 0 \| 0 \| — \| 1 \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L5：incident 两跳（fixed→closed = incident 确认链，复核 P2-3 收口）→ 完整链一次通过
  const root = mkfixLedger([
    LROW({ ts: '2026-10-01T00:00:00.000Z', doc: 'workflow/incidents/inc.md', stage: 'fixed' }),
    LROW({ ts: '2026-10-02T00:00:00.000Z', doc: 'workflow/incidents/inc.md', stage: 'closed', prev: 'fixed' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L5 incident 两跳确认链 → 完整链 1 / 确认链一次通过 1 / 无 git 时间中位 —',
    r.status === 0 && /\| 2026-10 \| 1 \| 1 \| 0（0%） \| 1 \| 0 \| — \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L7：incident 单行 closed（存量补关，无确认链）→ 协议前
  const root = mkfixLedger([
    LROW({ ts: '2026-10-02T00:00:00.000Z', doc: 'workflow/incidents/old.md', stage: 'closed', prev: 'fixed' }),
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L7 incident 单行 closed → 协议前 1（100% ⚠️）',
    r.status === 0 && /\| 2026-10 \| 1 \| 0 \| 1（100%） ⚠️ \| 0 \| 0 \|/.test(md), `${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // L6：跨月收口（9 月 approved、10 月 done）→ 归桶 10 月；9 月只计台账行
  const root = mkfixLedger([
    LROW({ ts: '2026-09-30T00:00:00.000Z' }),
    LROW({ ts: '2026-10-02T00:00:00.000Z', stage: 'done', prev: 'approved' }),
  ]);
  const rSep = run(root, ['--month', '2026-09']);
  const rOct = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('漏斗 L6 跨月收口归桶 10 月（9 月零收口 + 台账行 1）',
    rSep.status === 0 && rOct.status === 0 && /\| 2026-09 \| 0 \| 0 \| 0 \| 0 \| 0 \| — \| 1 \|/.test(md)
    && /\| 2026-10 \| 1 \| 1 \| 0（0%） \| 1 \| 0 \| — \| 1 \|/.test(md), `${rSep.stdout}${rOct.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5：归因空键用 attribution-legacy 补齐；frontmatter 非空不被覆盖；「不明」仍未判读 ----
{
  const root = mkfix();
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-09-18-c.md'), doc('状态: closed\n级别: L2\n发现: 2026-09-18', 'INCIDENT — 丙'), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-09-19-d.md'), doc('状态: closed\n级别: L1\n发现: 2026-09-19\n来源: self\n影响环境: dev', 'INCIDENT — 丁'), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-09-20-e.md'), doc('状态: open\n级别: L1\n发现: 2026-09-20', 'INCIDENT — 戊'), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-09-21-f.md'), doc('状态: open\n级别: L1\n发现: 2026-09-21\n来源: self\n影响环境: prod', 'INCIDENT — 己'), 'utf8');
  fs.mkdirSync(path.join(root, 'workflow', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'archive', 'attribution-legacy.md'), [
    '# legacy fixture',
    '',
    '| incident | 来源 | 影响环境 | 判据 |',
    '|---|---|---|---|',
    '| 2026-09-18-c | user | prod | 现场 |',
    '| 2026-09-19-d | user | prod | 不得覆盖 frontmatter |',
    '| 2026-09-20-e | 不明 | staging | 发现者未署名 |',
    '| 2026-09-18-c | self | dev | 重复行应被忽略 |',
    '',
  ].join('\n'), 'utf8');
  const r = run(root, ['--month', '2026-09']);
  const md = fs.existsSync(path.join(root, 'workflow', 'metrics.md')) ? readMetrics(root) : '';
  check('场景 5：exit 0 且重复行只警告、保留首行', r.status === 0 && (r.stderr || '').includes('重复行'), `exit=${r.status}\n${r.stderr}`);
  check('场景 5：空键补成 user/prod，frontmatter self/dev 保留，不明仍未判读且环境入账',
    /\| 2026-09 \| 4 \| self 2 \/ user 1 \/ test 0 \/ monitor 0 \| dev 1 \/ staging 1 \/ prod 2 \/ none 0 \| 25%（1\/4） \| 1 \|/.test(md),
    md);
  check('场景 5：逃逸率只计非 self 来源 ∩ prod（legacy user/prod 计入，self/prod 不计入）',
    md.includes('25%（1/4）'), md);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6：非当月已有体量行默认冻结；--restamp 才覆盖。当月仍更新 ----
{
  const root = mkfix();
  const first = run(root, ['--month', '2026-09']);
  const before = readMetrics(root);
  const volume = (before.match(/^\| 2026-09 \|.*$/m) || [])[0];
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-09-20-extra.md'), doc('状态: done\n级别: L1\n模块: material', 'PLAN — 追加'), 'utf8');
  const second = run(root, ['--month', '2026-09']);
  const frozen = readMetrics(root);
  check('场景 6：重跑历史月 exit 0 且声明体量行冻结', first.status === 0 && second.status === 0 && /体量行冻结/.test(second.stdout), second.stdout);
  check('场景 6：体量行字节级保留', frozen.includes(volume), `before=${volume}\n${frozen}`);
  const stamped = run(root, ['--month', '2026-09', '--restamp']);
  const after = readMetrics(root);
  const volume2 = (after.match(/^\| 2026-09 \|.*$/m) || [])[0];
  check('场景 6：--restamp 覆盖体量行（篇数变了）', stamped.status === 0 && volume2 && volume2 !== volume, `${volume}\n${volume2}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7：中位周期 = git 首次加入 → 终态确认。夹具提交日 10-01，终态 10-03 → 2.0 天 ----
{
  const root = mkfixLedger([
    LROW({ ts: '2026-10-03T00:00:00.000Z', doc: 'workflow/intents/demo.md', stage: 'done', prev: 'approved' }),
  ]);
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'demo.md'), doc('状态: done\n级别: L1\n日期: 2026-10-01', 'INTENT — demo'), 'utf8');
  const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv });
  git(['init']);
  git(['config', 'user.email', 'metrics-test@example.com']);
  git(['config', 'user.name', 'metrics-test']);
  git(['add', 'workflow/intents/demo.md']);
  const committed = git(['commit', '-m', 'add demo']);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('场景 7：git commit 成功且中位周期 2.0 天',
    committed.status === 0 && r.status === 0 && /\| 2026-10 \| 1 \| 0 \| 1（100%） ⚠️ \| 0 \| 0 \| 2\.0 \|/.test(md),
    `commit=${committed.status} ${committed.stderr}\n${r.stdout}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7b：中位周期「真实极小值」不得印成 0.0（2026-10-16 median-display）----
// 本仓建件与确认常在同会话内完成 → 真实周期可 < 0.05 天。toFixed(1) 会把它印成 `0.0`，
// 与表头声明「取不到写 —，不写 0.0」冲突，读者无法区分「真实的亚小时周期」与「口径失效」。
// 断言：0.5 小时（≈0.021 天）必须渲染为 `<0.1`，且不得出现 `0.0` 中位格。
{
  const root = mkfixLedger([
    LROW({ ts: '2026-10-01T00:30:00.000Z', doc: 'workflow/intents/demo.md', stage: 'done', prev: 'approved' }),
  ]);
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', 'demo.md'), doc('状态: done\n级别: L1\n日期: 2026-10-01', 'INTENT — demo'), 'utf8');
  const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv });
  git(['init']);
  git(['config', 'user.email', 'metrics-test@example.com']);
  git(['config', 'user.name', 'metrics-test']);
  git(['add', 'workflow/intents/demo.md']);
  const committed = git(['commit', '-m', 'add demo']);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  // 单条 done（无前置 approved）→ 协议前 1（100% ⚠️），完整链 0；中位格 = <0.1
  check('场景 7b：亚 0.1 天真实周期渲染为 <0.1（不印 0.0）',
    committed.status === 0 && r.status === 0 && /\| 2026-10 \| 1 \| 0 \| 1（100%） ⚠️ \| 0 \| 0 \| <0\.1 \| 1 \|/.test(md),
    `commit=${committed.status} ${committed.stderr}\n${r.stdout}${md}`);
  check('场景 7b：stdout 同步（<0.1 天），未把极小值说成 0.0 天',
    r.status === 0 && /中位周期 <0\.1 天/.test(r.stdout) && !/中位周期 0\.0 天/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8：门禁成本表（2026-10-14 G8）——all-gates 绿行 durations 按月聚合；无埋点旧行跳过；同月 upsert ----
{
  const root = mkfix();
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  const vrows = [
    { ts: '2026-09-05T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 16, totalMs: 90000, durations: { 'engine-tests': 80000, 'backend-build': 10000 } },
    { ts: '2026-09-20T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 16, totalMs: 125000, durations: { 'engine-tests': 100000, 'backend-build': 20000, 'frontend-build': 5000 } },
    { ts: '2026-09-25T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 16 }, // 埋点前旧行：无 durations → 跳过
    { ts: '2026-09-26T00:00:00.000Z', exitCode: 1, suite: 'backend-test', note: 'exit 1' }, // 失败行 → 跳过
  ];
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'), vrows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const r = run(root, ['--month', '2026-09']);
  const md = readMetrics(root);
  check('场景 8：生成 exit 0 且门禁成本行聚合正确（2 行 · 107.5s · 最慢三门降序）',
    r.status === 0 && /\| 2026-09 \| 2 \| 107\.5 \| engine-tests 90\.0s · backend-build 15\.0s · frontend-build 5\.0s \|/.test(md),
    `exit=${r.status}\n${r.stdout}${md}`);
  run(root, ['--month', '2026-09']);
  const md2 = readMetrics(root);
  check('场景 8：同月重跑 upsert 不重复（成本行仍 1 行）',
    (md2.match(/^\| 2026-09 \| 2 \| 107\.5 \|/gm) || []).length === 1, md2);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8b：墙钟优先（2026-10-16 verify-parallel）——绿行带 wallMs 时「平均总耗时」取墙钟，
//      无该键的旧行回退各门之和（totalMs）；两者混月时逐行各取各的，不伪造。 ----
{
  const root = mkfix();
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  const vrows = [
    // 旧口径行：无 wallMs → 取 totalMs 200s
    { ts: '2026-09-05T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 18, totalMs: 200000, durations: { 'engine-tests': 200000 } },
    // 并行口径行：wallMs 60s（各门之和 200s 已非等待成本）→ 取 60s
    { ts: '2026-09-06T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 18, totalMs: 200000, wallMs: 60000, durations: { 'engine-tests': 200000 } },
  ];
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'), vrows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const r = run(root, ['--month', '2026-09']);
  const md = readMetrics(root);
  check('场景 8b：wallMs 优先、旧行回退 totalMs（(200+60)/2 = 130.0s）',
    r.status === 0 && /\| 2026-09 \| 2 \| 130\.0 \|/.test(md),
    `exit=${r.status}\n${r.stdout}${md}`);
  check('场景 8b：成本表附口径注（墙钟优先）',
    md.includes('平均总耗时口径：墙钟'), md);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 8c：子目录运行绿行/常驻面不丢（2026-11 市场审查 M13 回归）----
// scanGateCosts 的 verifications.jsonl 与 scanSurface 的预算条目（AGENTS.md / .agents/commands/）
// 此前按 cwd 解析——子目录运行时绿行全丢（成本表归零）、常驻面条目全部「不存在」被跳过（空表）。
// 修复后锚 ROOT（projectRoot 单源 → git root）：夹具 git init，从深层子目录跑，两表须与根目录运行一致。
{
  const root = mkfix();
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'),
    JSON.stringify({ ts: '2026-09-05T00:00:00.000Z', exitCode: 0, suite: 'all-gates', gates: 16, totalMs: 90000, durations: { 'engine-tests': 80000, 'backend-build': 10000 } }) + '\n', 'utf8');
  const sub = path.join(root, 'sub', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const r = run(sub, ['--month', '2026-09']); // cwd = 子目录，ROOT 锚 git root
  const md = readMetrics(root);
  check('场景 8c：子目录运行 → all-gates 绿行仍聚合（1 行 · 90.0s，不归零）',
    r.status === 0 && /\| 2026-09 \| 1 \| 90\.0 \| engine-tests 80\.0s · backend-build 10\.0s \|/.test(md),
    `exit=${r.status}\n${r.stdout}${r.stderr}${md}`);
  check('场景 8c：子目录运行 → 常驻面不缩水（AGENTS.md 120B 峰值 120.0% 在表）',
    r.status === 0 && /峰值 120\.0% AGENTS\.md/.test(md), md);
  check('场景 8c：子目录运行 → 预算目录/glob 条目不丢（commands 合计计入 0.1 KB）',
    r.status === 0 && /0\.1 KB（峰值/.test(md) && !/预算目录不存在/.test(r.stderr), `${r.stderr}${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景组「复核效果台账」（2026-10-16）：workflow/reviews.d/ 意见级处置分片 → 第五表 ----
// mkfixReviews：在 mkfix 基础上写复核效果台账分片（shards: { 分片文件名: [数据行...] }，含表头）
const mkfixReviews = (shards) => {
  const root = mkfix();
  fs.mkdirSync(path.join(root, 'workflow', 'reviews.d'), { recursive: true });
  for (const [name, rows] of Object.entries(shards)) {
    fs.writeFileSync(path.join(root, 'workflow', 'reviews.d', name), [
      `# 独立复核效果台账 — ${name.replace(/\.md$/, '')}`,
      '',
      '| 日期 | 对象 | 复核员(宿主) | 意见数 | 采纳 | 拒绝 | 误报 | 备注 |',
      '|------|------|--------------|--------|------|------|------|------|',
      ...rows,
      '',
    ].join('\n'), 'utf8');
  }
  return root;
};
{
  // R1：同月两行聚合 + 跨月分片各一行、按月升序（率列 = 采纳/误报 ÷ 意见数，toFixed(0)%）
  const root = mkfixReviews({
    '2026-10.md': [
      '| 2026-10-14 | workflow/specs/2026-10-14-x.md | independent-reviewer(zcode) | 5 | 3 | 1 | 1 | P1 修 1；P2 采纳 3 拒 1 误 1 |',
      '| 2026-10-16 | diff 318922a9..7c8d9eb7 | independent-reviewer(新会话) | 4 | 2 | 2 | 0 | P2×4 全采纳 |',
    ],
    '2026-09.md': [
      '| 2026-09-30 | workflow/plans/2026-09-30-y.md | independent-reviewer(zcode) | 2 | 1 | 0 | 1 | 误报=指向已被覆盖的代码 |',
    ],
  });
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('复核 R1：同月两行聚合（事件 2 / 意见 9 / 采纳 5 / 拒绝 3 / 误报 1 / 采纳率 56% / 误报率 11%）',
    r.status === 0 && /\| 2026-10 \| 2 \| 9 \| 5 \| 3 \| 1 \| 56% \| 11% \|/.test(md), `exit=${r.status}\n${r.stdout}${r.stderr}\n${md}`);
  check('复核 R1：跨月分片各一行且按月升序（9 月 1/2/1/0/0 → 50%/50% 紧邻 10 月行）',
    /## 复核效果[\s\S]*?\| 2026-09 \| 1 \| 2 \| 1 \| 0 \| 1 \| 50% \| 50% \|\n\| 2026-10 \|/.test(md), md);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // R2：自洽破坏（采纳+拒绝+误报 ≠ 意见数）→ fail-loud（exit 1，报文点名分片与不变式）
  const root = mkfixReviews({
    '2026-10.md': [
      '| 2026-10-14 | workflow/specs/2026-10-14-x.md | independent-reviewer(zcode) | 5 | 2 | 1 | 1 | 2+1+1=4 ≠ 5，应被拦 |',
    ],
  });
  const r = run(root, ['--month', '2026-10']);
  check('复核 R2：自洽破坏（5 ≠ 2+1+1）→ exit 1 且报文含「自洽破坏」并点名分片 2026-10.md',
    r.status === 1 && /自洽破坏/.test(r.stderr) && /2026-10\.md/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // R3：目录不存在 / 分片存在但空表 → 合法零数据，占位行不崩
  const rootNone = mkfix(); // 不建 reviews.d
  const rNone = run(rootNone, ['--month', '2026-10']);
  const mdNone = readMetrics(rootNone);
  check('复核 R3：目录不存在 → exit 0 且出「（无记录）」占位行',
    rNone.status === 0 && /\| （无记录） \| 0 \| 0 \| 0 \| 0 \| — \| — \|/.test(mdNone), `exit=${rNone.status}\n${rNone.stderr}\n${mdNone}`);
  fs.rmSync(rootNone, { recursive: true, force: true });
  const rootEmpty = mkfixReviews({ '2026-10.md': [] }); // 分片存在、表为空
  const rEmpty = run(rootEmpty, ['--month', '2026-10']);
  const mdEmpty = readMetrics(rootEmpty);
  check('复核 R3b：分片空表 → exit 0 且出「（无记录）」占位行',
    rEmpty.status === 0 && /\| （无记录） \| 0 \| 0 \| 0 \| 0 \| — \| — \|/.test(mdEmpty), `exit=${rEmpty.status}\n${rEmpty.stderr}\n${mdEmpty}`);
  fs.rmSync(rootEmpty, { recursive: true, force: true });
}

// ---- 场景组「发布观察台账」（2026-10-25 优化5）：workflow/deploy-observations.d/ → 第七表 ----
// mkfixDeploys：在 mkfix 基础上写发布观察台账（主表说明+表头 + 当月分片数据行，生而分片口径）
const mkfixDeploys = (rows) => {
  const root = mkfix();
  fs.writeFileSync(path.join(root, 'workflow', 'deploy-observations.md'),
    '# 发布观察台账（夹具）\n\n## 发布观察结果\n| 日期 | release | 结果 | 关联 incident | 备注 |\n|------|---------|------|---------------|------|\n', 'utf8');
  fs.mkdirSync(path.join(root, 'workflow', 'deploy-observations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'deploy-observations.d', '2026-10.md'), [
    '| 日期 | release | 结果 | 关联 incident | 备注 |',
    '|------|---------|------|---------------|------|',
    ...rows,
    '',
  ].join('\n'), 'utf8');
  return root;
};
{
  // D1：两行聚合（通过 1 / 异常 1）
  const root = mkfixDeploys([
    '| 2026-10-20 | release/2026-10-20 | 通过 | — | 用户确认 |',
    '| 2026-10-24 | release/2026-10-24 | 异常 | 2026-10-24-inc.md | 超阈值回落 |',
  ]);
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('发布观察 D1：当月聚合（release 2 / 通过 1 / 异常 1）',
    r.status === 0 && /## 发布观察[\s\S]*?\| 2026-10 \| 2 \| 1 \| 1 \|/.test(md), `exit=${r.status}\n${r.stderr}\n${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // D2：台账全缺 → 合法零数据，占位行不崩
  const root = mkfix();
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('发布观察 D2：台账全缺 → exit 0 且出「（无记录）」占位行',
    r.status === 0 && /## 发布观察[\s\S]*?\| （无记录） \| 0 \| 0 \| 0 \|/.test(md), `exit=${r.status}\n${r.stderr}\n${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // D3：结果列枚举外 → fail-loud（exit 1，报文点名脏行）
  const root = mkfixDeploys(['| 2026-10-20 | release/2026-10-20 | 观察中 | — | 非终态 |']);
  const r = run(root, ['--month', '2026-10']);
  check('发布观察 D3：结果枚举外脏行 → exit 1 且报文含「脏行」',
    r.status === 1 && /脏行/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景组「spec 体积观察」（2026-10-16 spec 生命周期）：活跃 specs + 归档 specs 分开统计 ----
// mkSpec：生成恰好 lines 行（尾换行对齐 wc -l）、其中 checks 行为 checkbox 的 spec 文本
const mkSpec = (lines, checks) => {
  const rows = [`# spec 夹具 ${lines}行${checks}验收`];
  for (let i = 0; i < checks; i++) rows.push(`- [${i % 2 ? 'x' : ' '}] 验收 ${i + 1}`);
  while (rows.length < lines) rows.push('填充');
  return rows.join('\n') + '\n';
};
{
  // S1：活跃 2 份（10 行/3 验收、12 行/5 验收 → 偶数中位取均值）+ 归档 3 份跨单月目录（6/8/10 行 → 奇数中位取中）
  const root = mkfix();
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-10-01-a1.md'), mkSpec(10, 3), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-10-02-a2.md'), mkSpec(12, 5), 'utf8');
  fs.mkdirSync(path.join(root, 'workflow', 'archive', '2026-09', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'archive', '2026-09', 'specs', '2026-09-01-b1.md'), mkSpec(6, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'archive', '2026-09', 'specs', '2026-09-02-b2.md'), mkSpec(8, 4), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'archive', '2026-09', 'specs', '2026-09-03-b3.md'), mkSpec(10, 1), 'utf8');
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('spec S1：活跃行（2 份 / 行数中位 11 = (10+12)/2 / 最大 12 / 验收中位 4 / 最大 5）',
    r.status === 0 && /\| 活跃 \| 2 \| 11 \| 12 \| 4 \| 5 \|/.test(md), `exit=${r.status}\n${r.stderr}\n${md}`);
  check('spec S1：归档行（3 份 / 行数中位 8 取中 / 最大 10 / 验收中位 2 / 最大 4）',
    /\| 归档 \| 3 \| 8 \| 10 \| 2 \| 4 \|/.test(md), md);
  check('spec S1：表题在位且位于复核效果表之后',
    /## 复核效果[\s\S]*## spec 体积观察[\s\S]*<!-- GENERATED:END -->/.test(md), md);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S2：无 archive 目录 + specs 目录空 → 两行全 0 不崩（合法零数据）
  const root = mkfix();
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('spec S2：specs 空目录 + 无 archive → 活跃/归档两行全 0，exit 0',
    r.status === 0 && /\| 活跃 \| 0 \| 0 \| 0 \| 0 \| 0 \|/.test(md) && /\| 归档 \| 0 \| 0 \| 0 \| 0 \| 0 \|/.test(md),
    `exit=${r.status}\n${r.stderr}\n${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 10：空仓守卫（2026-11 Minor）——workflow/<type> 目录缺失按空集处理，生成器不崩 ----
// 修复前：scanDocs 对 workflow/<type> 直接 readdirSync，空仓/新仓（目录未建）ENOENT 崩栈；
// 生成器对空仓是合法调用（机制先于数据），缺目录按空集 + 输出说明行。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-workflow-metrics-empty-'));
  const r = run(root, ['--month', '2026-10']);
  const md = fs.existsSync(path.join(root, 'workflow', 'metrics.md')) ? readMetrics(root) : '';
  check('场景 10：完全空仓（无 workflow/）→ exit 0 且 metrics.md 照常落盘',
    r.status === 0 && md.includes('| 2026-10 |'), `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 10：缺目录出说明行（不静默吞）', /缺目录.*按空集/.test(r.stderr), r.stderr);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景组「阶段流转」（2026-11-12 步骤 E，第八表）：台账三件套 + git 时间戳 → 三段时长 + 返工代理 ----
// mkfixGitLedger：mkfix + git init + 按指定日期逐笔提交（GIT_AUTHOR_DATE/COMMITTER_DATE 注入）+ 台账行。
// steps = [[iso, [[相对路径, 内容], ...], 提交消息], ...]——每步先写盘再 add（同文件两次入步即「修订提交」）
const mkfixGitLedger = (ledgerLines, steps) => {
  const root = mkfixLedger(ledgerLines);
  const gitEnv = (iso) => ({ ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  const git = (args, iso) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv(iso) });
  git(['init'], '2026-10-01T00:00:00Z');
  git(['config', 'user.email', 'flow-test@example.com'], '2026-10-01T00:00:00Z');
  git(['config', 'user.name', 'flow-test'], '2026-10-01T00:00:00Z');
  for (const [iso, files, msg] of steps) {
    for (const [rel, text] of files) {
      fs.mkdirSync(path.join(root, rel, '..'), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text, 'utf8');
    }
    git(['add', ...files.map(([rel]) => rel)], iso);
    const c = git(['commit', '-m', msg], iso);
    if (c.status !== 0) throw new Error(`夹具提交失败（${iso} ${msg}）：${c.stderr}`);
  }
  return root;
};
{
  // FL1：主路径——intent(10-01)→spec(10-02)→plan(10-04)→产品提交(10-05，锚)→spec 修订(10-05T12)→终态(10-06)
  // 三段 = 1.0 / 2.0 / 2.0 天；build 锚 = min(产品提交, 终态) = 10-05；锚后修订 1 次 → 返工族 1
  const stem = '2026-10-01-fam1';
  const root = mkfixGitLedger(
    [LROW({ ts: '2026-10-06T00:00:00.000Z', doc: `workflow/plans/${stem}.md`, stage: 'done', prev: 'approved' })],
    [
      ['2026-10-01T00:00:00Z', [[`workflow/intents/${stem}.md`, doc('状态: approved\n级别: L1\n模块: pipeline', 'INTENT — 流转')]], `add intent ${stem}`],
      ['2026-10-02T00:00:00Z', [[`workflow/specs/${stem}.md`, doc('状态: approved\n级别: L1\n模块: pipeline', 'SPEC — 流转')]], `add spec ${stem}`],
      ['2026-10-04T00:00:00Z', [[`workflow/plans/${stem}.md`, doc('状态: approved\n级别: L1\n模块: pipeline', 'PLAN — 流转')]], `add plan ${stem}`],
      ['2026-10-05T00:00:00Z', [['src/app.txt', 'product']], `${stem}: 实现主体`],
      ['2026-10-05T12:00:00Z', [[`workflow/specs/${stem}.md`, doc('状态: approved\n级别: L1\n模块: pipeline\n备注: 修订', 'SPEC — 流转')]], `${stem}: spec 修订（返工）`],
    ],
  );
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('流转 FL1：三段时长与返工计数（| 2026-10 | 1.0/1.0 | 2.0/2.0 | 2.0/2.0 | 1 | 1 |）',
    r.status === 0 && /## 阶段流转[\s\S]*?\| 2026-10 \| 1\.0\/1\.0 \| 2\.0\/2\.0 \| 2\.0\/2\.0 \| 1 \| 1 \|/.test(md), `exit=${r.status}\n${r.stdout}${r.stderr}\n${md}`);
  check('流转 FL1：stdout 逐族返工明细（锚后 spec/plan 修订 1 次）', /锚后 spec\/plan 修订 1 次/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // FL2：无 git 仓 → 整表「数据不足」占位，不误报（无月份行、无 0 值）
  const root = mkfix();
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('流转 FL2：非 git 仓 → 「数据不足」占位行且无月份行',
    r.status === 0 && /## 阶段流转[\s\S]*?\| （数据不足：非 git 仓 \/ 无台账三件套或 git 时间不可得） \| —\/— \| —\/— \| —\/— \| — \| — \|/.test(md)
    && !/## 阶段流转[\s\S]*?\| 2026-10 \|\s*\d/.test(md), `exit=${r.status}\n${r.stdout}${r.stderr}\n${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // FL3：无产品提交 → build 锚回退 plan 终态；锚后修订计 1（纯台账族）
  const stem = '2026-10-01-fam2';
  const docText = (extra = '') => doc(`状态: approved\n级别: L1\n模块: pipeline${extra}`, '流转夹具 fam2');
  const root = mkfixGitLedger(
    [LROW({ ts: '2026-10-05T00:00:00.000Z', doc: `workflow/plans/${stem}.md`, stage: 'done', prev: 'approved' })],
    [
      ['2026-10-01T00:00:00Z', [[`workflow/intents/${stem}.md`, docText()]], `add intent ${stem}`],
      ['2026-10-02T00:00:00Z', [[`workflow/specs/${stem}.md`, docText()]], `add spec ${stem}`],
      ['2026-10-03T00:00:00Z', [[`workflow/plans/${stem}.md`, docText()]], `add plan ${stem}`],
      ['2026-10-06T00:00:00Z', [[`workflow/specs/${stem}.md`, docText('\n备注: 收口后修订')]], `${stem}: 收口后 spec 修订`],
    ],
  );
  const r = run(root, ['--month', '2026-10']);
  const md = readMetrics(root);
  check('流转 FL3：终态锚回退（| 2026-10 | 1.0/1.0 | 1.0/1.0 | 2.0/2.0 | 1 | 1 |）',
    r.status === 0 && /## 阶段流转[\s\S]*?\| 2026-10 \| 1\.0\/1\.0 \| 1\.0\/1\.0 \| 2\.0\/2\.0 \| 1 \| 1 \|/.test(md), `exit=${r.status}\n${r.stdout}${r.stderr}\n${md}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // FL4：同月重跑 upsert 不重复；旧版文件（无「阶段流转」节）跑出新节且既有节原样保留（向后兼容）
  const stem = '2026-10-01-fam3';
  const famDoc = doc('状态: approved\n级别: L1\n模块: pipeline', '流转夹具 fam3');
  const mk = () => mkfixGitLedger(
    [LROW({ ts: '2026-10-06T00:00:00.000Z', doc: `workflow/plans/${stem}.md`, stage: 'done', prev: 'approved' })],
    [
      ['2026-10-01T00:00:00Z', [[`workflow/intents/${stem}.md`, famDoc]], `add intent ${stem}`],
      ['2026-10-04T00:00:00Z', [[`workflow/specs/${stem}.md`, famDoc]], `add spec ${stem}`],
      ['2026-10-05T00:00:00Z', [[`workflow/plans/${stem}.md`, famDoc]], `add plan ${stem}`],
    ],
  );
  const rootUp = mk();
  run(rootUp, ['--month', '2026-10']);
  run(rootUp, ['--month', '2026-10']);
  const mdUp = readMetrics(rootUp);
  check('流转 FL4：同月重跑 upsert（「阶段流转」2026-10 行恰 1 行）',
    (mdUp.match(/^\| 2026-10 \|/gm) || []).length >= 1
    && (mdUp.split('## 阶段流转')[1].match(/^\| 2026-10 \|/gm) || []).length === 1, mdUp);
  fs.rmSync(rootUp, { recursive: true, force: true });
  const rootOld = mk();
  run(rootOld, ['--month', '2026-10']);
  const md1 = readMetrics(rootOld);
  const END = '<!-- GENERATED:END -->';
  const mdLegacy = md1.slice(0, md1.indexOf('## 阶段流转')) + END + '\n'; // 模拟旧版生成器产物：无第八节
  fs.writeFileSync(path.join(rootOld, 'workflow', 'metrics.md'), mdLegacy, 'utf8');
  const r2 = run(rootOld, ['--month', '2026-10']);
  const md2 = readMetrics(rootOld);
  const funnelPart = md2.split('## 闭环漏斗')[1]?.split('## 产品与质量维度')[0] || '';
  check('流转 FL4：旧版文件补出新节且漏斗行原样保留（不回吸不重复）',
    r2.status === 0 && /## 阶段流转[\s\S]*?\| 2026-10 \| 3\.0\/3\.0 \| 1\.0\/1\.0 \| 1\.0\/1\.0 \|/.test(md2)
    && (funnelPart.match(/^\| 2026-10 \|/gm) || []).length === 1, `exit=${r2.status}\n${md2}`);
  fs.rmSync(rootOld, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log(`\n${USAGE}`);
  process.exit(1);
}
process.exit(0);
