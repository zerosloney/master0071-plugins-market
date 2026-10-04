// caveman opencode 适配冒烟测试：假 ctx 验证 skill 注册与 prompt hook 接线。
// 不需要真实 opencode；hook 子进程走真实脚本，但用例保持只读（默认模式路径，
// 不触发 /caveman 写 flag 的分支），不需要真实 API 或网络。
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import plugin from '../index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;

// ── 假 ctx：记录注册调用 ────────────────────────────────────────────────────
const registeredSkills = [];
const promptHooks = [];
const ctx = {
  options: {},
  skill: {
    transform: async (fn) => {
      await fn({ add: (s) => registeredSkills.push(s) });
    },
  },
  session: {
    hook: (name, fn) => {
      assert.equal(name, 'prompt');
      promptHooks.push(fn);
    },
  },
};

// ── setup ───────────────────────────────────────────────────────────────────
await plugin.setup(ctx);
assert.equal(plugin.id, 'caveman');
assert.equal(promptHooks.length, 1, '应注册一个 prompt hook');
console.log('PASS  setup 注册一个 prompt hook');
pass++;

// ── 7 个 skill 全部注册，frontmatter 折叠标量解析正确 ───────────────────────
const ids = registeredSkills.map((s) => s.id).sort();
assert.deepEqual(ids, [
  'cavecrew', 'caveman', 'caveman-commit', 'caveman-compress',
  'caveman-help', 'caveman-review', 'caveman-stats',
]);
for (const s of registeredSkills) {
  assert.ok(s.name && s.name.length > 0, `${s.id} 应有 name`);
  assert.ok(s.description && s.description.length > 5, `${s.id} 应有解析后的 description`);
  assert.ok(!s.description.startsWith('>'), `${s.id} description 不应是未展开的折叠标量`);
  assert.ok(s.content && s.content.length > 0, `${s.id} 应有正文`);
  assert.ok(existsSync(s.path), `${s.id} path 应真实存在`);
}
const cavemanSkill = registeredSkills.find((s) => s.id === 'caveman');
assert.ok(cavemanSkill.description.includes('Ultra-compressed'), '折叠标量应展开为整段文本');
console.log('PASS  7 个 skill 注册，YAML 折叠标量正确展开');
pass++;

// ── prompt hook：普通输入追加 caveman 强化 ──────────────────────────────────
const hook = promptHooks[0];
const event = { prompt: { text: '帮我看看这个函数为什么慢' } };
await hook(event);
assert.ok(event.prompt.text.includes('CAVEMAN MODE ACTIVE'), '默认模式下应追加强化文本');
assert.ok(event.prompt.text.startsWith('帮我看看这个函数为什么慢'), '原文应保留在前');
console.log('PASS  普通输入追加 CAVEMAN MODE ACTIVE 强化');
pass++;

// ── 短输入直接放行（不 spawn、不改写） ───────────────────────────────────────
const short = { prompt: { text: '好' } };
await hook(short);
assert.equal(short.prompt.text, '好', '短输入应原样通过');
console.log('PASS  短输入直接放行');
pass++;

// ── 非 string prompt 静默放行 ────────────────────────────────────────────────
const weird = { prompt: {} };
await hook(weird);
assert.deepEqual(weird.prompt, {}, '非 string prompt 应原样通过');
console.log('PASS  非 string prompt 静默放行');
pass++;

console.log(`\nopencode 适配冒烟测试全部通过（${pass} 组）`);
