// compact-ledgers.test.mjs — 测试台账分片打包归并工具
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// fileURLToPath 解码百分号编码：非 ASCII 检出路径（如中文 worktree 名）下 pathname 会编码成 %E5%8F%98…，
// 子进程按坏路径启动 → status 1 / 空 stdout（2026-10-17 实证）
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'compact-ledgers.mjs');

// 2026-11-05 CLI 写侧 fail-closed（非 git 目录拒写台账，paths.mjs testAnyRootAllowed）的
// **仅测试**逃生门：本套件夹具是非 git 临时目录（历史「就地操作」契约）。双条件须同时
// NODE_ENV=test（生产路径不设）。子进程默认继承本进程 env，套件内既有场景零改动。
process.env.NODE_ENV = 'test';
process.env.LEDGER_CLI_TEST_ANYROOT = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));

try {
  const mainLedger = path.join(tmp, '.agents', 'confirmations.jsonl');
  const shardDir = path.join(tmp, '.agents', 'confirmations.d');
  fs.mkdirSync(shardDir, { recursive: true });

  fs.writeFileSync(mainLedger, '{"id":1}\n{"id":2}\n');
  fs.writeFileSync(path.join(shardDir, 'shard-a.jsonl'), '{"id":2}\n{"id":3}\n');
  fs.writeFileSync(path.join(shardDir, 'shard-b.jsonl'), '{"id":4}\n');

  const proc = spawnSync(process.execPath, [cliPath], { cwd: tmp, encoding: 'utf8' });

  check('S1 CLI exit 0', proc.status === 0, proc.stderr);

  const merged = fs.readFileSync(mainLedger, 'utf8');
  check('S2 主台账包含完整合并行', merged === '{"id":1}\n{"id":2}\n{"id":3}\n{"id":4}\n', merged);
  check('S3 分片目录文件已清理', !fs.existsSync(shardDir) || fs.readdirSync(shardDir).length === 0);
  check('S7 成功打包后无 .tmp 残留', !fs.existsSync(path.join(tmp, '.agents', 'confirmations.jsonl.tmp')));

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 场景B：读取失败 → 整体中止，主台账与分片原样保留
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));
try {
  const mainLedger2 = path.join(tmp2, '.agents', 'confirmations.jsonl');
  const shardDir2 = path.join(tmp2, '.agents', 'confirmations.d');
  fs.mkdirSync(shardDir2, { recursive: true });
  const mainBefore = '{"id":9}\n';
  fs.writeFileSync(mainLedger2, mainBefore);
  fs.writeFileSync(path.join(shardDir2, 'shard-ok.jsonl'), '{"id":10}\n');
  // 读不出来的分片：*.jsonl 名字的目录（readFileSync 对目录抛错，win32/linux 均可复现）
  fs.mkdirSync(path.join(shardDir2, 'shard-bad.jsonl'));

  const proc2 = spawnSync(process.execPath, [cliPath], { cwd: tmp2, encoding: 'utf8' });

  check('S4 读取失败时 CLI exit 非 0', proc2.status !== 0, `status=${proc2.status}`);
  check('S5 主台账保持原样', fs.readFileSync(mainLedger2, 'utf8') === mainBefore, fs.readFileSync(mainLedger2, 'utf8'));
  check('S6 分片目录原样保留（含读失败分片）',
    fs.existsSync(shardDir2) &&
    fs.existsSync(path.join(shardDir2, 'shard-ok.jsonl')) &&
    fs.existsSync(path.join(shardDir2, 'shard-bad.jsonl')));
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// 场景C：主台账写入失败 → 整体中止，主台账与分片原样保留
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));
try {
  const mainLedger3 = path.join(tmp3, '.agents', 'confirmations.jsonl');
  const shardDir3 = path.join(tmp3, '.agents', 'confirmations.d');
  fs.mkdirSync(shardDir3, { recursive: true });
  const mainBefore3 = '{"id":11}\n';
  fs.writeFileSync(mainLedger3, mainBefore3);
  fs.writeFileSync(path.join(shardDir3, 'shard-c.jsonl'), '{"id":12}\n');
  // 逼出写入失败：临时文件路径预置为目录（writeFileSync 对目录抛错）
  fs.mkdirSync(path.join(tmp3, '.agents', 'confirmations.jsonl.tmp'));

  const proc3 = spawnSync(process.execPath, [cliPath], { cwd: tmp3, encoding: 'utf8' });

  check('S8 写入失败时 CLI exit 非 0', proc3.status !== 0, `status=${proc3.status}`);
  check('S9 主台账保持原样', fs.readFileSync(mainLedger3, 'utf8') === mainBefore3, fs.readFileSync(mainLedger3, 'utf8'));
  check('S10 分片目录原样保留', fs.existsSync(shardDir3) && fs.existsSync(path.join(shardDir3, 'shard-c.jsonl')));
} finally {
  fs.rmSync(tmp3, { recursive: true, force: true });
}

// 场景D：收缩期间分片被并发写者持锁（<分片>.lock）→ compact 拒绝无锁收缩（2026-11-05 并发修复回归）
// 旧实现「读分片→tmp+rename 写主→unlink」全程无锁：收缩期间并发确认追加（ledger-loader.
// writeConfirmation / confirm-doc）落到该分片时，新行既没进 merged 又随 unlink 静默丢失。
// 修复后 compact 对每个分片持 `<分片>.lock`（复用 ledger-shards 的 withLedgerLock，与追加者同把锁）。
// 确定性：子进程先持住分片锁并空转 > withLedgerLock 等待上限（3s）、< 陈旧接管线（15s）——
//   修复前：compact 全程无锁，照常「合并→unlink」成功（exit 0），持锁者形同虚设（RED）；
//   修复后：compact 拿锁等待超时 → 响亮非零退出，分片不删、主台账原样；锁释放后重跑成功（GREEN）。
{
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  try {
    const mainLedger4 = path.join(tmp4, '.agents', 'confirmations.jsonl');
    const shardDir4 = path.join(tmp4, '.agents', 'confirmations.d');
    fs.mkdirSync(shardDir4, { recursive: true });
    const mainBefore4 = '{"id":20}\n';
    fs.writeFileSync(mainLedger4, mainBefore4);
    const shardPath = path.join(shardDir4, 'shard-held.jsonl');
    fs.writeFileSync(shardPath, '{"id":21}\n');

    // 子进程持锁 6s（> 3s 等待上限，< 15s 陈旧接管——不靠时序运气）
    const modUrl = new URL('../scripts/ledger-shards.mjs', import.meta.url).href;
    const child = spawn(process.execPath, [
      '-e',
      `import(${JSON.stringify(modUrl)}).then(m => m.withLedgerLock(process.argv[1], () => { console.log('LOCKED'); const g = Date.now() + 6000; while (Date.now() < g) {} })).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })`,
      shardPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let locked = false; // 同步轮询等锁就位（等不到就红，不假绿）
    for (let i = 0; i < 800 && !locked; i++) { locked = fs.existsSync(shardPath + '.lock'); if (!locked) sleepSync(25); }
    check('S11 前置：子进程已持住分片锁', locked);
    if (locked) {
      const proc4 = spawnSync(process.execPath, [cliPath], { cwd: tmp4, encoding: 'utf8' });
      check('S12 持锁期间收缩 → CLI exit 非 0（拒绝无锁收缩）', proc4.status !== 0, `status=${proc4.status} stderr=${proc4.stderr}`);
      check('S13 拒绝时报「写锁等待超时」而非静默', /写锁等待超时/.test(proc4.stderr || ''), proc4.stderr);
      check('S14 分片未被 unlink（持锁者保护成功）', fs.existsSync(shardPath), 'shard gone');
      check('S15 主台账保持原样', fs.readFileSync(mainLedger4, 'utf8') === mainBefore4, fs.readFileSync(mainLedger4, 'utf8'));
    }
    // 等子进程释放锁（最长 20s）后重跑 → 成功且内容正确（互斥不钉死收缩）
    for (let i = 0; i < 800 && fs.existsSync(shardPath + '.lock'); i++) sleepSync(25);
    child.kill();
    const proc5 = spawnSync(process.execPath, [cliPath], { cwd: tmp4, encoding: 'utf8' });
    check('S16 锁释放后重跑收缩 → exit 0', proc5.status === 0, proc5.stderr);
    check('S17 重跑后主台账含合并行', fs.readFileSync(mainLedger4, 'utf8') === '{"id":20}\n{"id":21}\n', fs.readFileSync(mainLedger4, 'utf8'));
    check('S18 重跑后分片已清理', !fs.existsSync(shardPath));
  } finally {
    fs.rmSync(tmp4, { recursive: true, force: true });
  }
}

// 场景E：含空行主台账经 compact 后空行仍在（2026-11-05 台账族 Minor#5）
// 旧实现 mergeJsonlLines 剥掉主台账内部空行（RED）——compact 后主台账不再是其旧 blob 的
// 逐字节前缀扩展，提交会被 check-ledger-invariant 判 HARD-BLOCK（自家门禁拦自家归并）。
{
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));
  try {
    const mainLedger5 = path.join(tmp5, '.agents', 'confirmations.jsonl');
    const shardDir5 = path.join(tmp5, '.agents', 'confirmations.d');
    fs.mkdirSync(shardDir5, { recursive: true });
    fs.writeFileSync(mainLedger5, '{"id":30}\n\n{"id":31}\n'); // 主台账内部空行
    fs.writeFileSync(path.join(shardDir5, 'shard-e.jsonl'), '{"id":32}\n');

    const proc5 = spawnSync(process.execPath, [cliPath], { cwd: tmp5, encoding: 'utf8' });

    const merged5 = fs.readFileSync(mainLedger5, 'utf8');
    check('S19 含空行主台账 compact → 空行仍在（旧实现被剥）',
      proc5.status === 0 && merged5 === '{"id":30}\n\n{"id":31}\n{"id":32}\n', merged5);
  } finally {
    fs.rmSync(tmp5, { recursive: true, force: true });
  }
}

// 场景F：bare 仓 / 非 git 目录 → 拒绝收缩（2026-11-05 台账族 Minor#4 CLI 写侧 fail-closed）
// 旧口径 projectRoot() 回退 cwd（RED：主台账在 cwd 被整写）。用例显式关掉本文件顶部的逃生门。
{
  const GITBIN = process.platform === 'win32' ? 'git.exe' : 'git';
  const noEscape = { ...process.env, NODE_ENV: '', LEDGER_CLI_TEST_ANYROOT: '' };

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-bare-'));
  spawnSync(GITBIN, ['init', '-q', '--bare'], { cwd: bare });
  const bareMain = path.join(bare, '.agents', 'confirmations.jsonl');
  const bareShard = path.join(bare, '.agents', 'confirmations.d');
  fs.mkdirSync(bareShard, { recursive: true });
  fs.writeFileSync(bareMain, '{"id":40}\n');
  fs.writeFileSync(path.join(bareShard, 'shard-f.jsonl'), '{"id":41}\n');
  const pBare = spawnSync(process.execPath, [cliPath], { cwd: bare, encoding: 'utf8', env: noEscape });
  check('S20a bare 仓 compact → 非零拒写（bare 不再误诊 git-unavailable）',
    pBare.status !== 0 && /拒绝写台账/.test(pBare.stderr), `status=${pBare.status} err=${pBare.stderr}`);
  check('S20b bare 仓主台账原样、分片未删',
    fs.readFileSync(bareMain, 'utf8') === '{"id":40}\n' && fs.existsSync(path.join(bareShard, 'shard-f.jsonl')));

  const nongit = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-nongit-'));
  const ngMain = path.join(nongit, '.agents', 'confirmations.jsonl');
  const ngShard = path.join(nongit, '.agents', 'confirmations.d');
  fs.mkdirSync(ngShard, { recursive: true });
  fs.writeFileSync(ngMain, '{"id":42}\n');
  fs.writeFileSync(path.join(ngShard, 'shard-g.jsonl'), '{"id":43}\n');
  const pNg = spawnSync(process.execPath, [cliPath], { cwd: nongit, encoding: 'utf8', env: noEscape });
  check('S20c 非 git 目录 compact → 非零拒写（不「就地」落 cwd）',
    pNg.status !== 0 && /拒绝写台账/.test(pNg.stderr), `status=${pNg.status} err=${pNg.stderr}`);
  check('S20d 非 git 目录主台账原样', fs.readFileSync(ngMain, 'utf8') === '{"id":42}\n');

  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(nongit, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
