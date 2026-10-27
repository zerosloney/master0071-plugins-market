#!/usr/bin/env node
// contract-commands.mjs — 命令面/角色面/skill 面合同测试（2026-10-27 命令面迁移批新增；skill 面迁移批扩展）
// 遍历 commands/*.md、agents/*.md、skills/**/SKILL.md，钉死五件事：
//   ① frontmatter 必含 description；commands 另必含 stage 与 next（6 阶段状态机路由协议，设计文档 §3.1）
//   ② 正文引用的插件内路径（commands/*.md、agents/*.md、[<插件根>/]scripts/*.mjs）目标文件必须存在；
//     workflow/、.agents/（hooks/notes/skills/config 等项目侧）、wiki/ 等项目侧路径跳过
//   ③ 正文引用的 config-templates 文件（按已知词表/清单文件名提及）必须存在
//   ⑤ 命令/角色正文提及的 skill 引用名（.agents/skills/<name>/SKILL.md 写法）必须在插件
//     skills/<name>/SKILL.md 存在——skill 引用闭包（2026-10-27 skill 面迁移批）；
//     显式 allowlist 三件豁免（裁决理由见 SKILL_REF_ALLOW 注）
//   ⑥ config-templates/pipelines/ 种子四件存在，且项目侧 .agents/pipelines/ 路径约定被
//     autonomous-run 正文引用（种子由初始化落位，2026-10-27 skill 面迁移批）
// 另断言改写完整性：三类文档零 `.agents/scripts|commands|roles` 残留（2026-10-27 命令面迁移改写契约）。
// 零依赖，Node ≥ 18 直接运行：node test/contract-commands.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// rel 路径统一 POSIX 斜杠（Windows path.join 产反斜杠，清单比对按斜杠归一）
const toPosix = (p) => p.split(path.sep).join('/');
const DOCS = [
  { kind: 'command', dir: path.join(PLUGIN_ROOT, 'commands'), files: fs.existsSync(path.join(PLUGIN_ROOT, 'commands')) ? fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).sort().map((f) => toPosix(path.join('commands', f))) : [] },
  { kind: 'agent', dir: path.join(PLUGIN_ROOT, 'agents'), files: fs.existsSync(path.join(PLUGIN_ROOT, 'agents')) ? fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort().map((f) => toPosix(path.join('agents', f))) : [] },
  { kind: 'skill', dir: path.join(PLUGIN_ROOT, 'skills'), files: collectSkills(path.join(PLUGIN_ROOT, 'skills')) },
];

function collectSkills(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...collectSkills(path.join(dir, ent.name), rel));
    else if (ent.isFile() && ent.name === 'SKILL.md') out.push(toPosix(path.join('skills', rel)));
  }
  return out.sort();
}

const parseFrontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
};

// ② 插件内路径引用（负向环视排除 .agents/ 前缀等宿主侧/项目侧写法）
const REF_RE = {
  command: /(?<![\w./-])commands\/([A-Za-z0-9_-]+\.md)/g,
  agent: /(?<![\w./-])agents\/([A-Za-z0-9_-]+\.md)/g,
  script: /(?<![\w./-])(?:<插件根>\/)?scripts\/([A-Za-z0-9_/-]+\.mjs)/g,
};
// ⑤ skill 引用闭包：命令/角色正文里的 `.agents/skills/<name>/SKILL.md` 写法 → 提取 <name>。
//    （沿用命令面既有写法：skill 引用保持项目侧路径形态，落位闭包由本合同钉在插件内。）
const SKILL_REF_RE = /(?<![\w./-])\.agents\/skills\/([A-Za-z0-9_-]+)\/SKILL\.md/g;
// allowlist（不随插件分发的引用，裁决理由逐件留档）：
//   interrogate  —— 高风险 diff 的多模型多镜头独立拆解技能，属源项目自建实验件未出库；
//                   review.md 已带降级话术（宿主有可叠加，无则单一独立复核兜底）。
//   blast-radius —— 影响面证明技能，同上未出库；review.md 降级话术：证明脚本随 PR 或落 tmp/。
//   tfs-pr       —— 源项目 Azure DevOps PR 流程技能，深度绑定其宿主环境，通用项目无意义，不迁。
const SKILL_REF_ALLOW = new Set(['interrogate', 'blast-radius', 'tfs-pr']);
// ⑥ pipelines 种子清单（autonomous-run 引用的项目侧目录；_ 前缀为机制文档，steps/ 为扩展点注册表）
const PIPELINE_SEEDS = [
  'config-templates/pipelines/_TEMPLATE.md',
  'config-templates/pipelines/pipeline-closing.md',
  'config-templates/pipelines/示例-并行实现评审.md',
  'config-templates/pipelines/steps/示例-部署验证.md',
];

// ③ config-templates 已知文件名提及（词表/清单/预算表类机制配置）
const CONFIG_DIR = path.join(PLUGIN_ROOT, 'config-templates');
const CONFIG_NAMES = fs.existsSync(CONFIG_DIR) ? fs.readdirSync(CONFIG_DIR).filter((f) => /\.(json|txt|md)$/.test(f)) : [];

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const allRelPaths = DOCS.flatMap((g) => g.files);
for (const group of DOCS) {
  for (const rel of group.files) {
    const abs = path.join(PLUGIN_ROOT, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const tag = `[${rel}]`;
    // ① frontmatter 合同
    const fm = parseFrontmatter(text);
    check(`${tag} ① frontmatter 存在且含 description`, fm !== null && typeof fm.description === 'string' && fm.description.length > 0,
      fm === null ? '无 frontmatter' : `keys=${Object.keys(fm).join(',')}`);
    if (group.kind === 'command') {
      check(`${tag} ① 命令另必含 stage 与 next（6 阶段状态机路由协议）`, fm !== null && !!fm.stage && !!fm.next,
        fm === null ? '无 frontmatter' : `stage=${fm.stage || '(缺)'} next=${fm.next || '(缺)'}`);
    }
    // ④ 改写完整性：零 .agents/scripts|commands|roles 残留
    const stale = text.match(/\.agents\/(?:scripts|commands|roles)\b/g) || [];
    check(`${tag} ④ 零 .agents/{scripts,commands,roles} 改写残留`, stale.length === 0, `命中 ${stale.length} 处`);
    // ② 插件内引用目标存在
    for (const [label, re] of Object.entries(REF_RE)) {
      const refs = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
      for (const r of refs) {
        // scripts/verify/** 豁免（2026-10-27 skill 面迁移批）：项目侧应用自验证脚本树（verify-ui 引用的
        // e2e harness / business 实测脚本随使用项目的应用仓走；verify.mjs GATES 的 backend-test 门同样按
        // 项目侧路径引用 scripts/verify/backend/…）——插件引擎脚本只有 scripts/ 平铺件与
        // check-loop-sections/，插件内不存在 scripts/verify/，凡该前缀引用均非插件资产。
        if (label === 'script' && r.startsWith('verify/')) continue;
        const base = label === 'script' ? 'scripts' : label === 'command' ? 'commands' : 'agents';
        const target = path.join(PLUGIN_ROOT, base, r);
        check(`${tag} ② 引用 ${base}/${r} → 插件内存在`, fs.existsSync(target), `缺文件: ${target}`);
      }
    }
    // ③ config-templates 引用存在（按已知文件名提及）
    for (const name of CONFIG_NAMES) {
      if (new RegExp(`(?<![\\w./-])${name.replace(/\./g, '\\.')}`).test(text)) {
        check(`${tag} ③ 引用 config-templates/${name} → 存在`, fs.existsSync(path.join(CONFIG_DIR, name)));
      }
    }
    // ⑤ skill 引用闭包（只扫命令/角色正文；skill 正文不互扫——autonomous-run 等的引用由落位本身保证）
    if (group.kind !== 'skill') {
      const skillRefs = [...new Set([...text.matchAll(SKILL_REF_RE)].map((m) => m[1]))];
      for (const name of skillRefs) {
        if (SKILL_REF_ALLOW.has(name)) continue;
        check(`${tag} ⑤ 引用 skill ${name} → skills/${name}/SKILL.md 插件内存在`,
          fs.existsSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md')),
          `缺文件: skills/${name}/SKILL.md`);
      }
    }
  }
}

// 插件面完备性：8 命令 + 3 角色 + autonomous-run（2026-10-27 迁移清单钉死）
const expectFiles = [
  'commands/new-task.md', 'commands/plan.md', 'commands/design.md', 'commands/build.md',
  'commands/test.md', 'commands/review.md', 'commands/deploy.md', 'commands/maintain.md',
  'agents/implementer.md', 'agents/independent-reviewer.md', 'agents/ui-verifier.md',
  'skills/autonomous-run/SKILL.md',
];
for (const f of expectFiles) {
  check(`[清单] ${f} 在插件内`, allRelPaths.includes(f) && fs.existsSync(path.join(PLUGIN_ROOT, f)));
}

// ⑥ pipelines 种子闭包：种子四件在位 + 项目侧路径约定被 autonomous-run 引用
for (const f of PIPELINE_SEEDS) {
  check(`[清单] ${f} 种子在位（首次初始化落项目侧 .agents/pipelines/）`, fs.existsSync(path.join(PLUGIN_ROOT, f)));
}
{
  const arPath = path.join(PLUGIN_ROOT, 'skills', 'autonomous-run', 'SKILL.md');
  const arText = fs.existsSync(arPath) ? fs.readFileSync(arPath, 'utf8') : '';
  check('[清单] autonomous-run 引用项目侧 .agents/pipelines/ 路径约定（种子落位口径）',
    arText.includes('.agents/pipelines/'), 'skills/autonomous-run/SKILL.md 无 .agents/pipelines/ 引用');
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
