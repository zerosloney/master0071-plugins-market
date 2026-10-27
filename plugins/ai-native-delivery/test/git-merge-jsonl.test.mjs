// git-merge-jsonl.test.mjs — 测试 git-merge-jsonl 合并驱动
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeJsonlLines } from '../scripts/git-merge-jsonl.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

// fileURLToPath 解码百分号编码：非 ASCII 检出路径（如中文 worktree 名）下 pathname 会编码成 %E5%8F%98…，
// 子进程按坏路径启动 → status 1 / 空 stdout（2026-10-17 实证）
// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'git-merge-jsonl.mjs');

// 1. 纯函数测试：去重与顺序
{
  const current = '{"id":1}\n{"id":2}\n';
  const other = '{"id":2}\n{"id":3}\n';
  const res = mergeJsonlLines(current, other);
  check('S1 纯函数去重并集', res === '{"id":1}\n{"id":2}\n{"id":3}\n', res);
}

// 2. CRLF 兼容与空行处理
{
  const current = '{"id":1}\r\n\r\n{"id":2}\r\n';
  const other = '{"id":3}\n';
  const res = mergeJsonlLines(current, other);
  check('S2 CRLF与空行归一', res === '{"id":1}\n{"id":2}\n{"id":3}\n', res);
}

// 3. 命令行端到端调用
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-jsonl-test-'));
  const ancestorPath = path.join(tmpDir, 'ancestor.jsonl');
  const currentPath = path.join(tmpDir, 'current.jsonl');
  const otherPath = path.join(tmpDir, 'other.jsonl');

  fs.writeFileSync(ancestorPath, '{"line":"base"}\n');
  fs.writeFileSync(currentPath, '{"line":"base"}\n{"line":"branch-a"}\n');
  fs.writeFileSync(otherPath, '{"line":"base"}\n{"line":"branch-b"}\n');

  const proc = spawnSync(process.execPath, [cliPath, ancestorPath, currentPath, otherPath], { encoding: 'utf8' });

  check('S3a CLI 正常退出 0', proc.status === 0, `status: ${proc.status}, err: ${proc.stderr}`);

  const merged = fs.readFileSync(currentPath, 'utf8');
  const expected = '{"line":"base"}\n{"line":"branch-a"}\n{"line":"branch-b"}\n';
  check('S3b 当前文件被正确写为并集', merged === expected, `got:\n${merged}`);

  check('S3c 成功合并后无 .tmp 残留', !fs.existsSync(`${currentPath}.tmp`));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 4. 写入失败：临时文件路径不可写 → exit 非 0，%A 原样
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-jsonl-test-'));
  const currentPath = path.join(tmpDir, 'current.jsonl');
  const otherPath = path.join(tmpDir, 'other.jsonl');

  const before = '{"line":"base"}\n{"line":"branch-a"}\n';
  fs.writeFileSync(currentPath, before);
  fs.writeFileSync(otherPath, '{"line":"branch-b"}\n');
  // 逼出写入失败：临时文件路径预置为目录（writeFileSync 对目录抛错）
  fs.mkdirSync(`${currentPath}.tmp`);

  const proc = spawnSync(process.execPath, [cliPath, currentPath, currentPath, otherPath], { encoding: 'utf8' });

  check('S4a 写入失败时 CLI exit 非 0', proc.status !== 0, `status: ${proc.status}`);
  check('S4b %A 保持原样', fs.readFileSync(currentPath, 'utf8') === before, `got:\n${fs.readFileSync(currentPath, 'utf8')}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
