#!/usr/bin/env node
// read-context.mjs 的 fixture 驱动测试——INDEX 注入纪律（设计稿 ai-native-closed-loop-and-memory 步骤 F）
// 断言：①超长 INDEX（> INDEX_MAX_LINES 行）→ 输出附 advisory「分片/归档建议」段 + 实际行数；
//       ②带内 INDEX（含恰等于阈值的边界）→ 输出键形与既有形状逐键一致（快照级，无新增键）；
//       ③未初始化仓 → 形状不变（initialized:false + hint）；④阈值常量在场且为 200 行量级。
// 用法：node test/read-context.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readContext, INDEX_MAX_LINES } from '../scripts/read-context.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const doc = (fm, title) => `---\n${fm}\n---\n# ${title}\n`;
const LEGACY_TOP_KEYS = ['initialized', 'index', 'inFlight', 'inFlightCount', 'confirmations', 'degraded'];

// 建仓：workflow/ + 三件套各一在途件 + INDEX.md（行数可调）
const mkfix = (indexLines) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-context-test-'));
  for (const d of ['intents', 'specs', 'plans']) fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-01-a.md'), doc('状态: draft\n级别: L1', 'INTENT — 甲'), 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', 'plans', '2026-10-01-a.md'), doc('状态: approved\n级别: L1', 'PLAN — 甲'), 'utf8');
  const idx = indexLines != null
    ? ['# index fixture', ...Array.from({ length: indexLines - 1 }, (_, i) => `| 行 ${i + 1} |`)].join('\n') + '\n'
    : '# index fixture\n\n## 活跃（1）\n';
  fs.writeFileSync(path.join(root, 'workflow', 'INDEX.md'), idx, 'utf8');
  return root;
};

// ---- 场景 1：阈值常量（步骤 F 独立常量从权，200 行量级）----
check('场景 1：INDEX_MAX_LINES 导出且为 200（量级上限，非门禁）', INDEX_MAX_LINES === 200, `got ${INDEX_MAX_LINES}`);

// ---- 场景 2：带内 INDEX → 输出与现形状一致（快照级：无 lines/advisory 键）----
{
  const root = mkfix(4);
  const rc = readContext(root);
  const idxKeys = rc.index ? Object.keys(rc.index) : [];
  check('场景 2：带内 INDEX → 顶层键形与既有一致（无新增键）',
    JSON.stringify(Object.keys(rc)) === JSON.stringify(LEGACY_TOP_KEYS), JSON.stringify(Object.keys(rc)));
  check('场景 2：带内 INDEX → index 键形恰 [exists, readable, head]',
    JSON.stringify(idxKeys) === JSON.stringify(['exists', 'readable', 'head']), JSON.stringify(idxKeys));
  check('场景 2：带内 INDEX → 无 advisory', rc.index && rc.index.advisory === undefined && rc.index.lines === undefined, JSON.stringify(rc.index));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：边界——恰等于阈值不放建议（超阈值才建议）----
{
  const root = mkfix(INDEX_MAX_LINES);
  const rc = readContext(root);
  check('场景 3：恰等阈值（200 行）→ 无 advisory（键形不变）',
    rc.index && rc.index.advisory === undefined && Object.keys(rc.index).join(',') === 'exists,readable,head', JSON.stringify(Object.keys(rc.index)));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：超长 INDEX → advisory 在场 + 行数 + 其余形状不变 ----
{
  const over = INDEX_MAX_LINES + 37;
  const root = mkfix(over);
  const rc = readContext(root);
  check('场景 4：超阈值 → index.lines = 实际行数（尾换行不计幻影行）',
    rc.index && rc.index.lines === over, `got ${rc.index && rc.index.lines} want ${over}`);
  check('场景 4：超阈值 → advisory 在场且点名阈值/超行规模',
    rc.index && typeof rc.index.advisory === 'string'
    && rc.index.advisory.includes(String(INDEX_MAX_LINES)) && rc.index.advisory.includes(String(over)), rc.index && rc.index.advisory);
  check('场景 4：advisory 指向 compact/archive 既有机制',
    /archive-sweep|compact-ledgers/.test(rc.index.advisory || '') && /只建议、不改写/.test(rc.index.advisory || ''), rc.index && rc.index.advisory);
  check('场景 4：头部仍取前 15 行（注入面形状不变）', Array.isArray(rc.index.head) && rc.index.head.length === 15, `got ${rc.index.head.length}`);
  check('场景 4：顶层键形不变（advisory 挂 index 内，不换输出形状）',
    JSON.stringify(Object.keys(rc)) === JSON.stringify(LEGACY_TOP_KEYS), JSON.stringify(Object.keys(rc)));
  check('场景 4：在途清单/最近确认行不受影响（inFlightCount=2，confirmations=[]）',
    rc.inFlightCount === 2 && Array.isArray(rc.confirmations) && rc.confirmations.length === 0, JSON.stringify(rc.inFlight));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5：未初始化仓 → 形状不变（无 index 键）----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-context-test-empty-'));
  const rc = readContext(root);
  check('场景 5：未初始化 → initialized:false + hint，无 index/advisory',
    rc.initialized === false && /init_engine/.test(rc.hint || '') && !('index' in rc), JSON.stringify(rc));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
