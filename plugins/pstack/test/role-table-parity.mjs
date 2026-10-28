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
console.log('\nmodels.json → 各 skill 的模型值对账：');
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
for (const [skill, entries] of rolesBySkill) {
  const rel = `skills/${skill}/SKILL.md`;
  const abs = path.join(PLUGIN, rel);
  if (!fs.existsSync(abs)) {
    check(`${rel} 存在（models.json 声明了 skill=${skill}）`, false);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const quoted = (v) => `\`${v}\``;
  const missing = entries.filter(({ expected }) => !expected.every((v) => text.includes(quoted(v))));
  check(
    `${rel} 承载 models.json 为 skill=${skill} 声明的全部模型值`,
    missing.length === 0,
    missing.map(({ role, expected }) => `${role} 期望 ${expected.join(', ')}`).join('；'),
  );
  // 值都在场还不够：文件得说明这些值是 models.json 的镜像，否则改 models.json 的人不知道要同步它
  check(`${rel} 说明这些模型值来自 models.json`, /models\.json/.test(text));
}

console.log(`\n${fail.length ? `${fail.length} 项失败：${fail.join('；')}` : '全部通过'}：${pass} 断言`);
process.exit(fail.length ? 1 : 0);
