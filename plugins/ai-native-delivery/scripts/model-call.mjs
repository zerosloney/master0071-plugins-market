#!/usr/bin/env node
// model-call.mjs — 无交互模型调用单源适配器（claude -p print 形态；opt-in 项目自治面）
// 定位：所有「带模型的 opt-in 面」（首个消费方：dream-verify --model 语义复评；项目自接诊断步同型）
//   共用的模型调用单源——旗标面固定为 runner 的 print 契约：`-p <prompt> --output-format json
//   --allowedTools <csv> --max-turns <N>`；--runner 参数 / MODEL_CALL_RUNNER 环境变量可换 claude
//   兼容 runner（默认 claude）。
// 纪律边界（头注声明）：本模块是 **opt-in 项目自治面**——不接任何门禁 / CI / init 默认路径，
//   门禁与 CI 的零模型零凭据纪律不变（README 的零模型纪律声明指认此单源）；模型 spawn 只允许
//   出现在本文件与 test/eval.mjs。test/eval.mjs 里的同型 runner 手法（win32 垫片 stdin 形态）
//   已验证收敛进本模块，eval.mjs 暂不反向重构（后续工单收编，避免本工单扩散）。
// win32 runner 形态（手法收敛自 test/eval.mjs 已验证实现）：npm 全局垫片是 .cmd，Node 对 .cmd
//   直接 spawn 硬拒（CVE-2024-27980）——显式路径原样采信（.cmd/.bat → shell 形态）；win32 用
//   where.exe 探测 PATH：优先真 .exe 直用（argv 传 prompt），只有 .cmd/.bat 垫片时退 shell 形态
//   且 prompt 走 stdin（多行 prompt 过 cmd.exe 命令行转义会坏）。POSIX 恒 argv 直传。
// 错误形态（不 throw，调用方按 error.kind 分支；ok=false 时 json 恒 null、text 留原始 stdout）：
//   kind:'spawn'    —— runner 不在场（code RUNNER_NOT_FOUND）或 spawn 系统级失败（ENOENT 等）
//   kind:'timeout'  —— 超时（spawnSync ETIMEDOUT / SIGTERM）
//   kind:'non-json' —— runner 跑完但输出不是约定 JSON（print 契约：stdout 整段或尾行可解析出
//                      含 result/is_error 键的对象；附 exit 与 stderr 头供排查）
// 返回：{ ok, json, text, error, durationMs }；ok=true 时 error=null，json 为 runner 输出对象
//   （claude 契约里模型正文在 json.result 字符串；exit 非零但 JSON 可解析也算 ok——是否采信由
//   调用方按 json.is_error 分支）。
// 用法：
//   库面：import { callModel, resolveRunner } from '<插件根>/scripts/model-call.mjs'
//   CLI： node <插件根>/scripts/model-call.mjs --probe [--runner <cmd>]  # 一次最小调用报 ok/fail
//         node <插件根>/scripts/model-call.mjs --help
// 测试：node <插件根>/test/model-call.test.mjs（全 mock runner，不真调模型）
// 零依赖，Node ≥ 18 直接运行。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_RUNNER = 'claude';
const DEFAULT_TIMEOUT_MS = 120000;
export const RUNNER_ENV = 'MODEL_CALL_RUNNER';

// resolveRunner(name)：runner 名/路径 → { path, shell }；null = PATH 找不到可执行体。
// 与 test/eval.mjs 同口径：显式路径（含分隔符 / 已带可执行扩展名）按原样用，不再探测。
export function resolveRunner(name = DEFAULT_RUNNER) {
  if (/[\\/]/.test(name)) return { path: name, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(name) };
  if (process.platform !== 'win32') return { path: name, shell: false };
  const probe = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  const hits = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = hits.find((h) => /\.exe$/i.test(h));
  if (exe && fs.existsSync(exe)) return { path: exe, shell: false };
  const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h));
  if (shim && fs.existsSync(shim)) return { path: shim, shell: true };
  return null;
}

// callModel({...})：单次无交互模型调用。不 throw——一切失败收进 error（见头注错误形态表）。
export function callModel({ prompt, allowedTools = null, maxTurns = 1, timeoutMs = DEFAULT_TIMEOUT_MS, runner, cwd } = {}) {
  const startedAt = Date.now();
  const finish = (r) => ({ durationMs: Date.now() - startedAt, ...r });
  const name = runner || process.env[RUNNER_ENV] || DEFAULT_RUNNER;
  const resolved = resolveRunner(name);
  if (!resolved) {
    return finish({
      ok: false, json: null, text: '',
      error: {
        kind: 'spawn', code: 'RUNNER_NOT_FOUND',
        message: `模型缺席：runner「${name}」在 PATH 找不到可执行体（win32 经 where.exe 探测；显式路径按原样采信）——先装 ${DEFAULT_RUNNER} 或用 --runner / ${RUNNER_ENV} 指定`,
      },
    });
  }
  const csv = Array.isArray(allowedTools) ? allowedTools.join(',') : String(allowedTools || '');
  let r;
  if (resolved.shell) {
    // win32 .cmd/.bat 垫片：prompt 走 stdin（-p 无值），避开 cmd.exe 命令行转义
    const cmd = `"${resolved.path}" -p --output-format json${csv ? ` --allowedTools "${csv}"` : ''} --max-turns ${maxTurns}`;
    r = spawnSync(cmd, { cwd, input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER, shell: true, windowsHide: true });
  } else {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (csv) args.push('--allowedTools', csv);
    args.push('--max-turns', String(maxTurns));
    r = spawnSync(resolved.path, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true });
  }
  const stdout = r.stdout || '';
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
  if (timedOut) {
    return finish({ ok: false, json: null, text: stdout, error: { kind: 'timeout', code: 'ETIMEDOUT', message: `模型调用超时（>${timeoutMs}ms）——runner ${name}` } });
  }
  if (r.error) {
    return finish({ ok: false, json: null, text: stdout, error: { kind: 'spawn', code: r.error.code || 'SPAWN_FAILED', message: `runner spawn 失败：${r.error.message}` } });
  }
  // print 契约解析：整段 stdout 是一个 JSON 对象；容错从尾行向前找可解析对象（eval.mjs 同手法）
  let json = tryContract(stdout);
  if (!json) {
    for (const line of stdout.split(/\r?\n/).reverse()) {
      json = tryContract(line);
      if (json) break;
    }
  }
  if (json) return finish({ ok: true, json, text: stdout, error: null });
  return finish({
    ok: false, json: null, text: stdout,
    error: {
      kind: 'non-json', code: `EXIT_${r.status ?? '?'}`,
      message: `runner 输出非约定 JSON（exit ${r.status}${r.stderr ? `；stderr 头: ${String(r.stderr).trim().slice(0, 200)}` : ''}；stdout 头: ${stdout.trim().slice(0, 200)}）`,
    },
  });
}

// tryContract(s)：print 契约判定——对象且含 result/is_error 键之一（claude json 输出形态）
const tryContract = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && ('result' in v || 'is_error' in v) ? v : null;
  } catch { return null; }
};

/* ---------- CLI（isMain 门：--probe 连通自检 / --help；库面 import 时本段不执行） ---------- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  let probe = false;
  let runnerArg = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--probe') probe = true;
    else if (a === '--runner') runnerArg = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node <插件根>/scripts/model-call.mjs [--probe] [--runner <cmd>]
  --probe          连通自检：一次最小调用报 ok/fail（真实调用模型，opt-in——门禁/CI/init 不接本面）
  --runner <cmd>   runner 可执行名或路径（默认 ${DEFAULT_RUNNER}；或环境变量 ${RUNNER_ENV}）
库面：callModel({prompt, allowedTools, maxTurns, timeoutMs, runner, cwd}) → {ok, json|text, error, durationMs}（不 throw，按 error.kind 分支）。
零模型纪律：本模块是 opt-in 项目自治面单源，门禁 / CI / init 默认路径零模型不变。`);
      process.exit(0);
    } else {
      console.error(`未知选项: ${a}`);
      process.exit(2);
    }
  }
  if (!probe) {
    console.error('无操作：模型调用是 opt-in 面，须显式 --probe 才发起（--help 看用法）');
    process.exit(2);
  }
  if (argv.includes('--runner') && !runnerArg) { console.error('--runner 需要可执行名或路径'); process.exit(2); }
  const probePrompt = '这是一次连通性自检（model-call --probe）。只回一个 JSON：{"ok":true}，不要调用任何工具。';
  const r = callModel({ prompt: probePrompt, maxTurns: 1, timeoutMs: 60000, ...(runnerArg ? { runner: runnerArg } : {}) });
  if (r.ok) {
    const body = typeof r.json.result === 'string' ? r.json.result : JSON.stringify(r.json.result);
    console.log(`[probe] ok=true runner=${resolveRunner(runnerArg || process.env[RUNNER_ENV] || DEFAULT_RUNNER)?.path} durationMs=${r.durationMs} is_error=${r.json.is_error ?? '?'} result=${String(body).slice(0, 120)}`);
    process.exit(0);
  }
  console.log(`[probe] ok=false error.kind=${r.error.kind} code=${r.error.code || '-'} durationMs=${r.durationMs}`);
  console.log(`        ${r.error.message}`);
  process.exit(1);
}
