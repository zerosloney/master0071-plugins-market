#!/usr/bin/env node
// grade-task — 两问定级（设计文档 §2.1 / §3.3 grade_task 工具的实现内核，可独立 CLI 跑、被 mcp/tools.mjs 包装）
// 两问（禁止按严重程度从 L1 往上滑）：
//   ① 结构面（schema / 迁移 SQL / DI / 认证管线）命中吗？→ 命中即 L3；
//   ② 契约或共享口径命中吗？→ 命中即 L2；
//   ③ 都没有 → L1。
// 判据单源分层（2026-10-27 MCP 工具层迁移）：
//   L3 = 通用结构面正则（本文件内联四类——schema/迁移 SQL/DI/认证管线是跨项目稳定语义，
//        不随项目配置漂移，无需配置化）；
//   L2 = 闭集四类通用关键词（编码权威/共享契约/既有接口语义/全局横切，§2.2）∪
//        lane-surfaces.txt 的 product 段 ERE（项目自登记的触达面，configDir() 项目侧优先回退
//        config-templates——与 check-lane-surface.mjs 同一段协议 ## engine / ## product）；
//   级别合法性以 workflow-enums.txt 的 level.all 校验（缺文件/缺键不阻断——定级是 advisory 面，
//        fail-open 出 rationale 注记；check-loop 主链的 fail-loud 契约不受此影响）。
// 输出：{ level, hits[], rationale }——hits 非空即判级有据（§10.1 可测化）；L1 的负向证据写在 rationale。
// 用法：node grade-task.mjs "<任务描述>" [--root <仓库根>]
// 测试：node test/grade.test.mjs（§10.1 三断言 + hits 非空）
import fs from 'node:fs';
import path from 'node:path';
import { configDir, PLUGIN_CONFIG_TEMPLATES_DIR } from './paths.mjs';

// root = null（未锚定项目根）时只用插件种子——configDir 的「项目侧优先」语义依赖真实根
const cfgDirOf = (root) => (root ? configDir(root) : PLUGIN_CONFIG_TEMPLATES_DIR);

// ---- L3 结构面正则（两问第①问：数据/运行时结构）----
export const L3_PATTERNS = [
  ['schema 变更', /\bschema\b|数据库结构|表结构|数据结构变更/i],
  ['迁移 SQL', /迁移\s*(?:sql|脚本)|\bmigrations?\b|\.sql\b|alter\s+table|create\s+table|drop\s+(?:table|column|database)|add\s+column/i],
  ['DI 管线', /\bDI\b|依赖注入|dependency\s+injection|容器注册|服务注册/i],
  ['认证管线', /认证|鉴权|授权管线|\bauth(?:\s*(?:管线|流程|中间件))?|中间件|middleware/i],
];

// ---- L2 闭集四类通用关键词（两问第②问：契约或共享口径，§2.2）----
export const L2_PATTERNS = [
  ['编码权威', /编码规则|编码权威|取号|编号规则|单号规则|命名规则|\bid\s*生成/i],
  ['共享契约', /共享契约|基类|\bDTO\b|公共接口|接口签名|公共\s*API|跨模块共享|shared\s+kernel/i],
  ['既有接口语义', /既有接口|接口语义|行为变化|默认值|钳制|失效变生效|向后不兼容|破坏性变更/i],
  ['全局横切', /全局横切|横切口径|错误响应|错误出口|分页口径|分页参数|校验口径|聚合投影|统一出口/i],
];

// 段协议（与 check-lane-surface.mjs 同口径）：`## engine` / `## product` 行切换类别——
// 只有 product 段（产品契约/schema 面）参与 L2 判定；engine 段是门禁自身面，与任务定级无关。
// ERE 行为 grep -E 兼容、new RegExp 直译（与 check-lane-surface 同法）；语法错误行收集不抛
// （定级是 advisory 面，fail-soft 出注记；门禁侧自己的 fail-closed 语义不在此复制）。
const SECTION_RE = /^##\s*(engine|product)\s*$/i;

export function parseLaneSurfaces(text) {
  const product = [];
  const syntaxErrors = [];
  let cls = 'engine';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(SECTION_RE);
    if (sec) { cls = sec[1].toLowerCase(); continue; }
    if (line.startsWith('#')) continue;
    try {
      if (cls === 'product') product.push(new RegExp(line));
    } catch {
      syntaxErrors.push(line);
    }
  }
  return { product, syntaxErrors };
}

// lane-surfaces 的 ERE 是为「文件路径清单」写的（常带 ^ 锚）；对任务描述这类自由文本匹配时
// 剥单个前导 ^（prose 不是路径列表，剥锚才是「描述里出现该路径片段」的自然语义）。
const unanchor = (re) => (re.source.startsWith('^') ? new RegExp(re.source.slice(1), re.flags) : re);

function loadLaneSurfaces(root) {
  const file = path.join(cfgDirOf(root), 'lane-surfaces.txt');
  try {
    return { ...parseLaneSurfaces(fs.readFileSync(file, 'utf8')), file };
  } catch {
    return { product: [], syntaxErrors: [], file, missing: true };
  }
}

// level.all 单源校验（缺文件/缺键 fail-open——advisory 面不因配置缺失崩，rationale 注记）
function loadLevels(root) {
  const file = path.join(cfgDirOf(root), 'workflow-enums.txt');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^level\.all=(\S.*)$/);
      if (m) return { levels: m[1].trim().split(/\s+/), file };
    }
    return { levels: null, file };
  } catch {
    return { levels: null, file, missing: true };
  }
}

/**
 * 两问定级。
 * @param {string} description 任务描述（自由文本）
 * @param {string|null} [root] 项目根（git 仓库根；null = 只用插件内 config-templates）
 * @returns {{level: 'L1'|'L2'|'L3', hits: Array<{source: string, pattern: string, match: string}>, rationale: string}}
 */
export function gradeTask(description, root = null) {
  const text = String(description ?? '');
  const hits = [];
  const notes = [];
  const lane = loadLaneSurfaces(root);
  if (lane.missing) notes.push(`lane-surfaces.txt 不可读（${lane.file}）——L2 触达面比对收窄为通用关键词`);
  if (lane.syntaxErrors.length) notes.push(`lane-surfaces.txt 有 ${lane.syntaxErrors.length} 条非法 ERE 行已跳过（${lane.syntaxErrors[0]}…）`);

  // 第①问：结构面 → L3
  for (const [name, re] of L3_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ source: 'L3-结构面', pattern: name, match: m[0] });
  }
  if (hits.length) {
    return { level: 'L3', hits, rationale: `两问定级①：命中结构面「${[...new Set(hits.map((h) => h.pattern))].join('、')}」→ L3（数据/运行时结构；同 L2 确认门 + spec 新会话独立复核，未确认不放行）${notes.length ? '。' + notes.join('；') : ''}` };
  }

  // 第②问：契约或共享口径 → L2（闭集四类通用关键词 ∪ lane-surfaces product 段）
  for (const [name, re] of L2_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ source: 'L2-闭集', pattern: name, match: m[0] });
  }
  for (const re of lane.product) {
    const m = text.match(unanchor(re));
    if (m) hits.push({ source: 'L2-触达面', pattern: re.source, match: m[0] });
  }
  if (hits.length) {
    return { level: 'L2', hits, rationale: `两问定级②：命中契约/共享口径「${[...new Set(hits.map((h) => h.pattern))].join('、')}」→ L2（规则/契约；同步确认门：spec 确认 → plan 确认 → 动手）${notes.length ? '。' + notes.join('；') : ''}` };
  }

  // 第③问：都没有 → L1（负向证据落在 rationale，hits 留空——判低也是判级结论）
  const levels = loadLevels(root);
  const levelNote = levels.levels
    ? `级别合法集 ${levels.levels.join('/')}（workflow-enums.txt level.all）`
    : 'workflow-enums.txt 的 level.all 不可读——级别合法性未校验（fail-open）';
  return {
    level: 'L1',
    hits,
    rationale: `两问定级③：L3 结构面（schema/迁移 SQL/DI/认证管线）与 L2 闭集四类（编码权威/共享契约/既有接口语义/全局横切）及触达面清单均未命中 → L1（协作道，一份 plan 即入口）。${levelNote}${notes.length ? '。' + notes.join('；') : ''}`,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('grade-task.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? path.resolve(argv[ri + 1] || '') : null;
  const desc = argv.filter((a, i) => a !== '--root' && i !== ri + 1).join(' ');
  if (!desc.trim()) {
    console.error('用法：node grade-task.mjs "<任务描述>" [--root <仓库根>]');
    process.exit(1);
  }
  console.log(JSON.stringify(gradeTask(desc, root), null, 2));
}
