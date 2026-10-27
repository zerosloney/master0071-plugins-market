// warn-format.test.mjs — 告警折叠输出层测试（2026-10-22 门禁收敛批 2「信噪比」）
// 判据：① 同标签多条折叠为「×N 条同类」单行 ② 异标签不合并 ③ 单条不折叠
//       ④ enabled=false 逐条原样（排障/夹具口径）⑤ 明细落盘含全部原始行
//       ⑥ 无标签行不误并（raw 键按首行独立分组）
// 动因：批 2 改了门禁**输出契约**（原先逐条打印），但聚合逻辑原内联在 check-loop.mjs
//       （该文件无 isMain 守卫、被 import 即执行 → 不可直接 import 测试），等于裸奔。
//       本套件锁住折叠规则，防后续改动把告警静默合并丢信息。
// 用法：node test/warn-format.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatWarnings, WARN_LOG_REL } from '../scripts/warn-format.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

// ---- S1 同标签多条折叠为一行 ----
{
  const list = [
    '- [WARN 模板未填] a.md 含模板占位符',
    '- [WARN 模板未填] b.md 含模板占位符',
    '- [WARN 模板未填] c.md 含模板占位符',
  ];
  const out = formatWarnings(list, { enabled: true, logPath: null });
  const lines = out.split('\n');
  check('S1 同标签 3 条折叠为 1 行且带 ×3 计数',
    lines.length === 1 && lines[0].includes('×3 条同类') && lines[0].includes('模板未填'), out);
  check('S1 折叠行不含具体文件名（明细在落盘里）', !out.includes('a.md'), out);
}

// ---- S2 异标签不合并 ----
{
  const out = formatWarnings([
    '- [WARN 模板未填] a',
    '- [WARN 模块元数据] b',
    '- [WARN 模板未填] c',
  ], { enabled: true, logPath: null });
  const lines = out.split('\n');
  check('S2 异标签分行输出（模板未填 ×2；模块元数据单条原样不写 ×1）',
    lines.length === 2
      && lines.some((l) => l.includes('模板未填') && l.includes('×2'))
      && lines.some((l) => l.includes('模块元数据') && !l.includes('条同类')), out);
}

// ---- S3 单条不折叠 ----
{
  const out = formatWarnings(['- [WARN 状态未确认] 只有一条'], { enabled: true, logPath: null });
  check('S3 单条原样输出（不写 ×1）',
    out === '- [WARN 状态未确认] 只有一条' && !out.includes('条同类'), out);
}

// ---- S4 enabled=false 逐条原样（排障 / 夹具口径）----
{
  const list = ['- [WARN A] 1', '- [WARN A] 2', '- [WARN B] 3'];
  const out = formatWarnings(list, { enabled: false });
  check('S4 enabled=false 逐条原样返回',
    out === list.join('\n'), out);
}

// ---- S5 明细落盘含全部原始行 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-format-'));
  const logPath = path.join(dir, 'tmp', 'check-loop-warn.log');
  const list = ['- [WARN A] 1', '- [WARN A] 2', '- [WARN B] 3'];
  formatWarnings(list, { enabled: true, logPath });
  const logged = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  check('S5 明细落盘含全部原始行（一条不少）',
    list.every((l) => logged.includes(l)) && logged.trim().split('\n').length === 3, logged);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- S6 无标签行不误并（raw 键按首行独立分组）----
{
  const out = formatWarnings([
    '没有方括号标签的第一行',
    '没有方括号标签的第一行',
  ], { enabled: true, logPath: null });
  check('S6 无标签行按首行独立分组（不被静默合并）',
    out.split('\n').length === 2, out);
}

// ---- S7 明细位置常量 ----
{
  check('S7 明细相对路径常量为 tmp/check-loop-warn.log', WARN_LOG_REL === 'tmp/check-loop-warn.log', WARN_LOG_REL);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
