#!/usr/bin/env node
// rewrite-file.test.mjs — 按行字面替换 + 响亮失败 fixture 套件（2026-10-12 silent-noop-loud-failure）
// 覆盖：CRLF 保全（papercut 2026-10-06 的静默无操作场景）/ 0 命中不写盘 / 命中数不符期望 /
//       --allow-multi / --dry-run / 缺文件 fail-loud / find===replace 自伤防护 / 跨行锚串必失败 /
//       无尾换行保全 / 写后回读校验成功形态
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPT_DIR, '..', 'scripts', 'rewrite-file.mjs'); // 插件化落位（2026-10-27 迁移）

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const run = (file, args) => {
  const r = spawnSync(process.execPath, [SCRIPT, file, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const mk = (name, content) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-file-'));
  const p = path.join(d, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
};

// T1：基本 LF 替换 → exit 0 + 内容正确 + 成功语含回读校验
{
  const p = mk('lf.md', 'a\nANCHOR\nc\n');
  const r = run(p, ['--find', 'ANCHOR', '--replace', 'NEW']);
  const after = fs.readFileSync(p, 'utf8');
  check('T1 基本 LF 替换 → exit 0 且内容正确', r.code === 0 && after === 'a\nNEW\nc\n', r.out);
  check('T1b 成功语含「回读校验通过」', /回读校验通过/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T2：CRLF 保全——papercut 2026-10-06 的静默无操作场景，本工具必须真改且不坏行尾
{
  const p = mk('crlf.md', 'line1\r\nANCHOR here\r\nline3\r\n');
  const r = run(p, ['--find', 'ANCHOR', '--replace', 'NEW']);
  const after = fs.readFileSync(p, 'utf8');
  check('T2 CRLF 文件替换成功且行尾保全', r.code === 0 && after === 'line1\r\nNEW here\r\nline3\r\n', r.out);
  check('T2b 未混入裸 LF（无 CRLF→LF 漂移）', !/[^\r]\n/.test(after), JSON.stringify(after));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T3：0 命中 → exit 1 且文件逐字节不变（核心：绝不存在「以为改了」）
{
  const before = 'x\r\nZZZ not here\r\n';
  const p = mk('nohit.md', before);
  const r = run(p, ['--find', 'QQQ', '--replace', 'Q']);
  const after = fs.readFileSync(p, 'utf8');
  check('T3 0 命中 → exit 1 且文件逐字节不变', r.code === 1 && after === before, r.out);
  check('T3b 报错点名行尾与常见成因（CRLF 检出态）', /0 命中/.test(r.out) && /CRLF/.test(r.out) && /跨行锚/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T4：命中数与期望不符 → exit 1 且不写盘（锚串非唯一时必须响亮，不可顺手全改）
{
  const before = 'k\nk\n';
  const p = mk('multi.md', before);
  const r = run(p, ['--find', 'k', '--replace', 'K']);
  const after = fs.readFileSync(p, 'utf8');
  check('T4 命中 2 ≠ 期望 1 → exit 1 且未写盘', r.code === 1 && after === before && /命中数 2 ≠ 期望 1/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T5：显式 --expect 2 → 过（同一行两处命中也按处计）
{
  const p = mk('expect2.md', 'k k\n');
  const r = run(p, ['--find', 'k', '--replace', 'K', '--expect', '2']);
  const after = fs.readFileSync(p, 'utf8');
  check('T5 --expect 2 且命中 2 → exit 0 且两处都改', r.code === 0 && after === 'K K\n', r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T6：--allow-multi 多命中 → 过（宽松形态，明示批量）
{
  const p = mk('allowmulti.md', 'k\nk\nk\n');
  const r = run(p, ['--find', 'k', '--replace', 'K', '--allow-multi']);
  const after = fs.readFileSync(p, 'utf8');
  check('T6 --allow-multi 三命中 → exit 0 且全改', r.code === 0 && after === 'K\nK\nK\n', r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T7：--allow-multi 与 --expect 互斥 → exit 1（一宽一严无法裁决）
{
  const p = mk('conflict.md', 'k\n');
  const r = run(p, ['--find', 'k', '--replace', 'K', '--allow-multi', '--expect', '1']);
  check('T7 --allow-multi 与 --expect 互斥 → exit 1', r.code === 1 && /互斥/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T8：--dry-run → 不写盘
{
  const p = mk('dry.md', 'a\nANCHOR\n');
  const r = run(p, ['--find', 'ANCHOR', '--replace', 'NEW', '--dry-run']);
  const after = fs.readFileSync(p, 'utf8');
  check('T8 --dry-run → exit 0 且未写盘', r.code === 0 && after === 'a\nANCHOR\n' && /dry-run/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T9：目标文件不存在 → exit 1 fail-loud（不静默创建新文件）
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-file-'));
  const r = run(path.join(d, 'nope.md'), ['--find', 'a', '--replace', 'b']);
  check('T9 文件不存在 → exit 1 且不创建文件', r.code === 1 && /不存在/.test(r.out) && !fs.existsSync(path.join(d, 'nope.md')), r.out);
  fs.rmSync(d, { recursive: true, force: true });
}
// T10：find === replace → exit 1（无操作却报成功，正是要堵的形态）
{
  const p = mk('same.md', 'a\nSAME\n');
  const r = run(p, ['--find', 'SAME', '--replace', 'SAME']);
  check('T10 find === replace → exit 1', r.code === 1 && /相同/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T11：跨行锚串（含 \n）→ 0 命中 exit 1——把「\n 锚串匹配 CRLF 文件静默无操作」变成响亮失败
{
  const p = mk('crossline.md', 'aaa\r\nbbb\r\n');
  const r = run(p, ['--find', 'aaa\nbbb', '--replace', 'xxx']);
  const after = fs.readFileSync(p, 'utf8');
  check('T11 跨行锚串 → exit 1 且文件不变（提示拆单行锚）', r.code === 1 && after === 'aaa\r\nbbb\r\n' && /跨行锚/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T12：无尾换行保全
{
  const p = mk('notrailing.md', 'a\nANCHOR');
  const r = run(p, ['--find', 'ANCHOR', '--replace', 'NEW']);
  const after = fs.readFileSync(p, 'utf8');
  check('T12 原文件无尾换行 → 替换后仍无尾换行', r.code === 0 && after === 'a\nNEW', JSON.stringify(after));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T13：空 --find → exit 1（空串会命中每一行，属误用）
{
  const p = mk('emptyfind.md', 'a\n');
  const r = run(p, ['--find', '', '--replace', 'b']);
  check('T13 空 --find → exit 1', r.code === 1 && /不能为空串/.test(r.out), r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}
// T14：同行的两处命中按处计数，且 --expect 3 精确匹配（处计数语义显式化）
{
  const p = mk('twiceinline.md', 'k-k-k\n');
  const r = run(p, ['--find', 'k', '--replace', 'K', '--expect', '3']);
  const after = fs.readFileSync(p, 'utf8');
  check('T14 同行多处按处计数（3 处）→ exit 0', r.code === 0 && after === 'K-K-K\n', r.out);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}

// T15：--root 生效——相对路径按 root 解析，且目标必须在 root 内（2026-10-27 路径逃逸修复）
// 旧实现把 --root 吞掉（解析后丢弃、路径仍按 cwd 解析）→ 「以为在仓库内改、实际改到别处」
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-file-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-file-out-'));
  fs.writeFileSync(path.join(root, 'ok.md'), 'ANCHOR\n', 'utf8');
  const victim = path.join(outside, 'victim.md');
  fs.writeFileSync(victim, 'ANCHOR\n', 'utf8');
  // ① root 内相对路径 → 按 root 解析并改写
  const r = spawnSync(process.execPath, [SCRIPT, 'ok.md', '--find', 'ANCHOR', '--replace', 'NEW', '--root', root], { encoding: 'utf8' });
  check('T15 --root 内相对路径按 root 解析并改写',
    r.status === 0 && fs.readFileSync(path.join(root, 'ok.md'), 'utf8') === 'NEW\n', `${r.stdout}${r.stderr}`);
  // ② root 外的绝对路径 → 拒（越界即拒，不改文件）
  const r2 = spawnSync(process.execPath, [SCRIPT, victim, '--find', 'ANCHOR', '--replace', 'NEW', '--root', root], { encoding: 'utf8' });
  check('T15b --root 外目标 → exit 1 且越界文件逐字节未变',
    r2.status === 1 && /逃逸|之外/.test(`${r2.stdout}${r2.stderr}`) && fs.readFileSync(victim, 'utf8') === 'ANCHOR\n', `${r2.stdout}${r2.stderr}`);
  // ③ root 外的相对逃逸路径（../）→ 拒
  const r3 = spawnSync(process.execPath, [SCRIPT, path.join('..', path.basename(outside), 'victim.md'), '--find', 'ANCHOR', '--replace', 'NEW', '--root', root], { encoding: 'utf8' });
  check('T15c root 外相对逃逸路径 → exit 1',
    r3.status === 1 && fs.readFileSync(victim, 'utf8') === 'ANCHOR\n', `${r3.stdout}${r3.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
