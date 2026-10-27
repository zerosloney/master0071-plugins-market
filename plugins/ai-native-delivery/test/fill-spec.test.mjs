// fill-spec.test.mjs — fill-spec 工具测试（2026-09-25 doc-fill-tools；2026-09-30 stage-gate-machine 补起草门场景）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderSpec } from '../scripts/fill-spec.mjs';

let pass = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { failCount++; console.log('FAIL ' + name + (detail ? '——' + detail : '')); }
}

// ---- 场景 1：6 节正文齐 ----
{
  const { body } = renderSpec({ topic: 'test', level: 'L2' });
  const expectedSections = ['功能行为', '数据流', '系统改动', '约束遵守映射', '验收判据', '风险评估', '确认与复核'];
  for (const s of expectedSections) check('S1 含节 ## ' + s, body.includes('## ' + s));
  check('S1 共 7 节标题', (body.match(/^##\s/gm) || []).length === 7);
  // 验收判据直出表骨架（检查 23 机器输入；表头签名与 s23 解析口径一致）
  check('S1 验收判据含表骨架', /\| 判据（可观察行为） \| 证据（测试文件 \/ 命令 \/ 证据文件） \| 状态 \|/.test(body)
    && body.includes('| <行为 1> | <路径或命令> | <覆盖 / 未覆盖 / 人工> |'));
}

// ---- 场景 2：frontmatter 含 5 字段 ----
{
  const { body } = renderSpec({ topic: 't', level: 'L2' });
  const fm = body.match(/^---([\s\S]*?)---/);
  check('S2 frontmatter 含状态 draft', /状态:\s*draft/.test(fm[1]));
  check('S2 frontmatter 含级别 L2', /级别:\s*L2/.test(fm[1]));
  check('S2 frontmatter 含日期', /日期:\s*\d{4}-\d{2}-\d{2}/.test(fm[1]));
  check('S2 frontmatter 含模块', /模块:/.test(fm[1]));
  check('S2 frontmatter 含备注', /备注:/.test(fm[1]));
}

// ---- 场景 3：L3 也合法（默认 L2，但显式 L3 也接受）----
{
  const { body } = renderSpec({ topic: 't', level: 'L3' });
  check('S3 L3 合法', /级别:\s*L3/.test(body.match(/^---([\s\S]*?)---/)[1]));
}

// ---- 场景 4：非法 level 抛错 ----
{
  let threw = false;
  try { renderSpec({ topic: 't', level: 'XX' }); } catch { threw = true; }
  check('S4 非法 level 抛错', threw);
}

// ---- 场景 5：默认 L2 ----
{
  const { body } = renderSpec({ topic: 't' });
  check('S5 默认级别 L2', /级别:\s*L2/.test(body.match(/^---([\s\S]*?)---/)[1]));
}

// ---- 场景 6：日期透传 ----
{
  const { body } = renderSpec({ topic: 't', date: '2026-12-31' });
  check('S6 自定义日期透传', body.includes('日期: 2026-12-31'));
}

// ---- 场景 7：L3 必填提示独立复核 ----
{
  const { body } = renderSpec({ topic: 't', level: 'L3' });
  check('S7 L3 节确认与复核含独立复核提示', body.includes('L3 必须独立复核'));
}

// ---- 场景 8-13：起草门（2026-09-30 stage-gate-machine）——output 落于工作区时须同主题入口已确认 ----
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const CLI = path.join(SCRIPT_DIR, '..', 'scripts', 'fill-spec.mjs');
const mkws = ({ entryFile = null, entryBody = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-spec-gate-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  if (entryFile) {
    fs.mkdirSync(path.join(root, 'workflow', entryFile.split('/')[0]), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflow', entryFile), entryBody);
  }
  return root;
};
const runTool = (root, base) => spawnSync(process.execPath,
  [CLI, '--topic', base, '--output', path.join(root, 'workflow', 'specs', `${base}.md`)],
  { cwd: root, encoding: 'utf8' });
{
  const root = mkws();
  const r = runTool(root, '2026-09-30-none');
  check('S8 起草门：无同名入口 → exit 2 且零文件产出',
    r.status === 2 && /起草门未过/.test(r.stderr) && !fs.existsSync(path.join(root, 'workflow', 'specs', '2026-09-30-none.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({ entryFile: 'intents/2026-09-30-draft.md', entryBody: '---\n状态: draft\n级别: L2\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-draft');
  check('S9 起草门：入口 draft → exit 2 + 提示状态',
    r.status === 2 && /状态「draft」/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // S9b 探索泳道（2026-09-30 hybrid-governance-explore-hardening）：L1 draft intent → 放行 spec 起草
  // （「先起草后确认」；L2/L3 防御道维持入口确认前置——S9 照旧）
  const root = mkws({ entryFile: 'intents/2026-09-30-exp.md', entryBody: '---\n状态: draft\n级别: L1\nrisk_level: L1\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-exp');
  const f = path.join(root, 'workflow', 'specs', '2026-09-30-exp.md');
  check('S9b 探索泳道：L1 入口 draft → 放行 spec 起草（先起草后确认）',
    r.status === 0 && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({ entryFile: 'intents/2026-09-30-ok.md', entryBody: '---\n状态: approved\n级别: L1\n日期: 2026-01-01\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-ok');
  const f = path.join(root, 'workflow', 'specs', '2026-09-30-ok.md');
  check('S10 起草门：入口 approved（存量口径）→ 放行生成',
    r.status === 0 && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({ entryFile: 'incidents/2026-09-30-inc.md', entryBody: '---\n状态: open\n级别: L2\n---\n# I\n\n## 时间线\n- 用户确认：过目\n' });
  const r = runTool(root, '2026-09-30-inc');
  check('S11 起草门：incident 入口（open + 用户确认留痕）→ 放行',
    r.status === 0,
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = mkws({ entryFile: 'incidents/2026-09-30-inc2.md', entryBody: '---\n状态: open\n级别: L2\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-inc2');
  check('S12 起草门：incident 缺「用户确认」留痕 → exit 2',
    r.status === 2 && /未过目确认/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-spec-scratch-'));
  const out = path.join(root, 'x.md');
  const r = spawnSync(process.execPath, [CLI, '--topic', 'x', '--output', out], { cwd: root, encoding: 'utf8' });
  check('S13 起草门：仓外草稿（无 workflow 段）→ 不拦 + 提示',
    r.status === 0 && fs.existsSync(out) && /仓外草稿/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // 场景 14：入口 approved 但无台账行且日期 ≥ confirmDocsEffective → 拒（防手改状态冒充；复核 P2-4③）
  const root = mkws({ entryFile: 'intents/2026-09-30-fake.md', entryBody: '---\n状态: approved\n级别: L1\n日期: 2026-09-30\n---\n# I\n' });
  const r = runTool(root, '2026-09-30-fake');
  check('S14 起草门：入口 approved 但无台账行（日期 ≥ 生效日）→ exit 2',
    r.status === 2 && /无确认台账行/.test(r.stderr),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // N1（2026-09-30 增量复核）：存量入口短路优先于级别校验——`流程: legacy` + 无级别 → 放行（不锁死）
  const root = mkws({ entryFile: 'intents/2026-09-30-leg.md', entryBody: '---\n状态: approved\n日期: 2026-01-01\n流程: legacy\n---\n# I（存量、无级别）\n' });
  const r = runTool(root, '2026-09-30-leg');
  check('S15 存量短路：legacy 入口缺级别 → 放行（不被 fail-closed 锁死）',
    r.status === 0 && fs.existsSync(path.join(root, 'workflow', 'specs', '2026-09-30-leg.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // 对照：门禁后入口（日期 ≥ 生效日）+ **台账行**（第三轮复核 P1-2 订正：原夹具无台账行，
  // 被上游「无确认台账行」拦下，从未进入级别校验——假绿）→ 须停在「缺合法级别」分支
  const root = mkws({ entryFile: 'intents/2026-09-30-nolev.md', entryBody: `---\n状态: approved\n日期: 2026-09-30\n确认指纹: ${'d'.repeat(16)}\n---\n# I（门禁后、无级别）\n` });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'confirmations.jsonl'), JSON.stringify({ ts: '2026-09-30T07:00:00.000Z', doc: 'workflow/intents/2026-09-30-nolev.md', stage: 'approved', fingerprint: 'd'.repeat(64), prev: 'draft', source: 'chat-delegated', batch: 'nl', seq: 1, of: 1 }) + '\n');
  const r = runTool(root, '2026-09-30-nolev');
  check('S16 门禁后入口缺级别 → 拒，且理由为「缺合法级别」（断言理由 + 零产出，防上游分支/无关失败冒充）',
    r.status === 2 && /缺合法「级别」字段/.test(r.stderr) && !fs.existsSync(path.join(root, 'workflow', 'specs', '2026-09-30-nolev.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // N2 回归（第三轮复核 P1-1）：模板时间线样例行必须真实可解析——照抄模板即应通过 incident 留痕判定
  const tpl = fs.readFileSync(path.join(SCRIPT_DIR, 'fixtures', 'incidents', '_TEMPLATE.md'), 'utf8');
  const sample = tpl.split(/\r?\n/).find((l) => /^\s*[-*].*用户确认/.test(l)) || '';
  const root = mkws({ entryFile: 'incidents/2026-09-30-tpl.md', entryBody: `---\n状态: open\n级别: L1\n---\n# I\n\n## 时间线\n${sample}\n` });
  const r = runTool(root, '2026-09-30-tpl');
  check('S18 模板样例可解析：照抄 _TEMPLATE.md 时间线样例行 → incident 入口放行',
    r.status === 0 && sample !== '',
    JSON.stringify({ status: r.status, sample, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  // 负例（第三轮复核 P1-1 放宽前缀后实证的假阳性）：叙述句即便带标准日期前缀也不算过目留痕
  const variants = ['- 2026-09-30 用户确认了方案（叙述）', '- 用户确认书已归档', '- <日期> 用户确认过细节'];
  const results = variants.map((line) => {
    const root = mkws({ entryFile: 'incidents/2026-09-30-neg.md', entryBody: `---\n状态: open\n级别: L1\n---\n# I\n\n## 时间线\n${line}\n` });
    const r = runTool(root, '2026-09-30-neg');
    fs.rmSync(root, { recursive: true, force: true });
    return { line, status: r.status, stderr: r.stderr };
  });
  check('S19 负例：叙述句（含日期前缀）不算过目留痕 → 仍拒',
    results.every((x) => x.status === 2 && /未过目确认/.test(x.stderr)),
    JSON.stringify(results));
}
{
  // 正面对照：既通过门、又产出文件——防「无关失败误绿」
  const tpl = fs.readFileSync(path.join(SCRIPT_DIR, 'fixtures', 'incidents', '_TEMPLATE.md'), 'utf8');
  const sample = tpl.split(/\r?\n/).find((l) => /^\s*[-*].*用户确认/.test(l)) || '';
  const root = mkws({ entryFile: 'incidents/2026-09-30-tpl2.md', entryBody: `---\n状态: open\n级别: L1\n---\n# I\n\n## 时间线\n${sample}\n` });
  const r = runTool(root, '2026-09-30-tpl2');
  const out = path.join(root, 'workflow', 'specs', '2026-09-30-tpl2.md');
  check('S20 模板样例可解析（正面对照：exit 0 且产出 draft 文件）',
    r.status === 0 && sample !== '' && fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r.status, sample, exists: fs.existsSync(out), stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // N1 存量短路（spec 档）——plan 门本体由 fill-plan.test / confirm-doc.test 覆盖
  const root = mkws({ entryFile: 'intents/2026-09-30-legp.md', entryBody: '---\n状态: approved\n日期: 2026-01-01\n流程: legacy\n---\n# I（存量、无级别）\n' });
  const r = runTool(root, '2026-09-30-legp');
  check('S17 存量短路（spec 档）：legacy 入口无级别 → 放行生成',
    r.status === 0 && fs.existsSync(path.join(root, 'workflow', 'specs', '2026-09-30-legp.md')),
    JSON.stringify({ status: r.status, stderr: r.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 形态矩阵（2026-09-30 四/五轮复核收敛）：8 正例 + 5 负例一次性钉死 ----
// 每轮补丁式改正则都只修一半（放宽前缀 → 叙述句假阳性；加词边界 → 加粗围栏假阴性），故穷举形态：
// 任何后续正则改动若破坏任一正例或放行任一负例，本矩阵立即翻红。
{
  const POSITIVE = [
    '- 用户确认：草稿过目通过',
    '- **用户确认**：草稿过目通过',
    '- 2026-09-30 用户确认：草稿过目通过',
    '- <日期> 用户确认：草稿过目通过',
    '- 2026-09-30 **用户确认**：草稿过目通过',
    '- <日期> **用户确认**：草稿过目通过',
    '- 用户确认',
    '- **用户确认**',
  ];
  const NEGATIVE = [
    '- 2026-09-30 用户确认了方案（叙述）',
    '- 用户确认书已归档',
    '- <日期> 用户确认过细节',
    '- 用户确认。',
    '- 待用户确认：稍后处理',
  ];
  const run = (line) => {
    const root = mkws({ entryFile: 'incidents/2026-09-30-mx.md', entryBody: `---\n状态: open\n级别: L1\n---\n# I\n\n## 时间线\n${line}\n` });
    const r = runTool(root, '2026-09-30-mx');
    fs.rmSync(root, { recursive: true, force: true });
    return r.status;
  };
  const posBad = POSITIVE.filter((l) => run(l) !== 0);
  const negBad = NEGATIVE.filter((l) => run(l) !== 2);
  check('S21 形态矩阵·正例全放行（8 形态，含词前/词后加粗围栏）[须与 S22 负例配对——单条不承重]',
    posBad.length === 0,
    JSON.stringify({ failedLines: posBad }));
  check('S22 形态矩阵·负例全拒绝（5 形态，叙述/无冒号/待办前缀）[须与 S21 正例配对——单条不承重]',
    negBad.length === 0,
    JSON.stringify({ failedLines: negBad }));
}

console.log('\n合计: PASS ' + pass + ' / FAIL ' + failCount);
process.exit(failCount ? 1 : 0);