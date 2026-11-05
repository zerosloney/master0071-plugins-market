// ledger-loader.test.mjs — 单元测试统一台账分片加载器
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadAllConfirmations, writeConfirmation } from '../scripts/ledger-loader.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));

try {
  // 1. 空目录返回空数组
  check('S1 空目录读取返回空', loadAllConfirmations(tmp).length === 0);

  // 2. 写入主台账并读取
  const entry1 = { doc: 'workflow/intents/2026-10-10-task-a.md', stage: 'approved', fingerprint: 'fp1' };
  writeConfirmation(tmp, entry1, { shard: false });
  const res1 = loadAllConfirmations(tmp);
  check('S2 主台账写入并正确读取', res1.length === 1 && res1[0].fingerprint === 'fp1');

  // 3. 写入分片台账并联合读取
  const entry2 = { doc: 'workflow/intents/2026-10-10-task-b.md', stage: 'approved', fingerprint: 'fp2' };
  writeConfirmation(tmp, entry2, { shard: true });

  const shardPath = path.join(tmp, '.agents', 'confirmations.d', '2026-10-10-task-b.jsonl');
  check('S3a 分片文件在预期路径生成', fs.existsSync(shardPath));

  const res2 = loadAllConfirmations(tmp);
  check('S3b 联合读取包含主台账和分片台账', res2.length === 2 && res2.some((r) => r.fingerprint === 'fp2'));

  // 4. 重复行去重
  writeConfirmation(tmp, entry1, { shard: true }); // 同样的内容写进分片
  const res3 = loadAllConfirmations(tmp);
  check('S4 跨主文件与分片去重生效', res3.length === 2);

  // 5. 分片读失败 fail-soft + stderr 出账（2026-10-10：IO 异常不再零日志伪装成「确认未对账」）
  {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));
    try {
      fs.mkdirSync(path.join(tmp2, '.agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp2, '.agents', 'confirmations.jsonl'),
        JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-c.md', stage: 'approved', fingerprint: 'fp3' }) + '\n',
        'utf8',
      );
      fs.mkdirSync(path.join(tmp2, '.agents', 'confirmations.d', 'bad.jsonl'), { recursive: true }); // 目录 → readFileSync 抛 EISDIR
      const errs = [];
      const origError = console.error;
      console.error = (...args) => errs.push(args.join(' '));
      try {
        const res4 = loadAllConfirmations(tmp2);
        check('S5a 分片读失败仍返回主台账行（fail-soft 不中断）', res4.length === 1 && res4[0].fingerprint === 'fp3');
      } finally {
        console.error = origError;
      }
      check('S5b 分片读失败 stderr 出账且消息含 bad.jsonl', errs.length > 0 && errs.join('\n').includes('bad.jsonl'), JSON.stringify(errs));
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  }

  // 6. 主文件读失败 fail-soft + stderr 出账
  {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));
    try {
      fs.mkdirSync(path.join(tmp3, '.agents', 'confirmations.jsonl'), { recursive: true }); // 目录 → readFileSync 抛 EISDIR
      const errs = [];
      const origError = console.error;
      console.error = (...args) => errs.push(args.join(' '));
      try {
        const res5 = loadAllConfirmations(tmp3);
        check('S6a 主文件读失败返回空数组（fail-soft 不中断）', res5.length === 0);
      } finally {
        console.error = origError;
      }
      check('S6b 主文件读失败 stderr 出账且消息含 confirmations.jsonl', errs.length > 0 && errs.join('\n').includes('confirmations.jsonl'), JSON.stringify(errs));
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }
  }

  // 7. 同键多行取末次（append-only 末次生效：主台账先读、分片后读，同键后读覆盖先读）
  {
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));
    try {
      fs.mkdirSync(path.join(tmp4, '.agents'), { recursive: true });
      // 主台账放同键行 A（ts=T1），分片放同键行 B（ts=T2，其余字段可区分）→ 分片行覆盖主台账行
      fs.writeFileSync(
        path.join(tmp4, '.agents', 'confirmations.jsonl'),
        JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-d.md', stage: 'approved', fingerprint: 'fp4', ts: 'T1' }) + '\n',
        'utf8',
      );
      fs.mkdirSync(path.join(tmp4, '.agents', 'confirmations.d'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp4, '.agents', 'confirmations.d', '2026-10-10-task-d.jsonl'),
        JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-d.md', stage: 'approved', fingerprint: 'fp4', ts: 'T2', quote: '分片较新' }) + '\n',
        'utf8',
      );
      const res6 = loadAllConfirmations(tmp4);
      check('S7a 分片与主台账同键 → 仅剩分片行（后读覆盖先读，主台账行被覆盖）',
        res6.length === 1 && res6[0].ts === 'T2' && res6[0].quote === '分片较新', JSON.stringify(res6));

      // 主台账内部两行同键 → 取后一行
      fs.appendFileSync(
        path.join(tmp4, '.agents', 'confirmations.jsonl'),
        [
          JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-e.md', stage: 'approved', fingerprint: 'fp5', ts: 'T3' }),
          JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-e.md', stage: 'approved', fingerprint: 'fp5', ts: 'T4' }),
        ].join('\n') + '\n',
        'utf8',
      );
      const res7 = loadAllConfirmations(tmp4);
      const fp5Rows = res7.filter((r) => r.fingerprint === 'fp5');
      check('S7b 主台账内部同键两行取后一行（ts=T4 胜出）',
        fp5Rows.length === 1 && fp5Rows[0].ts === 'T4', JSON.stringify(fp5Rows));
    } finally {
      fs.rmSync(tmp4, { recursive: true, force: true });
    }
  }

  // 8. 坏行容忍：非法 JSON 与空行跳过不抛错，仅合法行入账
  {
    const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));
    try {
      fs.mkdirSync(path.join(tmp5, '.agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp5, '.agents', 'confirmations.jsonl'),
        [
          JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-f.md', stage: 'approved', fingerprint: 'fp6' }),
          '',
          '{broken json',
          JSON.stringify({ doc: 'workflow/intents/2026-10-10-task-g.md', stage: 'approved', fingerprint: 'fp7' }),
          '   ',
        ].join('\n') + '\n',
        'utf8',
      );
      let threw = null;
      let res8 = [];
      try {
        res8 = loadAllConfirmations(tmp5);
      } catch (err) {
        threw = err;
      }
      check('S8a 混入非法 JSON 行与空行不抛错', threw === null, threw && threw.message);
      check('S8b 仅合法行入账（坏行/空行跳过）',
        res8.length === 2 && res8.some((r) => r.fingerprint === 'fp6') && res8.some((r) => r.fingerprint === 'fp7'),
        JSON.stringify(res8));
    } finally {
      fs.rmSync(tmp5, { recursive: true, force: true });
    }
  }

  // 9. writeConfirmation 持分片锁（2026-11-05 并发修复回归）
  // 旧实现 appendFileSync 无锁：compact-ledgers 收缩「锁内重读分片→并入主台账→unlink」期间，
  // 落进该分片的确认行随 unlink 静默丢失。修复后与 compact-ledgers / ledger-shards 持同一把
  // `<分片>.lock`（withLedgerLock 单源）：锁被他人持有时等待，超时响亮抛错——绝不无锁写
  //（写进正在收缩的分片 = 该行随收缩丢失）。
  {
    const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-loader-test-'));
    const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const modUrl = new URL('../scripts/ledger-shards.mjs', import.meta.url).href;
    try {
      const shardDir6 = path.join(tmp6, '.agents', 'confirmations.d');
      fs.mkdirSync(shardDir6, { recursive: true });
      // 分片名 = doc 基名（writeConfirmation 的落点规则）——doc 是 workflow/intents/held.md → held.jsonl
      const shard6 = path.join(shardDir6, 'held.jsonl');
      fs.writeFileSync(shard6, '{"seed":1}\n', 'utf8');
      // 子进程持锁 6s（> withLedgerLock 等待上限 3s、< 陈旧接管线 15s）——确定性不靠时序运气
      const child = spawn(process.execPath, [
        '-e',
        `import(${JSON.stringify(modUrl)}).then(m => m.withLedgerLock(process.argv[1], () => { console.log('LOCKED'); const g = Date.now() + 6000; while (Date.now() < g) {} })).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })`,
        shard6,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let locked = false; // 同步轮询等锁就位（等不到就红，不假绿）
      for (let i = 0; i < 800 && !locked; i++) { locked = fs.existsSync(shard6 + '.lock'); if (!locked) sleepSync(25); }
      check('S9a 前置：子进程已持住分片锁', locked);
      let threw = null;
      if (locked) {
        try { writeConfirmation(tmp6, { doc: 'workflow/intents/held.md', stage: 'approved', fingerprint: 'fp9' }, { shard: true }); } catch (e) { threw = e; }
        check('S9b 持锁期间写入 → 响亮抛错（不无锁追加）', threw !== null && /写锁等待超时/.test(threw.message), threw && threw.message);
        check('S9c 等待期间不落盘（分片原样、无半行撕裂）', fs.readFileSync(shard6, 'utf8') === '{"seed":1}\n', fs.readFileSync(shard6, 'utf8'));
      }
      // 等锁释放（最长 20s）后重写 → 成功且锁文件已清理（互斥不钉死写入）
      for (let i = 0; i < 800 && fs.existsSync(shard6 + '.lock'); i++) sleepSync(25);
      child.kill();
      writeConfirmation(tmp6, { doc: 'workflow/intents/held.md', stage: 'approved', fingerprint: 'fp9' }, { shard: true });
      check('S9d 锁释放后写入成功', fs.readFileSync(shard6, 'utf8').includes('fp9'), fs.readFileSync(shard6, 'utf8'));
      check('S9e 写完锁文件已释放', !fs.existsSync(shard6 + '.lock'));
      check('S9f 联合读取含新确认行', loadAllConfirmations(tmp6).some((r) => r.fingerprint === 'fp9'));
    } finally {
      fs.rmSync(tmp6, { recursive: true, force: true });
    }
  }

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
