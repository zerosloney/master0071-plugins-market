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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initEngine } from '../scripts/init-engine.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// rel 路径统一 POSIX 斜杠（Windows path.join 产反斜杠，清单比对按斜杠归一）
const toPosix = (p) => p.split(path.sep).join('/');
// 机器消费表豁免（规范键 / 规范模式，非可执行路径）——键为 config-templates 下的相对文件名：
//   scripts-test-exempt.txt —— 豁免登记的脚本/测试键恒用源仓形态 `.agents/scripts/…`，判据按形态解析
//   rule-budgets.txt         —— 预算表的路径模式恒用源仓形态 `.agents/scripts/…` / `.agents/commands/…`，按形态解析
// 两表由对应判据脚本（check-script-coverage / rule-budget）解析，不受「零 .agents/scripts 残留」约束。
const MACHINE_TABLE_ALLOW = new Set([
  'scripts-test-exempt.txt',
  'rule-budgets.txt',
]);
const DOCS = [
  { kind: 'command', dir: path.join(PLUGIN_ROOT, 'commands'), files: fs.existsSync(path.join(PLUGIN_ROOT, 'commands')) ? fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).sort().map((f) => toPosix(path.join('commands', f))) : [] },
  { kind: 'agent', dir: path.join(PLUGIN_ROOT, 'agents'), files: fs.existsSync(path.join(PLUGIN_ROOT, 'agents')) ? fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort().map((f) => toPosix(path.join('agents', f))) : [] },
  { kind: 'skill', dir: path.join(PLUGIN_ROOT, 'skills'), files: collectSkills(path.join(PLUGIN_ROOT, 'skills')) },
  // config-templates 种子面（2026-10-27 插件化修复扩展）：种子里带的可执行命令会原样落进使用项目的
  // .agents/pipelines/，由宿主 AI 直接执行——指向不存在的项目侧路径即断链，故与命令面同口径纳管。
  // 豁免表与预算表除外：其 `.agents/scripts/…` 是**规范键/规范模式**（机器消费，判据按形态解析），
  // 不是可执行路径——单列豁免（见上方 MACHINE_TABLE_ALLOW）。
  { kind: 'seed', dir: path.join(PLUGIN_ROOT, 'config-templates'), files: collectSeeds(path.join(PLUGIN_ROOT, 'config-templates')) },
];

// 种子面文件收集（递归 md/txt/json，剔除机器消费表——见 MACHINE_TABLE_ALLOW）
function collectSeeds(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...collectSeeds(path.join(dir, ent.name), rel));
    else if (ent.isFile() && /\.(md|txt|json)$/.test(ent.name) && !MACHINE_TABLE_ALLOW.has(rel)) out.push(toPosix(path.join('config-templates', rel)));
  }
  return out.sort();
}

// 机器消费表豁免见文件头 MACHINE_TABLE_ALLOW（定义于 DOCS 之前，避免 TDZ）。

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
  // 插件内测试树引用（2026-10-27）：管道模板的 gate 行可指向插件内 test/*.test.mjs（如「填档生成器
  // 契约自检」门）——原先不纳入契约面，引用错文件不会被发现。
  test: /(?<![\w./-])(?:<插件根>\/)?test\/([A-Za-z0-9_\/-]+\.test\.mjs)/g,
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
    // ① frontmatter 合同（仅文档类适用——命令/角色/skill 是带 frontmatter 的 markdown；
    //    种子类是 config 文件（json/txt/md），无 frontmatter 语义）
    if (group.kind !== 'seed') {
      const fm = parseFrontmatter(text);
      check(`${tag} ① frontmatter 存在且含 description`, fm !== null && typeof fm.description === 'string' && fm.description.length > 0,
        fm === null ? '无 frontmatter' : `keys=${Object.keys(fm).join(',')}`);
      if (group.kind === 'command') {
        check(`${tag} ① 命令另必含 stage 与 next（6 阶段状态机路由协议）`, fm !== null && !!fm.stage && !!fm.next,
          fm === null ? '无 frontmatter' : `stage=${fm.stage || '(缺)'} next=${fm.next || '(缺)'}`);
      }
    }
    // ④ 改写完整性：零 .agents/scripts|commands 残留（插件形态下这两个目录**永不创建**——
    //    治理脚本与命令面随插件分发，引用即断链）。
    //    种子面另允许 `.agents/roles/`：那是 workflows-check 的**项目侧角色扩展点**
    //    （词表 = 项目侧 .agents/roles/ ∪ 插件内 agents/），不是残留。
    const staleRe = group.kind === 'seed'
      ? /\.agents\/(?:scripts|commands)\b/g
      : /\.agents\/(?:scripts|commands|roles)\b/g;
    const stale = text.match(staleRe) || [];
    check(`${tag} ④ 零 .agents/{scripts,commands}${group.kind === 'seed' ? '（种子面另允许 .agents/roles 项目侧扩展点）' : ''} 改写残留`,
      stale.length === 0, `命中 ${stale.length} 处`);
    // ② 插件内引用目标存在
    for (const [label, re] of Object.entries(REF_RE)) {
      const refs = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
      for (const r of refs) {
        // scripts/verify/** 豁免（2026-10-27 skill 面迁移批）：项目侧应用自验证脚本树（verify-ui 引用的
        // e2e harness / business 实测脚本随使用项目的应用仓走；verify.mjs GATES 的 backend-test 门同样按
        // 项目侧路径引用 scripts/verify/backend/…）——插件引擎脚本只有 scripts/ 平铺件与
        // check-loop-sections/，插件内不存在 scripts/verify/，凡该前缀引用均非插件资产。
        if (label === 'script' && r.startsWith('verify/')) continue;
        const base = label === 'script' ? 'scripts' : label === 'command' ? 'commands' : label === 'agent' ? 'agents' : 'test';
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
    // ⑤ skill 引用闭包（只扫命令/角色正文）——skill 正文不互扫（autonomous-run 等的引用由落位本身保证）；
    //    种子面不扫：principles.md 的 `.agents/skills/…` 指针指向**宿主环境技能**（可能来自其他插件或
    //    用户自建），不是插件内资产——闭包要求只对插件自带的命令/角色面成立。
    if (group.kind === 'command' || group.kind === 'agent') {
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

// ⑥ pipelines 种子闭包：种子四件在位 + **实跑初始化验落位**（2026-10-27 插件化修复）
// 修复前此处只断言「种子在插件内存在」——恒真，与落位无关：种子实际落在 .agents/config/pipelines/，
// 而 workflows-check.mjs 扫 .agents/pipelines/ → 编排机器门扫 0 份恒报绿（假绿）。
// 现改为真跑一次 initEngine 到临时 git 仓，断言落位与机器门可见性。
{
  for (const f of PIPELINE_SEEDS) {
    check(`[清单] ${f} 种子在位（插件内，首次初始化复制到项目侧 .agents/pipelines/）`, fs.existsSync(path.join(PLUGIN_ROOT, f)));
  }
  const arPath = path.join(PLUGIN_ROOT, 'skills', 'autonomous-run', 'SKILL.md');
  const arText = fs.existsSync(arPath) ? fs.readFileSync(arPath, 'utf8') : '';
  check('[清单] autonomous-run 引用项目侧 .agents/pipelines/ 路径约定（种子落位口径）',
    arText.includes('.agents/pipelines/'), 'skills/autonomous-run/SKILL.md 无 .agents/pipelines/ 引用');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-init-'));
  try {
    spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', ['init', '-q'], { cwd: tmp });
    initEngine(tmp);
    check('[落位] 初始化后编排种子在项目侧 .agents/pipelines/',
      fs.existsSync(path.join(tmp, '.agents', 'pipelines', '_TEMPLATE.md'))
      && fs.existsSync(path.join(tmp, '.agents', 'pipelines', 'pipeline-closing.md')),
      fs.readdirSync(path.join(tmp, '.agents')).join(', '));
    check('[落位] 初始化后编排种子不在 .agents/config/pipelines/',
      !fs.existsSync(path.join(tmp, '.agents', 'config', 'pipelines')));
    const wf = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'workflows-check.mjs'), '--root', tmp], { encoding: 'utf8' });
    check('[落位] 编排机器门扫得到编排脚本（不再 0 份恒绿）',
      wf.status === 0 && /编排脚本 [1-9]/.test(wf.stdout || ''), `${wf.stdout}${wf.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ⑦ 客户端垫片接线（2026-10-27 插件化修复）：清单必须声明本插件实际提供的组件面。
// 修复前三个垫片都只声明 mcpServers → 6 个 skill、8 个命令、3 个角色、PreToolUse 风险闸
// 在对应宿主上**全不加载**（装了插件却什么都没发生，且无任何报错）。
{
  const manifests = {
    '.omp-plugin/plugin.json': { skills: true, commands: true, agents: true },
    '.codex-plugin/plugin.json': { skills: true, hooks: true },
    '.zcode-plugin/plugin.json': { skills: true, hooks: true },
  };
  const hasDir = (rel) => fs.existsSync(path.join(PLUGIN_ROOT, rel));
  for (const [rel, need] of Object.entries(manifests)) {
    const mp = path.join(PLUGIN_ROOT, rel);
    check(`[垫片] ${rel} 存在`, fs.existsSync(mp));
    if (!fs.existsSync(mp)) continue;
    let m = null;
    try { m = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* 下面断言里报错 */ }
    check(`[垫片] ${rel} 是合法 JSON`, m !== null);
    if (!m) continue;
    // skills/hooks：目录路径形态、数组形态、内联对象形态（codex 垫片照 pstack 内联 hooks 块）都算声明
    const declares = (v) => typeof v === 'string' || (Array.isArray(v) && v.length > 0)
      || (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0);
    for (const [key, dir] of [['skills', 'skills'], ['commands', 'commands'], ['agents', 'agents'], ['hooks', 'hooks']]) {
      if (!need[key]) continue;
      if (!hasDir(dir)) { check(`[垫片] ${rel} 声明 ${key}（插件内有 ${dir}/）`, declares(m[key]), '插件内无该目录'); continue; }
      check(`[垫片] ${rel} 声明 ${key}（否则该面在宿主上不加载）`, declares(m[key]), JSON.stringify(m[key]));
    }
  }
  // 组件面实物计数：声明存在 ≠ 实物为空（空目录声明也等于没接）
  const skillDirs = fs.existsSync(path.join(PLUGIN_ROOT, 'skills'))
    ? fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
  const cmdFiles = fs.existsSync(path.join(PLUGIN_ROOT, 'commands'))
    ? fs.readdirSync(path.join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).length : 0;
  const agentFiles = fs.existsSync(path.join(PLUGIN_ROOT, 'agents'))
    ? fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter((f) => f.endsWith('.md')).length : 0;
  check('[垫片] skill/命令/角色实物非空', skillDirs >= 6 && cmdFiles >= 8 && agentFiles >= 3,
    `skills=${skillDirs} commands=${cmdFiles} agents=${agentFiles}`);
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
process.exit(0);
