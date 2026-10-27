// workflow-enums.test.mjs — 枚举单源读取器测试（2026-09-25 enum-single-source）
// 判据：① 真实单源文件解析 + 不变量通过 ② 坏数据（坏行/重复键/重复值/缺键/子集破/重叠）fail-loud
//       ③ 缺文件 fail-loud（④ sh/sed 消费方同口径场景已随消费面退役，见 S11 注记）
// 用法：node test/workflow-enums.test.mjs（npm test 随跑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnums, validateEnums, loadEnums, ENUMS } from '../scripts/workflow-enums.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};
const throwsWith = (fn, kw) => {
  try { fn(); return false; } catch (e) { return String(e.message).includes(kw); }
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENUMS_TXT = path.join(SCRIPT_DIR, '..', 'config-templates', 'workflow-enums.txt');

// ---- S1 模块级 ENUMS 即加载即校验（真实文件），10 键齐 ----
{
  const keys = Object.keys(ENUMS).sort();
  check('S1 真实单源文件加载成功且 10 键齐',
    keys.length === 10 && keys.join(',') === 'doc.status.abandoned,doc.status.active,doc.status.all,doc.status.confirmed,doc.status.terminal,incident.env.all,incident.source.all,incident.status.active,incident.status.all,level.all',
    JSON.stringify(keys));
}

// ---- S2 真实文件关键值口径（check-loop/看板/检索的行为锚点，值变更须连本测试一起改）----
{
  check('S2 关键集值口径：confirmed 不含 draft、active=draft+approved、terminal 含 done、abandoned ⊆ terminal',
    !ENUMS['doc.status.confirmed'].includes('draft')
      && ENUMS['doc.status.active'].join('+') === 'draft+approved'
      && ENUMS['doc.status.terminal'].includes('done')
      && ENUMS['doc.status.abandoned'].every((v) => ENUMS['doc.status.terminal'].includes(v))
      && ENUMS['level.all'].length === 3, // 2026-10-10 L0 退役
    JSON.stringify(ENUMS));
}

// ---- S3 坏行 fail-loud ----
{
  check('S3 非法行抛错', throwsWith(() => parseEnums('乱行 no-equals-sign'), '行格式非法'));
}

// ---- S4 重复键 fail-loud ----
{
  check('S4 重复键抛错', throwsWith(() => parseEnums('a.b=x\na.b=y'), '键重复'));
}

// ---- S5 重复值 fail-loud ----
{
  check('S5 重复值抛错', throwsWith(() => parseEnums('a.b=x x'), '值重复'));
}

// ---- S6 缺键 fail-loud（validateEnums）----
{
  check('S6 缺键抛错', throwsWith(() => validateEnums({ 'level.all': ['L0'] }), '缺键'));
}

// ---- S7 子集破 fail-loud ----
{
  const bad = {
    'doc.status.all': ['draft', 'approved', 'done'], 'doc.status.confirmed': ['approved', 'done', 'ghost'],
    'doc.status.active': ['draft'], 'doc.status.terminal': ['done'], 'doc.status.abandoned': ['cancelled'],
    'incident.status.all': ['open'], 'incident.status.active': ['open'], 'level.all': ['L0'],
  };
  check('S7 子集不变量破抛错', throwsWith(() => validateEnums(bad), '不变量破'));
}

// ---- S8 活跃/终态重叠 fail-loud ----
{
  const bad = Object.fromEntries(Object.entries(ENUMS).map(([k]) => [k, [...ENUMS[k]]]));
  bad['doc.status.terminal'] = [...bad['doc.status.terminal'], 'draft'];
  check('S8 active 与 terminal 重叠抛错', throwsWith(() => validateEnums(bad), '重叠'));
}

// ---- S9 缺文件 fail-loud（loadEnums）----
{
  check('S9 单源文件缺失抛错（fail-loud 无 fallback）',
    throwsWith(() => loadEnums(path.join(SCRIPT_DIR, '..', 'no-such-enums.txt')), '不可读'));
}

// ---- S10 注释行与空行忽略 ----
{
  const e = parseEnums('# 注释\n\nlevel.all=L0 L1\n');
  check('S10 注释与空行忽略（仅 1 键）', Object.keys(e).length === 1 && e['level.all'].join('+') === 'L0+L1');
}

// ---- S11 退役（2026-10-12）：shell 侧 sed 读枚举的消费者已消亡 ----
// 钩子 2026-10-11 全 node 化后（git 仍以自带 sh 启动钩子文件、她bang 即 node），仓内不再有
// 任何 sed/sh 读 workflow-enums.txt 的消费点（宿主适配层亦无）——「跨语言单源口径」保证随消费面
// 退役。原场景 `execSync('sh -c "sed …"')` 在 CI 代理（Windows CmdLine 无 PATH sh）上未捕获崩溃
// （S1-S10 全过后击穿套件），是 develop 增量门第二轮红的元凶之二。
// node 侧读取口径由 S1（真实单源加载）持续锁定。

// ---- S12 CRLF 行尾容忍（autocrlf 检出坑：rule-budgets.txt 同约定；node 侧 split(/\r?\n/) 天然免疫，显式锁定）----
{
  const crlf = 'doc.status.all=draft approved done superseded cancelled\r\nlevel.all=L0 L1 L2 L3\r\n';
  const e = parseEnums(crlf);
  check('S12 CRLF 行尾不残留 \\r（值尾无回车）',
    e['level.all'].join('+') === 'L0+L1+L2+L3' && !e['doc.status.all'].some((v) => v.includes('\r')),
    JSON.stringify(e));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
