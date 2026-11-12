#!/usr/bin/env node
// pre-write-guard.mjs — PreToolUse 写前门（2026-11-12 机制同步；源 bb0478473 pre-write-check.cjs
// 判据级适配：只搬两组判据，不搬源仓的红线快照复用层与 --unlock 通道——本插件自建结构）。
// 写文件瞬间**前**拦截，两组判据（顺序短路）：
//   1) 执法面自保护（deny）：Write/Edit 目标落在使用项目的 .agents/（门禁脚本 / 配置 / hook 本体 /
//      安装台账等治理状态）→ 拒——AI 不得自行解掉自己的拴绳。例外（可写面，口径单源）：
//      scripts/install/plan.mjs 的 RUNTIME_DIRS（cache/loop/notes/board/tmp——init-engine 落什么
//      运行时目录，本门就放什么目录）。
//   2) 三本审计账 append-only（deny）：.agents/confirmations.jsonl / judgments.jsonl /
//      verifications.jsonl 只许追加式写——新内容 = 旧内容（工作区现值）前缀才放行；整写 / 删改拒。
//      分片 confirmations.d/* 不在追例外：分片写走 confirm-doc / ledger-shards（Bash 面），直编即拒。
// 协议（与 hooks/pretool-risk.mjs 同款宿主协议）：
//   stdin = hook JSON（tool_name / tool_input）；permit → 静默 exit 0；
//   deny / ask → stdout 输出 hookSpecificOutput.permissionDecision 决策体，exit 0；
//   tool_input.file_path 缺失（无可识别路径字段）→ fail-closed 转 ask（写目标不可判定）；
//   输入截断 / 坏 JSON / 空 stdin / 非对象 JSON → fail-closed 转 ask（与 pretool-risk 同向）；
//   项目根解析不出 → fail-closed 转 ask（执法面定位不了，不能静默放行）；
//   任何内部异常 → stderr 留痕 + 转 ask（绝不静默放行，也绝不硬阻塞）。
// 管辖口径：matcher 决定本 hook 会不会被调到，本内核决定调到了之后管不管（同 pretool-risk 纪律，
//   名单单源 WRITE_TOOL_NAMES，test/hook.test.mjs ⑧ 机器对账）。两个收窄豁免：
//   mcp__* 工具不经本门（MCP 工具不携带 file_path，写盘在服务进程内、由台账工具口径与 git 钩子兜底）；
//   todo 类速记工具（TodoWrite）不归本门（非项目文件面）。
// 已知边界（沿源定性）：Bash 重定向 / sed 写文件不经本门（走 shell 风险闸与 git 钩子兜底）；
//   omp 宿主无 PreToolUse 面，git hooks 层兜底。
// 测试：node test/pre-write-guard.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, ENGINE_DIR_REL } from '../scripts/paths.mjs';
import { RUNTIME_DIRS } from '../scripts/install/plan.mjs';

const STDIN_MAX_CHARS = 100_000; // 与 pretool-risk 同上限：截断即转 ask（fail-closed）

// 写工具名单单源：hooks.json matcher / .codex 垫片（gen-host-manifests 渲染）与本内核都从它
// 机器对账。zcode/codex 写工具命名对齐：write / edit / multiedit / notebookedit（zcode 系）、
// update（部分宿主的文件更新工具名）、apply_patch / applypatch（codex 系补丁形态）。
const WRITE_TOOL_NAMES = ['write', 'edit', 'multiedit', 'notebookedit', 'update', 'apply_patch', 'applypatch'];
const WRITE_TOOL = new RegExp(`(^|[_\\-.\\s])(?:${WRITE_TOOL_NAMES.join('|')})([_\\-.\\s]|$)`, 'i');
// 词尾形态：关键词作为整个工具名的词尾（前面是字母前缀），如 myedit / rewrite。方向安全（多拦
// 多问一次），与 pretool-risk 的 SHELL_TOOL_TAIL 同性质。
const WRITE_TOOL_TAIL = new RegExp(`[a-z](?:${WRITE_TOOL_NAMES.join('|')})$`, 'i');
// matcher 命中的近似判定代理：内核不知道宿主的 matcher 长什么样，用「名字含关键词子串」找
// 「matcher 命中但内核不认」的形态，stderr 一行告警让缺口可见（pretool-risk 同款兜底）。
const WRITE_TOOL_SUBSTRING = new RegExp(`(?:${WRITE_TOOL_NAMES.join('|')})`, 'i');

const normalizeToolName = (toolName) => String(toolName).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
const applies = (toolName) => {
  if (typeof toolName !== 'string') return false;
  const normalized = normalizeToolName(toolName);
  return (
    WRITE_TOOL.test(toolName) ||
    WRITE_TOOL.test(normalized) ||
    WRITE_TOOL_TAIL.test(toolName) ||
    WRITE_TOOL_TAIL.test(normalized)
  );
};

// 三本审计账（追加式写例外面）：项目侧 .agents/ 直下的三个 jsonl。
const LEDGER_NAMES = ['confirmations.jsonl', 'judgments.jsonl', 'verifications.jsonl'];

// 从写工具入参合成「提议内容」（判据沿源）：整写键直取；Edit 形态 old_string/new_string（含
// replace_all）与 edits 数组在现文件内容上合成。合成不了返回 null（调用方 fail-closed 转 ask）。
function synthesize(input, absPath) {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['content', 'new_content', 'file_text']) {
    if (typeof input[k] === 'string') return input[k];
  }
  const applyOne = (text, oldS, newS, all) => {
    if (typeof oldS !== 'string' || typeof newS !== 'string' || oldS === '') return null;
    if (!text.includes(oldS)) return null;
    return all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  };
  let cur;
  try { cur = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  if (typeof input.old_string === 'string') {
    return applyOne(cur, input.old_string, input.new_string || '', input.replace_all === true);
  }
  if (Array.isArray(input.edits)) {
    let text = cur;
    for (const e of input.edits) {
      const next = applyOne(text, e && e.old_string, (e && e.new_string) || '', e && e.replace_all === true);
      if (next === null) return null;
      text = next;
    }
    return text;
  }
  return null;
}

// file_path 提取（file_path 主字段；宿主变体别名沿源兼容——notebookedit 用 notebook_path）。
function extractFilePath(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'target_file', 'file']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  return '';
}

const denyDecision = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});
const askDecision = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  },
});

// 决策体输出（与 pretool-risk 的 writeAndExit 同款：drain/error 竞速，EPIPE 静默 exit 0）。
const writeAndExit = (text, onExit = () => process.exit(0)) => {
  if (!text || process.stdout.write(text)) onExit();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    process.stdout.removeListener('error', onError);
    onExit();
  };
  const onError = (err) => {
    if (settled) return;
    settled = true;
    process.stdout.removeListener('drain', finish);
    if (err && err.code === 'EPIPE') process.exit(0);
    process.stderr.write(`[ai-native-delivery hook] stdout 写入失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  };
  process.stdout.once('drain', finish);
  process.stdout.once('error', onError);
};

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
        process.stdin.destroy();
      }
    });
    process.stdin.once('end', () => resolve({ raw, truncated }));
    process.stdin.once('close', () => resolve({ raw, truncated }));
    process.stdin.once('error', () => resolve({ raw, truncated }));
  });
}

// stdin 本地 deadline（pretool-risk 同款口径）：挂起 = 无决策体 = 静默放行，而 stdin 到得慢恰是
// 输入最不可信的那次。触发时先送 ask 决策体再退。AI_NATIVE_HOOK_KILLER_MS 为测试注入口。
const HOOK_BUDGET_MS = 14_000;
const stdinKillerMs = () => {
  const raw = Number(process.env.AI_NATIVE_HOOK_KILLER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : HOOK_BUDGET_MS;
};
const stdinKiller = () => {
  const text = JSON.stringify(
    askDecision('[ai-native-delivery 写前门] hook 输入读取超时（stdin 未在共享预算内完成）——写目标不可判定，请向用户确认后再执行。'),
  );
  const diagThenExit = () => {
    process.stderr.write('[ai-native-delivery hook] stdin 未在共享预算内完成读取，兜底输出 ask 转人工\n');
    process.exit(0);
  };
  writeAndExit(text, diagThenExit);
};

async function main() {
  const killer = setTimeout(stdinKiller, stdinKillerMs());
  let raw;
  let truncated;
  try {
    ({ raw, truncated } = await readStdin());
  } finally {
    clearTimeout(killer);
  }
  let input = {};
  let jsonBroken = false;
  const emptyInput = !truncated && raw.trim() === '';
  if (!truncated && !emptyInput) {
    try { input = JSON.parse(raw); } catch { input = {}; jsonBroken = true; }
  }
  const notAnObject = input === null || typeof input !== 'object' || Array.isArray(input);
  // 输入不可信（截断 / 坏 JSON / 空 / 非对象）→ fail-closed 转 ask（与 pretool-risk 同向同理由）。
  if (truncated || jsonBroken || emptyInput || notAnObject) {
    const why = truncated ? '输入截断' : emptyInput ? 'hook 输入为空' : 'hook 输入不是合法 JSON';
    return askDecision(`[ai-native-delivery 写前门] ${notAnObject ? 'hook 输入不是合法的工具调用对象' : `hook 输入不完整（${why}）`}——写目标不可判定，请向用户确认后再执行。`);
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  // MCP 工具不经本门：调用名以 mcp__ 开头（不携带 file_path，写盘在服务进程内——台账口径与
  // git 钩子兜底）。收窄豁免放最前，防 update_ledger 这类名字经 'update' 词族误入管辖。
  if (/^mcp__/i.test(toolName)) return null;
  if (/^(?:todo[_ ]?write)$/i.test(toolName)) return null; // 速记面：todo 列表非项目文件
  if (!applies(toolName)) {
    if (WRITE_TOOL_SUBSTRING.test(toolName)) {
      process.stderr.write(
        `[ai-native-delivery hook] 工具 "${toolName}" 命中写前门 matcher 但内核不认（非写工具管辖形态），已静默放行；若是写类工具请反馈\n`,
      );
    }
    return null;
  }
  const fp = extractFilePath(input.tool_input);
  if (!fp) {
    return askDecision('[ai-native-delivery 写前门] hook 输入不完整（无可识别的 file_path 字段）——写目标不可判定（fail-closed），请向用户展示目标路径并确认后再执行。');
  }
  // 测试注入口（pretool-risk 惯例）：内部故障路径的转 ask 行为由此开关锁住，生产不设。
  if (process.env.AI_NATIVE_HOOK_FAULT_INJECT === '1') {
    throw new Error('fault injection (test only)');
  }
  const root = findProjectRoot();
  if (root === null) {
    return askDecision('[ai-native-delivery 写前门] 未解析到项目根（非 git 仓库或 git 不可用）——执法面无法定位（fail-closed），请向用户确认写目标后再执行。');
  }
  const abs = path.resolve(root, fp);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 仓外文件不管（沿源口径）

  // ② 三本审计账 append-only（先于执法面判定——三个账本是 .agents/ 直下、非运行时目录的追例外）。
  // LEDGER_NAMES 是 .agents/ 直下的裸名（口径同 paths.ENGINE_DIR_REL），而 rel 是含 .agents/ 前缀的
  // 整段路径——按裸名 includes(rel) 永远对不上，追例外整段死码、台账追加被执法面误拒（前缀切片后比对）。
  const underAgents = rel.startsWith(`${ENGINE_DIR_REL}/`) ? rel.slice(ENGINE_DIR_REL.length + 1) : null;
  if (underAgents !== null && LEDGER_NAMES.includes(underAgents)) {
    const proposed = synthesize(input.tool_input, abs);
    if (proposed === null) {
      return askDecision(`[ai-native-delivery 写前门] ${rel} 是审计账（append-only），本次写入内容无法合成核验（Edit 目标串不在现文件 / 字段缺失）——请改走 confirm-doc / judgment-ledger 等台账工具（fail-closed 转人工）。`);
    }
    let cur = null;
    try { cur = fs.readFileSync(abs, 'utf8'); } catch { /* 缺文件 = 首次追加，放行 */ }
    if (cur !== null && !proposed.startsWith(cur)) {
      return denyDecision(`[ai-native-delivery 写前门] ${rel} 是审计账，只允许追加式写（append-only）：本次写入不是现文件的前缀扩展（整写/删改历史行）——请改走 confirm-doc / judgment-ledger / verify 等台账工具落账，不直接编辑。`);
    }
    return null; // 追加（含新建）放行
  }

  // ① 执法面自保护：.agents/ 直下与子路径，运行时目录（RUNTIME_DIRS 单源）之外一律拒。
  if (rel === ENGINE_DIR_REL || rel.startsWith(`${ENGINE_DIR_REL}/`)) {
    const under = rel.slice(ENGINE_DIR_REL.length + 1);
    const top = under.split('/')[0];
    if (!RUNTIME_DIRS.includes(top)) {
      return denyDecision(`[ai-native-delivery 写前门] 执法面自保护：${rel} 是门禁脚本/配置/钩子/治理状态（.agents/ 下仅 ${RUNTIME_DIRS.join('/')} 运行时目录可写）——AI 不得自行改写门禁面。如系用户明示的引擎变更，请由用户手动修改或经安装器（init-engine）落盘。`);
    }
    return null; // 运行时目录（cache/loop/notes/board/tmp）可写
  }
  return null; // 非管辖路径（workflow/ 台账正文、业务代码等）：静默放行，git 钩子与流程门兜底
}

// CLI 门（isMain 前置，对齐 pretool-risk）：被测试 import 纯函数时不拉起 stdin 读取。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((out) => {
      writeAndExit(out ? JSON.stringify(out) : '');
    })
    .catch((e) => {
      const msg = e && e.message ? e.message : String(e);
      process.stderr.write(`[ai-native-delivery hook] 写前门内部故障，转 ask 由用户确认：${msg}\n`);
      writeAndExit(JSON.stringify(
        askDecision(`[ai-native-delivery 写前门] hook 内部故障（${msg}）——写目标未经判据核验（fail-closed），请向用户展示目标路径并确认后再执行。`),
      ));
    });
}
