// fill-intent.test.mjs — fill-intent 工具测试（2026-09-25 doc-fill-tools；2026-11-05 补 CLI 输出守卫场景）
// 方法：直接 import 模块调 renderIntent 拿字符串（不写盘），断言 frontmatter 字段 + 节数 + 枚举值合法性
// 用法：node test/fill-intent.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderIntent } from '../scripts/fill-intent.mjs';

let pass = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { failCount++; console.log('FAIL ' + name + (detail ? '——' + detail : '')); }
}

// ---- 场景 1：L1 必填 frontmatter 字段都在 ----
{
  const { body } = renderIntent({ topic: 'test', module: 'pipeline', level: 'L1' });
  const fm = body.match(/^---([\s\S]*?)---/);
  check('S1 frontmatter 含状态 draft', /状态:\s*draft/.test(fm[1]));
  check('S1 frontmatter 含级别 L1', /级别:\s*L1/.test(fm[1]));
  check('S1 frontmatter 含日期 YYYY-MM-DD', /日期:\s*\d{4}-\d{2}-\d{2}/.test(fm[1]));
  check('S1 frontmatter 含模块 pipeline', /模块:\s*pipeline/.test(fm[1]));
  check('S1 frontmatter 含备注', /备注:/.test(fm[1]));
}

// ---- 场景 2：L2/L3 frontmatter 同样含完整字段 ----
{
  for (const level of ['L2', 'L3']) {
    const { body } = renderIntent({ topic: 't', module: 'pipeline', level });
    const fm = body.match(/^---([\s\S]*?)---/);
    check('S2 级别 ' + level + ' frontmatter 完整', /状态:\s*draft/.test(fm[1]) && /级别:\s*/.test(fm[1]) && /日期:/.test(fm[1]));
  }
}

// ---- 场景 3：非法 level 抛错（枚举严格）----
{
  let threw = false;
  try { renderIntent({ topic: 't', module: 'pipeline', level: 'L9' }); } catch { threw = true; }
  check('S3 非法 level 抛错', threw);
}

// ---- 场景 4：9 节正文齐 ----
{
  const { body } = renderIntent({ topic: 't', module: 'pipeline', level: 'L1' });
  const expectedSections = ['背景与问题', '历史教训/防复发', '目标', '非目标', '约束', '影响面', '触达红线', '验收标准', '确认与复核'];
  for (const s of expectedSections) check('S4 含节 ## ' + s, body.includes('## ' + s));
  check('S4 共 9 节标题', (body.match(/^##\s/gm) || []).length === 9);
}

// ---- 场景 5：备注字段透传 ----
{
  const { body } = renderIntent({ topic: 't', module: 'pipeline', level: 'L1', notes: '自定义备注' });
  check('S5 自定义备注透传', body.includes('备注: 自定义备注'));
  const { body: body2 } = renderIntent({ topic: 't', module: 'pipeline', level: 'L1' });
  check('S5 默认备注占位', body2.includes('备注: <可选：附注自由文本，check-loop 不解析>'));
}

// ---- 场景 6：日期默认今日 ----
{
  const today = new Date().toISOString().slice(0, 10);
  const { body } = renderIntent({ topic: 't', module: 'pipeline', level: 'L1' });
  check('S6 日期默认今日 ' + today, body.includes('日期: ' + today));
  const { body: body2 } = renderIntent({ topic: 't', module: 'pipeline', level: 'L1', date: '2026-01-15' });
  check('S6 自定义日期透传', body2.includes('日期: 2026-01-15'));
}

// ---- 场景 7：导出函数可单元测试 ----
{
  check('S7 renderIntent 是函数', typeof renderIntent === 'function');
  // 边界：缺 topic 应返回字符串（渲染时缺 topic → topic 是 undefined 字符串，不抛错——按 design 透传）
  const r = renderIntent({ module: 'pipeline', level: 'L1' });
  check('S7 缺 topic 仍可渲染（透传设计）', typeof r.body === 'string' && r.body.includes('INTENT — undefined'));
}

// ---- 场景 8：risk_level 双字段协议退役（2026-10-10 收敛系列 2）——新草稿不再写 risk_level ----
{
  const { body } = renderIntent({ topic: 't', module: 'pipeline', level: 'L2' });
  const fm = body.match(/^---([\s\S]*?)---/)[1];
  check('S8 risk_level 不再写入 frontmatter（退役回归钉）', !/^risk_level:/m.test(fm));
}

// ---- 场景 9-11：CLI 输出守卫（2026-11-05 台账族 Minor#9：存在守卫 / 工作区围栏 / 换行注入）----
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fill-intent.mjs');
{
  // ① 存在守卫：--output 已存在 → 拒绝（--force 才覆盖）。旧实现静默覆盖——approved/done 文档
  //    会被打回 draft 模板（不可逆内容损失）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-intent-guard-'));
  const out = path.join(root, 'existing.md');
  fs.writeFileSync(out, '---\n状态: approved\n---\n已确认文档');
  const r1 = spawnSync(process.execPath, [CLI, '--module', 'pipeline', '--level', 'L1', '--topic', 't', '--output', out], { cwd: root, encoding: 'utf8' });
  check('S9 --output 已存在 → 拒绝覆盖（旧实现静默打回 draft 模板）',
    r1.status === 1 && /拒绝覆盖/.test(r1.stderr) && fs.readFileSync(out, 'utf8').includes('状态: approved'),
    JSON.stringify({ status: r1.status, stderr: r1.stderr }));
  const r2 = spawnSync(process.execPath, [CLI, '--module', 'pipeline', '--level', 'L1', '--topic', 't', '--output', out, '--force'], { cwd: root, encoding: 'utf8' });
  check('S9b --force 显式覆盖放行', r2.status === 0 && fs.readFileSync(out, 'utf8').includes('状态: draft'),
    JSON.stringify({ status: r2.status, stderr: r2.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // ② 工作区围栏：output 落在 workflow/ 树内 → 必须在 workflow/intents/（错子目录拒；仓外草稿不受围栏）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-intent-fence-'));
  fs.mkdirSync(path.join(root, 'workflow', 'specs'), { recursive: true });
  const badOut = path.join(root, 'workflow', 'specs', '2026-11-05-fence.md');
  const r1 = spawnSync(process.execPath, [CLI, '--module', 'pipeline', '--topic', 't', '--output', badOut], { cwd: root, encoding: 'utf8' });
  check('S10 围栏：workflow 树内错子目录 → 拒（intent 只落 workflow/intents/）',
    r1.status === 1 && /围栏拒绝/.test(r1.stderr) && !fs.existsSync(badOut),
    JSON.stringify({ status: r1.status, stderr: r1.stderr }));
  const okOut = path.join(root, 'workflow', 'intents', '2026-11-05-fence.md');
  const r2 = spawnSync(process.execPath, [CLI, '--module', 'pipeline', '--topic', 't', '--output', okOut], { cwd: root, encoding: 'utf8' });
  check('S10b 协议子目录内放行', r2.status === 0 && fs.existsSync(okOut),
    JSON.stringify({ status: r2.status, stderr: r2.stderr }));
  fs.rmSync(root, { recursive: true, force: true });
}
{
  // ③ 换行注入：--notes 自由文本入 frontmatter 前剥换行——旧实现可借换行注入任意键（RED：多出键）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-intent-inject-'));
  const out = path.join(root, 'x.md');
  const r = spawnSync(process.execPath, [CLI, '--module', 'pipeline', '--topic', 't', '--notes', 'x\n级别: L3\n模块: evil', '--output', out], { cwd: root, encoding: 'utf8' });
  const body = fs.readFileSync(out, 'utf8');
  const fm = body.match(/^---\n([\s\S]*?)\n---/)[1];
  check('S11 --notes 换行注入被剥（frontmatter 不多出键，单行化）',
    r.status === 0 && (fm.match(/^级别:/gm) || []).length === 1 && (fm.match(/^模块:/gm) || []).length === 1
      && /^备注: x 级别: L3 模块: evil$/m.test(fm), fm);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n合计: PASS ' + pass + ' / FAIL ' + failCount);
process.exit(failCount ? 1 : 0);