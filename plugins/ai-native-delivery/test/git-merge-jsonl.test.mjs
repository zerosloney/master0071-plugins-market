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

// 2. CRLF 归一 + 空行原样保留（2026-11-05 契约更新：空行不属于并集行集，剥掉会让含空行的
// 主台账经 compact 后不再是旧 blob 的逐字节前缀扩展——被台账不变量门禁判 HARD-BLOCK）
{
  const current = '{"id":1}\r\n\r\n{"id":2}\r\n';
  const other = '{"id":3}\n';
  const res = mergeJsonlLines(current, other);
  check('S2 CRLF归一且主台账空行原样保留', res === '{"id":1}\n\n{"id":2}\n{"id":3}\n', res);
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

// ---- S5 末尾不完整 JSON 行按崩溃残迹丢弃（2026-11-05 台账族 Minor#1）----
// 半行 ≠ 全行：union 去重不掉半行，且两输入各带一份半行会都进结果。旧实现结果含半行（RED）。
{
  const current = '{"id":1}\n{"id":2}\n{"id":3'; // 末尾半行（崩溃残迹）
  const other = '{"id":4}\n';
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let res;
  try { res = mergeJsonlLines(current, other); } finally { console.error = origError; }
  check('S5a 末尾半行输入 → 结果不含（旧实现含）', res === '{"id":1}\n{"id":2}\n{"id":4}\n', JSON.stringify(res));
  check('S5b 丢弃有 stderr 计数出账', errs.some((m) => /末尾不完整 JSON 行/.test(m)), JSON.stringify(errs));
}

// ---- S6 行中坏行维持现状（不判不删——崩溃残迹只认「文件末尾」形态）----
{
  const current = '{"a"\n{"id":1}\n'; // 坏行在行中（后面还有完整行）
  const res = mergeJsonlLines(current, '{"id":2}\n');
  check('S6 行中坏行维持现状（参与并集）', res === '{"a"\n{"id":1}\n{"id":2}\n', JSON.stringify(res));
}

// ---- S7 主台账内部空行经合并原样保留（2026-11-05 台账族 Minor#5）----
// 旧实现剥掉空行（RED）：含空行主台账经 compact 后不再是其旧 blob 的前缀扩展 → 提交被
// check-ledger-invariant 判 HARD-BLOCK（自家门禁拦自家归并）。
{
  const current = '{"id":1}\n\n{"id":2}\n'; // 主台账内部空行
  const res = mergeJsonlLines(current, '{"id":3}\n');
  check('S7 主台账空行保留（union 行集之外的磁盘空行不剥）', res === '{"id":1}\n\n{"id":2}\n{"id":3}\n', JSON.stringify(res));
}

// ---- S8 端到端：%A 末尾半行 → 合并结果不含，%B 正常行照常并入 ----
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-jsonl-test-'));
  const ancestorPath = path.join(tmpDir, 'ancestor.jsonl');
  const currentPath = path.join(tmpDir, 'current.jsonl');
  const otherPath = path.join(tmpDir, 'other.jsonl');

  fs.writeFileSync(ancestorPath, '{"line":"base"}\n');
  fs.writeFileSync(currentPath, '{"line":"base"}\n{"line":"a"}\n{"line":"b"'); // 末尾半行
  fs.writeFileSync(otherPath, '{"line":"base"}\n{"line":"c"}\n');

  const proc = spawnSync(process.execPath, [cliPath, ancestorPath, currentPath, otherPath], { encoding: 'utf8' });

  check('S8a CLI 正常退出 0', proc.status === 0, `status: ${proc.status}, err: ${proc.stderr}`);
  const merged = fs.readFileSync(currentPath, 'utf8');
  check('S8b 半行被丢弃、%B 新行并入', merged === '{"line":"base"}\n{"line":"a"}\n{"line":"c"}\n', `got:\n${merged}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// BOM 剥除（2026-11-09 审查收口）：Windows 编辑器另存引入的 BOM 不再把首行记录吞成坏行
{
  const out = mergeJsonlLines('\uFEFF{"doc":"a","stage":"draft","ts":"2026-01-01"}\n', '{"doc":"a","stage":"approved","ts":"2026-02-01"}\n{"doc":"b","ts":"2026-03-01"}\n');
  const rows = out.split('\n').filter((l) => l.trim());
  let bad = 0;
  const parsed = [];
  for (const l of rows) { try { parsed.push(JSON.parse(l)); } catch { bad++; } }
  check('BOM 首行不再解析失败（0 坏行）', bad === 0 && !out.startsWith('\uFEFF'), `bad=${bad} out=${JSON.stringify(out)}`);
  check('BOM 后各行照常并入（BOM 不吞首行、不产冲突标记）',
    parsed.length === 3 && parsed.some((p) => p.doc === 'a' && p.stage === 'approved') && parsed.some((p) => p.doc === 'b'),
    JSON.stringify(parsed));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
