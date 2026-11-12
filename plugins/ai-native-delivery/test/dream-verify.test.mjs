#!/usr/bin/env node
// dream-verify.test.mjs — 引用完整性对拍（dream-verify）黑盒 + 库面测试
// 夹具：临时目录造 principles / regression-checklist（主档+分片）+ specs|plans 终态存档件 + confirmations
//       台账 + workflow/archive 归档批，断行成分按用例开关。断言：①引用已删证据文件 → 点名（文档+行号+
//       失效引用）且报告落 .agents/tmp/dream-verify-<date>.md、exit 0（advisory 恒绿）；②引用在场的正常
//       文档零误报；③指纹引用对不上 confirmations → 点名；④URL 与绝对路径跳过；⑤空/缺台账 → 指纹面
//       跳过零误报；⑥终态件已归档（基名在 workflow/archive/**）不判硬漂移；⑦扫描闭集口径：specs/plans
//       仅扫终态存档件（在途稿不扫）；⑧库面 runDreamVerify 返回结构 + 报告写出 + 行号准确；⑨未知选项 exit 2。
// 用法：node test/dream-verify.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runDreamVerify, renderVerifyReport } from '../scripts/dream-verify.mjs';

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dream-verify.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const put = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body, 'utf8');
};

// mkfix({ ledger, brokenPath, brokenFp })：一张原则档——ledger: 'row'|'empty'|'absent'（确认台账形态）；
// brokenPath/brokenFp：是否注入「已删证据路径行 / 台账对不上的指纹行」。URL 与绝对路径行恒在（跳过锚）。
const mkfix = ({ ledger = 'row', brokenPath = true, brokenFp = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-verify-test-'));
  const ledgerFp = sha('ledger-confirmed-content');
  const orphanFp = sha('orphan-unconfirmed-content');
  put(root, 'workflow/verify-evidence.md', '# 验证绿凭证\n');
  const lines = [
    '# 原则',
    '',
    `回归证据必须落 workflow/verify-evidence.md（在场件，零误报锚）。`,
    `已被删除的证据行：workflow/evidence/gone.md 是唯一权威凭证。`,           // 硬漂移①：路径不存在
    `指纹锚定行：${orphanFp} 为关单凭证。`,                                   // 硬漂移②：台账对不上
    `指纹在册行：${ledgerFp} 已过 confirm-doc。`,                             // 在场：零误报锚
    `外部参考见 https://example.com/workflow/also-gone.md，不判。`,           // URL 跳过
    `绝对路径样例 E:/Demo/other/workflow/also-gone.md 与 /var/data/workflow/also-gone.md，不判。`, // 绝对路径跳过
  ];
  const kept = lines.filter((l, i) => (i === 3 ? brokenPath : i === 4 ? brokenFp : true));
  put(root, 'workflow/principles.md', kept.join('\n') + '\n');
  if (ledger === 'row') {
    put(root, '.agents/confirmations.jsonl',
      JSON.stringify({ ts: '2026-11-12T00:00:00.000Z', doc: 'workflow/verify-evidence.md', stage: 'done', fingerprint: ledgerFp }) + '\n');
  } else if (ledger === 'empty') {
    put(root, '.agents/confirmations.jsonl', '');
  } // 'absent'：不造台账
  return { root, ledgerFp, orphanFp };
};

const run = (root, args) => spawnSync(process.execPath, [VERIFY, ...args], { cwd: root, encoding: 'utf8' });
const today = () => new Date().toISOString().slice(0, 10);
const readReport = (root) => fs.readFileSync(path.join(root, '.agents', 'tmp', `dream-verify-${today()}.md`), 'utf8');
const findingsOf = (root) => runDreamVerify(root).findings;

// ---- ①③ 引用已删证据 / 指纹对不上 → 点名（文档+行号+失效引用），报告落盘，exit 0 ----
{
  const { root, orphanFp } = mkfix();
  const r = run(root, ['--root', root]);
  check('① CLI exit 0（advisory 恒绿，含有存疑夹具）且报告已写入提示', r.status === 0 && /报告已写入 .*dream-verify-\d{4}-\d{2}-\d{2}\.md/.test(r.stdout), `exit=${r.status} ${r.stdout} ${r.stderr}`);
  const report = readReport(root);
  check('① 报告头带 advisory 声明与口径（不改源文档；只标硬漂移）',
    report.startsWith('# 引用完整性对拍报告 ') && report.includes('不改任何源文档') && report.includes('只标硬漂移'), report.slice(0, 300));
  check('① 点名文档+行号+失效引用（principles.md:4 引用失效 workflow/evidence/gone.md）',
    report.includes('workflow/principles.md:4') && report.includes('引用失效') && report.includes('workflow/evidence/gone.md'), report);
  check('③ 指纹对不上 → 点名（principles.md:5 指纹未对上）',
    report.includes('workflow/principles.md:5') && report.includes('指纹未对上') && report.includes(orphanFp), report);
  check('① 删除类动作仅建议（建议行含 删除须用户单独指令）', report.includes('删除须用户单独指令'), report);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ②④ 引用在场的正常文档零误报（含 URL / 绝对路径跳过） ----
{
  const { root } = mkfix({ ledger: 'row', brokenPath: false, brokenFp: false });
  const f = findingsOf(root);
  check('②④ 在场引用 + 在册指纹 + URL + 绝对路径 → 零误报', f.length === 0, JSON.stringify(f, null, 2));
  check('② 报告渲染零存疑基线文案', renderVerifyReport(runDreamVerify(root)).includes('无存疑注记'), '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ 指纹面对拍：空台账 / 缺台账 → 指纹面跳过零误报 ----
{
  for (const mode of ['empty', 'absent']) {
    const { root } = mkfix({ ledger: mode, brokenPath: false, brokenFp: true });
    const f = findingsOf(root);
    check(`⑤ ${mode === 'empty' ? '空' : '缺'}台账 → 指纹面整面跳过（零误报）`, f.length === 0, JSON.stringify(f, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- ⑥ 终态件已归档（基名在场）不判硬漂移 ----
{
  const { root } = mkfix({ brokenPath: false, brokenFp: false });
  put(root, 'workflow/archive/2026-10/specs/archived-thing.md', '---\n状态: done\n---\n# 归档件\n');
  put(root, 'workflow/principles.d/extra.md', `归档引用：workflow/specs/archived-thing.md（主档已搬家）。\n真失效：workflow/specs/really-gone.md。\n`);
  const f = findingsOf(root);
  check('⑥ 归档基名在场 → 不判硬漂移；归档无同名 → 照常点名（分片也在扫）',
    f.length === 1 && f[0].doc === 'workflow/principles.d/extra.md' && f[0].ref === 'workflow/specs/really-gone.md', JSON.stringify(f, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ 扫描闭集口径：specs/plans 仅扫终态存档件；非扫描闭集不扫 ----
{
  const { root } = mkfix({ brokenPath: false, brokenFp: false });
  put(root, 'workflow/specs/2026-01-01-done-spec.md', '---\n状态: done\n---\n终态件引用失效：workflow/evidence/spec-gone.md。\n');
  put(root, 'workflow/plans/2026-01-02-draft-plan.md', '---\n状态: approved\n---\n在途稿引用失效：workflow/evidence/plan-gone.md。\n');
  put(root, 'workflow/intents/2026-01-03-open-intent.md', '---\n状态: open\n---\n不在闭集：workflow/evidence/intent-gone.md。\n');
  const f = findingsOf(root);
  const docs = f.map((x) => x.doc);
  check('⑦ 终态 spec 存档件在扫（点名 workflow/evidence/spec-gone.md）',
    docs.includes('workflow/specs/2026-01-01-done-spec.md'), JSON.stringify(f, null, 2));
  check('⑦ 在途稿（approved）与非闭集目录（intents）不扫',
    !docs.some((d) => d.includes('draft-plan')) && !docs.some((d) => d.includes('intent')), JSON.stringify(docs));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑧ 库面 runDreamVerify：返回结构 + 报告写出 + 行号准确 ----
{
  const { root, orphanFp } = mkfix();
  const r = runDreamVerify(root);
  const byRef = Object.fromEntries(r.findings.map((x) => [x.ref, x]));
  check('⑧ 库面返回 findings 两处硬漂移，行号与夹具逐行对齐',
    byRef['workflow/evidence/gone.md'] && byRef['workflow/evidence/gone.md'].doc === 'workflow/principles.md'
      && byRef['workflow/evidence/gone.md'].line === 4
      && byRef[orphanFp] && byRef[orphanFp].kind === 'fingerprint' && byRef[orphanFp].line === 5,
    JSON.stringify(r.findings, null, 2));
  check('⑧ 报告落 <root>/.agents/tmp/dream-verify-<date>.md 且扫描面有交代',
    r.reportPath === path.join(root, '.agents', 'tmp', `dream-verify-${today()}.md`)
      && fs.existsSync(r.reportPath) && /扫描闭集 \d+ 文档/.test(readReport(root)), r.reportPath);
  check('⑧ 台账在场交代（1 个指纹值）', r.ledger.present === true && r.ledger.fingerprints === 1, JSON.stringify(r.ledger));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ 未知选项 exit 2（参数错误例外面） ----
{
  const { root } = mkfix();
  const bad = run(root, ['--unknown']);
  check('⑨ 未知选项 exit 2', bad.status === 2, `exit=${bad.status}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
