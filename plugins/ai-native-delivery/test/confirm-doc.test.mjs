#!/usr/bin/env node
// confirm-doc.test.mjs — 用户确认门测试（2026-09-26 confirm-gate-machine；2026-09-27 confirm-gate-delegated 补委托场景）
// 判据：① 指纹算法（CRLF 归一 / 剔指纹行防自引用 / 内容敏感） ② 跳转唯一合法性 ③ 落态只动两行
//       ④ 台账追加 schema ⑤ 核心——非 TTY spawn（模拟 AI 调用路径）无 --delegated 必须被拒
//       ⑥ 委托代录（--delegated）：免 TTY 落态 + 台账如实记 source/quote；空原话拒跑
//       ⑦ 逐阶段前置门（2026-09-30 stage-gate-machine）：specs/plans 的 draft→approved 须入口（plan 另须
//          L2/L3 时同名 spec）已确认；未过 → exit 2 + 未落盘未记账（S19-S22）
//       ⑧ done 前置门（2026-09-30 confirm-gate-approved-history）：→done 须 git 历史已留 approved 态
//          （先 done 后提交 / 两跳同批提交 → 拒绝）；非 git / legacy / 存量豁免声明 → 跳过（S25-S29）
// 用法：node test/confirm-doc.test.mjs（npm test 随跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeFingerprint, nextStage, applyTransition, appendLedger, resolveTransition } from '../scripts/confirm-doc.mjs';
import { planConfirmedFor, reviewLineFor } from '../scripts/stage-gates.mjs';
import {
  normalizeQuote, longestCommonAnchor, hasAnchorAtLeast, stripRelease, groundQuote,
  resolveDocText, resolveFamilyTexts, GROUND_ANCHOR_MIN,
} from '../scripts/quote-grounding.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const CLI = path.join(SCRIPT_DIR, '..', 'scripts', 'confirm-doc.mjs');

// 台账读取 helper（2026-09-30 复核 P2-1）：缺失/空行 → 安全返回（[]）——防「门拒路径下台账未生成」时
// 未捕获 ENOENT 截断后续用例（注入验证实证：原裸读在门失效时崩溃、无「合计」行）
// readLedgerOf：读统一台账视图（2026-10-12 ledger-shard-default 起确认行默认写分片——
// 主台账 + .agents/confirmations.d/*.jsonl 全量并入，按读入序返回，供「末次一行」断言）
const readLedgerOf = (root) => {
  const out = [];
  const push = (p) => {
    if (!fs.existsSync(p)) return;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
    }
  };
  push(path.join(root, '.agents', 'confirmations.jsonl'));
  const dir = path.join(root, '.agents', 'confirmations.d');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
      push(path.join(dir, f));
    }
  }
  return out;
};

// ---- S1 指纹：CRLF 归一（同内容不同行尾同指纹）----
{
  const lf = '---\n状态: draft\n---\n正文';
  const crlf = lf.replace(/\n/g, '\r\n');
  check('S1 CRLF 归一——同内容不同行尾指纹相同', computeFingerprint(lf) === computeFingerprint(crlf));
}

// ---- S2 指纹：剔「确认指纹:」行（防自引用——加指纹行不改指纹）----
{
  const a = '---\n状态: draft\n---\n正文';
  const b = '---\n状态: draft\n确认指纹: abc123\n---\n正文';
  check('S2 指纹行不参与指纹计算（防自引用）', computeFingerprint(a) === computeFingerprint(b));
}

// ---- S3 指纹：内容敏感（一字之差指纹不同；64 位 hex）----
{
  const fp1 = computeFingerprint('---\n状态: draft\n---\n正文A');
  const fp2 = computeFingerprint('---\n状态: draft\n---\n正文B');
  check('S3 内容敏感且为 64 位 hex', fp1 !== fp2 && /^[0-9a-f]{64}$/.test(fp1));
}

// ---- S4 nextStage：合法前向跳转（docs 两跳 + incidents 两跳，2026-09-27 gate-coverage）----
{
  check('S4 跳转表：draft→approved、approved→done、done/空/自造值→null',
    nextStage('draft') === 'approved' && nextStage('approved') === 'done'
      && nextStage('done') === null && nextStage('') === null && nextStage('进行中') === null);
  check('S4 incidents 跳转表：open→fixed、fixed→closed、closed→null（无 open→closed 单跳）',
    nextStage('open') === 'fixed' && nextStage('fixed') === 'closed'
      && nextStage('closed') === null && nextStage('open') !== 'closed');
  // --to 放弃态跳转表（2026-09-27 closing-coverage）：cancelled 自未确认/进行态；superseded 自已确认态
  const cancelOk = ['draft', 'approved', 'open', 'fixed'].every((s) => resolveTransition(s, 'cancelled') === 'cancelled');
  const supersedeOk = ['approved', 'done', 'fixed', 'closed'].every((s) => resolveTransition(s, 'superseded') === 'superseded');
  check('S4 --to 合法表：cancelled×{draft,approved,open,fixed} / superseded×{approved,done,fixed,closed} 全通',
    cancelOk && supersedeOk);
  check('S4 --to 非法表：draft→superseded / open→superseded / done→cancelled / cancelled→cancelled / 非法目标值 全拒',
    resolveTransition('draft', 'superseded') === null && resolveTransition('open', 'superseded') === null
      && resolveTransition('done', 'cancelled') === null && resolveTransition('cancelled', 'cancelled') === null
      && resolveTransition('approved', 'deleted') === null && resolveTransition('approved', null) === 'done');
}

// ---- S5 applyTransition：只动状态行 + 增指纹行，正文逐字节原样 ----
{
  const src = '---\n状态: draft\n级别: L2\n---\n\n# PLAN — x\n\n正文含 状态: 假行 不受影响';
  const out = applyTransition(src, 'approved', 'a3f9000000000000');
  check('S5 落态：状态行改值、指纹行追加、级别行与正文原样',
    out.startsWith('---\n状态: approved\n级别: L2\n确认指纹: a3f9000000000000\n---\n\n# PLAN — x\n\n正文含 状态: 假行 不受影响'),
    JSON.stringify(out));
}

// ---- S6 applyTransition：已有指纹行则覆盖（done 跳换新指纹）----
{
  const src = '---\n状态: approved\n确认指纹: old\n---\nX';
  const out = applyTransition(src, 'done', 'new1234567890abcd');
  check('S6 已有指纹行覆盖为新值', out.includes('状态: done') && out.includes('确认指纹: new1234567890abcd') && !out.includes('old'));
}

// ---- S7 applyTransition：无 frontmatter → null 不写 ----
{
  check('S7 无 frontmatter 返回 null', applyTransition('# 无 fm\n状态: draft', 'approved', 'x') === null);
}

// ---- S8 appendLedger：追加行 schema（ts/doc/stage/fingerprint/prev）----
// 2026-10-12 ledger-shard-default：默认写分片 .agents/confirmations.d/<doc 基名>.jsonl；
// {shard:false} 显式回退主台账 .agents/confirmations.jsonl（归并/排障路径）。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-led-'));
  appendLedger(root, { ts: 'T', doc: 'workflow/plans/a.md', stage: 'approved', fingerprint: 'f'.repeat(64), prev: 'draft' });
  const shardP = path.join(root, '.agents', 'confirmations.d', 'a.jsonl');
  check('S8a 默认写分片（confirmations.d/a.jsonl）', fs.existsSync(shardP) && !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl')));
  const lines = fs.readFileSync(shardP, 'utf8').trim().split('\n');
  const j = JSON.parse(lines[0]);
  check('S8b 分片追加行 schema 齐', lines.length === 1 && j.doc === 'workflow/plans/a.md' && j.stage === 'approved' && j.fingerprint.length === 64 && j.prev === 'draft');
  appendLedger(root, { ts: 'T2', doc: 'workflow/plans/b.md', stage: 'approved', fingerprint: 'e'.repeat(64), prev: 'draft' }, { shard: false });
  const mainLines = fs.readFileSync(path.join(root, '.agents', 'confirmations.jsonl'), 'utf8').trim().split('\n');
  check('S8c {shard:false} 显式回退主台账', mainLines.length === 1 && JSON.parse(mainLines[0]).doc === 'workflow/plans/b.md');
  fs.rmSync(root, { recursive: true, force: true });
}
// ---- S8d CLI 旗标：--shard/--no-shard 互斥拒绝；默认（无旗标）走分片 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-led-flag-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-12-f.md'), '---\n状态: draft\n级别: L1\n---\n# P');
  const both = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-12-f.md', '--shard', '--no-shard', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  check('S8d --shard 与 --no-shard 互斥 → exit 1', both.status === 1 && /互斥/.test(both.stderr), `exit=${both.status}\n${both.stderr}`);
  const dflt = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-12-f.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  check('S8e 无旗标默认写分片', dflt.status === 0 && fs.existsSync(path.join(root, '.agents', 'confirmations.d', '2026-10-12-f.jsonl')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S9【核心】非 TTY spawn（AI 调用路径）必须被拒 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tty-'));
  const docP = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-27-x.md'), '---\n状态: draft\n---\n# P');
  // spawnSync 无 TTY（管道 stdin）——模拟 AI 会话内调用；即使参数完全合法也必须拒绝
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-27-x.md'], { cwd: root, encoding: 'utf8', input: '可以\n' });
  const after = fs.readFileSync(path.join(docP, '2026-09-27-x.md'), 'utf8');
  check('S9 非 TTY 调用被拒：exit 1 + 提示 + 文档未被改动（AI 无法代确认）',
    r.status === 1 && /不可代确认/.test(r.stderr) && after === '---\n状态: draft\n---\n# P',
    JSON.stringify({ status: r.status, stderr: r.stderr, after }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S10 非 TTY 拒绝先于参数校验（无参数同拒）----
{
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  check('S10 TTY 门最先（无参数也是拒绝而非用法提示）', r.status === 1 && /不可代确认/.test(r.stderr));
}

// ---- S11 委托代录：非 TTY spawn + --delegated → 免 TTY 落态 + 台账如实记 source/quote ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-del-'));
  const docP = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-27-d.md'), '---\n状态: draft\n级别: L2\n---\n# P\n');
  // 逐阶段门夹具（2026-09-30 stage-gate-machine）：plan 批准须先有已确认入口——
  // 入口用存量口径（日期早于 confirmDocsEffective）免台账；级别 L1 免 spec 档
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-d.md'), '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n---\n# I（S11 入口夹具）\n');
  const before = fs.readFileSync(path.join(docP, '2026-09-27-d.md'), 'utf8');
  const fpExpect = computeFingerprint(before);
  // spawnSync 无 TTY（管道 stdin）——模拟 AI 会话内委托代录调用
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-27-d.md', '--delegated', '2选2'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-27-d.md'), 'utf8');
  const led = readLedgerOf(root);
  const j = led[led.length - 1];
  check('S11 委托代录：exit 0 + draft→approved + 指纹行 + 台账 source=chat-delegated / quote=原话 / 指纹全量与 frontmatter 前 16 位配对',
    r.status === 0 && after.includes('状态: approved') && after.includes(`确认指纹: ${fpExpect.slice(0, 16)}`)
      && j.source === 'chat-delegated' && j.quote === '2选2' && j.stage === 'approved' && j.prev === 'draft'
      && j.fingerprint === fpExpect,
    JSON.stringify({ status: r.status, stderr: r.stderr, ledger: led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S12 委托代录第二跳：approved→done 换新指纹（台账行仍如实记来源）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-del2-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  const fp1 = computeFingerprint('---\n状态: draft\n---\n# I\n');
  fs.writeFileSync(path.join(docP, '2026-09-27-e.md'), `---\n状态: approved\n确认指纹: ${fp1.slice(0, 16)}\n---\n# I\n`);
  const before = fs.readFileSync(path.join(docP, '2026-09-27-e.md'), 'utf8');
  const fp2 = computeFingerprint(before);
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-e.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-27-e.md'), 'utf8');
  const led = readLedgerOf(root);
  check('S12 委托第二跳：approved→done + 指纹行换新值 + 台账 stage=done / source 如实',
    r.status === 0 && after.includes('状态: done') && after.includes(`确认指纹: ${fp2.slice(0, 16)}`) && !after.includes(fp1.slice(0, 16))
      && led[led.length - 1].stage === 'done' && led[led.length - 1].source === 'chat-delegated',
    JSON.stringify({ status: r.status, after }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S13 委托代录：--delegated 空原话 → exit 1 用法提示，零文件改动 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-del3-'));
  const docP = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-27-f.md'), '---\n状态: draft\n---\n# P\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-27-f.md', '--delegated', '  '], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-27-f.md'), 'utf8');
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S13 空原话拒跑：exit 1 + 用法提示 + 文档未动 + 无台账',
    r.status === 1 && /--delegated 须带用户对话原话/.test(r.stderr) && after === '---\n状态: draft\n---\n# P\n' && noLedger,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S15 incidents 委托代录（2026-09-27 gate-coverage）：open→fixed 落态 + 台账 stage=fixed ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-inc-'));
  const docP = path.join(root, 'workflow', 'incidents');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-28-i.md'), '---\n状态: open\n级别: L1\n---\n# I\n');
  const before = fs.readFileSync(path.join(docP, '2026-09-28-i.md'), 'utf8');
  const fpExpect = computeFingerprint(before);
  const r = spawnSync(process.execPath, [CLI, 'workflow/incidents/2026-09-28-i.md', '--delegated', '修好了'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-28-i.md'), 'utf8');
  const led = readLedgerOf(root);
  const j = led[led.length - 1];
  check('S15 incidents 委托代录：exit 0 + open→fixed + 指纹行 + 台账 stage=fixed / prev=open',
    r.status === 0 && after.includes('状态: fixed') && after.includes(`确认指纹: ${fpExpect.slice(0, 16)}`)
      && j.source === 'chat-delegated' && j.quote === '修好了' && j.stage === 'fixed' && j.prev === 'open'
      && j.fingerprint === fpExpect,
    JSON.stringify({ status: r.status, stderr: r.stderr, ledger: led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S16 放弃态 --to（2026-09-27 closing-coverage）：draft --to cancelled 委托代录落态 + 台账 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-to-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-28-c.md'), '---\n状态: draft\n级别: L1\n---\n# I\n');
  const before = fs.readFileSync(path.join(docP, '2026-09-28-c.md'), 'utf8');
  const fpExpect = computeFingerprint(before);
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-28-c.md', '--to', 'cancelled', '--delegated', '不做了'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-28-c.md'), 'utf8');
  const led = readLedgerOf(root);
  const j = led[led.length - 1];
  check('S16 --to cancelled 委托代录：exit 0 + draft→cancelled + 台账 stage=cancelled / prev=draft',
    r.status === 0 && after.includes('状态: cancelled') && after.includes(`确认指纹: ${fpExpect.slice(0, 16)}`)
      && j.stage === 'cancelled' && j.prev === 'draft' && j.quote === '不做了' && j.fingerprint === fpExpect,
    JSON.stringify({ status: r.status, stderr: r.stderr, ledger: led }));
  // 调用事实（2026-09-28 batch-ledger-audit）：委托单份 → of=1、seq=1、batch 为非空字符串
  // （check-loop 检查 15 的并录审计据此判「是否一次调用落多份」——不再从 quote/ts 反推）
  check('S16b 台账行含调用事实 batch/seq/of 且单份 = of=1 / seq=1',
    typeof j.batch === 'string' && j.batch.length > 0 && j.seq === 1 && j.of === 1,
    JSON.stringify({ batch: j.batch, seq: j.seq, of: j.of }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S17 --to 非法组合拒跑：done --to cancelled → 跳过且不落台账 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-to2-'));
  const docP = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-28-d.md'), '---\n状态: done\n级别: L1\n---\n# P\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-28-d.md', '--to', 'cancelled', '--delegated', '试试'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-28-d.md'), 'utf8');
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S17 --to 非法组合（done→cancelled）：跳过不落态 + 无台账 + 文档未动',
    /无合法跳转/.test(r.stderr || '') && after.includes('状态: done') && noLedger,
    JSON.stringify({ stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S18 delegated 单文档强制（2026-09-27 confirm-gate-one-per-call）----
//     多文档并录曾系统性塌掉三道阶段门（build.md「逐件确认不得并作一次」）——机器层收口
{
  const mk2docs = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-single-'));
    for (const sub of ['intents', 'plans']) {
      fs.mkdirSync(path.join(root, 'workflow', sub), { recursive: true });
      fs.writeFileSync(path.join(root, 'workflow', sub, '2026-09-27-s.md'), `---\n状态: draft\n级别: L1\n---\n# ${sub === 'intents' ? 'I' : 'P'}\n`);
    }
    return root;
  };
  {
    const root = mk2docs();
    const before1 = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-s.md'), 'utf8');
    const before2 = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-27-s.md'), 'utf8');
    const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-s.md', 'workflow/plans/2026-09-27-s.md', '--delegated', '两份一起'], { cwd: root, encoding: 'utf8' });
    const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
    const after1 = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-s.md'), 'utf8');
    const after2 = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-27-s.md'), 'utf8');
    check('S18 delegated 双文档 → exit 1 拒绝 + 逐件口径提示 + 零台账 + 文档零改动',
      r.status === 1 && /一次仅接受一份文档/.test(r.stderr) && /逐件/.test(r.stderr)
        && noLedger && after1 === before1 && after2 === before2,
      JSON.stringify({ status: r.status, stderr: r.stderr }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mk2docs();
    const r1 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-s.md', '--delegated', '第一份可以'], { cwd: root, encoding: 'utf8' });
    const r2 = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-27-s.md', '--delegated', '第一份可以'], { cwd: root, encoding: 'utf8' });
    check('S18 delegated 单文档逐次调用照常（两次各落态各记账）',
      r1.status === 0 && r2.status === 0
        && fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-s.md'), 'utf8').includes('状态: approved')
        && fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-27-s.md'), 'utf8').includes('状态: approved'),
      JSON.stringify({ r1: r1.status, r2: r2.status, stderr: r2.stderr }));
    // 调用事实（2026-09-28 batch-ledger-audit）：每次进程调用 **一个** batch；两次独立调用 batch **不同**，
    // 各自 seq=1 / of=1——这是并录审计「逐件 vs 并录」的判别基础（复核 P2-2：plan 要求覆盖此面）
    const led2 = readLedgerOf(root);
    const [e1, e2] = led2.slice(-2);
    check('S18b 两次独立调用各生成独立 batch（不同批、各自 seq=1/of=1）',
      e1.batch !== e2.batch && e1.seq === 1 && e2.seq === 1 && e1.of === 1 && e2.of === 1,
      JSON.stringify(led2.slice(-2)));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 【复核 P2-2】单次调用落 N 份 → batch 相同 / seq 递增 1,2 / of=2 —— **端到端**验证 TTY 多文档路径。
    // 该路径仅 TTY 可达（delegated 已被入口限为 1 份），故注入两个**仅测试用**逃生门：
    //   CONFIRM_DOC_TEST_TTY=1      —— 放行 isTTY 判定（本环境无 TTY）
    //   CONFIRM_DOC_TEST_ANSWERS    —— 按序注入问答应答（见下「为什么不能用管道 stdin」）
    //   NODE_ENV=test               —— TTY 逃生门双条件的第二键（2026-09-28 check16-inline-debt：
    //                                 单变量可被生产会话顺手设置绕过 TTY 门，收紧为双条件）
    // 三者均不改动任何落态/记账语义。
    //
    // **为什么不能用 spawnSync 的 input 管道（2026-09-28 更正）**：此前本用例用 `input:'可以\n可以\n'`
    // 并断言「首份」了事，注释把根因误记为「readline 对第二份提问会 unsettled / 管道输入不被逐次消费」。
    // 经复现，真实机制是：spawnSync 的管道**一次性写完即关闭写端**，readline 在第一个 question 注册前
    // 就已把第二行读入并丢弃，且 stdin 随即 EOF —— 第二个 question 永远等不到输入。**与「有无 TTY」无关**，
    // 是「管道 EOF + 跨 await 边界的 question 注册时序」所致（嵌套回调版同样两问两答可用，加 await 即挂）。
    const root = mk2docs();
    const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-s.md', 'workflow/plans/2026-09-27-s.md'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CONFIRM_DOC_TEST_TTY: '1', CONFIRM_DOC_TEST_ANSWERS: '可以,可以', NODE_ENV: 'test' },
    });
    const ledN = readLedgerOf(root);
    const stI = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-s.md'), 'utf8');
    const stP = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-27-s.md'), 'utf8');
    check('S18c 单次调用落 2 份（TTY 多文档）端到端 → batch 相同 / seq 1,2 / of 均=2 / 两份都落态',
      r.status === 0 && ledN.length === 2
        && ledN[0].batch === ledN[1].batch && typeof ledN[0].batch === 'string' && ledN[0].batch.length > 0
        && ledN[0].seq === 1 && ledN[1].seq === 2
        && ledN[0].of === 2 && ledN[1].of === 2
        && ledN[0].source === 'tty' && ledN[1].source === 'tty'
        && stI.includes('状态: approved') && stP.includes('状态: approved'),
      JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300), ledger: ledN }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 【复核 P2-2】注入应答不足时，剩余文档按「未确认」跳过（不落态、不记账）——钉住注入语义的边界，
    // 避免测试逃生门被误用成「无条件放行」。
    const root = mk2docs();
    const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-s.md', 'workflow/plans/2026-09-27-s.md'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CONFIRM_DOC_TEST_TTY: '1', CONFIRM_DOC_TEST_ANSWERS: '可以', NODE_ENV: 'test' }, // 只给一份应答
    });
    const led1 = readLedgerOf(root);
    const stP1 = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-27-s.md'), 'utf8');
    check('S18d 注入应答不足 → 仅首份落态，次份按跳过处理（不落态不记账）',
      led1.length === 1 && led1[0].seq === 1 && led1[0].of === 2 && stP1.includes('状态: draft'),
      JSON.stringify({ status: r.status, ledger: led1 }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 【T3 双条件】仅设 CONFIRM_DOC_TEST_TTY=1 而未设 NODE_ENV=test → 逃生门不生效，仍按非 TTY 拒绝
    // （2026-09-28 check16-inline-debt：单变量可被生产会话顺手设置绕过 TTY 门，收紧为双条件——
    //   本用例钉住「缺第二键即不放行」，与 S18c/S18d 的「双键齐 → 放行」构成双向覆盖）
    const root = mk2docs();
    const env1 = { ...process.env, CONFIRM_DOC_TEST_TTY: '1', CONFIRM_DOC_TEST_ANSWERS: '可以' };
    delete env1.NODE_ENV; // 显式剔除——防宿主环境恰好携带 NODE_ENV 时用例失真
    const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-27-s.md'], {
      cwd: root, encoding: 'utf8', env: env1,
    });
    const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
    const afterI = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-27-s.md'), 'utf8');
    check('S18e 仅 CONFIRM_DOC_TEST_TTY=1 无 NODE_ENV=test → 仍非 TTY 拒绝（exit 1 + 零台账 + 文档未动）',
      r.status === 1 && /不可代确认/.test(r.stderr) && noLedger && afterI.includes('状态: draft'),
      JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- S19a【逐阶段门】L1 plan 无 intent → 本身即入口，允许 draft→approved ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg-l1-'));
  const docP = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-10-10-solo.md'), '---\n状态: draft\n级别: L1\n---\n# P\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-10-solo.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-10-10-solo.md'), 'utf8');
  check('S19a L1 plan 无 intent → exit 0 且 draft→approved',
    r.status === 0 && after.includes('状态: approved'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S19【逐阶段门】spec 无同名入口 → 拒绝落账（2026-09-30 stage-gate-machine）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg1-'));
  const docP = path.join(root, 'workflow', 'specs');
  fs.mkdirSync(docP, { recursive: true });
  fs.writeFileSync(path.join(docP, '2026-09-30-g.md'), '---\n状态: draft\n级别: L2\n---\n# S\n');
  const before = fs.readFileSync(path.join(docP, '2026-09-30-g.md'), 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-g.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-09-30-g.md'), 'utf8');
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S19 逐阶段门：spec 无同名入口 → exit 2 + 未落盘未记账 + 回退提示',
    r.status === 2 && /逐阶段前置门/.test(r.stderr) && /未找到同名入口/.test(r.stderr) && after === before && noLedger,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S20【逐阶段门】入口存在但未确认（draft）→ 拒绝 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-h.md'), '---\n状态: draft\n级别: L2\n日期: 2026-09-30\n---\n# I\n');
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-h.md'), '---\n状态: draft\n级别: L2\n---\n# S\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-h.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S20 逐阶段门：入口未确认（draft）→ exit 2 + 提示状态、零落账',
    r.status === 2 && /状态「draft」/.test(r.stderr) && noLedger,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S21【逐阶段门】L1 入口已确认 → plan 放行（存量口径免台账；级别 L1 免 spec 档）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-j.md'), '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n---\n# I\n');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-09-30-j.md'), '---\n状态: draft\n级别: L1\n---\n# P\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-30-j.md', '--delegated', '继续'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-30-j.md'), 'utf8');
  check('S21 逐阶段门：L1 入口 approved（存量口径）→ plan 放行落态',
    r.status === 0 && after.includes('状态: approved'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S22【逐阶段门】L2 入口已确认但缺 spec → plan 拒绝 ----
{
  // 入口须有**台账行**（不复用存量日期短路路径）——夹具写 confirmed 行使前置成立，仅缺 spec
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const fp4 = '4'.repeat(64);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-k.md'), `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${fp4.slice(0, 16)}\n---\n# I\n`);
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), JSON.stringify({ ts: '2026-09-30T04:00:00.000Z', doc: 'workflow/intents/2026-09-30-k.md', stage: 'approved', fingerprint: fp4, prev: 'draft', source: 'chat-delegated', batch: 'k4', seq: 1, of: 1 }) + '\n');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-09-30-k.md'), '---\n状态: draft\n级别: L2\n---\n# P\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-30-k.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'plans', '2026-09-30-k.md'), 'utf8');
  check('S22 逐阶段门：L2 入口（台账行）缺同名 spec → plan 拒绝（exit 2 + 未落态）',
    r.status === 2 && /缺同名 spec/.test(r.stderr) && after.includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S23【逐阶段门】入口「台账行」正路放行（非存量口径；复核 P2-4④）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-sg5-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  const fp = 'b'.repeat(64);
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-m.md'), `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${fp.slice(0, 16)}\n---\n# I\n`);
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), JSON.stringify({ ts: '2026-09-30T02:00:00.000Z', doc: 'workflow/intents/2026-09-30-m.md', stage: 'approved', fingerprint: fp, prev: 'draft', source: 'chat-delegated', batch: 't9', seq: 1, of: 1 }) + '\n');
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-m.md'), '---\n状态: draft\n级别: L2\n---\n# S\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-m.md', '--delegated', '继续'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-m.md'), 'utf8');
  check('S23 逐阶段门：入口状态 approved + 台账行（正路）→ spec 放行',
    r.status === 0 && after.includes('状态: approved'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // N1：存量短路（confirm-doc 侧）——legacy 入口无级别 → spec 放行
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-n1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-n1.md'), '---\n状态: approved\n日期: 2026-01-01\n流程: legacy\n---\n# I（存量、无级别）\n');
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-n1.md'), '---\n状态: draft\n级别: L2\n---\n# S\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-n1.md', '--delegated', 'n1 回归'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-n1.md'), 'utf8');
  check('S24 N1 存量短路：legacy 入口无级别 → confirm-doc 放行（不锁死确认）',
    r.status === 0 && after.includes('状态: approved'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S25–S29【done 前置门】approved 历史留痕（2026-09-30 confirm-gate-approved-history）----
// git helper：与 check-loop.test 同口径（win32 → git.exe；-c 注入 user 免全局 config 依赖）
const GITBIN = process.platform === 'win32' ? 'git.exe' : 'git';
const gitAt = (root, ...args) => spawnSync(GITBIN, args, { cwd: root, encoding: 'utf8' });
const gitHead = (root) => {
  gitAt(root, 'init', '-q');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
};

// S25：有 HEAD 但文档从未提交（先 done 后提交形态）→ done 拒绝
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dh1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-09-30-d1.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n日期: 2026-09-30\n---\n# P\n');
  const before = fs.readFileSync(p, 'utf8');
  gitHead(root);
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-30-d1.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S25 done 门：历史无 approved（先 done 后提交形态）→ exit 2 + 零落账 + 零写盘',
    r.status === 2 && /done 前置门/.test(r.stderr) && /从未出现/.test(r.stderr) && after === before && noLedger,
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 260) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S26：approved 态已提交（留痕）→ done 放行落账
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dh2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-09-30-d2.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n日期: 2026-09-30\n---\n# P\n');
  // 委派台账在场门夹具（2026-10-25 优化4）：夹具根无 engine.json → policy 回退 v1（无 delegationSince
  // 锚键，与检查 18「缺键全量对账」同语义）——2026-09-30 的 L2 也须有台账行
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-09-30 | 自做 2026-09-30-d2 关单 | 一次通过 | 在场门夹具 |  |\n');
  gitHead(root);
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-30-d2.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  const ledger = readLedgerOf(root); // 复核 P2-1：统一 helper（缺失 → []，不崩溃）
  check('S26 done 门：approved 态已提交（留痕）→ 放行落态 + 台账 stage=done',
    r.status === 0 && after.includes('状态: done') && ledger.some((e) => e.stage === 'done' && e.prev === 'approved'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S27：非 git 环境 → 跳过（不误拦；沿检查 14 口径）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dh3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-09-30-d3.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n---\n# P\n');
  // 委派台账在场门夹具（2026-10-27 日期兜底修）：plan 无「日期」字段时日期回落文件名（2026-09-30），
  // 委派门据此适用（夹具根无 engine.json → policy v1 无 delegationSince 锚键 = 全量对账）——须有台账行。
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-09-30 | 自做 2026-09-30-d3 关单 | 一次通过 | 在场门夹具 |  |\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-09-30-d3.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  check('S27 done 门：非 git 环境 → 跳过放行',
    r.status === 0 && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S28：legacy 标记 → 跳过（存量口径；intent 文档承载——spec/plan 不产生 legacy 标记）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dh4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p = path.join(root, 'workflow', 'intents', '2026-09-30-d4.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n流程: legacy\n---\n# I\n');
  gitHead(root);
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-d4.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  check('S28 done 门：legacy 标记 → 跳过放行',
    r.status === 0 && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S29：正文「存量确认态豁免（」声明 → 跳过（显式逃生口；与检查 14 同标记）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dh5-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  const p = path.join(root, 'workflow', 'specs', '2026-09-30-d5.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n---\n# S\n\n存量确认态豁免（S29 构造：声明式逃生口覆盖）\n');
  // 委派台账在场门夹具（2026-10-27 日期兜底修）：日期回落文件名（2026-09-30）→ 委派门适用，须有台账行
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-09-30 | 自做 2026-09-30-d5 关单 | 一次通过 | 在场门夹具 |  |\n');
  gitHead(root);
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-d5.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  check('S29 done 门：存量豁免声明 → 跳过放行',
    r.status === 0 && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S29b–S29d【委派台账在场门】delegation-presence（2026-10-25 优化4）----
// 判据与检查 18 事后对账一致（单源 delegation-presence.rowCovers）：L2/L3 新需求族 →done 须有
// 日期 ≥ 文档日期且含文件名的台账行；修复族（同名 incident 在场）豁免；锚前/缺日期/L1 跳过。
{
  // S29b：锚后 L2 spec 无台账行 → 拒（exit 2 + 零落账零写盘）。spec 过格式门须带「验收判据」数据行
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dp1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  const p = path.join(root, 'workflow', 'specs', '2026-10-20-dp1.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n日期: 2026-10-20\n---\n# S\n\n## 验收判据\n\n| 判据 | 证据 |\n|---|---|\n| 构建绿 | verify.mjs |\n');
  const before = fs.readFileSync(p, 'utf8');
  gitHead(root);
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-10-20-dp1.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(p, 'utf8');
  check('S29b 在场门：锚后 L2 无台账行 → exit 2 + 点名文件名 + ledger-shards 补行指引 + 零写盘',
    r.status === 2 && /委派台账在场门/.test(r.stderr) && /2026-10-20-dp1/.test(r.stderr)
      && /ledger-shards\.mjs --append/.test(r.stderr) && after === before,
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S29c：补自做表台账行（任务一句话含文件名）→ 放行落 done
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dp2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-10-20-dp2.md'), '---\n状态: approved\n级别: L2\n日期: 2026-10-20\n---\n# S\n\n## 验收判据\n\n| 判据 | 证据 |\n|---|---|\n| 构建绿 | verify.mjs |\n');
  // 分片形态夹具（主表∪分片同口径）：行落在当月分片「自做任务结果」节
  fs.mkdirSync(path.join(root, 'workflow', 'delegations.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.d', '2026-10.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-10-20 | 自做 2026-10-20-dp2 关单 | 一次通过 | - |  |\n');
  gitHead(root);
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-10-20-dp2.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-10-20-dp2.md'), 'utf8');
  check('S29c 在场门：分片自做表含文件名行 → 放行落 done',
    r.status === 0 && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S29d：修复族豁免——同名 incident 在场（记法「修复类不记」）→ 无行也放行
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-dp3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'incidents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-10-20-dp3.md'), '---\n状态: approved\n级别: L2\n日期: 2026-10-20\n---\n# S\n\n## 验收判据\n\n| 判据 | 证据 |\n|---|---|\n| 构建绿 | verify.mjs |\n');
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-10-20-dp3.md'), '---\n状态: fixed\n级别: L2\n发现: 2026-10-20\n---\n# INC\n');
  gitHead(root);
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const r = spawnSync(process.execPath, [CLI, 'workflow/specs/2026-10-20-dp3.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-10-20-dp3.md'), 'utf8');
  check('S29d 在场门：同名 incident 在场（修复族）→ 豁免放行',
    r.status === 0 && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S30【协作道批量】--batch：delegated 多份 L1 一次代录 → 全部落态 + 台账 brief:true（2026-09-30 hybrid-governance-risk-lanes）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt1.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I1\n');
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt2.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I2\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-bt1.md', 'workflow/intents/2026-09-30-bt2.md', '--delegated', '批量放行', '--batch'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  const st1 = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt1.md'), 'utf8');
  const st2 = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt2.md'), 'utf8');
  check('S30 --batch：2 份 L1 一次代录 → 全部 approved + 台账 brief:true / of=2 / seq 递增',
    r.status === 0 && led.length === 2
      && led.every((e) => e.brief === true && e.source === 'chat-delegated' && e.of === 2 && e.stage === 'approved')
      && led[0].seq === 1 && led[1].seq === 2
      && st1.includes('状态: approved') && st2.includes('状态: approved'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300), led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S31【协作道批量】--batch 混入 L2 → 该份逐份拒绝（exit 2 + 未落盘未记账），L1 份照常落态 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt3.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I3\n');
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt4.md'), '---\n状态: draft\n级别: L2\n日期: 2026-09-30\n---\n# I4\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-bt3.md', 'workflow/intents/2026-09-30-bt4.md', '--delegated', '批量放行', '--batch'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  const st4 = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt4.md'), 'utf8');
  check('S31 --batch 混入 L2 → L2 拒绝（exit 2 + 未落盘未记账）+ L1 落态',
    r.status === 2 && /不在协作道/.test(r.stderr) && led.length === 1 && led[0].doc.endsWith('bt3.md') && st4.includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300), led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S31b --batch 级别缺失件 → 泳道 suspect 逐份拒绝（2026-10-10 单字段协议；原双字段分歧场景随协议退役）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 2 }));
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-02-dv1.md'), '---\n状态: draft\n日期: 2026-10-02\n---\n# DV\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-02-dv1.md', '--delegated', '批量放行', '--batch'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  const st = fs.readFileSync(path.join(root, 'workflow', 'intents', '2026-10-02-dv1.md'), 'utf8');
  check('S31b --batch 级别缺失件 → 泳道 suspect 拒（exit 2 + 补级别提示 + 零台账未落盘）',
    r.status === 2 && /泳道「suspect」/.test(r.stderr) && /补级别/.test(r.stderr) && led.length === 0 && st.includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300), led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S31c --auto 级别缺失件 → suspect 拒（消息锁定，先于 trust 判定短路）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 2 }));
  fs.writeFileSync(path.join(root, '.agents', 'trust-mode.json'), JSON.stringify({ enabled: true, level: 1, name: 'Standard', enabledAt: '2026-10-02T00:00:00.000Z' }));
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-02-dv2.md'), '---\n状态: draft\n日期: 2026-10-02\n---\n# DV2\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-02-dv2.md', '--auto'], { cwd: root, encoding: 'utf8' });
  check('S31c --auto（trust=Standard）级别缺失件 → 泳道 suspect 拒（消息含 suspect 与补级别指引）',
    r.status !== 0 && /suspect/.test(r.stderr) && /补「级别」/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S32 --batch 组合约束：与 --auto / --to 互斥（exit 1，零落账）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt5.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I5\n');
  const r1 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-bt5.md', '--delegated', 'x', '--batch', '--auto'], { cwd: root, encoding: 'utf8' });
  const r2 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-bt5.md', '--delegated', 'x', '--batch', '--to', 'cancelled'], { cwd: root, encoding: 'utf8' });
  const noLedger = !fs.existsSync(path.join(root, '.agents', 'confirmations.jsonl'));
  check('S32 --batch 与 --auto / --to 互斥 → 均 exit 1 + 零台账',
    r1.status === 1 && r2.status === 1 && noLedger,
    JSON.stringify({ r1: r1.status, r2: r2.status }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S33 简洁审计：单份 delegated L1（无 --batch）→ 台账 brief:true + 紧凑输出；L2 份不带 brief ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-bt4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-bt6.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I6\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-bt6.md', '--delegated', '单份放行'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  check('S33 单份 L1 代录 → brief:true + 紧凑输出（协作道/异步审计标记）',
    r.status === 0 && led.length === 1 && led[0].brief === true && /协作道\/异步审计/.test(r.stdout),
    JSON.stringify({ status: r.status, stdout: String(r.stdout).slice(0, 200), led }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S34–S37【Trusted 自动泳道】trust-mode.json = Trusted（level 2）→ 非 TTY 免旗标隐式自治（2026-09-30 hybrid-governance-explore-hardening）----
const writeTrust = (root, cfg) => {
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'trust-mode.json'), JSON.stringify(cfg));
};
// S34：Trusted + L1 intent 免旗标 → draft→approved 落态 + 台账 source=ai-auto-trust-L2；第二跳 → done（全闭环）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tr1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  writeTrust(root, { enabled: true, level: 2, name: 'Trusted', enabledAt: '2026-09-30T00:00:00.000Z' });
  const p = path.join(root, 'workflow', 'intents', '2026-09-30-tr1.md');
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I\n');
  const r1 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr1.md'], { cwd: root, encoding: 'utf8' });
  const led1 = readLedgerOf(root);
  check('S34 Trusted 隐式：非 TTY 无旗标 L1 draft→approved + 台账 source=ai-auto-trust-L2',
    r1.status === 0 && fs.readFileSync(p, 'utf8').includes('状态: approved')
      && led1.length === 1 && led1[0].source === 'ai-auto-trust-L2' && led1[0].stage === 'approved' && led1[0].prev === 'draft',
    JSON.stringify({ status: r1.status, stderr: String(r1.stderr).slice(0, 300), led: led1 }));
  // 第二跳：非 git 环境 done 门跳过（S27 同口径）→ Level 2 全闭环直达 done
  const r2 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr1.md'], { cwd: root, encoding: 'utf8' });
  const led2 = readLedgerOf(root);
  check('S34b Trusted 隐式第二跳：approved→done（Level 2 全闭环）',
    r2.status === 0 && fs.readFileSync(p, 'utf8').includes('状态: done')
      && led2.length === 2 && led2[1].stage === 'done' && led2[1].prev === 'approved',
    JSON.stringify({ status: r2.status, stderr: String(r2.stderr).slice(0, 300), led: led2 }));
  fs.rmSync(root, { recursive: true, force: true });
}
// S35：Trusted 隐式边界——L2 文档与 incidents 均不过自治门（exit 2 未落账）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tr2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'incidents'), { recursive: true });
  writeTrust(root, { enabled: true, level: 2, name: 'Trusted' });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-tr2.md'), '---\n状态: draft\n级别: L2\n日期: 2026-09-30\n---\n# I\n');
  fs.writeFileSync(path.join(root, 'workflow', 'incidents', '2026-09-30-tr3.md'), '---\n状态: open\n级别: L1\n---\n# I\n');
  const r1 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr2.md'], { cwd: root, encoding: 'utf8' });
  const r2 = spawnSync(process.execPath, [CLI, 'workflow/incidents/2026-09-30-tr3.md'], { cwd: root, encoding: 'utf8' });
  check('S35 Trusted 隐式边界：L2 文档与 incidents 均拒绝（exit 2 未过自治门）+ 零台账',
    r1.status === 2 && r2.status === 2 && readLedgerOf(root).length === 0,
    JSON.stringify({ r1: r1.status, r2: r2.status, stderr1: String(r1.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// S36：Standard（level 1）不隐式——非 TTY 无旗标仍拒（隐式泳道仅 Trusted；fail-closed）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tr3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  writeTrust(root, { enabled: true, level: 1, name: 'Standard' });
  const p = path.join(root, 'workflow', 'intents', '2026-09-30-tr4.md');
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I\n');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr4.md'], { cwd: root, encoding: 'utf8' });
  check('S36 Standard 不隐式：非 TTY 无旗标 → 仍 exit 1 拒绝 + 零写盘',
    r.status === 1 && /不可代确认/.test(r.stderr) && fs.readFileSync(p, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// S37：Trusted 隐式边界——多份 / --to 放弃态 → 不隐式，仍拒（exit 1）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-tr4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  writeTrust(root, { enabled: true, level: 2, name: 'Trusted' });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-tr5.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I\n');
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-tr6.md'), '---\n状态: draft\n级别: L1\n日期: 2026-09-30\n---\n# I\n');
  const r1 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr5.md', 'workflow/intents/2026-09-30-tr6.md'], { cwd: root, encoding: 'utf8' });
  const r2 = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-30-tr5.md', '--to', 'cancelled'], { cwd: root, encoding: 'utf8' });
  check('S37 Trusted 隐式边界：多份 / --to 放弃态 → 不隐式仍拒（exit 1 + 零台账）',
    r1.status === 1 && r2.status === 1 && /不可代确认/.test(r1.stderr) && readLedgerOf(root).length === 0,
    JSON.stringify({ r1: r1.status, r2: r2.status, stderr1: String(r1.stderr).slice(0, 160), stderr2: String(r2.stderr).slice(0, 160) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S38 测试绿凭证前置（2026-10-07 verify-evidence）：v5 + 验收节 + 无凭证 → ⚠️ advisory 且仍落账 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-verify1-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 5 }), 'utf8');
  fs.writeFileSync(path.join(docP, '2026-10-07-v.md'),
    '---\n状态: approved\n级别: L1\n确认指纹: aaaa1111aaaa1111\n---\n# I\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-07-v.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-10-07-v.md'), 'utf8');
  check('S38 凭证前置：v5 + 验收节 + 无凭证 → ⚠️ 出账且 done 仍落态（advisory 不拦）',
    r.status === 0 && /无测试绿凭证/.test(r.stderr) && /verify\.mjs/.test(r.stderr) && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S39 测试绿凭证前置：近期绿凭证在场 → 静默（无 ⚠️）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-verify2-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 5 }), 'utf8');
  fs.writeFileSync(path.join(root, '.agents', 'verifications.jsonl'),
    `${JSON.stringify({ ts: new Date().toISOString(), exitCode: 0, suite: 'npm test', passed: 1, failed: 0 })}\n`, 'utf8');
  fs.writeFileSync(path.join(docP, '2026-10-07-w.md'),
    '---\n状态: approved\n级别: L1\n确认指纹: bbbb2222bbbb2222\n---\n# I\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-07-w.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const after = fs.readFileSync(path.join(docP, '2026-10-07-w.md'), 'utf8');
  check('S39 凭证前置：24h 内有绿行 → 静默（无 ⚠️）且 done 落态',
    r.status === 0 && !/无测试绿凭证/.test(r.stderr) && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S40 测试绿凭证 hard 升级（2026-10-09 AI-Native 架构审查修复，policy v8 verifyHardSince=2026-10-10）：
//      锚日之后 →done 且无凭证 → 拒绝落账（不改盘、不写台账）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-verify3-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 8 }), 'utf8');
  fs.writeFileSync(path.join(docP, '2026-10-07-v.md'),
    '---\n状态: approved\n级别: L1\n确认指纹: aaaa1111aaaa1111\n---\n# I\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-07-v.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-11' } });
  const after = fs.readFileSync(path.join(docP, '2026-10-07-v.md'), 'utf8');
  check('S40 凭证 hard 档：v8 + 锚后日期 + 无凭证 → 拒绝落账（exit 2=refused、仍 approved、台账零行）',
    r.status === 2 && /无测试绿凭证/.test(r.stderr) && /拒绝落账/.test(r.stderr)
    && after.includes('状态: approved') && !after.includes('状态: done')
    && readLedgerOf(root).length === 0,
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S41 凭证 hard 档分档不追溯：v8 + 锚前日期（2026-10-09 < 2026-10-10）→ 仍 advisory 落账 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-verify4-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 8 }), 'utf8');
  fs.writeFileSync(path.join(docP, '2026-10-07-v.md'),
    '---\n状态: approved\n级别: L1\n确认指纹: aaaa1111aaaa1111\n---\n# I\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-07-v.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-09' } });
  const after = fs.readFileSync(path.join(docP, '2026-10-07-v.md'), 'utf8');
  check('S41 凭证 hard 档锚前：v8 + 锚前日期 + 无凭证 → ⚠️ 出账且 done 仍落态（不追溯）',
    r.status === 0 && /无测试绿凭证/.test(r.stderr) && /advisory，灰度第一档/.test(r.stderr) && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S42 向后兼容：v7 无 verifyHardSince 键 → 即便日期注入到未来也逐字节维持 advisory ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-verify5-'));
  const docP = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(docP, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 7 }), 'utf8');
  fs.writeFileSync(path.join(docP, '2026-10-07-v.md'),
    '---\n状态: approved\n级别: L1\n确认指纹: aaaa1111aaaa1111\n---\n# I\n\n## 验收标准（可测试）\n- [x] 用例通过（证据:测试全绿）\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-07-v.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-12-01' } });
  const after = fs.readFileSync(path.join(docP, '2026-10-07-v.md'), 'utf8');
  check('S42 缺键兼容：v7 + 未来日期 + 无凭证 → 仍 advisory（verifyHardSince 缺键即不升档）',
    r.status === 0 && /advisory，灰度第一档/.test(r.stderr) && after.includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S43 关单即归档（2026-10-13 archive-on-close）：终态家族超窗 → git mv 进 archive ----
// 需真实 git 仓库（归档走 git mv）；家族原子：intent+plan 同进同退。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-arch-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const ip = path.join(root, 'workflow', 'intents');
  const pp = path.join(root, 'workflow', 'plans');
  fs.mkdirSync(ip, { recursive: true });
  fs.mkdirSync(pp, { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'archive'), { recursive: true }); // 归档约定在场（启用条件）
  // 家族：intent（本次关单）+ plan（已 done 且正文变更在 30 天前 → 超窗）
  fs.writeFileSync(path.join(ip, '2026-09-01-fam.md'), '---\n状态: approved\n级别: L1\n确认指纹: aaaa1111aaaa1111\n---\n# I\n\n## 验收标准（可测试）\n- [x] 通过（证据:测试全绿）\n', 'utf8');
  fs.writeFileSync(path.join(pp, '2026-09-01-fam.md'), '---\n状态: done\n级别: L1\n---\n# P\n\n## 改动方案\n- 正文\n', 'utf8');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-09-01T10:00:00+08:00' } });
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-01-fam.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-13' } });
  const intentArchived = fs.existsSync(path.join(root, 'workflow', 'archive', '2026-10', 'intents', '2026-09-01-fam.md'));
  const planArchived = fs.existsSync(path.join(root, 'workflow', 'archive', '2026-10', 'plans', '2026-09-01-fam.md'));
  check('S43 关单即归档：终态家族整族 git mv 进 archive（intent+plan 同批）',
    r.status === 0 && intentArchived && planArchived && /📦 归档/.test(r.stdout),
    JSON.stringify({ status: r.status, stdout: String(r.stdout).slice(-300), intentArchived, planArchived }));
  check('S43b 归档后活跃目录不再留该家族', !fs.existsSync(path.join(ip, '2026-09-01-fam.md')) && !fs.existsSync(path.join(pp, '2026-09-01-fam.md')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S44 归档边界：本次确认的家族即时归档（窗口对其冗余）；未涉及的家族不越权清理 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-arch2-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const ip = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(ip, { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'archive'), { recursive: true }); // 归档约定在场（启用条件）
  // 本次确认的家族（刚落终态 → 即时归档，窗口不适用）
  fs.writeFileSync(path.join(ip, '2026-10-12-fresh.md'), '---\n状态: approved\n级别: L1\n确认指纹: bbbb2222bbbb2222\n---\n# I\n\n## 验收标准（可测试）\n- [x] 通过（证据:测试全绿）\n', 'utf8');
  // 未涉及的家族（同为终态、超窗、零引用——但不在本次确认范围，须留守）
  fs.writeFileSync(path.join(ip, '2026-09-01-other.md'), '---\n状态: done\n级别: L1\n---\n# I2\n\n## 验收标准（可测试）\n- [x] 通过（证据:测试全绿）\n', 'utf8');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-12T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-10-12T10:00:00+08:00' } });
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-12-fresh.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-13' } });
  check('S44 本次确认家族即时归档（窗口对刚过确认门的终态件冗余）',
    r.status === 0 && fs.existsSync(path.join(root, 'workflow', 'archive', '2026-10', 'intents', '2026-10-12-fresh.md')) && /📦 归档/.test(r.stdout),
    JSON.stringify({ status: r.status, stdout: String(r.stdout).slice(-200) }));
  check('S44b 未涉及的家族不越权清理（历史积压走 archive-sweep 手工批次）',
    fs.existsSync(path.join(ip, '2026-09-01-other.md')),
    JSON.stringify({ exists: fs.existsSync(path.join(ip, '2026-09-01-other.md')) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S45 归档约定缺席 → 不启用（未采纳归档的仓库不凭空造目录）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-arch3-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const ip = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(ip, { recursive: true });
  fs.writeFileSync(path.join(ip, '2026-09-01-noconv.md'), '---\n状态: approved\n级别: L1\n确认指纹: cccc3333cccc3333\n---\n# I\n\n## 验收标准（可测试）\n- [x] 通过（证据:测试全绿）\n', 'utf8');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-09-01T10:00:00+08:00' } });
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-09-01-noconv.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-13' } });
  check('S45 无 workflow/archive/ 约定 → 不归档、不造目录',
    r.status === 0 && fs.existsSync(path.join(ip, '2026-09-01-noconv.md')) && !fs.existsSync(path.join(root, 'workflow', 'archive')) && !/📦 归档/.test(r.stdout),
    JSON.stringify({ status: r.status, stdout: String(r.stdout).slice(-200) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S46 特性分支关单不归档（2026-10-15）：合并前保持活跃路径 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-arch-topic-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'topic/demo');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const ip = path.join(root, 'workflow', 'intents');
  fs.mkdirSync(ip, { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(ip, '2026-10-12-topic.md'), '---\n状态: approved\n级别: L1\n确认指纹: dddd4444dddd4444\n---\n# I\n\n## 验收标准（可测试）\n- [x] 通过（证据:测试全绿）\n', 'utf8');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'c1'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-12T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-10-12T10:00:00+08:00' } });
  const r = spawnSync(process.execPath, [CLI, 'workflow/intents/2026-10-12-topic.md', '--delegated', '可以'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CONFIRM_DOC_TEST_NOW: '2026-10-13' } });
  check('S46 特性分支关单不归档，文件留在活跃目录',
    r.status === 0 && fs.existsSync(path.join(ip, '2026-10-12-topic.md'))
      && !fs.existsSync(path.join(root, 'workflow', 'archive', '2026-10', 'intents', '2026-10-12-topic.md'))
      && /特性分支 topic\/demo 不归档/.test(r.stdout),
    JSON.stringify({ status: r.status, stdout: String(r.stdout).slice(-300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- G1–G7【关单格式门】验收面机器可读格式（2026-10-13 done-evidence-gate；判据单源 stage-gates.acceptanceEvidenceGate）----
const gitInit = (root) => {
  spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['init', '-q'], { cwd: root });
};
const gitCommit = (root, msg, date) => {
  const args = ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg];
  if (date) args.splice(1, 0, `--date=${date}`);
  spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['add', '-A'], { cwd: root });
  spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', args, { cwd: root, env: date ? { ...process.env, GIT_COMMITTER_DATE: date } : process.env });
};
const closeDoc = (root, rel) => spawnSync(process.execPath, [CLI, rel, '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
const intentDoc = (acceptBody) => `---\n状态: approved\n级别: L1\n日期: 2026-10-13\n模块: infra\n---\n# I — g\n\n## 验收标准\n\n${acceptBody}\n`;

// G1：intent 勾选项缺「证据：」→ 拒绝（exit 2 + 零写盘 + 零落账）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg1-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p = path.join(root, 'workflow', 'intents', '2026-10-13-g1.md');
  fs.writeFileSync(p, intentDoc('- [x] 用例通过'));
  gitInit(root); gitCommit(root, 'init');
  const r = closeDoc(root, 'workflow/intents/2026-10-13-g1.md');
  const after = fs.readFileSync(p, 'utf8');
  check('G1 关单格式门：[x] 缺证据标注 → exit 2 + 零写盘 + 零落账',
    r.status === 2 && /关单格式门/.test(r.stderr) && /缺「证据：」/.test(r.stderr) && after.includes('状态: approved') && readLedgerOf(root).length === 0,
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 220) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G2：证据在同行/续行均认 → 放行落 done
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg2-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p1 = path.join(root, 'workflow', 'intents', '2026-10-13-g2a.md');
  const p2 = path.join(root, 'workflow', 'intents', '2026-10-13-g2b.md');
  fs.writeFileSync(p1, intentDoc('- [x] 用例通过（证据：scripts/x.test.mjs 3/3）'));
  fs.writeFileSync(p2, intentDoc('- [x] 用例通过\n  （证据：scripts/x.test.mjs 3/3）'));
  gitInit(root); gitCommit(root, 'init');
  const ra = closeDoc(root, 'workflow/intents/2026-10-13-g2a.md');
  const rb = closeDoc(root, 'workflow/intents/2026-10-13-g2b.md');
  check('G2 关单格式门：证据同行/续行 → 放行落 done + 台账 done 行',
    ra.status === 0 && rb.status === 0
    && fs.readFileSync(p1, 'utf8').includes('状态: done') && fs.readFileSync(p2, 'utf8').includes('状态: done')
    && readLedgerOf(root).filter((e) => e.stage === 'done').length === 2,
    JSON.stringify({ ra: ra.status, rb: rb.status, err: String(ra.stderr).slice(0, 160) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G3：存在 [ ] 未勾项 → 拒绝（s08 验收未对账同源）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg3-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p = path.join(root, 'workflow', 'intents', '2026-10-13-g3.md');
  fs.writeFileSync(p, intentDoc('- [x] 甲（证据：x）\n- [ ] 乙未完成'));
  gitInit(root); gitCommit(root, 'init');
  const r = closeDoc(root, 'workflow/intents/2026-10-13-g3.md');
  check('G3 关单格式门：未勾项 → exit 2 且报「未勾验项」',
    r.status === 2 && /未勾验项/.test(r.stderr), JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 200) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G4：legacy 标记 → 跳过放行（无证据也放行，存量口径）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg4-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p = path.join(root, 'workflow', 'intents', '2026-10-13-g4.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L1\n日期: 2026-10-13\n流程: legacy\n---\n# I\n\n## 验收标准\n\n- [x] 无证据项\n');
  gitInit(root); gitCommit(root, 'init');
  const r = closeDoc(root, 'workflow/intents/2026-10-13-g4.md');
  check('G4 关单格式门：legacy 标记 → 跳过放行', r.status === 0 && fs.readFileSync(p, 'utf8').includes('状态: done'),
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 160) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G5：旧时代文档（首加 author date < 2026-09-12）→ isNew=false 放行（s08 存量双轨同源）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg5-'));
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  const p = path.join(root, 'workflow', 'intents', '2026-09-01-g5.md');
  fs.writeFileSync(p, intentDoc('- [x] 无证据项'));
  gitInit(root); gitCommit(root, 'init', '2026-09-01T10:00:00+08:00');
  const r = closeDoc(root, 'workflow/intents/2026-09-01-g5.md');
  check('G5 关单格式门：旧时代首加（accCutoff 前）→ 放行', r.status === 0,
    JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 160) }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G6：L2 spec —— 缺「验收判据」节拒 / 空表拒 / 有数据行放行
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg6-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  const mk = (name, body) => { const p = path.join(root, 'workflow', 'specs', name); fs.writeFileSync(p, body); return p; };
  mk('2026-10-13-g6a.md', '---\n状态: approved\n级别: L2\n日期: 2026-10-13\n模块: infra\n---\n# S a\n');
  mk('2026-10-13-g6b.md', '---\n状态: approved\n级别: L2\n日期: 2026-10-13\n模块: infra\n---\n# S b\n\n## 验收判据\n\n| 判据 | 证据 |\n|---|---|\n');
  mk('2026-10-13-g6c.md', '---\n状态: approved\n级别: L2\n日期: 2026-10-13\n模块: infra\n---\n# S c\n\n## 验收判据\n\n| 判据 | 证据 |\n|---|---|\n| 构建绿 | verify.mjs |\n');
  // 委派台账在场门夹具（2026-10-25 优化4）：g6c 走 done 成功路径，须先有台账行（判据与检查 18 一致）
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-10-13 | 自做 2026-10-13-g6c 关单 | 一次通过 | 在场门夹具 |  |\n');
  gitInit(root); gitCommit(root, 'init');
  const r1 = closeDoc(root, 'workflow/specs/2026-10-13-g6a.md');
  const r2 = closeDoc(root, 'workflow/specs/2026-10-13-g6b.md');
  const r3 = closeDoc(root, 'workflow/specs/2026-10-13-g6c.md');
  check('G6 关单格式门：spec 缺判据节/空表拒、有数据行放行',
    r1.status === 2 && /缺「## 验收判据」/.test(r1.stderr) && r2.status === 2 && /无数据行/.test(r2.stderr) && r3.status === 0,
    JSON.stringify({ r1: r1.status, r2: r2.status, r3: r3.status }));
  fs.rmSync(root, { recursive: true, force: true });
}
// G7：独立 L1 plan 执法 / 有同名 intent 在场则 plan 不在对账面（s08 口径）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-eg7-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-10-13-g7.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L1\n日期: 2026-10-13\n模块: infra\n---\n# P\n\n## 验收标准\n\n- [x] 无证据项\n');
  gitInit(root); gitCommit(root, 'init');
  const r1 = closeDoc(root, 'workflow/plans/2026-10-13-g7.md');
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-13-g7.md'), '---\n状态: approved\n级别: L1\n---\n# I\n');
  gitCommit(root, 'add intent');
  const r2 = closeDoc(root, 'workflow/plans/2026-10-13-g7.md');
  check('G7 关单格式门：独立 L1 plan 拒 / 同名 intent 在场放行（对账面归 intent）',
    r1.status === 2 && /缺「证据：」/.test(r1.stderr) && r2.status === 0,
    JSON.stringify({ r1: r1.status, r2: r2.status, stderr: String(r1.stderr).slice(0, 160) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S50【歧义清单门】clarify-ledger（2026-10-22）----
// 判据：锚后（policy clarifySince 2026-10-22）新建 spec 的 draft→approved 须过
//       6 维闭集 × 状态闭集 × 待澄清归零 × 依据非空；锚前存量与缺「日期」不可判定者零阻断。
// 重点钉住「缺维 ≠ 无歧义」——旧机制的失败点正是把「没写」当成「没问题」。
{
  const row = (dim, status, basis = '见功能行为 §1') => `| ${dim} | 无歧义 | ${basis} | ${status} |`;
  const DIMS = ['状态与边界', '数据口径', '失败路径', '契约对称', '存量数据', '验收可测性'];
  const table = (over = {}, drop = []) => [
    '## 歧义清单', '| 维度 | 结论 | 依据 / 问题 | 状态 |', '|---|---|---|---|',
    ...DIMS.filter((d) => !drop.includes(d)).map((d) => row(d, over[d] || '已定')),
  ].join('\n');
  const mkClarifyRoot = (specDate, body) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-clar-'));
    for (const d of ['workflow/intents', 'workflow/specs', '.agents/config']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 13 }));
    fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-z.md'), '---\n状态: approved\n级别: L2\n日期: 2026-09-30\n---\n# I\n');
    fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-z.md'), `---\n状态: draft\n级别: L2\n日期: ${specDate}\n---\n# S\n\n${body}\n`);
    return root;
  };
  const runC = (root) => spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-z.md', '--delegated', '歧义已清，可以'], { cwd: root, encoding: 'utf8' });
  const statusOf = (root) => fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-z.md'), 'utf8');

  {
    const root = mkClarifyRoot('2026-10-22', table());
    const r = runC(root);
    check('S50a 歧义清单齐备（6 维全已定 + 依据齐）→ exit 0 落 approved',
      r.status === 0 && statusOf(root).includes('状态: approved'), JSON.stringify({ s: r.status, e: r.stderr }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mkClarifyRoot('2026-10-22', table({}, ['数据口径']));
    const r = runC(root);
    check('S50b 缺「数据口径」维 → exit 2 + 点名缺维 + 未落盘（缺维≠无歧义）',
      r.status === 2 && /缺维度/.test(r.stderr) && /数据口径/.test(r.stderr) && statusOf(root).includes('状态: draft'),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mkClarifyRoot('2026-10-22', table({ '失败路径': '待澄清' }));
    const r = runC(root);
    check('S50c 仍有待澄清项 → exit 2 + 点名维度 + 未落盘',
      r.status === 2 && /待澄清未关闭/.test(r.stderr) && /失败路径/.test(r.stderr) && statusOf(root).includes('状态: draft'),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mkClarifyRoot('2026-10-01', '# 无歧义清单的存量 spec');
    const r = runC(root);
    check('S50d 锚前存量（日期 < clarifySince）无歧义清单 → 放行落 approved（存量零阻断）',
      r.status === 0 && statusOf(root).includes('状态: approved'), JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 上界（2026-10-22）：清单是收敛工具不是工作台——同维 >2 行说明该维没想清。
    const body = [
      '## 歧义清单', '| 维度 | 结论 | 依据 / 问题 | 状态 |', '|---|---|---|---|',
      ...DIMS.map((d) => `| ${d} | 无歧义 | 见功能行为 §1 | 已定 |`),
      '| 数据口径 | 空值是否计 0 | 未查 | 已定 |',
      '| 数据口径 | 精度保留几位 | 未查 | 已定 |',
    ].join('\n');
    const root = mkClarifyRoot('2026-10-22', body);
    const r = runC(root);
    check('S50e 同一维超 2 行 → exit 2 + 点名该维（反确认税上界）',
      r.status === 2 && /超过 2 行/.test(r.stderr) && /数据口径/.test(r.stderr) && statusOf(root).includes('状态: draft'),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- S51【验收覆盖门】coverage-map（2026-10-22）----
// 判据：锚后 spec 的 intent 验收须编号 A1..An，且每条至少被「验收判据」表第 4 列引用一次（只做单向）。
// 反向不强制：技术性判据留空合法——避免为凑映射编造验收。
{
  const CLR = [
    '## 歧义清单', '| 维度 | 结论 | 依据 / 问题 | 状态 |', '|---|---|---|---|',
    ...['状态与边界', '数据口径', '失败路径', '契约对称', '存量数据', '验收可测性']
      .map((d) => `| ${d} | 无歧义 | 见功能行为 §1 | 已定 |`),
  ].join('\n');
  const HEAD = '| 判据（可观察行为） | 证据（测试文件 / 命令 / 证据文件） | 状态 | 对应验收 |\n|---|---|---|---|';
  const mkCov = (intentAcc, specRows) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-cov-'));
    for (const d of ['workflow/intents', 'workflow/specs', '.agents/config']) fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'config', 'engine.json'), JSON.stringify({ policyVersion: 14 }));
    fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-30-v.md'),
      `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n---\n# I\n\n## 验收标准（可测试）\n${intentAcc}\n`);
    fs.writeFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-v.md'),
      `---\n状态: draft\n级别: L2\n日期: 2026-10-22\n---\n# S\n\n${CLR}\n\n## 验收判据\n${HEAD}\n${specRows}\n`);
    return root;
  };
  const runCov = (root) => spawnSync(process.execPath, [CLI, 'workflow/specs/2026-09-30-v.md', '--delegated', '覆盖已核'], { cwd: root, encoding: 'utf8' });
  const covStatus = (root) => fs.readFileSync(path.join(root, 'workflow', 'specs', '2026-09-30-v.md'), 'utf8');
  const ACC2 = '- [x] A1 非本人改单 → 400\n- [x] A2 本人改单成功';
  const FULLROWS = '| 非本人改单 400 | 单测 X | 覆盖 | A1 |\n| 本人改单成功 | 单测 Y | 覆盖 | A2 |';

  {
    const root = mkCov(ACC2, FULLROWS);
    const r = runCov(root);
    check('S51a 每条验收均被判据引用 → exit 0 落 approved',
      r.status === 0 && covStatus(root).includes('状态: approved'), JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mkCov(ACC2, '| 非本人改单 400 | 单测 X | 覆盖 | A1 |');
    const r = runCov(root);
    check('S51b 漏覆盖一条验收（A2）→ exit 2 + 点名未覆盖编号 + 未落盘',
      r.status === 2 && /未覆盖/.test(r.stderr) && /A2/.test(r.stderr) && covStatus(root).includes('状态: draft'),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = mkCov('- [x] 非本人改单 → 400\n- [x] 本人改单成功', FULLROWS);
    const r = runCov(root);
    check('S51c 入口验收未编号 → exit 2 + 要求补 A1..An + 未落盘',
      r.status === 2 && /未编号/.test(r.stderr) && covStatus(root).includes('状态: draft'),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 300) }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- S52 引文接地纯函数（delegated-quote-grounding）：规范化 ----
{
  check('S52 normalizeQuote：去空白/中英标点/引号并小写（保留汉字与字母数字）',
    normalizeQuote('  可以，「提交」并关单。  ') === '可以提交并关单'
      && normalizeQuote('UI 实测 OK') === 'ui实测ok',
    JSON.stringify([normalizeQuote('  可以，「提交」并关单。  '), normalizeQuote('UI 实测 OK')]));
}

// ---- S53 最长逐字锚点：hasAnchorAtLeast 与 longestCommonAnchor 等价 ----
{
  const cases = [
    ['确认第三点库存扣减口径', '本轮按确认第三点库存扣减口径落地', true],
    ['确认库存口径', '本轮按确认第三点库存扣减口径落地', false],
    ['完全无关的一句话', '本轮按确认第三点库存扣减口径落地', false],
  ];
  const eq = cases.every(([q, h, want]) => {
    const lcs = longestCommonAnchor(q, h);
    return hasAnchorAtLeast(q, h, GROUND_ANCHOR_MIN) === (lcs >= GROUND_ANCHOR_MIN)
      && (lcs >= GROUND_ANCHOR_MIN) === want;
  });
  check('S53 hasAnchorAtLeast ≡ longestCommonAnchor ≥ K（K=GROUND_ANCHOR_MIN）', eq
    && longestCommonAnchor('abc', '') === 0 && longestCommonAnchor('', 'x') === 0
    && longestCommonAnchor('abcd', 'zzabcdzz') === 4,
    JSON.stringify(cases.map(([q, h]) => [q, longestCommonAnchor(q, h)])));
}

// ---- S54 groundQuote 三层判据：verbatim / anchor / generic / ungrounded / empty ----
{
  const doc = '## 改动方案\n本条确认第三点库存扣减口径与反写链路一致，避免重复扣减。';
  const verbatim = groundQuote({ quote: '本条确认第三点库存扣减口径与反写链路一致', docText: doc });
  const anchor = groundQuote({ quote: '好的，第三点库存扣减口径就按这个来', docText: doc });
  const generic = groundQuote({ quote: '好的，提交并关单', docText: doc });
  const ungrounded = groundQuote({ quote: '把采购单打印模板表头全部改成居中', docText: doc });
  const empty = groundQuote({ quote: '   ', docText: doc });
  check('S54a 逐字命中 → ok/verbatim', verbatim.ok && verbatim.reason === 'verbatim', JSON.stringify(verbatim));
  check('S54b 复述含 8 字以上逐字串 → ok/anchor', anchor.ok && anchor.reason === 'anchor', JSON.stringify(anchor));
  check('S54c 纯放行语（残余为空）→ ok/generic',
    generic.ok && generic.reason === 'generic' && stripRelease(normalizeQuote('好的，提交并关单')) === '',
    JSON.stringify(generic));
  check('S54d 指涉他件内容（残余找不到落点）→ !ok/ungrounded',
    !ungrounded.ok && ungrounded.reason === 'ungrounded' && ungrounded.residual.length > 2,
    JSON.stringify(ungrounded));
  check('S54e 空引文 → !ok/empty', !empty.ok && empty.reason === 'empty', JSON.stringify(empty));
  check('S54f 家族正文同样算接地（引文命中同名 spec/plan 即成立）',
    groundQuote({ quote: '同族：定额明细多条并存', docText: doc, familyTexts: ['定额明细多条并存而非只记最后一条'] }).ok);
}

// ---- S55 文档/家族解析：活跃命中 + 归档回落 + 缺失 ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ground-resolve-'));
  const mk = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  mk('workflow/plans/2026-10-22-x.md', '---\n状态: draft\n---\n活跃 plan 正文');
  mk('workflow/intents/2026-10-22-x.md', '---\n状态: approved\n---\n同族 intent 正文');
  mk('workflow/archive/2026-10/plans/2026-09-01-y.md', '---\n状态: done\n---\n归档 plan 正文');
  const live = resolveDocText(root, 'workflow/plans/2026-10-22-x.md');
  const archived = resolveDocText(root, 'workflow/plans/2026-09-01-y.md');
  const missing = resolveDocText(root, 'workflow/plans/2026-01-01-none.md');
  const fam = resolveFamilyTexts(root, 'workflow/plans/2026-10-22-x.md');
  check('S55a 活跃文档直读', live && !live.archived && live.text.includes('活跃 plan 正文'), JSON.stringify(live));
  check('S55b 活跃路径缺失 → 归档回落并标记 archived',
    archived && archived.archived && archived.text.includes('归档 plan 正文'), JSON.stringify(archived));
  check('S55c 活跃与归档都没有 → null（唯一硬拦形态）', missing === null);
  check('S55d 家族解析含同名 intent 且排除自身',
    fam.length === 1 && fam[0].includes('同族 intent 正文'), JSON.stringify(fam));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S56–S58 引文接地的落账行为（默认 advisory / --strict-quote 收硬）----
{
  // 夹具：plan draft + 已确认 L1 入口（存量口径免台账）——同 S11，绕过逐阶段门只留接地判据
  const mkRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ground-cli-'));
    fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-22-q.md'),
      '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n---\n# I（S56 入口夹具）\n');
    fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-22-q.md'),
      '---\n状态: draft\n级别: L2\n---\n# P\n## 改动方案\n本条确认第三点库存扣减口径与反写链路一致。\n');
    return root;
  };
  const DOC = 'workflow/plans/2026-10-22-q.md';
  const UNGROUNDED_QUOTE = '把采购单打印模板表头全部改成居中';
  const GROUNDED_QUOTE = '本条确认第三点库存扣减口径与反写链路一致';

  // S56 --strict-quote + 接地不成立 → 拒绝落账（不写盘、不 append 台账、exit 2）
  {
    const root = mkRoot();
    const r = spawnSync(process.execPath,
      [CLI, DOC, '--delegated', UNGROUNDED_QUOTE, '--strict-quote'], { cwd: root, encoding: 'utf8' });
    const after = fs.readFileSync(path.join(root, DOC), 'utf8');
    check('S56 --strict-quote + 引文接地不成立 → exit 2 + 点名残余 + 未落盘 + 零台账',
      r.status === 2 && /接地未成立/.test(r.stderr) && after.includes('状态: draft') && readLedgerOf(root).length === 0,
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 400) }));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // S57 默认 advisory：接地不成立仍放行，但 WARN + 台账行记 quoteGrounding=ungrounded
  {
    const root = mkRoot();
    const r = spawnSync(process.execPath,
      [CLI, DOC, '--delegated', UNGROUNDED_QUOTE], { cwd: root, encoding: 'utf8' });
    const after = fs.readFileSync(path.join(root, DOC), 'utf8');
    const led = readLedgerOf(root);
    check('S57 默认 advisory：exit 0 + 落态 + 台账 quoteGrounding=ungrounded + stderr 有 WARN',
      r.status === 0 && after.includes('状态: approved')
        && led.length === 1 && led[0].quoteGrounding === 'ungrounded' && led[0].quote === UNGROUNDED_QUOTE
        && /advisory/.test(r.stderr),
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 400), led }));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // S58 --strict-quote + 接地成立 → 照常落账（证明收硬不误伤合规引文）
  {
    const root = mkRoot();
    const r = spawnSync(process.execPath,
      [CLI, DOC, '--delegated', GROUNDED_QUOTE, '--strict-quote'], { cwd: root, encoding: 'utf8' });
    const led = readLedgerOf(root);
    check('S58 --strict-quote + 逐字引文 → exit 0 + 落态 + 台账 quoteGrounding=verbatim',
      r.status === 0 && led.length === 1 && led[0].quoteGrounding === 'verbatim',
      JSON.stringify({ s: r.status, e: String(r.stderr).slice(0, 400), led }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- S59-S63 关单完成度门（closeout-completeness 2026-10-24）----
// 纯函数面：L2/L3 intent →done 的同名 plan / 独立复核判据（confirm-doc 主循环调用同源）。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-closeout-'));
  const wf = (d) => { fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true }); };
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body);
  wf('intents'); wf('specs'); wf('plans');
  write('workflow/intents/k.md', '---\n状态: approved\n级别: L2\n---\n# I\n');
  check('S59 planConfirmedFor：缺同名 plan → 拒', planConfirmedFor(root, 'k').ok === false);
  write('workflow/plans/k.md', '---\n状态: approved\n日期: 2026-01-01\n级别: L2\n---\n# P\n');
  check('S60 planConfirmedFor：同名 plan 已确认（存量日期口径）→ 放行', planConfirmedFor(root, 'k').ok === true);
  check('S61 reviewLineFor：intent/spec 均无复核行 → 拒', reviewLineFor(root, 'k').ok === false);
  write('workflow/specs/k.md', '---\n状态: approved\n级别: L2\n---\n# S\n- 独立复核：PASS\n');
  check('S62 reviewLineFor：有复核行但缺复核上下文 → 拒', reviewLineFor(root, 'k').ok === false);
  write('workflow/specs/k.md', '---\n状态: approved\n级别: L2\n---\n# S\n- 独立复核：PASS（复核上下文：sess-1）\n');
  check('S63 reviewLineFor：复核行 + 上下文 → 放行', reviewLineFor(root, 'k').ok === true);
  // S64（2026-10-24 复核 m1）：首个复核行缺上下文、后续行有 → 须放行（原 find() 只看首行会误拒）
  write('workflow/specs/k.md', '---\n状态: approved\n级别: L2\n---\n# S\n- 独立复核：PASS\n- 独立复核：补充（复核上下文：sess-2）\n');
  check('S64 reviewLineFor：首个复核行缺上下文、次行有 → 放行', reviewLineFor(root, 'k').ok === true, JSON.stringify(reviewLineFor(root, 'k')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S65–S68 承诺面绑定（approved-content-binding 2026-10-27）----
// 语义：用户在 approved 那一刻点头的是「承诺面」（判据文本/红线/目标/改动方案）；关单期合法动作
// （勾验收 + 证据回填 / 确认结果 / 复核行）不改承诺面，故归一掉；承诺被改写则须重新点头。
{
  // S65：approved 后改写验收判据文本 → done 拒绝（承诺面绑定门；exit 2 + 零落账 + 指引 --reconfirm）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-commit-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-10-27-cm1.md');
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n---\n# P\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n');
  gitHead(root);
  const appr = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm1.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  // 承诺改写：判据文本 甲 → 乙（勾选态与证据括号不变）
  const cur = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cur.replace('判据甲', '判据乙'));
  const close = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm1.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  const after = fs.readFileSync(p, 'utf8');
  check('S65 承诺面改写：approved→done 拒绝（exit 2 + 承诺面绑定门 + 零落账零台账）',
    appr.status === 0 && close.status === 2 && /承诺面绑定门/.test(close.stderr) && /--reconfirm/.test(close.stderr)
      && after.includes('状态: approved') && !led.some((e) => e.stage === 'done'),
    JSON.stringify({ appr: appr.status, close: close.status, stderr: String(close.stderr).slice(0, 300), done: led.some((e) => e.stage === 'done') }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S66：勾验收 + 证据回填（承诺面未变）→ done 放行（不误伤标准关单序列）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-commit-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-10-27-cm2.md');
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n---\n# P\n\n## 验收标准\n\n- [ ] 1. 判据甲\n');
  gitHead(root);
  const appr = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm2.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  // 关单期合法动作：勾验收 + 补证据（判据文本未变）
  const cur = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cur.replace('- [ ] 1. 判据甲', '- [x] 1. 判据甲（证据：commit abc）'));
  const close = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm2.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  check('S66 勾验收 + 证据回填：承诺面未变 → done 放行（不误伤）',
    appr.status === 0 && close.status === 0 && fs.readFileSync(p, 'utf8').includes('状态: done')
      && led.some((e) => e.stage === 'done') && !/承诺面绑定门/.test(close.stderr),
    JSON.stringify({ appr: appr.status, close: close.status, stderr: String(close.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S67：--reconfirm 重录承诺面指纹（状态仍 approved；台账追加 approved 行带 commit）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-commit-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-10-27-cm3.md');
  fs.writeFileSync(p, '---\n状态: draft\n级别: L1\n---\n# P\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n');
  gitHead(root);
  spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm3.md', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const cur = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cur.replace('判据甲', '判据乙'));
  const rc = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm3.md', '--reconfirm', '--delegated', '可以'], { cwd: root, encoding: 'utf8' });
  const led = readLedgerOf(root);
  const apprRows = led.filter((e) => e.stage === 'approved');
  const after = fs.readFileSync(p, 'utf8');
  check('S67 --reconfirm：状态仍 approved + 台账重录 approved 行（带承诺面指纹）',
    rc.status === 0 && after.includes('状态: approved') && apprRows.length >= 2
      && apprRows[apprRows.length - 1].reconfirm === true && typeof apprRows[apprRows.length - 1].commit === 'string',
    JSON.stringify({ status: rc.status, stderr: String(rc.stderr).slice(0, 300), rows: apprRows.length }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S68：委派台账在场门 —— 无 frontmatter 日期、文件名带日期 → 门适用（拒），补台账行后放行
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-commit-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  const p = path.join(root, 'workflow', 'plans', '2026-10-27-cm4.md');
  fs.writeFileSync(p, '---\n状态: approved\n级别: L2\n---\n# P\n\n## 验收标准\n\n- [x] 1. 判据甲（证据：commit abc）\n');
  gitHead(root);
  gitAt(root, 'add', '-A');
  gitAt(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'approved');
  const noRow = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm4.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'workflow', 'delegations.md'),
    '## 自做任务结果\n| 日期 | 任务一句话 | 结果 | 备注 | 返工原因 |\n|------|------------|------|------|----------|\n| 2026-10-27 | 自做 2026-10-27-cm4 关单 | 一次通过 | 夹具 |  |\n');
  const withRow = spawnSync(process.execPath, [CLI, 'workflow/plans/2026-10-27-cm4.md', '--delegated', '关单'], { cwd: root, encoding: 'utf8' });
  check('S68 委派门日期兜底：无日期字段的 L2 doc（文件名带日期）→ 门适用；补台账行后放行',
    noRow.status === 2 && /委派台账在场门/.test(noRow.stderr) && /2026-10-27/.test(noRow.stderr)
      && withRow.status === 0 && fs.readFileSync(p, 'utf8').includes('状态: done'),
    JSON.stringify({ noRow: noRow.status, withRow: withRow.status, stderr: String(noRow.stderr).slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
