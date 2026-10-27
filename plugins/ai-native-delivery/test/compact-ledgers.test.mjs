// compact-ledgers.test.mjs — 测试台账分片打包归并工具
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// fileURLToPath 解码百分号编码：非 ASCII 检出路径（如中文 worktree 名）下 pathname 会编码成 %E5%8F%98…，
// 子进程按坏路径启动 → status 1 / 空 stdout（2026-10-17 实证）
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'compact-ledgers.mjs');

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

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
