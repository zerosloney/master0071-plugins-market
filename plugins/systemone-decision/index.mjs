// opencode 插件入口：把 stdio MCP server、skill 与需求明确度预检 hook 注册进 opencode。
// 业务载荷（mcp/*.mjs、skills/、hooks/clarity.mjs）与 ZCode / MiniMax Code / omp 完全共享，
// 三端跑的是同一份代码；本文件只做 opencode 侧的接线，不含任何业务逻辑。
//
// 刻意不 import @opencode/plugin：默认导出裸对象 { id, setup } 与 Plugin.define() 形状一致，
// 但少一个运行时解析依赖——长驻 service 曾缓存过 @opencode/plugin 的负解析结果，
// 而本包定位是零依赖（安装即用，不需要 npm install 拉任何东西）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { precheck } from './hooks/clarity.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');

// 插件设置页在 opencode 不存在，等价入口是 opencode.json 里 plugins[].options。
// 4 项配置映射回服务端本来就认的 SYSTEMONE_PLUGIN_*，取值链（设置页 > 环境变量 > 内置默认）
// 与 ZCode 端完全一致；API Key 不在其中，仍只走环境变量。
const OPTION_ENV = {
  base_url: 'SYSTEMONE_PLUGIN_BASE_URL',
  model: 'SYSTEMONE_PLUGIN_MODEL',
  timeout_ms: 'SYSTEMONE_PLUGIN_TIMEOUT_MS',
  scenarios: 'SYSTEMONE_PLUGIN_SCENARIOS',
};

function optionEnv(options) {
  const env = {};
  for (const [key, name] of Object.entries(OPTION_ENV)) {
    const value = options?.[key];
    if (typeof value === 'string' && value.trim() !== '') env[name] = value;
  }
  return env;
}

function loadSkill() {
  const file = path.join(ROOT, 'skills', 'systemone-decision', 'SKILL.md');
  const raw = readFileSync(file, 'utf8');
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const field = (key) => (front ? RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(front[1])?.[1]?.trim() : '') || '';
  return {
    id: 'systemone-decision',
    name: field('name') || 'SystemOne Decision',
    description: field('description'),
    path: file,
    // content 是「去掉 frontmatter 的正文」——opencode 加载 skill 时正文与 frontmatter 分开处理
    content: front ? raw.slice(front[0].length) : raw,
  };
}

export default {
  id: 'systemone-decision',
  async setup(ctx) {
    // 1) MCP server：与另外两端跑同一份 mcp/server.mjs，工具名不变
    //    （opencode 会把工具暴露为 systemone_systemone_scenario 等，默认 Code Mode 下走
    //    tools.systemone.systemone_scenario(...) 的命名空间）
    const environment = optionEnv(ctx.options);
    await ctx.mcp.transform((editor) => {
      editor.set('systemone', {
        type: 'local',
        command: ['node', SERVER],
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
      });
    });

    // 2) skill：共用 SKILL.md。单独兜底——skill 文件读失败不该连带 MCP 一起不上。
    let skill;
    try {
      skill = loadSkill();
    } catch (e) {
      console.error(`[systemone-decision] 跳过 skill 注册：${e && e.message ? e.message : e}`);
    }
    if (skill) {
      await ctx.skill.transform((editor) => editor.add(skill));
    }

    // 3) 需求明确度预检：opencode 没有 Claude 式 hooks/hooks.json，
    //    UserPromptSubmit 对应 ctx.session.hook('prompt')。
    //    结论只能落在 event.prompt.text 上（改动会成为持久化的用户输入），
    //    这正是 additionalContext 的等价物；判定为"明确"时一个字都不加。
    await ctx.session.hook('prompt', async (event) => {
      const text = typeof event.prompt.text === 'string' ? event.prompt.text : '';
      let verdict;
      try {
        verdict = await precheck(text);
      } catch (e) {
        console.error(`[systemone-decision] 预检跳过：${e && e.message ? e.message : e}`);
        return;
      }
      if (verdict) event.prompt.text = `${text}\n\n${verdict}`;
    });
  },
};
