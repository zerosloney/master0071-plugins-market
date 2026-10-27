// ledger-loader.test.mjs — 单元测试统一台账分片加载器
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
