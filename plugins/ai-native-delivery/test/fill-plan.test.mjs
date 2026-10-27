// fill-plan.test.mjs — fill-plan 工具测试（2026-09-25 doc-fill-tools；2026-09-30 stage-gate-machine 补起草门场景）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPlan } from '../scripts/fill-plan.mjs';

let pass = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { failCount++; console.log('FAIL ' + name + (detail ? '——' + detail : '')); }
}

// ---- 场景 1：L1 plan 即入口（入口 + 改动 + 约束 + 验证 + 验收） ----
{
  const { body } = renderPlan({ topic: 't', level: 'L1' });
  const sections = body.match(/^##\s.+$/gm) || [];
  check('S1 L1 含节 ## 改动方案', body.includes('## 改动方案'));
  check('S1 L1 含节 ## 约束与风险', body.includes('## 约束与风险'));
  check('S1 L1 含节 ## 验证计划', body.includes('## 验证计划'));
  check('S1 L1 含节 ## 入口', body.includes('## 入口'));
  check('S1 L1 含节 ## 验收标准', body.includes('## 验收标准'));
  check('S1 L1 共 6 节（入口+三节+验收+确认与复核）', sections.length === 6, '实际 ' + sections.length + ' 节');
}

// ---- 场景 2：L2 完整 4 节 ----
{
  const { body } = renderPlan({ topic: 't', level: 'L2' });
  const sections = body.match(/^##\s.+$/gm) || [];
  check('S2 L2 含节 ## 改动方案', body.includes('## 改动方案'));
  check('S2 L2 含节 ## 任务拆解', body.includes('## 任务拆解'));
  check('S2 L2 含节 ## 执行顺序', body.includes('## 执行顺序'));
  check('S2 L2 含节 ## 验证计划', body.includes('## 验证计划'));
  check('S2 L2 共 5 节（4 节 + 确认与复核）', sections.length === 5, '实际 ' + sections.length + ' 节');
  // 任务即勾选态（2026-10-11 session-context）：任务拆解直出 checkbox 形态——勾选态是会话重入的机器可读锚
  check('S2 L2 任务拆解直出勾选态（- [ ] 前缀 + 留痕槽）', /- \[ \] 1\. <任务>/m.test(body) && body.includes('留痕：（勾选时回填'), body);
  check('S2 L2 改动方案含重入三锚注记', body.includes('会话重入三锚'), body);
}

// ---- 场景 3：L3 与 L2 同结构 ----
{
  const { body } = renderPlan({ topic: 't', level: 'L3' });
  check('S3 L3 含节 ## 改动方案', body.includes('## 改动方案'));
  check('S3 L3 含节 ## 任务拆解', body.includes('## 任务拆解'));
  check('S3 L3 含节 ## 验证计划', body.includes('## 验证计划'));
}

// ---- 场景 4：非法 level 抛错 ----
{
  let threw = false;
  try { renderPlan({ topic: 't', level: 'X' }); } catch { threw = true; }
  check('S4 非法 level 抛错', threw);
}

// ---- 场景 5：默认 L1 ----
{
  const { body } = renderPlan({ topic: 't' });
  check('S5 默认级别 L1', /级别:\s*L1/.test(body.match(/^---([\s\S]*?)---/)[1]));
}

// ---- 场景 6：frontmatter 含 3 字段（与 _TEMPLATE 对齐——L1 plan 无日期字段）----
{
  const { body } = renderPlan({ topic: 't', level: 'L1' });
  const fm = body.match(/^---([\s\S]*?)---/)[1];
  check('S6 frontmatter 含状态', /状态:/.test(fm));
  check('S6 frontmatter 含级别', /级别:/.test(fm));
  check('S6 frontmatter 含模块', /模块:/.test(fm));
}

// ---- 场景 7：与入口配对提示 ----
{
  const { body } = renderPlan({ topic: 't', level: 'L1' });
  check('S7 含「对应入口」段', body.includes('对应入口：'));
  check('S7 含「对应 spec」段（L1 可省略）', body.includes('对应 spec：'));
}

// ---- 场景 8-13：起草门（2026-09-30 stage-gate-machine）——入口已确认；L2/L3 另须 spec 已确认 ----
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const CLI = path.join(SCRIPT_DIR, '..', 'scripts', 'fill-plan.mjs');
const mkws = (files = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-plan-gate-'));
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
};
const runTool = (root, base, level) => spawnSync(process.execPath,
  [CLI, '--topic', base, '--level', level, '--output', path.join(root, 'workflow', 'plans', `${base}.md`)],
  { cwd: root, encoding: 'utf8' });
{
  const root = mkws();
  const r = runTool(root, '2026-09-30-none', 'L1');
  check('S8 起草门：L1 无同名入口 → plan 即入口，exit 0 且生成文件',
    r.status === 0 && fs.existsSync(path.join(root, 'workflow', 'plans', '2026-09-30-none.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({ 'workflow/intents/2026-09-30-l1.md': '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-l1', 'L1');
  const f = path.join(root, 'workflow', 'plans', '2026-09-30-l1.md');
  check('S9 起草门：L1 入口 approved（存量口径）→ 放行生成',
    r.status === 0 && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S10（2026-09-30 hybrid-governance-explore-hardening 更新）：draft 且 L2 → 仍拒（防御道维持入口确认
  // 前置）；原 L1 draft 夹具转入 S10b（探索泳道放行）
  const root = mkws({ 'workflow/intents/2026-09-30-draft.md': '---\n状态: draft\n级别: L2\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-draft', 'L1');
  check('S10 起草门：入口 draft 且 L2 → exit 2 + 提示状态（防御道不变）',
    r.status === 2 && /状态「draft」/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S10b 探索泳道（2026-09-30 hybrid-governance-explore-hardening）：L1 draft intent → 放行 plan 起草
  // （「先起草后确认」；收口由 check-loop --hardening 加固门兜底）
  const root = mkws({ 'workflow/intents/2026-09-30-exp.md': '---\n状态: draft\n级别: L1\nrisk_level: L1\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-exp', 'L1');
  const f = path.join(root, 'workflow', 'plans', '2026-09-30-exp.md');
  check('S10b 探索泳道：L1 入口 draft → 放行生成（先起草后确认）',
    r.status === 0 && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S10c（2026-10-02 caliber-convergence 方案 C 改判）：级别缺失 → suspect，不再回落 risk_level——
  // 豁免仅认两字段一致的 low；缺失须先补「级别」再走起草（fail-closed 就严）。
  const root = mkws({ 'workflow/intents/2026-09-30-exp0.md': '---\n状态: draft\nrisk_level: L0\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-exp0', 'L1');
  check('S10c 方案 C：级别缺失 + risk_level L0 → suspect 拒（不回落，先补级别）',
    r.status === 2 && !fs.existsSync(path.join(root, 'workflow', 'plans', '2026-09-30-exp0.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S10d 探索泳道边界：级别 L2 合法时 risk_level L0 不回落 → 仍拒（fail-closed 就严）
  const root = mkws({ 'workflow/intents/2026-09-30-expd.md': '---\n状态: draft\n级别: L2\nrisk_level: L0\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-expd', 'L1');
  check('S10d 探索泳道边界：级别 L2（risk_level L0 不回落）→ 仍拒',
    r.status === 2 && /状态「draft」/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 门禁后入口（日期 ≥ 生效日）须有台账行——夹具补 confirmed 行，才触达「缺 spec」分支
  const root = mkws({ 'workflow/intents/2026-09-30-l2.md': `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${'7'.repeat(16)}\n---\n# I\n` });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), JSON.stringify({ ts: '2026-09-30T05:00:00.000Z', doc: 'workflow/intents/2026-09-30-l2.md', stage: 'approved', fingerprint: '7'.repeat(64), prev: 'draft', source: 'chat-delegated', batch: 'l2', seq: 1, of: 1 }) + '\n');
  const r = runTool(root, '2026-09-30-l2', 'L2');
  check('S11 起草门：L2 入口已确认但缺同名 spec → exit 2 + 缺 spec 提示',
    r.status === 2 && /缺同名 spec/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({
    'workflow/intents/2026-09-30-l2b.md': '---\n状态: approved\n级别: L2\n日期: 2026-01-01\n---\n# I\n',
    'workflow/specs/2026-09-30-l2b.md': '---\n状态: approved\n级别: L2\n日期: 2026-01-01\n---\n# S\n',
  });
  const r = runTool(root, '2026-09-30-l2b', 'L2');
  const f = path.join(root, 'workflow', 'plans', '2026-09-30-l2b.md');
  check('S12 起草门：L2 入口 + spec 均已确认（存量口径）→ 放行生成',
    r.status === 0 && fs.existsSync(f),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-plan-scratch-'));
  const out = path.join(root, 'x.md');
  const r = spawnSync(process.execPath, [CLI, '--topic', 'x', '--output', out], { cwd: root, encoding: 'utf8' });
  check('S13 起草门：仓外草稿（无 workflow 段）→ 不拦 + 提示',
    r.status === 0 && fs.existsSync(out) && /仓外草稿/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // 场景 14：级别取入口 frontmatter（非 --level）——**门禁后入口 + 台账行**（早日期会走存量短路，
  // 绕过级别取值逻辑；第三轮复核 P2-2 订正夹具）
  const root = mkws({
    'workflow/intents/2026-09-30-lv.md': `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${'a'.repeat(16)}\n---\n# I\n`,
    'workflow/specs/2026-09-30-lv.md': `---\n状态: approved\n级别: L2\n日期: 2026-09-30\n确认指纹: ${'b'.repeat(16)}\n---\n# S\n`,
  });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  const led = (doc, fp) => JSON.stringify({ ts: '2026-09-30T06:00:00.000Z', doc, stage: 'approved', fingerprint: fp, prev: 'draft', source: 'chat-delegated', batch: 'lv', seq: 1, of: 1 }) + '\n';
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'),
    led('workflow/intents/2026-09-30-lv.md', 'a'.repeat(64)) + led('workflow/specs/2026-09-30-lv.md', 'b'.repeat(64)));
  const r = runTool(root, '2026-09-30-lv', 'L1');
  check('S14 级别取入口 frontmatter：入口 L2（台账行）+ spec 确认 → 传 --level L1 仍放行（不弱化前置）',
    r.status === 0,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 场景 15：入口 L1（门禁后 + 台账行）+ 传 --level L2 → 免 spec 档（级别以入口为准）
  const root = mkws({ 'workflow/intents/2026-09-30-lv2.md': `---\n状态: approved\n级别: L1\n日期: 2026-09-30\n确认指纹: ${'c'.repeat(16)}\n---\n# I\n` });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), JSON.stringify({ ts: '2026-09-30T06:10:00.000Z', doc: 'workflow/intents/2026-09-30-lv2.md', stage: 'approved', fingerprint: 'c'.repeat(64), prev: 'draft', source: 'chat-delegated', batch: 'lv2', seq: 1, of: 1 }) + '\n');
  const r = runTool(root, '2026-09-30-lv2', 'L2');
  check('S15 级别取入口 frontmatter：入口 L1 → 传 --level L2 不索要 spec、放行',
    r.status === 0,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n合计: PASS ' + pass + ' / FAIL ' + failCount);
process.exit(failCount ? 1 : 0);