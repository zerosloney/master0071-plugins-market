#!/usr/bin/env node
// grade.test.mjs — 两问定级可测化（设计文档 §10.1 第 1 条）
// 断言：①命中闭集（公共接口签名）的描述 → L2 且 hits 非空；②纯页面文案描述 → L1；
//       ③schema 变更 → L3 且 hits 非空；④rationale 恒非空 + lane-surfaces product 段参与判定。
// 零依赖，Node ≥ 18 直接运行：node test/grade.test.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { gradeTask, parseLaneSurfaces, L2_PATTERNS, L3_PATTERNS } from '../scripts/grade-task.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// ---- §10.1 断言 1：命中闭集（共享契约/公共接口签名）→ L2 ----
{
  const r = gradeTask('修改共享契约：公共接口签名 IOrderService.GetPaged 的分页参数默认值改为 50');
  check('公共接口签名描述 → L2', r.level === 'L2', `got ${r.level}: ${JSON.stringify(r)}`);
  check('L2 判定依据 hits 非空', Array.isArray(r.hits) && r.hits.length > 0, JSON.stringify(r.hits));
  check('L2 hits 命中共享契约类', r.hits.some((h) => h.pattern === '共享契约'), JSON.stringify(r.hits));
}

// ---- §10.1 断言 2：纯页面文案 → L1（负向判级，hits 留空、依据落 rationale）----
{
  const r = gradeTask('把登录页的标题文案从「用户登录」改为「欢迎登录」，只动页面文字');
  check('纯页面文案描述 → L1', r.level === 'L1', `got ${r.level}: ${JSON.stringify(r)}`);
  check('L1 无命中（hits 为空数组）', Array.isArray(r.hits) && r.hits.length === 0, JSON.stringify(r.hits));
  check('L1 rationale 记录负向证据', typeof r.rationale === 'string' && r.rationale.includes('未命中'), r.rationale);
}

// ---- §10.1 断言 3：schema 变更 → L3 ----
{
  const r = gradeTask('订单表新增冗余字段，需要 schema 迁移 SQL（alter table）');
  check('schema 变更描述 → L3', r.level === 'L3', `got ${r.level}: ${JSON.stringify(r)}`);
  check('L3 判定依据 hits 非空', r.hits.length > 0, JSON.stringify(r.hits));
}

// ---- 判级优先级：结构面与契约面同时命中 → L3 优先（两问顺序）----
{
  const r = gradeTask('重构认证中间件，同时调整错误响应统一出口口径');
  check('结构面+契约面并存 → L3（第①问优先）', r.level === 'L3', `got ${r.level}: ${JSON.stringify(r)}`);
}

// ---- lane-surfaces product 段参与 L2（触达面 ERE 对描述文本剥 ^ 锚匹配）----
{
  const tpl = readFileSync(path.join(TEST_DIR, '..', 'config-templates', 'lane-surfaces.txt'), 'utf8');
  const parsed = parseLaneSurfaces(tpl);
  check('种子 lane-surfaces product 段非空', parsed.product.length > 0, `got ${parsed.product.length}`);
  check('种子 lane-surfaces 无语法错误行', parsed.syntaxErrors.length === 0, parsed.syntaxErrors.join(' | '));
  const r = gradeTask('调整 db/schema/ 下的建表脚本（schema 迁移 SQL）', null);
  check('触达面清单条目出现在 L3 hits 之外按 L3 优先', r.level === 'L3', `got ${r.level}`);
  const r2 = gradeTask('backend/shared/OrderPager 的分页口径调整');
  check('product 触达面命中 → L2', r2.level === 'L2' && r2.hits.some((h) => h.source === 'L2-触达面'), JSON.stringify(r2));
}

// ---- 输出契约：rationale 恒非空 ----
{
  const samples = [
    '改个按钮颜色',
    '统一全部列表页的分页参数默认值',
    '新增 workflow 迁移脚本目录',
  ];
  let allRationale = true;
  for (const s of samples) {
    const r = gradeTask(s);
    if (!r.rationale || typeof r.rationale !== 'string') { allRationale = false; break; }
  }
  check('三态 rationale 恒非空（判定依据可读）', allRationale);
}

// ---- 通用关键词表与结构面表非空（配置驱动面的最小组数）----
check('L2 闭集四类关键词表齐备', L2_PATTERNS.length === 4, `got ${L2_PATTERNS.length}`);
check('L3 结构面四类正则表齐备', L3_PATTERNS.length === 4, `got ${L3_PATTERNS.length}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
