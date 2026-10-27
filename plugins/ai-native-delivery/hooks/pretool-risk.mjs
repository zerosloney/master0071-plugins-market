#!/usr/bin/env node
// pretool-risk.mjs — PreToolUse hook：shell 类命令风险闸，deny / ask / allow 三清单静态匹配
//（设计文档 §3.2 L-hook 层。接线照本仓 systemone-decision/hooks/pretool-risk.mjs 的宿主协议；
// 与其「判定模型三问」不同，本闸是确定性清单匹配——无网络、无模型、零依赖，15s 超时绰绰有余）。
// 契约（严格照 systemone hook 的宿主协议）：
//   stdin = hook JSON（取 tool_name / tool_input 字段）；
//   deny → stdout 输出 hookSpecificOutput.permissionDecision='deny'（宿主阻断），exit 0；
//   ask  → 同格式 permissionDecision='ask'（宿主向用户确认），exit 0；
//   allow / 非 shell 工具 / 取不到命令 → 静默 exit 0；
//   settings.json 损坏 → fail-open：放行 + stderr WARN（配置问题绝不卡死用户）；
//   任何异常 → stderr 后 exit 0，绝不阻塞工具调用。
// 清单单源：项目侧 .agents/settings.json（permissions.deny/ask/allow，§5.2）——缺该文件回退
// 插件内置默认（config-templates/settings.json 种子；再缺则代码内最小 deny 兜底）。
// 匹配语义：deny/ask 用子串命中（链式 `x && git push -f` 也拦）；allow 用前缀命中（防
// 「git add」白名单放行「git add-remote …」这类意外前缀）。deny > ask > allow 优先级裁决。
// 测试：node test/hook.test.mjs（deny 阻断 / 普通放行 / 损坏 fail-open / 项目侧清单单源）
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, PLUGIN_CONFIG_TEMPLATES_DIR } from '../scripts/paths.mjs';

const STDIN_MAX_CHARS = 100_000; // 与 systemone hook-io 同上限：截断即转 ask（fail-closed）

// 只对 shell 类工具生效（与 systemone risk-gate 同一正则——宿主对终端类工具的常见命名全覆盖）
const SHELL_TOOL = /(^|[_\-.])(bash|shell|terminal|command|cmd|exec|process|run|powershell|pwsh|zsh|fish)([_\-.]|$)/i;

// 代码内最小兜底（插件种子 settings.json 也缺失时的最后防线——deny 面永不因缺文件变空）
const BUILTIN = {
  deny: ['git reset --hard', 'git push --force', 'git push -f', 'drop database'],
  ask: ['git checkout', 'git clean', 'git branch -D', 'rm -rf'],
  allow: [],
};

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

function matchList(command, rules, { prefix = false } = {}) {
  const c = norm(command);
  for (const rule of rules || []) {
    const r = norm(rule);
    if (!r) continue;
    if (prefix ? (c === r || c.startsWith(`${r} `)) : c.includes(r)) return rule;
  }
  return null;
}

// 清单加载：项目侧 .agents/settings.json 优先（清单单源），缺文件回退插件种子，再缺代码兜底。
// 「损坏」仅指文件在场但不可解析 / permissions 形状非法——fail-open 放行并标 broken（调用方 WARN）。
function loadLists(root) {
  const candidates = [
    ...(root ? [path.join(root, '.agents', 'settings.json')] : []),
    path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      return { broken: file };
    }
    const p = parsed && typeof parsed === 'object' ? parsed.permissions : null;
    if (!p || typeof p !== 'object') return { broken: file };
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
    return { deny: arr(p.deny), ask: arr(p.ask), allow: arr(p.allow), source: file };
  }
  return { ...BUILTIN, source: 'builtin-default' };
}

function commandOf(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const raw = input.command ?? input.cmd ?? input.script ?? input.execution_input;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (truncated) return;
      raw += c;
      if (raw.length >= STDIN_MAX_CHARS) {
        truncated = true;
        raw = raw.slice(0, STDIN_MAX_CHARS);
        process.stdin.destroy(); // destroy() 只触发 close：超大残流立即收尾
      }
    });
    process.stdin.once('end', () => resolve({ raw, truncated }));
    process.stdin.once('close', () => resolve({ raw, truncated }));
    process.stdin.once('error', () => resolve({ raw, truncated }));
  });
}

async function main() {
  const { raw, truncated } = await readStdin();
  let input = {};
  if (!truncated) {
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const command = commandOf(input.tool_input);
  // 管辖外（非 shell 工具）与截断/读不出命令的走向：
  //   非 shell 工具 → 静默放行；shell 工具但输入截断（命令不可信，尾巴里可藏破坏性命令）→ fail-closed 转 ask
  if (!SHELL_TOOL.test(toolName)) return null;
  if (truncated || command === null) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: '[ai-native-delivery 风险闸] hook 输入不完整（截断或缺 command 字段），无法做清单匹配——请向用户展示命令并确认后再执行。',
      },
    };
  }

  const root = findProjectRoot();
  const lists = loadLists(root);
  if (lists.broken) {
    process.stderr.write(`[ai-native-delivery hook] settings.json 损坏（${lists.broken}）——fail-open 放行本条命令；请修复该文件后风险闸自动恢复\n`);
    return null;
  }

  const denyHit = matchList(command, lists.deny);
  if (denyHit) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[ai-native-delivery 风险闸] 命中 deny 清单「${denyHit}」（单源 ${lists.source}）——高风险/破坏性命令已阻断；如确需执行请由用户手动运行。`,
      },
    };
  }
  const askHit = matchList(command, lists.ask);
  if (askHit) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `[ai-native-delivery 风险闸] 命中 ask 清单「${askHit}」（单源 ${lists.source}）——有一定风险，请先向用户确认再执行。`,
      },
    };
  }
  if (matchList(command, lists.allow, { prefix: true })) return null; // allow：静默放行，零噪音
  return null; // 清单外：静默放行（清单闸只拦已知风险，不做语义猜测）
}

main()
  .then((out) => {
    const text = out ? JSON.stringify(out) : '';
    if (!text || process.stdout.write(text)) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
  })
  .catch((e) => {
    process.stderr.write(`[ai-native-delivery hook] 风险闸跳过：${e && e.message ? e.message : e}\n`);
    process.exit(0);
  });
