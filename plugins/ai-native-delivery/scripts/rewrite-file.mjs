#!/usr/bin/env node
// rewrite-file.mjs — 按行字面替换 + 响亮失败（silent-noop-loud-failure）
// 背景（workflow/papercuts.md 2026-10-06 行，两次假落账实证）：
//   `node -e "fs.writeFileSync(p, s.replace(A, B))"` 对 **CRLF 检出文件**用 `\n` 锚串定位时
//   **静默无操作**，脚本照样打印「落账 OK」——假成功比响亮失败危险得多（台账/文档被以为改了）。
// 本工具把该形态的三个失效点逐一堵死：
//   ① 按行处理并保留原行尾（`/\r?\n/` 切分 + 检出 EOL 回写）——不再有「\n 锚串匹配不上 CRLF」这一类
//   ② 替换数必须与 --expect 相符（默认 1）——0 命中即非零退出，**文件不写**，绝不存在「以为改了」
//   ③ 写后回读校验（新锚已在、旧锚已零、行数不变、EOL 未变）——全过才打印成功；任一不过即非零退出
// 另防两类自伤：find === replace（无操作却报成功）与目标文件不存在（fail-loud，不静默建文件）。
// 原子写：同目录临时文件 + rename——中途崩溃不留半写文件（沿 git-merge-jsonl.mjs / compact-ledgers.mjs 惯例）。
// 用法：node .agents/scripts/rewrite-file.mjs <文件> --find <字面串> --replace <字面串>
//         [--expect N] [--allow-multi] [--dry-run] [--root <仓库根>]
//   --expect N    期望命中数（默认 1）；实际 ≠ N → 非零退出且不写盘
//   --allow-multi 显式声明允许多命中（等价 --expect 的宽松形态：N ≥ 1 即过，用于批量同串替换）
//   --dry-run     只打印将发生的替换与校验预览，不写盘
// 测试：node .agents/scripts/rewrite-file.test.mjs
// 沿革：2026-10-12 立档（优先级 3：把「静默无操作」改成响亮失败）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const DRY = argv.includes('--dry-run');
const MULTI = argv.includes('--allow-multi');
let file = '';
let find = null;
let replace = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--find') find = argv[++i] ?? null;
  else if (a === '--replace') replace = argv[++i] ?? null;
  else if (a === '--expect') { /* 下面统一解析 */ }
  else if (a === '--root') { /* 仅为与其它脚本口令一致，路径按 cwd 解析 */ i++; }
  else if (a === '--dry-run' || a === '--allow-multi') { /* 旗标已处理 */ }
  else if (!a.startsWith('--') && !file) file = a;
}
const expectRaw = argOf('--expect');

const USAGE = `用法：node .agents/scripts/rewrite-file.mjs <文件> --find <字面串> --replace <字面串> [--expect N] [--allow-multi] [--dry-run]`;
const die = (msg) => { console.error(`❌ rewrite-file: ${msg}\n${USAGE}`); process.exit(1); };
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
if (!file) die('缺目标文件');
if (find === null || replace === null) die('--find 与 --replace 必须成对给出');
if (find === '') die('--find 不能为空串（空串会命中每一行，属误用）');
if (find === replace) die(`--find 与 --replace 相同（「${find.slice(0, 40)}」）——无操作却会报成功，正是本工具要堵的形态`);
let expect = 1;
if (expectRaw !== '') {
  if (!/^\d+$/.test(expectRaw)) die(`--expect 须为非负整数（现 ${expectRaw}）`);
  expect = Number(expectRaw);
}
if (MULTI && expectRaw !== '') die('--allow-multi 与 --expect 互斥（一个宽松一个严格，同给无法裁决）');

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) die(`目标文件不存在：${file}（不静默创建新文件——路径写错时应响亮失败）`);
let raw;
try { raw = fs.readFileSync(abs, 'utf8'); } catch (err) { die(`读取失败：${file}（${err.message}）`); }

// ---- 按行处理 + EOL 保全 ----
const crlf = raw.includes('\r\n');
const eol = crlf ? '\r\n' : '\n';
const hadTrailingNewline = /\r?\n$/.test(raw);
const lines = raw.split(/\r?\n/);
// 末行是「 trailing newline 产生的空串」时不计入可替换行集合（避免把 EOF 空串当一行改）
const bodyLines = hadTrailingNewline ? lines.slice(0, -1) : lines;

let hits = 0;
const changedIdx = [];
const newBody = bodyLines.map((l, i) => {
  if (!l.includes(find)) return l;
  const n = l.split(find).length - 1;
  hits += n;
  changedIdx.push(i + 1);
  return l.split(find).join(replace);
});

if (hits === 0) {
  console.error(`❌ rewrite-file: 0 命中——未写盘（文件保持原样）`);
  console.error(`   文件：${file}`);
  console.error(`   行尾：${crlf ? 'CRLF（仓库 autocrlf 检出态）' : 'LF'}｜总行数：${bodyLines.length}`);
  console.error(`   锚串（前 80 字符）：${JSON.stringify(find.slice(0, 80))}`);
  console.error(`   常见成因：① 锚串与文件实际内容不一致（空格/全角/标点）；② 用 \\n 跨行锚串去匹配 CRLF 文件——本工具按行匹配，跨行锚请拆成单行锚或改用 Edit 工具；③ 文件已被前一次改动写过。`);
  process.exit(1);
}
if (MULTI) {
  if (hits < 1) die('内部不变式违反：hits < 1');
} else if (hits !== expect) {
  console.error(`❌ rewrite-file: 命中数 ${hits} ≠ 期望 ${expect}——未写盘（文件保持原样）`);
  console.error(`   文件：${file}｜命中行号：${changedIdx.join(', ')}`);
  console.error(`   含义：锚串不是唯一命中——要么目标不唯一（应加 --expect ${hits} 或 --allow-multi 明示），要么文件已被改过。`);
  process.exit(1);
}

const out = newBody.join(eol) + (hadTrailingNewline ? eol : '');
if (newBody.length !== bodyLines.length) die('内部不变式违反：行数发生变化');

if (DRY) {
  console.log(`[dry-run] ${file}：将替换 ${hits} 处（行 ${changedIdx.join(', ')}），行尾 ${crlf ? 'CRLF' : 'LF'}，未写盘`);
  process.exit(0);
}

// ---- 原子写 ----
const tmp = `${abs}.rewrite-tmp`;
try {
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, abs);
} catch (err) {
  try { fs.unlinkSync(tmp); } catch { /* tmp 可能尚未创建 */ }
  die(`写入失败：${file}（${err.message}）——原文件应保持原样，请核对后重试`);
}

// ---- 写后回读校验（③）：任一不过即非零退出，绝不打印成功 ----
const problems = [];
let back;
try { back = fs.readFileSync(abs, 'utf8'); } catch (err) { die(`回读失败：${file}（${err.message}）——写入结果不可验证，请人工核对`); }
if (back !== out) problems.push('回读内容与拟写内容不一致（写入被截断或并发改动）');
if (back.includes(find)) problems.push('旧锚串仍存在于回读内容中（替换不完整）');
if (replace !== '' && !back.includes(replace)) problems.push('新锚串不在回读内容中');
const backLines = back.split(/\r?\n/);
const backBody = hadTrailingNewline ? backLines.slice(0, -1) : backLines;
if (backBody.length !== bodyLines.length) problems.push(`行数变化：${bodyLines.length} → ${backBody.length}`);
if (back.includes('\r\n') !== crlf) problems.push(`行尾形态变化：${crlf ? 'CRLF' : 'LF'} → ${back.includes('\r\n') ? 'CRLF' : 'LF'}`);
if (problems.length) {
  console.error(`❌ rewrite-file: 写后回读校验未过——${file}`);
  problems.forEach((p) => console.error(`   - ${p}`));
  console.error('   现场已保留（不要手改），请核对后用 git 恢复或重新替换');
  process.exit(1);
}

console.log(`✅ rewrite-file: ${file} 替换 ${hits} 处（行 ${changedIdx.join(', ')}）｜行尾 ${crlf ? 'CRLF' : 'LF'} 保全｜行数 ${bodyLines.length} 不变｜回读校验通过`);
