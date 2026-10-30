#!/usr/bin/env node
// role-table-parity.mjs — 角色表三处单源对账（2026-10-28 市场审查新增）
//
// 背景：pstack 的「角色 → 模型」映射事实上有三处载体，此前全靠人工同步：
//   ① models.json 的 roles[]（声明式，供人读；**无任何代码消费**）
//   ② hooks/sheet.mjs 的 ROLES 常量（hook 解码用户模型表时的合法角色集，运行时执法）
//   ③ skills/setup-pstack/SKILL.md 的写入模板（setup 引导用户落盘时的默认表）
// 三处漏改任一即造成「setup 写出的表被 hook 判为非法角色」或「hook 认的角色 setup 从不生成」——
// 都只在真实会话启动那一刻暴露。本套件把「三处角色集与顺序一致」变成机器对账。
//
// 口径：以 models.json 的 roles[] 为准（它是声明式事实源），比对另两处的角色**名集合与顺序**。
//   只比角色名，不比模型值——模型值本就是各处的默认建议，允许按宿主差异裁剪（如 setup 模板用
//   具体 slug，models.json 用 default/strongest/panel 这类抽象档）。
//
//   node test/role-table-parity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../hooks/sheet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');

let pass = 0;
const fail = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ① models.json 的角色名（事实源）
const models = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'models.json'), 'utf8'));
const modelsRoles = (models.roles || []).map((r) => (typeof r === 'string' ? r : r.role));

// ② sheet.mjs 的 ROLES（运行时执法集）
const sheetRoles = [...ROLES];

// ③ setup-pstack 模板里的角色行：取 ```markdown 代码块中的 `<role>: <value>` 行。
//    代码块首行是一段含冒号的散文说明，故不能只靠「行首有冒号」判定——用「值不得含空格之外的
//    说明性标点 + 角色名必须出现在 models.json 里」双重过滤，散文行自然落选。
const setupText = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup-pstack', 'SKILL.md'), 'utf8');
const blockMatch = setupText.match(/```markdown\r?\n([\s\S]*?)```/);
const setupRoles = [];
if (blockMatch) {
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(\S.*)$/);
    if (!m) continue;
    const role = m[1].trim();
    const value = m[2].trim();
    if (role === 'default effort' || role === 'session hook') continue;
    // 值形态：`opus` / `inherit-parent` / `opus, fable, sonnet, haiku`（可带 ` @xhigh` 后缀）。
    // 散文说明行的值含句子标点与反引号，在此被排除。
    if (!/^[A-Za-z0-9_.-]+(?: @[a-z]+)?(?:, [A-Za-z0-9_.-]+(?: @[a-z]+)?)*$/.test(value)) continue;
    setupRoles.push(role);
  }
}

console.log('角色表三处对账：');
check('models.json 声明了 roles[]', modelsRoles.length > 0, `roles=${modelsRoles.length}`);
check('setup-pstack 模板解析出角色行', setupRoles.length > 0, `setup=${setupRoles.length}`);

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

check(
  'models.json ↔ hooks/sheet.mjs ROLES 角色名与顺序一致',
  same(modelsRoles, sheetRoles),
  `models=${JSON.stringify(modelsRoles)}\n      sheet =${JSON.stringify(sheetRoles)}`,
);
check(
  'models.json ↔ setup-pstack 模板角色名与顺序一致',
  same(modelsRoles, setupRoles),
  `models=${JSON.stringify(modelsRoles)}\n      setup =${JSON.stringify(setupRoles)}`,
);

// 顺序漂移的独立提示：集合相同但顺序不同，说明只是排版差异而非漏改，报得更具体
if (!same(modelsRoles, setupRoles) && modelsRoles.length === setupRoles.length
  && [...modelsRoles].sort().join('|') === [...setupRoles].sort().join('|')) {
  console.log('  （提示：三处角色集合相同但顺序不同——若为有意排版，请同步顺序以免误导）');
}

// ② 双份角色文件必须逐字相同（2026-10-28 市场审查）
// agents/comment-sicko.md 与 skills/poteto-mode/references/agents/comment-sicko.md 是有意的双份：
// 宿主加载 agents/ 时用前者，Codex 等不加载 agents/ 的宿主由 no-comments 指示子代理读后者
// （见 NOTICE-PORT.md 与 codex-tools.md）。两份靠人工同步，改一份漏改另一份会让同一角色在不同宿主
// 上行为分叉——这里把「逐字相同」变成机器对账。
console.log('\n双份角色文件对账：');
const dupPairs = [['agents/comment-sicko.md', 'skills/poteto-mode/references/agents/comment-sicko.md']];
for (const [a, b] of dupPairs) {
  const pa = path.join(PLUGIN, a);
  const pb = path.join(PLUGIN, b);
  check(`${a} 存在`, fs.existsSync(pa));
  check(`${b} 存在`, fs.existsSync(pb));
  if (fs.existsSync(pa) && fs.existsSync(pb)) {
    check(`${a} ↔ ${b} 逐字相同`, fs.readFileSync(pa, 'utf8') === fs.readFileSync(pb, 'utf8'), '两份内容已漂移，须同步');
  }
}

// ③ 反方向对账：models.json 的每个 skill 归属，都要在对应 SKILL.md 里能找到那份模型值
// （2026-10-28）。上面 ①② 只对「角色名集合与顺序」，锁不住「值」。实测漏了一处：
// models.json 为角色 interrogate reviewers 指定了 skill=interrogate，而 interrogate/SKILL.md
// 把默认模型写成表格、既无 ## Models 节也不提 models.json——`grep models.json` 找不到它，
// 于是「改 models.json 要同步 mirror」这条约定对它不成立，它是一份没人对账的第四份副本。
// 判据：models.json 里每个 (role, skill) 的期望模型值序列，必须出现在该 skill 的 SKILL.md 中
// （按 `a`, `b` 反引号形态逐项出现即可；不要求特定标题，表格与列表都算）。
console.log('\nmodels.json → 各 skill 的模型值对账（逐角色双向）：');
// 2026-10-29 第三轮：上一版只检查「expected 里的每个值在该 SKILL.md 的全文里以 `v` 形态出现过」。
// 那是「值出现」而不是「角色 → 值」对账，两类漂移都能溜过去：
//   · 张冠李戴——把 bug-fix 的值挪到 feature 名下，两处值都还在全文里，旧断言照样绿；
//   · 多写——文档里多出一个 models.json 没有的模型名，旧断言不管。
// 现在解析每份文档的「角色 → 值序列」行（`- <role>: `a`, `b``），与 models.json 做双向逐项比对：
// 角色名集合相同、每个角色的值序列相同、且没有多余行。
const tierOf = models.tiers || {};
// tiers 的值有两种形态：字符串（default → "opus"）与数组（panel → ["opus", "fable", ...]）。
// 统一摊平成字符串数组——第一版写成 [tierOf[m] ?? m]，panel 就解成了嵌套数组，三处误红。
const resolveTier = (m) => {
  const v = Array.isArray(m) ? m : [m ?? null];
  return v.flatMap((x) => {
    const t = tierOf[x];
    if (t === undefined) return x === null ? [] : [x];
    return Array.isArray(t) ? t : [t];
  });
};
const rolesBySkill = new Map();
for (const r of models.roles || []) {
  const role = typeof r === 'string' ? r : r.role;
  const skill = typeof r === 'string' ? 'poteto-mode' : r.skill;
  if (!rolesBySkill.has(skill)) rolesBySkill.set(skill, []);
  rolesBySkill.get(skill).push({ role, expected: resolveTier(typeof r === 'string' ? null : r.models) });
}
check('models.json 的 roles[] 带 skill 归属', rolesBySkill.size > 0, JSON.stringify([...rolesBySkill.keys()]));

// 解析「Role defaults」段里的角色行：`- <role>: `v1`, `v2``。
// 必须限定在该段内——首版对全文抓 `- x: `y``，把文档别处的清单（如 reflect 的
// 「Edits applied: `<skill path>`」）也当成角色行，9 条误红。段的边界：
// 以含 `Role defaults` 的行开始，到下一个 `## ` 标题为止（文档里 `## Reasoning effort` 紧随其后）。
const roleSection = (text) => {
  const lines = text.split(/\r?\n/);
  // 锚点要足够窄：poteto-mode 的 `## Subagents` 段里有一句散文 'Role defaults in [Models]'，用宽匹配会把整段散文当角色段（实测 6 条误解析）。真正的段首是
  // 「Role defaults, stamped from `models.json`」或「Defaults are stamped from `models.json`」。
  const start = lines.findIndex((l) => /^(Role defaults, stamped from|Defaults are stamped from)/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
};
const parseRoleLines = (text) => {
  const out = new Map();
  const section = roleSection(text);
  if (section === null) return out;
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^-\s+([^:`]+?):\s*(.+)$/);
    if (!m) continue;
    const role = m[1].trim();
    const values = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    if (values.length === 0) continue;
    out.set(role, values);
  }
  return out;
};

for (const [skill, entries] of rolesBySkill) {
  const rel = `skills/${skill}/SKILL.md`;
  const abs = path.join(PLUGIN, rel);
  if (!fs.existsSync(abs)) {
    check(`${rel} 存在（models.json 声明了 skill=${skill}）`, false);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  check(`${rel} 说明这些模型值来自 models.json`, /models\.json/.test(text));

  // interrogate 的载体是一张「Subagent → 模型」表格（4 个面板成员），没有角色行。
  // 它的结构化对账是「表格行数 == panel 长度，且值序列逐项相同」。
  if (skill === 'interrogate') {
    const tableRows = [...text.matchAll(/^\|\s*(?!Subagent|[-:| ])[^|]+\|\s*`([^`]+)`\s*\|\s*$/gm)].map((m) => m[1]);
    const expected = entries.find((e) => e.role === 'interrogate reviewers')?.expected ?? [];
    check(
      `${rel} 的表格行数与 panel 长度一致（${expected.length}）`,
      tableRows.length === expected.length,
      `table=${JSON.stringify(tableRows)} expected=${JSON.stringify(expected)}`,
    );
    check(
      `${rel} 的表格逐行值与 panel 顺序一致`,
      tableRows.length === expected.length && tableRows.every((v, i) => v === expected[i]),
      `table=${JSON.stringify(tableRows)}\n      expected=${JSON.stringify(expected)}`,
    );
    continue;
  }

  const declared = parseRoleLines(text);
  check(
    `${rel} 解析出 ${entries.length} 条角色行`,
    declared.size === entries.length,
    `解析到 ${declared.size} 条：${JSON.stringify([...declared.keys()])}`,
  );
  const missingRoles = entries.filter((e) => !declared.has(e.role)).map((e) => e.role);
  check(
    `${rel} 覆盖 models.json 为 skill=${skill} 声明的全部角色名`,
    missingRoles.length === 0,
    `缺少：${missingRoles.join('；')}`,
  );
  const extraRoles = [...declared.keys()].filter((r) => !entries.some((e) => e.role === r));
  check(
    `${rel} 没有 models.json 未声明的角色行`,
    extraRoles.length === 0,
    `多余：${extraRoles.join('；')}`,
  );
  const mismatched = entries
    .filter((e) => declared.has(e.role))
    .filter((e) => JSON.stringify(declared.get(e.role)) !== JSON.stringify(e.expected))
    .map((e) => `${e.role}: 文档 ${JSON.stringify(declared.get(e.role))} ≠ models.json ${JSON.stringify(e.expected)}`);
  check(
    `${rel} 每个角色的值序列与 models.json 一致（防张冠李戴）`,
    mismatched.length === 0,
    mismatched.join('\n      '),
  );
  // 文档里出现的模型名必须都是 models.json 声明过的——拼错（`fabl`）或上游新增（`gpt-5`）都会在这里暴露
  const known = new Set(models.available || []);
  const unknownModels = [...declared.values()].flat().filter((v) => !known.has(v));
  check(
    `${rel} 未使用 models.json available 之外的模型名`,
    unknownModels.length === 0,
    `未知：${[...new Set(unknownModels)].join(', ')}`,
  );
}
// 解析器自检（2026-10-29 第三轮）：上面的断言只在文件真的漂移时才红，本套件本身是否
// 还认得漂移却没人验证——「只验值出现」那一版就是这么长期假绿的。这里用合成文档直接
// 打解析器：喂进各类漂移，断言解析结果与期望不符（也就是上层断言会红）。
console.log('\n解析器自检（合成文档，不碰真实文件）：');
const HEAD = 'Role defaults, stamped from `models.json` at the plugin root (edit there and mirror).';
const synth = (lines) => [HEAD, '', ...lines, '', '## Reasoning effort', '', '- untouched: `opus`'].join('\n');

const selfCases = [
  {
    label: '正常角色行解析出全部角色与值序列',
    doc: synth(['- feature, refactoring: `opus`', '- arena runners: `opus`, `fable`, `sonnet`, `haiku`']),
    expect: [['feature, refactoring', ['opus']], ['arena runners', ['opus', 'fable', 'sonnet', 'haiku']]],
  },
  {
    label: '值写错时解析结果与声明不同（上层会红）',
    doc: synth(['- feature, refactoring: `fable`']),
    expect: [['feature, refactoring', ['opus']]],
    expectMismatch: true,
  },
  {
    label: '段外的列表不被当成角色行',
    doc: synth(['- feature, refactoring: `opus`']),
    expect: [['feature, refactoring', ['opus']]],
    extraLines: ['## Later section', '', '- Edits applied: `<skill path>`'],
  },
];

for (const c of selfCases) {
  const doc = c.extraLines ? `${c.doc}\n\n${c.extraLines.join('\n')}\n` : c.doc;
  const parsed = parseRoleLines(doc);
  const got = [...parsed.entries()];
  const same = JSON.stringify(got) === JSON.stringify(c.expect);
  check(c.label, c.expectMismatch ? !same && got.some(([r, v]) => {
    const want = c.expect.find((e) => e[0] === r);
    return want && JSON.stringify(v) !== JSON.stringify(want[1]);
  }) : same, `got=${JSON.stringify(got)}\n      expect=${JSON.stringify(c.expect)}`);
}

// 散文误锚自检：poteto-mode 的 ## Subagents 段里有一句 'Role defaults in [Models]'。
// 若锚点过宽，整段散文会被当角色段——这里确认现在不会。
const proseDoc = [
  '**Defaults for every Agent call.** Role defaults in [Models], with "judgment and prose" covering prose.',
  '',
  '- not a role: `opus`',
].join('\n');
check('散文里出现的 Role defaults 不被当作段首', parseRoleLines(proseDoc).size === 0, JSON.stringify([...parseRoleLines(proseDoc).entries()]));

console.log(`\n${fail.length ? `${fail.length} 项失败：${fail.join('；')}` : '全部通过'}：${pass} 断言`);
process.exit(fail.length ? 1 : 0);
