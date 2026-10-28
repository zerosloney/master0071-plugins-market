#!/usr/bin/env node
// 垫片一致性检查（市场级，2026-10-28 市场审查）。
// 五个插件各有四份清单：plugin.json（Agent Plugins 标准，权威）+ 三份宿主垫片。
// 它们由不同轮次写成，约定逐渐分叉："./skills/" 与 "./skills" 混用、部分 zcode 垫片缺
// homepage/repository/license、hooks 指针写成 "hooks" 而非 "./hooks"、skills 用显式数组
// 钉死两个目录（未来新增 skill 静默不加载）、author 缺 url。这些差异不会报错，只会在某个
// 宿主上静默少加载东西——所以用机器对账，不靠人眼。
//
//   node scripts/manifest-lint.mjs
//
// 退出码非 0 表示有不一致。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIMS = ['.codex-plugin', '.omp-plugin', '.zcode-plugin'];
// 每份清单都必须带的元数据键（author 额外要求 url，见下）
const META = ['homepage', 'repository', 'license', 'keywords'];
// Agent Plugins 1.0.0 的 plugin.schema.json 允许的顶层字段全集（additionalProperties: false）。
// Node 下限不在其中：规范没有 engines 这个键，宿主按规范读清单时会把它当未知字段忽略，
// 于是"清单已声明 Node 下限"只是错觉。Node ≥ 18 的要求由各插件 README 与运行期自检承担。
const MANIFEST_KEYS = [
  '$schema', 'name', 'version', 'description', 'author',
  'homepage', 'repository', 'license', 'keywords', 'extensions',
];

const plugins = fs.readdirSync(path.join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'plugins', e.name, 'plugin.json')))
  .map((e) => e.name)
  .sort();

const problems = [];
const fail = (msg) => problems.push(msg);
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

for (const plugin of plugins) {
  const manifestRel = `plugins/${plugin}/plugin.json`;
  const manifest = read(manifestRel);

  // 标准清单的顶层字段受规范封闭约束（Agent Plugins 1.0.0 的 plugin.schema.json 是
  // additionalProperties: false）：规范外的字段宿主会直接忽略——写进去等于没写，还会让
  // "清单已声明 Node 下限"之类的错觉成立。这里按规范白名单对账，越界即报错。
  const extra = Object.keys(manifest).filter((k) => !MANIFEST_KEYS.includes(k));
  if (extra.length) {
    fail(`${manifestRel}: 顶层字段越界（规范封闭集不含）——${extra.join(', ')}`);
  }
  if (!manifest.$schema) fail(`${manifestRel}: 缺 $schema`);
  if (!manifest.name) fail(`${manifestRel}: 缺 name`);
  if (!manifest.author || !manifest.author.url) fail(`${manifestRel}: author 缺 url`);

  for (const shim of SHIMS) {
    const rel = `plugins/${plugin}/${shim}/plugin.json`;
    if (!fs.existsSync(path.join(ROOT, rel))) { fail(`${rel}: 清单不存在`); continue; }
    const m = read(rel);

    // 身份三键必须与标准清单一致（版本另有 release.mjs --check 逐处校验，这里只兜 name）
    if (m.name !== manifest.name) fail(`${rel}: name=${m.name} 与标准清单 ${manifest.name} 不一致`);
    if (!m.author || !m.author.url) fail(`${rel}: author 缺 url`);

    // 元数据齐全：宿主市场列表只渲染垫片，缺 homepage/repository/license 就显示成无出处作品
    for (const key of META) {
      if (m[key] === undefined) fail(`${rel}: 缺 ${key}`);
    }

    // 能力指针只允许目录形式，且不带尾斜杠（"./skills/" 与 "./skills" 混用会让规范实现各执一词）
    if ('skills' in m) {
      if (m.skills !== './skills') fail(`${rel}: skills=${JSON.stringify(m.skills)}，约定为 "./skills"（目录形式，别钉死具体子目录）`);
    }
    // hooks 指针为字符串时必须与 skills 同形（"hooks" 曾与 "./skills" 并存）
    if (typeof m.hooks === 'string' && m.hooks !== './hooks') {
      fail(`${rel}: hooks=${JSON.stringify(m.hooks)}，字符串形态应为 "./hooks"`);
    }
  }
}

// ── 组件面必须在固定位置、不得写进根清单（2026-10-28 市场审查，据 Agent Plugins 1.0.0 §6.1）──
// 规范原文（agent-plugins.org/specification §6.1 Fixed locations）：
//   "Clients MUST discover each supported component type from its fixed location. `plugin.json` cannot
//    override these locations or contain inline component configuration."
//   Skills → `skills/`（子目录含 SKILL.md）；MCP servers → `mcp.json`。
// §5.2 的封闭字段集里没有 skills/mcpServers/hooks/commands/agents——把它们写进根 plugin.json 属越界
// 未知字段（会被报并忽略），且违反 §6.1「不得内联组件配置」。本仓的约定正是：根清单只放元数据，
// 组件走固定位置；`skills` / `mcpServers` 这类内联声明只出现在各宿主垫片里（垫片非标准，不受 §5.2 约束）。
// 这条检查把该约定固化为机器对账：根 plugin.json 出现这些键即报错（防日后「顺手加一个」）。
const FORBIDDEN_ROOT_KEYS = ['skills', 'mcpServers', 'hooks', 'commands', 'agents'];
for (const plugin of plugins) {
  const manifestRel = `plugins/${plugin}/plugin.json`;
  const manifest = read(manifestRel);
  const inline = FORBIDDEN_ROOT_KEYS.filter((k) => k in manifest);
  if (inline.length) {
    fail(`${manifestRel}: 内联声明了组件面（${inline.join(', ')}）——Agent Plugins 1.0.0 §6.1 规定组件只在固定位置被发现，根清单不得内联；请删掉（垫片里可以声明）`);
  }
  // 反向锚：声明了 skills/ 就必须真有 skills/ 目录，声明了 mcp.json 就必须真有该文件
  if (fs.existsSync(path.join(ROOT, 'plugins', plugin, 'skills'))) {
    const hasSkill = fs.readdirSync(path.join(ROOT, 'plugins', plugin, 'skills'), { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'plugins', plugin, 'skills', e.name, 'SKILL.md')));
    if (!hasSkill) fail(`${manifestRel}: 有 skills/ 目录但无任何 skills/<name>/SKILL.md（规范要求每个 skill 是含 SKILL.md 的直属子目录）`);
  }
  // mcp.json 若在场：必须是含 $schema 与 mcpServers 的对象，且无其他顶层字段（§7.2.1）
  const mcpRel = `plugins/${plugin}/mcp.json`;
  if (fs.existsSync(path.join(ROOT, mcpRel))) {
    let mcp;
    try {
      mcp = read(mcpRel);
    } catch (e) {
      fail(`${mcpRel}: JSON 解析失败（${e.message}）`);
      continue;
    }
    if (!mcp.$schema) fail(`${mcpRel}: 缺 $schema（§7.2.1 必填）`);
    if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') fail(`${mcpRel}: 缺 mcpServers 对象（§7.2.1 必填）`);
    const mcpExtra = Object.keys(mcp).filter((k) => !['$schema', 'mcpServers'].includes(k));
    if (mcpExtra.length) fail(`${mcpRel}: 顶层字段越界——${mcpExtra.join(', ')}（§7.2.1 只允许 $schema 与 mcpServers）`);
  }
}

// ── CI 引用对账（2026-10-28 市场审查；同日第二轮收紧到「必须已入库」）────────────
// .github/workflows/ci.yml 里每个 `node <path>` 都是一条测试门。这些文件若被改名/删除却忘了同步
// ci.yml，或反之（新测试文件没入库、ci.yml 先引用了它），失败会在 CI 那一刻才暴露，且报错形态是
// 「文件不存在」而非「哪条门失配」。这里在本地/CI 前置一步对账：ci.yml 引用的每个 node 目标必须
// 真实存在（按 `cd <dir>` 上下文解析相对路径）。
//
// 为什么只看 fs.existsSync 不够（2026-10-28 实测踩坑）：本地跑 CI 的脚本时工作树是完整的，未入库
// 的文件照样存在、照样过——于是这批修复可以一路「本地全绿」提交，而 CI 在 actions/checkout 的干净
// 工作树上因文件缺失全红。本次就攒出了 8 个这样的文件（7 个 CI 引用的测试 + 被 check-loop-kit
// 再导出的 scripts/binding.mjs，后者断的是运行路径不是测试）。所以判据换成 git 索引：未跟踪即红。
const ciRel = '.github/workflows/ci.yml';
if (fs.existsSync(path.join(ROOT, ciRel))) {
  const lines = fs.readFileSync(path.join(ROOT, ciRel), 'utf8').split(/\r?\n/);
  let cwd = '.';
  let refs = 0;
  const targets = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const cd = line.match(/^cd\s+(\S+)\s*$/);
    if (cd) { cwd = cd[1]; return; }
    const m = line.match(/^node\s+(\S+\.mjs)\s*$/);
    if (!m) return;
    refs += 1;
    targets.push({ lineNo: idx + 1, rel: path.posix.normalize(path.posix.join(cwd, m[1])) });
  });
  for (const t of targets) {
    if (!fs.existsSync(path.join(ROOT, t.rel))) {
      fail(`${ciRel}:${t.lineNo} 引用的测试不存在——${t.rel}（改名/删除后未同步 ci.yml）`);
    }
  }
  // 入库对账：git 不可用时 loud-skip（明确说出来，不当成通过）
  let tracked = null;
  const probe = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (probe.status !== 0) {
    process.stderr.write(`! git ls-files 失败（${(probe.stderr || probe.error && probe.error.message || '').trim()}）`
      + `——跳过「CI 引用文件必须已入库」对账，此项未验证，不代表通过\n`);
  } else {
    tracked = new Set(String(probe.stdout).split('\0').filter(Boolean).map((p) => p.split(path.sep).join('/')));
  }
  if (tracked) {
    for (const t of targets) {
      if (!fs.existsSync(path.join(ROOT, t.rel))) continue; // 已在上面报过
      if (!tracked.has(t.rel)) {
        fail(`${ciRel}:${t.lineNo} 引用的文件在磁盘上存在但**未入库**——${t.rel}（本地全绿、CI 干净检出必红；请 git add）`);
      }
    }
  }
  if (refs === 0) fail(`${ciRel}: 未解析到任何 \`node <path>\` 测试门——解析口径可能已与文件格式脱节`);
}

// ── skill 名唯一性（2026-10-28 市场审查）───────────────────────────────────
// 宿主按 frontmatter 的 `name` 解析 skill，且多数宿主是**扁平命名空间**：两个插件提供同名
// skill 时，一个会被静默覆盖、或第二个插件被安装器拒绝。此前 pstack 与 ai-native-delivery
// 都提供 `show-me-your-work`，实现还不同（log.sh + bash/perl vs decision-log.mjs + Node），
// 谁赢另一个插件的内部流程就静默失去留痕步骤——而这类流程恰好是无人值守长跑，丢了也发现不了。
// 已把 ai-native 那份更名为 decision-log；这里加机器检查防再次相撞。
// 同时校验 name 与目录名一致：宿主的发现规则是 skills/<dir>/SKILL.md，两者不一致时调用名不可预期。
const skills = [];
for (const plugin of plugins) {
  const dir = path.join(ROOT, 'plugins', plugin, 'skills');
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const fm = fs.readFileSync(skillMd, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = fm && fm[1].match(/^name:\s*(.+)$/m);
    skills.push({ plugin, dir: entry.name, name: name ? name[1].trim() : '(缺 frontmatter name)' });
  }
}
for (const s of skills) {
  if (s.name !== s.dir) {
    fail(`plugins/${s.plugin}/skills/${s.dir}/SKILL.md: name=${JSON.stringify(s.name)} 与目录名不一致（宿主按目录发现、按 name 调用）`);
  }
}
const byName = new Map();
for (const s of skills) byName.set(s.name, [...(byName.get(s.name) || []), `${s.plugin}/${s.dir}`]);
for (const [name, owners] of byName) {
  if (owners.length > 1) {
    fail(`skill 名 ${JSON.stringify(name)} 被多个插件声明：${owners.join(' + ')}——扁平命名空间下会互相覆盖，或第二个插件被安装器拒绝`);
  }
}

if (problems.length) {
  console.error(`✗ 垫片一致性检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 垫片一致性检查通过（${plugins.length} 插件 × 4 份清单；${skills.length} 个 skill 名唯一）`);
