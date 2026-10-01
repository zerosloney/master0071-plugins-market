// opencode 适配层冒烟测试：直接调用 index.mjs 的 setup，用假 ctx 捕获注册结果与 prompt hook，
// 预检判定打本地 mock SystemOne 端点，不需要真实 API Key。
// 验证五类行为：MCP server 注册（绝对路径 + 选项映射）、skill 注册（frontmatter 拆解正确）、
// 需求不明确 → 追加结论文本、需求明确 → 原文零改动、故障/寒暄/缺 Key → fail-open 零改动。
// 运行：node test/opencode.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import plugin from '../index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(here, '..', 'mcp', 'server.mjs');
const SKILL_FILE = path.resolve(here, '..', 'skills', 'systemone-decision', 'SKILL.md');

const LEVELS = ['模糊：目标都不清楚', '偏低：目标清楚但范围或关键约束不明', '较高：目标范围清楚，细节可自行决策', '明确：目标、范围、验收都清楚'];

const SCENARIOS = {
  unclear: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 1, confidence: 0.92 },
    missing: { type: 'choice', choice: 'acceptance', probabilities: { acceptance: 0.88, goal: 0.12 }, confidence: 0.88 },
    proceed: { type: 'noul', noul: 0.42 },
  },
  clear: {
    clarity: { type: 'score', legend: Object.fromEntries(LEVELS.map((c, i) => [String(i), c])), score: 3, confidence: 0.95 },
    missing: { type: 'choice', choice: 'none', probabilities: { none: 0.9, goal: 0.1 }, confidence: 0.9 },
    proceed: { type: 'noul', noul: 0.91 },
  },
};
let scenario = 'clear';

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'u2-decision', answers: SCENARIOS[scenario] }));
  });
});

/** 假 ctx：只实现 index.mjs 实际用到的三个 transform/hook，把注册结果收集出来。 */
function fakeCtx(options) {
  const mcpServers = {};
  const skills = {};
  const hooks = {};
  return {
    options,
    captured: { mcpServers, skills, hooks },
    mcp: { transform: async (cb) => cb({ set: (name, cfg) => (mcpServers[name] = cfg) }) },
    skill: { transform: async (cb) => cb({ add: (s) => (skills[s.id] = s) }) },
    session: { hook: async (name, cb) => (hooks[name] = cb) },
  };
}

let failed = false;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
};

let received = [];
let port;

const main = async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  port = mock.address().port;
  process.env.SYSTEMONE_API_KEY = 'test-key';
  process.env.UNISOUND_API_KEY = '';
  process.env.SYSTEMONE_BASE_URL = `http://127.0.0.1:${port}/v1`;

  // 1. MCP server 注册：本地 stdio，指向插件包内同一份 server.mjs
  const bare = fakeCtx();
  await plugin.setup(bare);
  const server = bare.captured.mcpServers.systemone;
  check('MCP server 注册为 local stdio 且指向包内 server.mjs', () => {
    assert.ok(server, 'systemone 未注册');
    assert.equal(server.type, 'local');
    assert.deepEqual(server.command, ['node', SERVER_ENTRY]);
    assert.equal(server.environment, undefined, '未配置 options 时不该注入空 environment');
  });

  // 2. options → SYSTEMONE_PLUGIN_*（设置页替代入口），空值与缺项都不注入
  const withOpts = fakeCtx({ base_url: 'https://acme/v1', model: 'acme-1', timeout_ms: '', scenarios: '[{"id":"x"}]' });
  await plugin.setup(withOpts);
  check('options 映射为 SYSTEMONE_PLUGIN_*，空串视为未配置', () => {
    assert.deepEqual(withOpts.captured.mcpServers.systemone.environment, {
      SYSTEMONE_PLUGIN_BASE_URL: 'https://acme/v1',
      SYSTEMONE_PLUGIN_MODEL: 'acme-1',
      SYSTEMONE_PLUGIN_SCENARIOS: '[{"id":"x"}]',
    });
  });

  // 3. skill 注册：frontmatter 拆成 name/description，content 只留正文
  const skill = bare.captured.skills['systemone-decision'];
  check('skill 注册：id/name/description/path 正确且 content 已剥 frontmatter', () => {
    assert.ok(skill, 'skill 未注册');
    assert.equal(skill.id, 'systemone-decision');
    assert.equal(skill.name, 'systemone-decision');
    assert.match(skill.description, /2 个 MCP 工具/);
    assert.equal(skill.path, SKILL_FILE);
    assert.doesNotMatch(skill.content, /^---/);
    assert.match(skill.content, /# SystemOne 决策/);
  });

  // 4. 需求不明确 → 结论文本追加到 prompt.text 末尾
  scenario = 'unclear';
  received = [];
  const event = { prompt: { text: '帮我把这个项目优化一下，尽快弄好' } };
  await bare.captured.hooks.prompt(event);
  check('需求不明确时把结论追加到 prompt.text', () => {
    assert.equal(received.length, 1, '应发出一次判定请求');
    assert.match(event.prompt.text, /需求预检/);
    assert.match(event.prompt.text, /1\.0\/3/);
    assert.match(event.prompt.text, /acceptance/);
    assert.match(event.prompt.text, /0\.42/);
    assert.ok(event.prompt.text.startsWith('帮我把这个项目优化一下'), '原始输入必须原样保留在最前');
  });

  // 5. 需求明确 → 原文零改动
  scenario = 'clear';
  received = [];
  const clearEvent = { prompt: { text: '把 server.mjs 里的 thresholdOf 默认值从 0.7 改成 0.8' } };
  await bare.captured.hooks.prompt(clearEvent);
  check('需求明确时 prompt.text 零改动（零噪音）', () => {
    assert.equal(clearEvent.prompt.text, '把 server.mjs 里的 thresholdOf 默认值从 0.7 改成 0.8');
    assert.equal(received.length, 1, '静默发生在判定之后');
  });

  // 6. 寒暄捷径 → 不发请求直接放行
  scenario = 'unclear';
  received = [];
  const casual = { prompt: { text: '好的' } };
  await bare.captured.hooks.prompt(casual);
  check('寒暄捷径不触发判定请求', () => {
    assert.equal(casual.prompt.text, '好的');
    assert.equal(received.length, 0);
  });

  // 7. 缺 Key → 不发请求直接放行
  received = [];
  const savedKey = process.env.SYSTEMONE_API_KEY;
  process.env.SYSTEMONE_API_KEY = '';
  process.env.UNISOUND_API_KEY = '';
  const noKey = { prompt: { text: '帮我把这个项目优化一下，尽快弄好' } };
  await bare.captured.hooks.prompt(noKey);
  process.env.SYSTEMONE_API_KEY = savedKey;
  check('缺 API Key 时静默放行且不发请求', () => {
    assert.equal(noKey.prompt.text, '帮我把这个项目优化一下，尽快弄好');
    assert.equal(received.length, 0);
  });

  // 8. 接口不可达 → fail-open，hook 不抛、原文零改动
  process.env.SYSTEMONE_BASE_URL = 'http://127.0.0.1:9/v1';
  const down = { prompt: { text: '帮我把这个项目优化一下，尽快弄好' } };
  await bare.captured.hooks.prompt(down);
  process.env.SYSTEMONE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  check('接口故障时 fail-open：不抛异常且原文零改动', () => {
    assert.equal(down.prompt.text, '帮我把这个项目优化一下，尽快弄好');
  });

  // 9. 无 prompt 文本（合成消息等）不炸
  const bare2 = { prompt: {} };
  await bare.captured.hooks.prompt(bare2);
  check('prompt 无 text 字段时静默跳过', () => {
    assert.equal(bare2.prompt.text, undefined);
  });

  mock.close();
  if (failed) {
    console.error('\nopencode 适配冒烟测试存在失败项');
    process.exit(1);
  }
  console.log('\nopencode 适配冒烟测试全部通过');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
