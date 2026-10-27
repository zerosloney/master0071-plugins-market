#!/usr/bin/env node
// check-lane-surface.test.mjs — 泳道完整性门禁 fixture 套件（2026-10-01 drift-hardening）
// 方法：现场构造临时根（workflow/{intents,incidents} + .agents/config/lane-surfaces.txt），经
//       --root/--branch/--staged-file 三注入位 spawn 脚本，断言 exit code 与输出关键词。
//       场景集对齐同名 spec「功能行为」表 S1-S6 + 平台边界（CRLF / 非 ASCII / detached /
//       配置语法 / 状态活性 / incident 等价），另含 1 个 git 真仓端到端（quotepath=off 实路径）。
// 用法：node test/check-lane-surface.test.mjs（npm test 随跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ciPushBefore } from '../scripts/check-lane-surface.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const SCRIPT = path.join(SCRIPT_DIR, '..', 'scripts', 'check-lane-surface.mjs');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? '\n      ' + detail : ''}`); }
};

const mkfix = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-surface-test-'));
  for (const s of ['intents', 'incidents']) fs.mkdirSync(path.join(d, 'workflow', s), { recursive: true });
  fs.mkdirSync(path.join(d, '.agents', 'config'), { recursive: true });
  return d;
};
const w = (root, rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
// eol='\r\n' 时整文件按 CRLF 写（平台边界：frontmatter 读取容忍性）
const intent = (name, fm, eol = '\n') => `---${eol}${fm}${eol}---${eol}# INTENT — ${name}${eol}`;
const incident = (fm) => `---\n${fm}\n---\n# INCIDENT\n`;
const run = (root, { branch = 'main', staged = [] } = {}) => {
  const listFile = path.join(root, 'staged.txt');
  fs.writeFileSync(listFile, staged.join('\n') + '\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--branch', branch, '--staged-file', listFile], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// 通用 fixture：面清单 + 一个活跃 L1 intent（2026-09-28）+ 可选第二个入口
const base = (root, { level = 'L1', status = 'approved', extra = null } = {}) => {
  w(root, '.agents/config/lane-surfaces.txt', '^templates/\n^\\.agents/(scripts|hooks)/\n');
  w(root, 'workflow/intents/2026-09-28-old-l1.md', intent('x', `状态: ${status}\n级别: ${level}\n日期: 2026-09-28\n模块: pipeline`));
  if (extra) w(root, extra[0], intent('y', extra[1]));
};
const FM_LOW_NEW = '状态: draft\n级别: L1\n日期: 2026-10-01\n模块: ui';

// --- S1：命中 + 活跃 L2 存在 → 豁免放行 ---
{
  const d = mkfix();
  base(d, { level: 'L2' });
  const r = run(d, { staged: ['templates/_agents/scripts/x.mjs'] });
  check('S1 命中面+活跃 L2 入口 → 放行且无触达面判低输出', r.code === 0 && !r.out.includes('触达面判低'), r.out);
}
// --- S2：命中 + 活跃全为 L1（低泳道）→ 阻断 ---
{
  const d = mkfix();
  base(d);
  const r = run(d, { staged: ['templates/_agents/scripts/x.mjs', 'docs/readme.md'] });
  check('S2 命中面+仅活跃 L1 → 阻断且消息含标签/命中文件/入口名/修法',
    r.code === 1 && r.out.includes('[触达面判低]') && r.out.includes('templates/_agents/scripts/x.mjs')
      && r.out.includes('workflow/intents/2026-09-28-old-l1.md') && r.out.includes('修法'),
    r.out);
}
// --- S2b：多个低泳道活跃 → 点名最新（日期排序）---
{
  const d = mkfix();
  base(d, { extra: ['workflow/intents/2026-10-01-new-low.md', FM_LOW_NEW] });
  const r = run(d, { staged: ['templates/t.md'] });
  check('S2b 多活跃 L1 → 关联入口取最新日期件', r.code === 1 && r.out.includes('2026-10-01-new-low') && r.out.includes('共 2 件'), r.out);
}
// --- S2c：experiment 分支 → 检查 A 降级 advisory ---
{
  const d = mkfix();
  base(d);
  const r = run(d, { branch: 'experiment/poc', staged: ['templates/t.md'] });
  check('S2c experiment 分支检查 A → advisory 放行', r.code === 0 && r.out.includes('advisory·experiment'), r.out);
}
// --- S3：命中 + 无活跃入口 → advisory 放行（done 不算活跃）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^templates/\n');
  w(d, 'workflow/intents/2026-09-01-closed.md', intent('c', '状态: done\n级别: L1\n日期: 2026-09-01\n模块: ui'));
  const r = run(d, { staged: ['templates/t.md'] });
  check('S3 命中+无活跃（done 不算活跃）→ advisory 放行', r.code === 0 && r.out.includes('无任何活跃入口'), r.out);
}
// （原 S4b「探索标记缺失」检查 B 场景随 2026-10-10 收敛系列 2 退役。）
// --- S5：配置缺失 → 检查 A 整体静默跳过（装户无感）---
{
  const d = mkfix();
  w(d, 'workflow/intents/2026-09-28-l1.md', intent('x', '状态: approved\n级别: L1\n日期: 2026-09-28\n模块: ui'));
  const r = run(d, { staged: ['templates/t.md'] });
  check('S5 无 lane-surfaces.txt → 静默跳过', r.code === 0 && r.out.trim() === '', JSON.stringify(r.out));
}
// --- incident 等价：open incident L2 豁免；fixed L1 算活跃低级 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^src/\n');
  w(d, 'workflow/incidents/2026-09-30-inc.md', incident('状态: open\n级别: L2\n发现: 2026-09-30\n模块: backend'));
  const r = run(d, { staged: ['src/a.ts'] });
  check('incident 等价：活跃 open incident L2 → 豁免放行', r.code === 0, r.out);
}
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^src/\n');
  w(d, 'workflow/incidents/2026-09-30-inc.md', incident('状态: fixed\n级别: L1\n发现: 2026-09-30\n模块: backend'));
  const r = run(d, { staged: ['src/a.ts'] });
  check('incident 等价：fixed L1 算活跃低级入口 → 阻断',
    r.code === 1 && r.out.includes('[触达面判低]') && r.out.includes('incidents/2026-09-30-inc.md'), r.out);
}
// --- 级别缺失：suspect 拦截（方案 C：不能自证 high 即拦，消息给两字段对齐指引）---
{
  const d = mkfix();
  base(d, { level: '', status: 'draft' });
  const r = run(d, { staged: ['templates/t.md'] });
  check('级别缺失 → 泳道 suspect 拦断且消息含补级别指引',
    r.code === 1 && r.out.includes('suspect') && r.out.includes('补该入口「级别」'), r.out);
}
// --- 单字段协议：risk_level 残留字段宽容（级别 L2 单字段 high，不因残留分歧降 suspect）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^templates/\n');
  w(d, '.agents/config/engine.json', JSON.stringify({ policyVersion: 2 }));
  w(d, 'workflow/intents/2026-10-02-divergent.md',
    intent('x', '状态: approved\n级别: L2\nrisk_level: L1\n日期: 2026-10-02\n模块: pipeline'));
  const r = run(d, { staged: ['templates/t.md'] });
  check('级别 L2 + risk_level 残留 L1 → 单字段 high 不拦（双协议退役回归钉）',
    r.code === 0 && !r.out.includes('触达面判低'), r.out);
}
// --- 单字段协议：级别 L2 high → 豁免（对照）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^templates/\n');
  w(d, '.agents/config/engine.json', JSON.stringify({ policyVersion: 2 }));
  w(d, 'workflow/intents/2026-10-02-aligned.md',
    intent('x', '状态: approved\n级别: L2\n日期: 2026-10-02\n模块: pipeline'));
  const r = run(d, { staged: ['templates/t.md'] });
  check('级别 L2 → 豁免放行', r.code === 0 && !r.out.includes('触达面判低'), r.out);
}
// --- 平台边界：CRLF frontmatter ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^templates/\n');
  w(d, 'workflow/intents/2026-09-28-crlf.md', intent('x', '状态: approved\r\n级别: L1\r\n日期: 2026-09-28\r\n模块: ui', '\r\n'));
  const r = run(d, { staged: ['templates/t.md'] });
  check('CRLF frontmatter 正常解析（仍阻断）', r.code === 1 && r.out.includes('2026-09-28-crlf'), r.out);
}
// --- 平台边界：非 ASCII 路径透传（quotepath 教训的对账面）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^模块/\n');
  w(d, 'workflow/intents/2026-09-28-l1.md', intent('x', '状态: approved\n级别: L1\n日期: 2026-09-28\n模块: ui'));
  const r = run(d, { staged: ['模块/接口契约.ts'] });
  check('非 ASCII 暂存路径命中模式且消息原样透传', r.code === 1 && r.out.includes('模块/接口契约.ts'), r.out);
}
// --- 平台边界：detached HEAD（branch=HEAD）→ A strict、B 跳过 ---
{
  const d = mkfix();
  base(d);
  w(d, 'workflow/intents/2026-10-01-poc.md', intent('p', '状态: draft\n级别: L1\n日期: 2026-10-01\n模块: ui'));
  const r = run(d, { branch: 'HEAD', staged: ['templates/t.md', 'workflow/intents/2026-10-01-poc.md'] });
  check('detached HEAD：A 按 strict 阻断、B 不触发', r.code === 1 && r.out.includes('[触达面判低]') && !r.out.includes('探索标记缺失'), r.out);
}
// --- 边界：_TEMPLATE.md 排除（不算活跃入口、不触发 B）---
{
  const d = mkfix();
  w(d, 'workflow/intents/_TEMPLATE.md', intent('t', '状态: draft\n级别: L1'));
  const r = run(d, { branch: 'experiment/poc', staged: ['workflow/intents/_TEMPLATE.md'] });
  check('_TEMPLATE.md 不触发检查 B，也不算活跃入口', r.code === 0, r.out);
}
// --- 配置边界：非法 ERE 行 → fail-closed ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', '^ok/\n[invalid(\n');
  const r = run(d, { staged: ['ok/a.ts'] });
  check('配置含非法 ERE → fail-closed 阻断并指出坏行', r.code === 1 && r.out.includes('[面清单语法错误]') && r.out.includes('[invalid('), r.out);
}
// --- git 真仓端到端：走生产发现路径（quotepath=off + diff --cached）---
{
  const d = mkfix();
  const g = (a) => spawnSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: d, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  w(d, '.agents/config/lane-surfaces.txt', '^模块/\n');
  w(d, 'workflow/intents/2026-09-28-l1.md', intent('x', '状态: approved\n级别: L1\n日期: 2026-09-28\n模块: ui'));
  fs.mkdirSync(path.join(d, '模块'), { recursive: true });
  w(d, '模块/接口契约.ts', 'export {};\n');
  g(['add', '模块/接口契约.ts']);
  const r = spawnSync(process.execPath, [SCRIPT, '--root', d], { cwd: d, encoding: 'utf8' });
  check('git 端到端：真实暂存非 ASCII 路径 → 阻断且路径不转义',
    r.status === 1 && `${r.stdout || ''}${r.stderr || ''}`.includes('模块/接口契约.ts'),
    `${r.stdout || ''}${r.stderr || ''}`);
}

// --- 2026-10-09 ai-native-review-p1：段协议（engine/product）+ --ci 模式 ---
const runRaw = (root, args, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ciList = (root, files) => {
  const f = path.join(root, 'ci-files.txt');
  fs.writeFileSync(f, files.join('\n') + '\n');
  return f;
};
const SURFACES_SEG = '## engine\n^\\.agents/(scripts|hooks)/\n## product\n^backend/shared/\n';

// --- P1：product 段命中 + 无活跃入口（pre-commit）→ 阻断（产品面不属豁免面）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  const r = run(d, { staged: ['backend/shared/App.Shared.Application/x.cs'] });
  check('P1 product 命中+无活跃入口 → 阻断且含产品面语义与修法',
    r.code === 1 && r.out.includes('[产品契约面无活跃入口]') && r.out.includes('backend/shared/') && r.out.includes('maintain.md'), r.out);
}
// --- P2：product 命中 + approved L2 正文写出该路径 → 放行 ---
{
  const d = mkfix();
  const sql = 'wiki/数据维护/schema变更/2026-10-09-x/01-alter.sql';
  base(d, { level: 'L2' });
  w(d, 'workflow/intents/2026-09-28-old-l1.md', intent('x', '状态: approved\n级别: L2\n日期: 2026-09-28\n模块: pipeline') + `\n## 影响面\n- ${sql}\n`);
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG + '^wiki/数据维护/schema变更/.*\\.sql$\n');
  const r = run(d, { staged: [sql] });
  check('P2 product 命中（schema SQL）+ approved L2 正文含该路径 → 放行', r.code === 0 && !r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P2b：approved L2 但正文没写路径 → 不罩 ---
{
  const d = mkfix();
  base(d, { level: 'L2' });
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG + '^wiki/数据维护/schema变更/.*\\.sql$\n');
  const r = run(d, { staged: ['wiki/数据维护/schema变更/2026-10-09-x/01-alter.sql'] });
  check('P2b approved L2 正文不含路径 → 阻断', r.code === 1 && r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P4：product + 仅 fixed L2 incident → fixed 不罩产品面 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-09-18-fixed.md', incident('状态: fixed\n级别: L2\n发现: 2026-09-18\n模块: shared'));
  const r = run(d, { staged: ['backend/shared/a.cs'] });
  check('P4 product + 仅 fixed L2 incident → 阻断（fixed 不罩产品面）',
    r.code === 1 && r.out.includes('[产品契约面无活跃入口]') && !r.out.includes('[触达面判低]'), r.out);
}
// --- P4b：product + 仅 open L1 → 低级别 open 不罩 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-10-10-low.md', incident('状态: open\n级别: L1\n发现: 2026-10-10\n模块: shared'));
  const r = run(d, { staged: ['backend/shared/a.cs'] });
  check('P4b product + 仅 open L1 incident → 阻断',
    r.code === 1 && r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P5：product + open L2 正文写出该路径 → 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-10-10-open.md', incident('状态: open\n级别: L2\n发现: 2026-10-10\n模块: shared') + '\n## 影响面\n- backend/shared/a.cs\n');
  const r = run(d, { staged: ['backend/shared/a.cs'] });
  check('P5 product + open L2 正文含该路径 → 放行', r.code === 0 && !r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P5b：open L2 正文为空 → 不罩 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-10-10-open.md', incident('状态: open\n级别: L2\n发现: 2026-10-10\n模块: shared'));
  const r = run(d, { staged: ['backend/shared/a.cs'] });
  check('P5b open L2 正文不含路径 → 阻断', r.code === 1 && r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P5c：路径只写在同名 plan → 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/intents/2026-10-10-via-plan.md', intent('p', '状态: approved\n级别: L2\n日期: 2026-10-10\n模块: shared'));
  w(d, 'workflow/plans/2026-10-10-via-plan.md', '# PLAN\n## 改动\n- backend/shared/a.cs\n');
  const r = run(d, { staged: ['backend/shared/a.cs'] });
  check('P5c 路径只写在同名 plan → 放行', r.code === 0 && !r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P5d：只写批次目录 → 罩住该目录下的 SQL，不罩别的批次 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG + '^wiki/数据维护/schema变更/.*\\.sql$\n');
  w(d, 'workflow/intents/2026-10-10-batch.md', intent('b', '状态: approved\n级别: L2\n日期: 2026-10-10\n模块: wiki') + '\n## 影响面\n- wiki/数据维护/schema变更/2026-10-09-x\n');
  const hit = run(d, { staged: ['wiki/数据维护/schema变更/2026-10-09-x/01-alter.sql'] });
  const miss = run(d, { staged: ['wiki/数据维护/schema变更/other-batch/02.sql'] });
  check('P5d 批次目录罩住目录内 SQL', hit.code === 0 && !hit.out.includes('[产品契约面无活跃入口]'), hit.out);
  check('P5d 批次目录不罩别的批次', miss.code === 1 && miss.out.includes('other-batch/02.sql'), miss.out);
}
// --- P5e：两条产品路径只写了一条 → 只拦未写的那条 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/intents/2026-10-10-half.md', intent('h', '状态: approved\n级别: L2\n日期: 2026-10-10\n模块: shared') + '\n## 影响面\n- backend/shared/a.cs\n');
  const r = run(d, { staged: ['backend/shared/a.cs', 'backend/shared/b.cs'] });
  check('P5e 只写一条路径 → 阻断并点名未写的路径',
    r.code === 1 && r.out.includes('backend/shared/b.cs') && !r.out.includes('backend/shared/a.cs'), r.out);
}
// --- P6：代码笔不要求协伴同暂存——暂存集携带 done L2，树上仅 fixed → 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-09-18-fixed.md', incident('状态: fixed\n级别: L2\n发现: 2026-09-18\n模块: shared'));
  w(d, 'workflow/intents/2026-10-10-done.md', intent('c', '状态: done\n级别: L2\n日期: 2026-10-10\n模块: shared'));
  const r = run(d, { staged: ['backend/shared/a.cs', 'workflow/intents/2026-10-10-done.md'] });
  check('P6 product + 暂存 done L2 协伴（树上仅 fixed）→ 放行', r.code === 0 && !r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P7：engine + 仅 fixed L2 → 引擎路径仍按活跃 high 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-09-18-fixed.md', incident('状态: fixed\n级别: L2\n发现: 2026-09-18\n模块: shared'));
  const r = run(d, { staged: ['.agents/scripts/y.mjs'] });
  check('P7 engine + 仅 fixed L2 → 放行（引擎路径不改）', r.code === 0 && !r.out.includes('[触达面判低]'), r.out);
}
// --- P8：experiment 上产品面无罩 → advisory，不阻断 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/incidents/2026-09-18-fixed.md', incident('状态: fixed\n级别: L2\n发现: 2026-09-18\n模块: shared'));
  const r = run(d, { branch: 'experiment/poc', staged: ['backend/shared/a.cs'] });
  check('P8 experiment 产品面无罩 → advisory 放行',
    r.code === 0 && r.out.includes('advisory·experiment') && r.out.includes('[产品契约面无活跃入口]'), r.out);
}
// --- P3：engine 段命中 + 无活跃入口 → 仍 advisory（分段向后兼容）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  const r = run(d, { staged: ['.agents/scripts/y.mjs'] });
  check('P3 engine 命中+无活跃入口 → advisory 放行（段语义不外溢）',
    r.code === 0 && r.out.includes('无任何活跃入口'), r.out);
}
// --- C1：--ci product 命中 + 无协伴入口 → 阻断 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  const r = runRaw(d, ['--ci', '--ci-file', ciList(d, ['backend/shared/a.cs', 'docs/x.md'])]);
  check('C1 CI product 命中+无协伴文档 → 阻断且消息含语义/修法',
    r.code === 1 && r.out.includes('[CI·产品契约面无协伴入口]') && r.out.includes('backend/shared/a.cs') && r.out.includes('plan.md'), r.out);
}
// --- C2：--ci product 命中 + diff 内协伴 L2 入口（done 状态亦算）→ 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'workflow/intents/2026-10-09-ci.md', intent('c', '状态: done\n级别: L2\n日期: 2026-10-09\n模块: shared'));
  const r = runRaw(d, ['--ci', '--ci-file', ciList(d, ['backend/shared/a.cs', 'workflow/intents/2026-10-09-ci.md'])]);
  check('C2 CI 协伴 L2 入口（done 亦算）→ 放行且出 info 行',
    r.code === 0 && r.out.includes('[CI·泳道]') && r.out.includes('2026-10-09-ci.md'), r.out);
}
// --- C2b：--ci 协伴入口为归档件（关单即归档，级别照读归档文件）→ 放行 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG + '^wiki/数据维护/schema变更/.*\\.sql$\n');
  const arch = 'workflow/archive/2026-10/intents/2026-10-15-archived.md';
  w(d, arch, intent('a', '状态: done\n级别: L3\n日期: 2026-10-15\n模块: wiki'));
  const r = runRaw(d, ['--ci', '--ci-file', ciList(d, ['wiki/数据维护/schema变更/2026-10-15-x/01-alter.sql', arch])]);
  check('C2b CI 协伴入口为归档 L3 件 → 放行且出 info 行（2026-10-15 lane-surface-ci-archive）',
    r.code === 0 && r.out.includes('[CI·泳道]') && r.out.includes('2026-10-15-archived.md'), r.out);
}
// --- C2c：归档件但级别为 L1 → 不算 high 协伴 → 阻断（防扩展过宽）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG + '^wiki/数据维护/schema变更/.*\\.sql$\n');
  const arch = 'workflow/archive/2026-10/intents/2026-10-15-archived-l1.md';
  w(d, arch, intent('a', '状态: done\n级别: L1\n日期: 2026-10-15\n模块: wiki'));
  const r = runRaw(d, ['--ci', '--ci-file', ciList(d, ['wiki/数据维护/schema变更/2026-10-15-x/01-alter.sql', arch])]);
  check('C2c 归档件为 L1 → 不算协伴 → 阻断',
    r.code === 1 && r.out.includes('[CI·产品契约面无协伴入口]'), r.out);
}
// --- C3：--ci engine 命中 → advisory 放行（CI 只执法 product 段）---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  const r = runRaw(d, ['--ci', '--ci-file', ciList(d, ['.agents/scripts/y.mjs'])]);
  check('C3 CI engine 命中 → advisory 放行', r.code === 0 && r.out.includes('CI 不拦引擎面'), r.out);
}
// --- C4：--ci 无基准事实（非 git root、无 --base/--ci-file）→ advisory 跳过 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  const r = runRaw(d, ['--ci']);
  check('C4 CI 无基准事实 → advisory 跳过 exit 0', r.code === 0 && r.out.includes('--base'), r.out);
}
// --- C5-C7：git 真仓（--base diff / 合并提交自动基准 / 坏 rev fail-closed / TF main 末笔）---
{
  const g = (d, a, env = {}) => spawnSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: d, encoding: 'utf8', env: { ...process.env, ...env } });
  const commitAll = (d, msg) => { g(d, ['add', '-A']); g(d, ['commit', '-q', '-m', msg]); };

  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  g(d, ['init', '-q', '-b', 'main']); g(d, ['config', 'user.email', 't@t']); g(d, ['config', 'user.name', 't']);
  w(d, 'README.md', 'base\n'); commitAll(d, 'base');
  const baseSha = g(d, ['rev-parse', 'HEAD']).stdout.trim();
  w(d, 'backend/shared/A.cs', 'x\n'); commitAll(d, 'touch product, no doc');
  // C5：显式 --base → diff 命中 product 且无协伴 → 阻断
  let r = runRaw(d, ['--ci', '--base', baseSha]);
  check('C5 git --base：diff 命中 product 无协伴 → 阻断', r.code === 1 && r.out.includes('[CI·产品契约面无协伴入口]'), r.out);
  // C6：坏 rev → fail-closed
  r = runRaw(d, ['--ci', '--base', 'deadbeefdeadbeef']);
  check('C6 git --base 坏 rev → fail-closed 阻断', r.code === 1 && r.out.includes('基准不可解'), r.out);
  // 补协伴 L2 doc 后重跑 → 放行（协伴判据=同 diff 携带）
  w(d, 'workflow/intents/2026-10-09-l2.md', intent('l', '状态: approved\n级别: L2\nrisk_level: L2\n日期: 2026-10-09\n模块: shared'));
  commitAll(d, 'carry L2 entry');
  r = runRaw(d, ['--ci', '--base', baseSha]);
  check('C5b git --base：diff 携带 L2 入口 → 放行', r.code === 0, r.out);

  // 合并提交自动基准：side 分支改 product+doc，merge 回 main → --ci 无 --base 自动取 HEAD^1
  const d2 = mkfix();
  w(d2, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  g(d2, ['init', '-q', '-b', 'main']); g(d2, ['config', 'user.email', 't@t']); g(d2, ['config', 'user.name', 't']);
  w(d2, 'README.md', 'base\n'); commitAll(d2, 'base');
  g(d2, ['checkout', '-q', '-b', 'wt/x']);
  w(d2, 'backend/shared/B.cs', 'y\n');
  w(d2, 'workflow/intents/2026-10-09-m.md', intent('m', '状态: approved\n级别: L2\nrisk_level: L2\n日期: 2026-10-09\n模块: shared'));
  commitAll(d2, 'side: product + L2 doc');
  // 第一父侧独有文件（若基准误取 side 父会被错算）——在 main 侧补一笔 engine 面提交
  g(d2, ['checkout', '-q', 'main']);
  w(d2, '.agents/scripts/z.mjs', '// engine\n'); commitAll(d2, 'main side engine file');
  g(d2, ['merge', '-q', '--no-ff', 'wt/x', '-m', 'merge PR']);
  r = runRaw(d2, ['--ci']);
  check('C7 合并提交：自动基准 HEAD^1 → 只核 incoming 侧（product 有协伴）→ 放行',
    // info 行在场本身即证明基准取了第一父（若误取 side 父，B.cs 不进 diff、无产品面命中与 info 行）
    r.code === 0 && r.out.includes('[CI·泳道]') && r.out.includes('2026-10-09-m.md'), r.out);

  // TF main 单亲推送：末笔命中 product 无协伴 → 阻断（HEAD~1 基准）
  const d3 = mkfix();
  w(d3, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  g(d3, ['init', '-q', '-b', 'main']); g(d3, ['config', 'user.email', 't@t']); g(d3, ['config', 'user.name', 't']);
  w(d3, 'README.md', 'base\n'); commitAll(d3, 'base');
  w(d3, 'backend/shared/C.cs', 'z\n'); commitAll(d3, 'direct push product');
  r = runRaw(d3, ['--ci'], { TF_BUILD: '1', BUILD_SOURCEBRANCH: 'refs/heads/main' });
  check('C8 TF_BUILD main 单亲：HEAD~1 基准核末笔 → 无协伴阻断', r.code === 1 && r.out.includes('[CI·产品契约面无协伴入口]'), r.out);
}
// --- M1：合并进行中（MERGE_HEAD 在场）→ 检查 A 跳过 ---
{
  const d = mkfix();
  const g = (a) => spawnSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: d, encoding: 'utf8' });
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  w(d, 'README.md', 'base\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  w(d, 'backend/shared/M.cs', 'm\n'); g(['add', 'backend/shared/M.cs']);
  // 制造合并态：MERGE_HEAD 指向既有提交即可被 rev-parse 认出
  g(['rev-parse', 'HEAD']);
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(d, '.git', 'MERGE_HEAD'), headSha + '\n');
  const listFile = path.join(d, 'staged.txt');
  fs.writeFileSync(listFile, 'backend/shared/M.cs\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--root', d, '--branch', 'main', '--staged-file', listFile], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('M1 合并进行中 → 检查 A 跳过（advisory，不阻断）',
    r.status === 0 && out.includes('MERGE_HEAD') && !out.includes('[产品契约面无活跃入口]'), out);
}
// --- M2：无 MERGE_HEAD，但 --merge（pre-merge-commit 窗口）→ 检查 A 同样跳过 ---
{
  const d = mkfix();
  w(d, '.agents/config/lane-surfaces.txt', SURFACES_SEG);
  w(d, 'backend/shared/M.cs', 'm\n');
  const listFile = path.join(d, 'staged.txt');
  fs.writeFileSync(listFile, 'backend/shared/M.cs\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--merge', '--root', d, '--branch', 'main', '--staged-file', listFile], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('M2 --merge 且无 MERGE_HEAD → 检查 A 跳过（advisory，不阻断）',
    r.status === 0 && out.includes('--merge') && !out.includes('[产品契约面无活跃入口]'), out);
}

// --- CI_PUSH_BEFORE：changes JSON 夹具，不访问 CI 服务 ---
{
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const parent = 'd'.repeat(40);
  const three = { value: [
    { id: a, timestamp: '2026-10-10T03:00:00Z' },
    { id: b, timestamp: '2026-10-10T01:00:00Z' },
    { id: c, timestamp: '2026-10-10T02:00:00Z' },
  ] };
  const calls = [];
  const got = ciPushBefore(three, (id) => { calls.push(id); return id === b ? parent : 'short'; });
  check('三笔提交 → 基准是最老一笔的第一父', got.before === parent && calls.length === 1 && calls[0] === b, JSON.stringify(got));
  const one = ciPushBefore({ value: [{ id: a, timestamp: '2026-10-10T01:00:00Z' }] }, () => parent);
  check('一笔提交 → 基准是该笔的第一父', one.before === parent, JSON.stringify(one));
  const empty = ciPushBefore({ value: [] }, () => parent);
  check('无关联提交 → before 为空（调用方退回 HEAD~1）', empty.before === null, JSON.stringify(empty));
  const badParent = ciPushBefore({ value: [{ id: a, timestamp: '2026-10-10T01:00:00Z' }] }, () => 'not-a-sha');
  check('第一父不是 40 位 sha → before 为空', badParent.before === null, JSON.stringify(badParent));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
