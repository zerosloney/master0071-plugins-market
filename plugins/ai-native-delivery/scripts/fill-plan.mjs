// fill-plan：起草 plan 草稿（L1 五节且 plan 即入口 / L2-L3 完整 4 节）
// 用法：node <插件根>/scripts/fill-plan.mjs --level L1 --topic "test" --output /tmp/x.md [--root <仓库根>]
// L1：入口 + 改动方案 + 约束与风险 + 验证计划 + 验收标准（不另立 intent）
// L2/L3：改动方案 + 任务拆解 + 执行顺序 + 验证计划
// 起草门（stage-gate-machine）：output 落于工作区（路径含 workflow 段）时，须同主题入口已确认，
// 且入口级别（取入口 frontmatter，非 --level）为 L2/L3 时同名 spec 已确认；未过 → 拒绝生成（exit 2）。
// L1 例外（2026-10-10）：无同名 intent/incident 时 plan 自己就是入口，--level L1 直接生成。
import fs from 'node:fs';
import path from 'node:path';
import { ENUMS } from './workflow-enums.mjs';
import { draftGateFor, resolveWorkspace } from './stage-gates.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const LEVELS = ENUMS['level.all']; // 级别词表单源（.agents/config/workflow-enums.txt）

function parseArgs(argv) {
  const out = { topic: null, level: 'L1', output: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) return null; return v; };
    if (a === '--topic') out.topic = next();
    else if (a === '--level') out.level = next();
    else if (a === '--output') out.output = next();
    else if (a === '--root') out.root = next();
  }
  return out;
}

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

const L1_ENTRY = {
  title: '入口',
  hint: '- 来源：<工单 / 对话 / 事故>\n- 目标：<可验证的一句话>\n- [ ] 规则 / 契约变更（编码权威 / 共享契约 / 接口签名 / 既有参数语义 / 全局口径）→ 级别至少 L2\n- [ ] schema / 迁移 SQL / DI 链 / 认证与中间件管线 → 级别 L3\n\n> 勾选任一行就把本 plan 级别升到 L2/L3，并补同名 intent + spec。未勾选即 L1，不再另立 intent。',
};
const L1_ACCEPTANCE = {
  title: '验收标准（可测试）',
  hint: '- [ ] <逐条可测试；写不出判据 = 还没想清楚>\n\n> 关单前逐条勾验并补证据：`- [x] <判据>（证据：<commit SHA / 测试用例名 / 冒烟输出>）`。',
};
const L1_SECTIONS = [
  L1_ENTRY,
  { title: '改动方案', hint: '- <文件/组件>：<做什么；判据细节直接写进条目，如「L771 message.success 改『更新成功』」>\n\n> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。' },
  { title: '约束与风险', hint: '- 约束：<对照 AGENTS.md 红线，说明如何满足；不许动什么>\n- 风险：<潜在影响 / 破坏性风险>' },
  { title: '验证计划', hint: '- 静态门：项目构建命令（+ 项目测试命令，测试项目就绪后）\n- 前端：cd frontend && npm run build（vue-tsc）\n- UI：.agents/commands/test.md（涉及页面改动必走，headless Chrome 实测）\n- L2 追加：<契约 / 规则面比对：编码结果抽样 / 接口契约断言 / 口径对账>\n- L3 追加：<含 schema 变更：备份 + 回滚 SQL 就绪后执行；仅运行时 / 管线：回退上一 release tag + 配置开关预案>' },
  L1_ACCEPTANCE,
];

const FULL_SECTIONS = [
  L1_SECTIONS[1],
  { title: '任务拆解（L2/L3 必填；L1 仅多文件多步骤时用，单任务微改动删本节）', hint: '- [ ] 1. <任务>\n   - 判据：<怎样算完成；尽量对应一个测试或可复现操作>\n   - 风险：低 / 中 / 高（<原因>）\n   - 留痕：（勾选时回填 commit SHA / 测试名 / 实测输出）\n- [ ] 2. <任务>\n   - 判据：…\n   - 风险：…\n   - 留痕：…\n\n> 任务即勾选态（session-context）：完成一项立刻勾选并回填留痕；压缩 / 新会话续作先读本表勾选态 + git status 重建进度，禁凭记忆补勾。' },
  { title: '执行顺序（L2/L3 必填；L1 单文件微改动删本节）', hint: '<1 → 2 → 3；标注依赖关系>' },
  L1_SECTIONS[3],
];

export function renderPlan({ topic, level = 'L1', date = TODAY }) {
  if (!LEVELS.includes(level)) throw new Error('level 不在枚举 ' + LEVELS.join('|') + '：' + level);
  const sections = level === 'L1' ? L1_SECTIONS : FULL_SECTIONS;
  // 日期写进 frontmatter（2026-10-27）：此前 renderPlan 收了 date 参数却从不落 frontmatter，
  // 致 plan 无「日期」字段——委派台账在场门（confirm-doc）与检查 18 均以日期为适用前提，
  // 缺日期即整段跳过 = 本门对绝大多数 L2/L3 plan 静默失效。文件名兜底为第二道保险。
  const fm = '---\n状态: draft\n级别: ' + level + '\n日期: ' + date + '\n模块: pipeline\n---\n';
  const entryLine = level === 'L1'
    ? '对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md\n对应 spec：省略\n\n'
    : '对应入口：../intents/YYYY-MM-DD-<主题>.md 或 ../incidents/YYYY-MM-DD-<主题>.md（保留实际一项）\n对应 spec：../specs/YYYY-MM-DD-<主题>.md\n\n';
  let body = '# PLAN — ' + topic + '\n\n<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->\n<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->\n<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->\n\n' + entryLine;
  for (const { title, hint } of sections) {
    body += '## ' + title + '\n\n' + hint + '\n\n';
  }
  body += '## 确认与复核\n\n> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。\n- 确认结果：approved（YYYY-MM-DD 用户对话内确认）；done（YYYY-MM-DD 关单，随入口文档置终态）\n- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，逐次，不合并）\n- 复核：L1 不要求独立复核\n';
  return { frontmatter: fm, body: fm + body, sections: sections.map((s) => s.title) };
}

const isMain = process.argv[1] && process.argv[1].endsWith('fill-plan.mjs');
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.topic || !a.output) fail('必填：--topic / --output；选填：--level（默认 L1）/ --root');
  if (!LEVELS.includes(a.level)) fail('level 必须在 ' + LEVELS.join('|') + '：' + a.level);
  const ws = resolveWorkspace(a.output, a.root);
  if (ws) {
    const gate = draftGateFor('plan', ws.root, ws.base, { level: a.level });
    if (!gate.ok) {
      console.error('❌ 起草门未过（stage-gates）：' + gate.reason);
      console.error('   ' + gate.hint + '——本份未生成（确认前置后重跑本命令）');
      process.exit(2);
    }
  } else {
    console.error('ℹ️  未定位到工作区（output 路径不含 workflow/ 段）——按仓外草稿处理，跳过起草门前置校验');
  }
  const { body } = renderPlan(a);
  fs.mkdirSync(path.dirname(a.output), { recursive: true });
  fs.writeFileSync(a.output, body);
  console.log('✅ 已生成 plan 草稿：' + a.output + '（状态 draft / 级别 ' + a.level + ' / ' + (a.level === 'L1' ? 'L1 五节（plan 即入口）' : '完整 4 节') + '）');
}
export default renderPlan;