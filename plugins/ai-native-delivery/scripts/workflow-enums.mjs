// workflow-enums 读取器——.agents/config/workflow-enums.txt 单源（2026-09-25 enum-single-source）
// 消费方：check-loop.mjs / workflow-board-server.mjs / kb-search.mjs / gen-workflow-index.mjs /
//         fill-{intent,plan,spec}.mjs（均经本读取器）。（2026-09-26 check-loop sh→node 迁移后，
//         原先的 sh sed 消费方已退役——全部消费方统一经本读取器，无跨语言读取口径；S11 测试仍守
//         「空格分隔 + # 注释」格式对简单工具保持可解析）
// fail-loud 无 fallback：kit 自带该文件，缺失/坏数据属安装破损——直接抛错崩得可见，
//   doctor §2 布局门同时把关文件存在性。禁止在任何消费方内再抄一份枚举字面量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认单源文件定位（2026-10-27 插件化迁移）：项目侧 config/ 优先，缺失回退插件内 config-templates/
//（首次初始化的种子）。源仓形态（本模块被复制进 <root>/.agents/scripts/ 时）两候选同位，行为不变。
// 注：check-loop 主链不消费本默认值——kit 显式传 <root>/.agents/config/workflow-enums.txt 且缺文件
// fail-loud（fixture 契约）；默认值只服务「无参调用方」（如 gen-workflow-index 的模块级 ENUMS）。
const ENUMS_HERE = path.dirname(fileURLToPath(import.meta.url));
const ENUMS_FILE = [
  path.join(ENUMS_HERE, '..', 'config', 'workflow-enums.txt'),
  path.join(ENUMS_HERE, '..', 'config-templates', 'workflow-enums.txt'),
].find((p) => fs.existsSync(p)) || path.join(ENUMS_HERE, '..', 'config', 'workflow-enums.txt');

// parseEnums(text)：`key=a b` 行 → { key: ['a','b'] }；非法行/重复键/重复值抛错（单源纪律）
export function parseEnums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-z][a-z0-9.]*)=(\S.*)$/);
    if (!m) throw new Error('workflow-enums 行格式非法（须 key=value value）: ' + line);
    if (m[1] in out) throw new Error('workflow-enums 键重复: ' + m[1]);
    const vals = m[2].trim().split(/\s+/);
    if (new Set(vals).size !== vals.length) throw new Error('workflow-enums 值重复: ' + line);
    out[m[1]] = vals;
  }
  return out;
}

const NEED_KEYS = [
  'doc.status.all', 'doc.status.confirmed', 'doc.status.active', 'doc.status.terminal', 'doc.status.abandoned',
  'incident.status.all', 'incident.status.active', 'level.all',
];

// validateEnums(enums)：跨键不变量（子集关系 + 活跃/终态互斥 + 关键态在位）——坏数据尽早抛错
export function validateEnums(e) {
  for (const k of NEED_KEYS) {
    if (!Array.isArray(e[k]) || !e[k].length) throw new Error('workflow-enums 缺键或空值: ' + k);
  }
  const sub = (a, b) => {
    for (const v of e[a]) if (!e[b].includes(v)) throw new Error(`workflow-enums 不变量破: ${a} 含 ${b} 外的值 ${v}`);
  };
  sub('doc.status.confirmed', 'doc.status.all');
  sub('doc.status.active', 'doc.status.all');
  sub('doc.status.terminal', 'doc.status.all');
  sub('doc.status.abandoned', 'doc.status.all');
  sub('doc.status.abandoned', 'doc.status.terminal');
  sub('incident.status.active', 'incident.status.all');
  if (e['doc.status.active'].some((v) => e['doc.status.terminal'].includes(v))) {
    throw new Error('workflow-enums 不变量破: doc.status.active 与 doc.status.terminal 重叠');
  }
  if (!e['doc.status.confirmed'].includes('approved') || !e['doc.status.terminal'].includes('done')) {
    throw new Error('workflow-enums 不变量破: approved 须在 confirmed、done 须在 terminal（确认/关单语义锚点）');
  }
  return e;
}

// loadEnums(file = 单源标准位置)：读文件 → parse → validate；缺文件抛错（fail-loud）
export function loadEnums(file = ENUMS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error('workflow-enums 单源文件不可读（本仓配置，见 .agents/config/ 落位）: ' + file + ' — ' + err.message);
  }
  return validateEnums(parseEnums(text));
}

// 模块级常量：import 即加载即校验（标准位置）
export const ENUMS = loadEnums();
export default ENUMS;
