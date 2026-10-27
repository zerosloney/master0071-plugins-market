// fill-intent：起草 intent 草稿（背景与问题/历史教训防复发/目标/非目标/约束/影响面/触达红线/验收标准 8 节正文 + 确认与复核 共 9 节）
// 读 workflow/intents/_TEMPLATE.md 的节标题 → 输出符合 frontmatter 受限子集（5 字段）的草稿到指定文件
// 用法：node .agents/scripts/fill-intent.mjs --module pipeline --level L1 --topic "test" --output /tmp/x.md
// 零依赖；CLI 解析用最简字符串匹配；不替代 AI 起草——本工具只输出模板与提示句
import fs from 'node:fs';
import path from 'node:path';
import { ENUMS } from './workflow-enums.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const LEVELS = ENUMS['level.all']; // 级别词表单源（.agents/config/workflow-enums.txt）

function parseArgs(argv) {
  const out = { topic: null, module: null, level: 'L1', output: null, notes: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) return null; return v; };
    if (a === '--topic') out.topic = next();
    else if (a === '--module') out.module = next();
    else if (a === '--level') out.level = next();
    else if (a === '--output') out.output = next();
    else if (a === '--notes') out.notes = next() || '';
  }
  return out;
}

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

const SECTIONS = [
  { title: '背景与问题', hint: '<为什么做；写明需求来源（工单 / 沟通记录 / 待办事项）>' },
  { title: '历史教训/防复发', hint: '- 检索结果：`node .agents/scripts/kb-search.mjs "<关键词>" --type incidents` 命中结果；按改动文件找同类用 `--files <路径,...>`（词元 OR）\n- 避坑指南：<针对历史根因，本次如何预防/规避>' },
  { title: '目标', hint: '- <可验证的目标>' },
  { title: '非目标（L1 微改动无实质内容可删本节，不硬填）', hint: '- <明确不做的，防止范围蔓延>' },
  { title: '约束（L1 微改动无实质内容可删本节，不硬填）', hint: '- <复用什么、不许动什么>' },
  { title: '影响面', hint: '- 模块：<词表之一，见 .agents/config/workflow-modules.txt>\n- 数据库：无 / <表名>（涉及 schema 变更 $\rightarrow$ L3；无 schema 的运行时 / 管线结构面亦为 L3，判据见 .agents/commands/new-task.md §级别判断）\n- 前端页面：<路由或组件，无则删本行>' },
  { title: '触达红线（对照 AGENTS.md，勾选仅标记触及范围；具体如何满足在同名 spec 或 Quick-Plan 中说明）', hint: '- [ ] <按本项目 AGENTS.md 红线逐行补；无则删本行>\n- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）$\rightarrow$ 级别至少 L2\n- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 $\rightarrow$ 级别 L3\n\n> 触及任一红线即为 L2 / L3，必须立 ../specs/YYYY-MM-DD-<主题>.md 写明如何满足，方可起草 plan。' },
  { title: '验收标准（可测试）', hint: '- [ ] <逐条可测试；写不出可测试判据 = 还没想清楚>\n\n> **闭环对账**：关单在 test 阶段（不依赖 deploy）。intent 置 done 前逐条勾验，每条补证据——`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟脚本输出>）`。\n> done 状态仍有未勾项会被 check-loop 拦截（2026-09-12 起新建 intent 为 hard-block，存量 intent 仅 warning 提示）；勾选但缺「证据：」为 hard-block。' },
];

export function renderIntent({ topic, module, level, notes, date = TODAY }) {
  if (!LEVELS.includes(level)) throw new Error('level 不在枚举 ' + LEVELS.join('|') + '：' + level);
  const fm = '---\n状态: draft\n级别: ' + level + '\n日期: ' + date + '\n模块: ' + module + '\n备注: ' + (notes || '<可选：附注自由文本，check-loop 不解析>') + '\n---\n';
  let body = '# INTENT — ' + topic + '\n\n<!-- 复制本模板为 YYYY-MM-DD-<主题>.md 后填写；plans/ 下同名文件与本文件配对 -->\n<!-- frontmatter 受限子集（2026-09-13）：每行 键: 值；状态∈draft/approved/done/superseded/cancelled（严格枚举，附注写备注键）；级别∈L1/L2/L3；check-loop 只扫 frontmatter 取机器字段，正文不再写状态/级别行 -->\n\n';
  for (const { title, hint } of SECTIONS) {
    body += '## ' + title + '\n\n' + hint + '\n\n';
  }
  body += '## 确认与复核\n\n- 确认日期：\n- 确认人：用户（对话内明确放行即确认）\n- 确认范围：\n- 复核：L1 不要求独立复核\n';
  return { frontmatter: fm, body: fm + body, sections: SECTIONS.map((s) => s.title) };
}

const isMain = process.argv[1] && process.argv[1].endsWith('fill-intent.mjs');
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.topic || !a.module || !a.output) fail('必填：--topic / --module / --output；选填：--level（默认 L1）/ --notes');
  if (!LEVELS.includes(a.level)) fail('level 必须在 ' + LEVELS.join('|') + '：' + a.level);
  const { body } = renderIntent(a);
  fs.mkdirSync(path.dirname(a.output), { recursive: true });
  fs.writeFileSync(a.output, body);
  console.log('✅ 已生成 intent 草稿：' + a.output + '（状态 draft / 级别 ' + a.level + ' / 模块 ' + a.module + '）');
}
export default renderIntent;