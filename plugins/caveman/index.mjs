// opencode 插件入口：把 caveman 的 7 个 skill 与模式管理 hook 注册进 opencode。
// 业务逻辑不在这里——prompt hook 直接 spawn hooks/opencode/user-prompt.js，
// 与 ZCode / CodeBuddy / MiniMax 跑同一份脚本（同一条模式解析、/caveman 指令、
// per-turn reinforcement 路径），本文件只做接线。
//
// 能力边界（opencode 没有 Claude 式 hooks.json，能接的等价物只有 prompt 一处）：
//   - skills ×7：ctx.skill.transform 逐个注册
//   - UserPromptSubmit 等价物：ctx.session.hook('prompt')，子进程喂 {prompt}
//   - /caveman 系列指令：opencode 无法注册斜杠命令，但 hook 在 prompt 文本层
//     拦截，输入 "/caveman ultra" 效果等同
//   - 空输入拦截与 /caveman-stats 的 continue:false：opencode 的 prompt hook
//     只能追加文本、不能拦截，body 会作为上下文追加
//   - SessionStart / PreToolUse / Stop / token 统计：opencode 侧不接——
//     per-turn reinforcement 已保证模式在场，统计依赖的工具事件未接线
//
// 刻意不 import @opencode/plugin：默认导出裸对象 { id, setup } 与 Plugin.define()
// 形状一致，保持零依赖（与 plugins/systemone-decision/index.mjs 同一约定）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(ROOT, 'hooks', 'opencode', 'user-prompt.js');
const SKILLS_DIR = path.join(ROOT, 'skills');

const SKILL_IDS = [
  'caveman', 'caveman-commit', 'caveman-compress', 'caveman-help',
  'caveman-review', 'caveman-stats', 'cavecrew',
];

// caveman 技能的 description 用 YAML 折叠标量（`>` 后跟缩进续行），
// 逐行收集拼接；单行标量直接取值。
function frontmatterField(front, key) {
  if (!front) return '';
  const lines = front.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:[ \\t]*(.*)$`).test(l));
  if (start < 0) return '';
  const value = lines[start].match(new RegExp(`^${key}:[ \\t]*(.*)$`))[1].trim();
  if (!['>', '>-', '|', '|-'].includes(value)) return value;
  const parts = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s+\S/.test(lines[i])) parts.push(lines[i].trim());
    else break;
  }
  return parts.join(' ');
}

function loadSkill(id) {
  const file = path.join(SKILLS_DIR, id, 'SKILL.md');
  const raw = readFileSync(file, 'utf8');
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return {
    id,
    name: frontmatterField(front?.[1], 'name') || id,
    description: frontmatterField(front?.[1], 'description'),
    path: file,
    // content 是「去掉 frontmatter 的正文」——opencode 加载 skill 时正文与 frontmatter 分开处理
    content: front ? raw.slice(front[0].length) : raw,
  };
}

// spawn 同一份 user-prompt.js（stdin JSON → stdout JSON）。任何失败都 fail-open：
// 返回 null，prompt 原样通过，绝不阻塞用户输入。
function runHook(prompt) {
  return new Promise((resolve) => {
    execFile(process.execPath, [HOOK], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        resolve(JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? null);
      } catch {
        resolve(null);
      }
    }).stdin?.end(JSON.stringify({ prompt }));
  });
}

export default {
  id: 'caveman',
  async setup(ctx) {
    // 1) skills：7 个一起注册，单个文件读失败只跳过自己
    const skills = [];
    for (const id of SKILL_IDS) {
      try {
        skills.push(loadSkill(id));
      } catch (e) {
        console.error(`[caveman] 跳过 skill ${id}：${e && e.message ? e.message : e}`);
      }
    }
    if (skills.length) {
      await ctx.skill.transform((editor) => {
        for (const s of skills) editor.add(s);
      });
    }

    // 2) 模式管理 hook：opencode 只能追加 prompt 文本（等价 additionalContext）；
    //    判定为无强化时一个字都不加。少于 3 字符的输入直接放行（与 hook 内的
    //    空输入拦截同阈值，避免无谓的子进程开销）。
    await ctx.session.hook('prompt', async (event) => {
      const text = typeof event.prompt.text === 'string' ? event.prompt.text : '';
      if (text.trim().length < 3) return;
      const context = await runHook(text.trim());
      if (context) event.prompt.text = `${text}\n\n${context}`;
    });
  },
};
