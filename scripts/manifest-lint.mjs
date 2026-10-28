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
// 深度遍历清单取出所有字符串值（hook 命令、args、env、指针都藏在不同层级，逐个手抄会漏）
function* stringsOf(node) {
  if (typeof node === 'string') { yield node; return; }
  if (Array.isArray(node)) { for (const v of node) yield* stringsOf(v); return; }
  if (node && typeof node === 'object') { for (const v of Object.values(node)) yield* stringsOf(v); }
}

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

// ── 组件指针落点 + 设置页三跳对账（2026-10-28 第二轮市场审查）─────────────────
// 垫片里的 hooks 指针、`${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` 命令串、`userConfig → env` 映射全都是
// **字符串**：宿主照着找，找不到就不装这个 hook / 不注入这个变量，且不报错。于是「声明在、实体不在」
// 表现为该宿主上闸门静默不存在、或设置页改了没反应——正是本脚本的立项目标（机器对账代替人眼）。
// 四条：
//   ① `"hooks": "./hooks"` 必须解析到真实目录且其中有 hooks.json；
//   ② 任何 `${CLAUDE_PLUGIN_ROOT}/<带扩展名路径>` 与 `"./<带扩展名路径>"` 必须真实存在
//      （相对路径一律按**插件根**解析——宿主就是这么解的，不是按垫片所在目录）；
//   ③ mcpServers.env 里 `${user_config.X}` 引用的 X 必须在同一垫片 userConfig 中存在；
//   ④ 该 env 键名必须在插件**生产代码**里被读取过（test/ 里的读取不算：测试绿不代表宿主生效）。
// 扩展名交替必须**长名在前**且后接非词字符：写成 `js|json` 会把 "./mcp.json" 截成 "./mcp.js"
// （实测踩过一次，报出三条假阳性），宿主解的是整串，截断即指向不存在的文件。
const PATH_TOKEN_RE = /\$?\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"'`),]+?\.(?:json|mjs|cjs|ps1|sh|py|js)(?![\w]))|(?<=^|\s)(\.\/[^\s"'`),]+?\.(?:json|mjs|cjs|ps1|sh|py|js)(?![\w]))/g;
const codeCache = new Map();
const pluginCode = (plugin) => {
  if (codeCache.has(plugin)) return codeCache.get(plugin);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) files.push(p);
    }
  };
  const base = path.join(ROOT, 'plugins', plugin);
  walk(base);
  const blob = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  codeCache.set(plugin, { blob, count: files.length });
  return codeCache.get(plugin);
};

for (const plugin of plugins) {
  const dirRel = `plugins/${plugin}`;
  const manifestFiles = [`${dirRel}/plugin.json`, ...SHIMS.map((s) => `${dirRel}/${s}/plugin.json`),
    `${dirRel}/hooks/hooks.json`, `${dirRel}/mcp.json`];
  for (const relFile of manifestFiles) {
    const abs = path.join(ROOT, relFile);
    if (!fs.existsSync(abs)) continue;
    let m;
    try { m = read(relFile); } catch { continue; } // JSON 合法性另有检查

    if (typeof m.hooks === 'string' && m.hooks.startsWith('.')) {
      const target = path.join(ROOT, dirRel, m.hooks);
      if (!fs.existsSync(target)) fail(`${relFile}: hooks 指针 ${JSON.stringify(m.hooks)} 不存在——该宿主上 hook 静默不装，闸门不生效`);
      else if (!fs.existsSync(path.join(target, 'hooks.json'))) fail(`${relFile}: hooks 指针 ${JSON.stringify(m.hooks)} 指向的目录里没有 hooks.json——宿主找不到 hook 入口`);
    }

    for (const s of stringsOf(m)) {
      for (const mm of s.matchAll(PATH_TOKEN_RE)) {
        const tok = mm[1] || mm[2];
        if (!tok) continue;
        if (!fs.existsSync(path.join(ROOT, dirRel, tok))) {
          fail(`${relFile}: 引用 ${JSON.stringify(tok)} 不存在（按插件根解析）——宿主照字符串找，找不到即静默跳过，不报错`);
        }
      }
    }

    for (const server of Object.values(m.mcpServers && typeof m.mcpServers === 'object' ? m.mcpServers : {})) {
      if (!server || typeof server !== 'object') continue;
      for (const [envKey, envVal] of Object.entries(server.env || {})) {
        const ref = typeof envVal === 'string' && /\$\{user_config\.([\w-]+)\}/.exec(envVal);
        if (!ref) continue;
        if (!m.userConfig || !(ref[1] in m.userConfig)) {
          fail(`${relFile}: env ${envKey} 映射 \${user_config.${ref[1]}}，但本垫片 userConfig 无此键——设置页没有这一项，注入恒为空`);
        }
        const { blob } = pluginCode(plugin);
        if (!blob.includes(envKey)) {
          fail(`${relFile}: env ${envKey} 在 plugins/${plugin} 的生产代码里没有任何读取点（test/ 不计）——设置页改了不生效，属静默失效`);
        }
      }
    }
  }
}

// ── 组件实体 vs 垫片声明（2026-10-28 第二轮市场审查）─────────────────────────
// 垫片漏声明一个组件面 = 那个宿主上这批 skill / command / agent 静默不加载。2026-10-28 实测抓到
// 一条：ai-native-delivery 的 zcode 垫片声明了 skills/hooks/mcpServers 却漏了 commands 与 agents，
// 而同仓另外两个有 commands 的插件都声明了——README 通篇按「8 交付命令 + 3 角色委派」宣传。
// 判据取**本仓既有约定**而非臆造：同一垫片在别的插件里声明过某个组件面，就认为该宿主支持它，
// 于是本插件凡有该实体也必须声明。宿主确实不支持的面（下表）以豁免显式记录并注明出处，
// 不再靠"口口相传的实测结论"——那样下次加插件必然漏。
const COMPONENTS = ['skills', 'commands', 'agents', 'hooks', 'mcpServers'];
const SHIM_COMPONENT_EXEMPTIONS = {
  // Codex 不执行插件 hook（本仓实测，见 plugins/pstack/README.md「宿主与 hook 降级」）→ 声明无意义
  'systemone-decision/.codex-plugin': ['hooks'],
  // ZCode 按约定路径注册 hooks、不理会 hooks 指针（见 plugins/pstack/README.md）→ pstack 选择不写
  'pstack/.zcode-plugin': ['hooks'],
};
for (const shim of SHIMS) {
  for (const plugin of plugins) {
    const rel = `plugins/${plugin}/${shim}/plugin.json`;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const m = read(rel);
    const entityOf = (k) => (k === 'mcpServers'
      ? fs.existsSync(path.join(ROOT, 'plugins', plugin, 'mcp.json'))
      : fs.existsSync(path.join(ROOT, 'plugins', plugin, k)));
    // 该宿主在本仓的支持面：任一插件的同一垫片声明过，即视为支持
    const supported = COMPONENTS.filter((k) => plugins.some((q) => {
      if (q === plugin) return false;
      const p = `plugins/${q}/${shim}/plugin.json`;
      if (!fs.existsSync(path.join(ROOT, p))) return false;
      return k in read(p);
    }));
    const exempt = SHIM_COMPONENT_EXEMPTIONS[`${plugin}/${shim}`] || [];
    for (const k of supported) {
      if (exempt.includes(k)) continue;
      if (entityOf(k) && !(k in m)) {
        fail(`${rel}: 有 ${k} 实体目录/文件但垫片未声明——该宿主上这批组件静默不加载`
          + `（同仓其他插件的 ${shim} 都声明了 ${k}）。确属宿主不支持请写入 SHIM_COMPONENT_EXEMPTIONS 并注明出处`);
      }
    }
  }
}
// 豁免表自身的保鲜：豁免项若实体已不在，就是陈旧条目（防止豁免表随时间变成垃圾场）。
// 只校验**本次检出里在场**的插件——selftest 与局部检出不可能带齐 5 个插件，若把「插件不在」当错误
// 报，合法夹具会被判红（实测踩过一次，6 条断言连带失配）。插件若真被删除，其豁免项无害（对应的
// 实体检查面也随之消失），不值得为此让任何局部检出跑不通过。
for (const [key, list] of Object.entries(SHIM_COMPONENT_EXEMPTIONS)) {
  const [plugin] = key.split('/');
  if (!plugins.includes(plugin)) continue;
  for (const k of list) {
    const entity = k === 'mcpServers'
      ? fs.existsSync(path.join(ROOT, 'plugins', plugin, 'mcp.json'))
      : fs.existsSync(path.join(ROOT, 'plugins', plugin, k));
    if (!entity) fail(`SHIM_COMPONENT_EXEMPTIONS[${JSON.stringify(key)}] 含 ${JSON.stringify(k)}，但实体已不存在——陈旧豁免，请删除`);
  }
}

// ── 共装闸门必须在市场首页可见（2026-10-28 第二轮）─────────────────────────────
// 两个插件都注册 PreToolUse shell 闸时，宿主各跑各的、没有仲裁通道：同装 = 一条命令判两次。
// 这件事原本只写在**各自** README 里，而用户在装之前读的是市场首页——于是安装后才撞上双确认。
// 规则：凡注册 PreToolUse 的插件达到 2 个，根 README 就得有一节把这些插件**全部点名**，
// 第三个插件再加闸却不进这一节时，本规则报红（防这节随时间变成半真信息）。
const preToolPlugins = plugins.filter((p) => {
  const files = [`plugins/${p}/hooks/hooks.json`, ...SHIMS.map((s) => `plugins/${p}/${s}/plugin.json`)];
  return files.some((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return false;
    try { return /"PreToolUse"/.test(fs.readFileSync(abs, 'utf8')); } catch { return false; }
  });
});
if (preToolPlugins.length >= 2) {
  const rootReadme = path.join(ROOT, 'README.md');
  const text = fs.existsSync(rootReadme) ? fs.readFileSync(rootReadme, 'utf8') : '';
  const section = text.split(/\r?\n/).filter((l) => l.includes('PreToolUse') || l.includes('共装')).join('\n');
  if (!section) {
    fail(`README.md: ${preToolPlugins.length} 个插件都注册了 PreToolUse 闸（${preToolPlugins.join(' + ')}），`
      + '但市场首页没有一个字提到共装会双判——用户装之前看不到，装之后才撞');
  } else {
    for (const p of preToolPlugins) {
      if (!new RegExp(p.replace(/-/g, '\\-')).test(section)) {
        fail(`README.md 的共装/PreToolUse 段未点名 ${p}——该插件也注册了 PreToolUse 闸，漏一个就等于这节是半真信息`);
      }
    }
  }
}

// ── 护栏措辞必须与实现同口径（2026-10-28 第二轮；第一轮就漏过一次）───────────────
// worktree_remove 的丢弃护栏是**双标志**（`mcp/tools.mjs` 里 `discard = force && confirmDiscard`）。
// 面向用户的描述只要提了 `force` 却没提 `confirmDiscard`，就是在广告一道比实现更弱的护栏：
// 用户或 agent 照描述只传 force，必然撞二次确认，轻则流程卡死、重则误判成工具坏了。
// 这类漂移改一处漏一处——第一轮修了 plugin.json / 垫片 / README 正文 / SKILL，却漏了带反引号的
// 根 README 表格行（`（\`force=true\` 可越过）`），关键词 grep 也没抓到它。所以判据从**实现**取：
// 源文件里的与关系一旦变（增删标志），本规则先自曝，不允许悄悄过期。
const GUARDRAILS = [
  {
    plugin: 'worktree-ops',
    source: 'plugins/worktree-ops/mcp/tools.mjs',
    pairRe: /const\s+discard\s*=\s*(\w+)\s*&&\s*(\w+)/,
    // 提到主标志、又确实在讲删除，就必须同时提到副标志
    // 词边界判据即可覆盖 `force`（反引号）/ force / force=true 三种写法——反引号本身是非词字符，
    // 不需要为它单列分支（第一版在这里写模板串转义直接把脚本编译打挂了，反而说明单判据更稳）
    mentionsPrimary: (t, primary) => new RegExp(`\\b${primary}\\b`).test(t),
  },
];
for (const g of GUARDRAILS) {
  // 只校验本次检出里在场的插件（selftest 与局部检出不可能带齐全部插件；缺席时硬报错会让合法夹具判红）
  if (!plugins.includes(g.plugin)) continue;
  const src = fs.existsSync(path.join(ROOT, g.source)) ? fs.readFileSync(path.join(ROOT, g.source), 'utf8') : '';
  const m = g.pairRe.exec(src);
  if (!m) { fail(`${g.source}: 取不到「标志A && 标志B」的与关系——护栏措辞规则失去依据，请同步更新 manifest-lint 里的 GUARDRAILS`); continue; }
  const [, primary, secondary] = m;
  const texts = [];
  // ① 根 README 的插件表格行
  const rootReadme = path.join(ROOT, 'README.md');
  if (fs.existsSync(rootReadme)) {
    for (const line of fs.readFileSync(rootReadme, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('|') && line.includes(`[${g.plugin}](`)) texts.push(['README.md 插件表行', line]);
    }
  }
  // ② 各市场目录的条目描述（含 i18n 分支）
  for (const cat of ['marketplace.json', '.omp-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    if (!fs.existsSync(path.join(ROOT, cat))) continue;
    for (const e of (read(cat).plugins || []).filter((x) => x && x.name === g.plugin)) {
      texts.push([`${cat} · ${e.displayName || e.name}`, String(e.description || '')]);
      for (const [loc, v] of Object.entries(e.description_i18n || {})) texts.push([`${cat} · ${loc}`, String(v || '')]);
    }
  }
  // ③ 插件自身清单（根 + 三垫片）
  for (const rel of [`plugins/${g.plugin}/plugin.json`, ...SHIMS.map((s) => `plugins/${g.plugin}/${s}/plugin.json`)]) {
    if (fs.existsSync(path.join(ROOT, rel))) texts.push([rel, String(read(rel).description || '')]);
  }
  const seen = new Set();
  for (const [where, text] of texts) {
    if (!text || seen.has(where + text)) continue;
    seen.add(where + text);
    if (g.mentionsPrimary(text, primary) && !new RegExp(secondary).test(text)) {
      fail(`${where}: 描述了 ${primary} 却没提 ${secondary}——实现是「${primary} && ${secondary}」双标志`
        + `（${g.source}），单提 ${primary} 会让调用方只传一个标志然后撞二次确认`);
    }
  }
}

if (problems.length) {
  console.error(`✗ 垫片一致性检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 垫片一致性检查通过（${plugins.length} 插件 × 4 份清单；${skills.length} 个 skill 名唯一）`);
