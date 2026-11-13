#!/usr/bin/env node
// eval.mjs — 提示面 eval 套件（无交互 runner：claude -p 驱动夹具任务，确定性终态判据）
// 测的是「提示面」（commands/skills/agents 正文）指挥 agent 行为的达标性——改文案后的行为回归：
//   夹具任务（taskBrief + surface 命令正文剥 frontmatter 整文件注入、<插件根> 实化为插件绝对路径）
//   → mkdtemp 临时 git 仓（e2e-fixture 手法）→ init-engine 落引擎运行时 → 无交互跑
//   → checks 逐条断言终态工件（workflow 档案 / 确认台账 / git 历史 / 引擎配置）。
// 判据哲学：只断言**终态工件**，不判过程合规、不用裁判模型；transcript（claude json 输出 +
//   用例元数据 + checks 明细）落系统临时目录 eval-logs/<id>-<时间戳>.json 留档复盘，不污染仓内。
// 零模型纪律：模型 spawn 只允许出现在本文件（scripts / mcp / hooks 面零命中）——本文件在 test/。
// 用法：node test/eval.mjs [--eval <id>] [--dry-run] [--runner <cmd>] [--bail]
//   --eval E4    单条选跑；--dry-run 只打印各条拼装 prompt 不调模型（免鉴权免 runner）
//   --runner claude   换 runner 可执行名（默认 claude）；--bail 首条 FAIL 即停
// 退出码：0 全 PASS / SKIP；1 有 FAIL；2 runner 不在场（fail-loud；--dry-run 豁免）或用法错。
// SKIP 口径：claude 不在场 / spawn error（如鉴权缺失起不来）→ 该条 SKIP 并提示，不误报 FAIL。
// runner 形态（win32）：npm 全局垫片是 .cmd，Node 对 .cmd 直接 spawn 硬拒（CVE-2024-27980）——
//   where 先找 .exe 直用（argv 传 prompt）；只有 .cmd 垫片时退 shell 形态且 prompt 走 stdin
//   （多行 prompt 过 cmd.exe 命令行转义会坏）。POSIX 恒 argv 直传（claude -p "<prompt>"）。
// 不进仓级 CI：模型调用需凭据，触碰仓级 CI 零凭据纪律（.github/workflows/ci.yml 头注豁免）——
//   本地手动跑，或用 config-templates/ci/github-actions-eval.yml.template（手动触发 + 自备 secrets）。
// 用例集：test/fixtures/eval/cases.json（checks DSL 成文于其 dslDoc 字段）。
// 零依赖，Node ≥ 18 直接运行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const LOGS_DIR = path.join(os.tmpdir(), 'eval-logs');
const PROMPT_TAG = '<插件根>';
// 占位符实化用正斜杠形态：Windows 下命令正文把路径拼进 shell 命令，反斜杠会被 bash 当转义吃掉
const PLUGIN_ROOT_FOR_PROMPT = PLUGIN_ROOT.split(path.sep).join('/');
const GIT_IDENTITY = { email: 'eval@example.invalid', name: 'eval' };
const MAX_BUFFER = 32 * 1024 * 1024;
// 夹具仓基线 README（E1 的 taskBrief 以其中的标语为对象）
const FIXTURE_README = '# eval 夹具仓\n\n标语：快速构建，稳健交付\n';

let pass = 0;
let fail = 0;
let skip = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};
const step = (name) => console.log(`\n---- ${name} ----`);

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const flagOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const DRY_RUN = argv.includes('--dry-run');
const BAIL = argv.includes('--bail');
const RUNNER = flagOf('--runner') || 'claude';
const EVAL_ID = flagOf('--eval');
if (argv.includes('--eval') && !EVAL_ID) {
  console.error('用法错：--eval 需要用例 id（如 --eval E4）');
  process.exit(2);
}

/* ---------- 用例集 ---------- */
const CASES_PATH = path.join(TEST_DIR, 'fixtures', 'eval', 'cases.json');
const CASES_DOC = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const ALL_CASES = Object.values(CASES_DOC.groups).flat();
const cases = EVAL_ID ? ALL_CASES.filter((c) => c.id === EVAL_ID) : ALL_CASES;
if (!cases.length) {
  console.error(`--eval ${EVAL_ID} 无命中（可用：${ALL_CASES.map((c) => c.id).join(', ')}）`);
  process.exit(2);
}

/* ---------- runner 解析 ---------- */
// 返回 { path, shell }；null = PATH 找不到（fail-loud exit 2，--dry-run 豁免）
function resolveRunner(name) {
  // 显式路径（含分隔符 / 已带可执行扩展名）按原样用，不再探测
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
let RUNNER_CMD = null;
let RUNNER_SHELL = false;
if (!DRY_RUN) {
  const resolved = resolveRunner(RUNNER);
  if (!resolved) {
    console.error(`[eval] runner 不在场：${RUNNER} 在 PATH 找不到可执行体——`
      + '先装 claude（npm i -g @anthropic-ai/claude-code，鉴权见 ~/.claude/settings.json）或 --runner 指定。'
      + '（只想审拼装 prompt 用 --dry-run，免 runner 免鉴权）');
    process.exit(2);
  }
  RUNNER_CMD = resolved.path;
  RUNNER_SHELL = resolved.shell;
}

/* ---------- 夹具仓 ---------- */
const git = (args, cwd) => {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${((r.stderr || '') + (r.stdout || '')).slice(0, 300)}`);
  return r;
};
const setupRepo = (tmp) => {
  git(['init', '-q'], tmp);
  git(['config', 'user.email', GIT_IDENTITY.email], tmp);
  git(['config', 'user.name', GIT_IDENTITY.name], tmp);
  fs.writeFileSync(path.join(tmp, 'README.md'), FIXTURE_README, 'utf8');
  git(['add', '-A'], tmp);
  git(['-c', `user.email=${GIT_IDENTITY.email}`, '-c', `user.name=${GIT_IDENTITY.name}`, 'commit', '-qm', 'base'], tmp);
  const init = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'init-engine.mjs'), '--root', tmp],
    { cwd: tmp, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return init;
};

/* ---------- prompt 拼装 ---------- */
const stripFrontmatter = (text) => {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return (m ? text.slice(m[0].length) : text).replace(/^\r?\n+/, '').trimEnd();
};
const buildPrompt = (c) => {
  const body = stripFrontmatter(fs.readFileSync(path.join(PLUGIN_ROOT, c.surface), 'utf8'))
    .split(PROMPT_TAG).join(PLUGIN_ROOT_FOR_PROMPT);
  return `${c.taskBrief}\n\n按以下 playbook 执行：\n\n${body}`;
};

/* ---------- 无交互跑 ---------- */
function runRunner(prompt, c, cwd) {
  const allowedCsv = c.allowedTools.join(',');
  const r = RUNNER_SHELL
    ? spawnSync(`"${RUNNER_CMD}" -p --output-format json --allowedTools "${allowedCsv}" --max-turns ${c.maxTurns}`,
      { cwd, input: prompt, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: MAX_BUFFER, shell: true, windowsHide: true })
    : spawnSync(RUNNER_CMD, ['-p', prompt, '--output-format', 'json', '--allowedTools', allowedCsv, '--max-turns', String(c.maxTurns)],
      { cwd, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true });
  // claude -p --output-format json 整段 stdout 是一个 JSON 对象；容错：从尾行向前找可解析对象
  let json = null;
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && ('result' in v || 'is_error' in v) ? v : null; } catch { return null; } };
  json = tryParse(r.stdout || '');
  if (!json) {
    for (const line of (r.stdout || '').split(/\r?\n/).reverse()) {
      json = tryParse(line);
      if (json) break;
    }
  }
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
  return { raw: r, json, timedOut, spawnError: r.error && !timedOut ? r.error : null, allowedCsv };
}

/* ---------- 终态 checks（确定性算子，DSL 见 cases.json dslDoc） ---------- */
const sha256 = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const listFiles = (root, rel = '', out = []) => {
  let ents;
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { if (!(rel === '' && ent.name === '.git')) listFiles(root, r, out); }
    else if (ent.isFile()) out.push(r);
  }
  return out;
};
const countUnder = (files, dir) => {
  const prefix = dir.replace(/\/+$/, '') + '/';
  return files.filter((f) => f.startsWith(prefix)).length;
};
const expandJsonl = (tmp, entries, nowFiles) => {
  const out = [];
  for (const e of entries) {
    const a = path.join(tmp, e);
    let st = null;
    try { st = fs.statSync(a); } catch { continue; }
    if (st.isDirectory()) out.push(...nowFiles.filter((f) => f.startsWith(e.replace(/\/+$/, '') + '/') && f.endsWith('.jsonl')).map((f) => path.join(tmp, f)));
    else if (st.isFile()) out.push(a);
  }
  return out;
};
const gitText = (args, cwd) => {
  try { return git(args, cwd).stdout || ''; } catch { return ''; }
};

// 返回 { pass, detail }
function runCheck(chk, tmp, baselineFiles, nowFiles) {
  const abs = (p) => path.join(tmp, p);
  const rx = (s, flags) => new RegExp(s, flags || '');
  switch (chk.op) {
    case 'pathExists':
      return { pass: fs.existsSync(abs(chk.path)), detail: `缺: ${chk.path}` };
    case 'pathAbsent':
      return { pass: !fs.existsSync(abs(chk.path)), detail: `不该存在: ${chk.path}` };
    case 'fileContains': {
      const text = readText(abs(chk.path));
      return { pass: text !== null && text.includes(chk.text), detail: text === null ? `缺文件: ${chk.path}` : `未含字面 ${JSON.stringify(chk.text)}` };
    }
    case 'fileMatches': {
      const text = readText(abs(chk.path));
      return { pass: text !== null && rx(chk.regex, chk.flags).test(text), detail: text === null ? `缺文件: ${chk.path}` : `不匹配 /${chk.regex}/${chk.flags || ''}` };
    }
    case 'fileUnchanged': {
      const before = baselineFiles.find((f) => f.rel === chk.path);
      if (!before) return { pass: false, detail: `基线无此文件（setup 后即应存在）: ${chk.path}` };
      const now = readText(abs(chk.path));
      if (now === null) return { pass: false, detail: `文件被删除: ${chk.path}` };
      const nowSha = sha256(abs(chk.path));
      return { pass: nowSha === before.sha, detail: `内容漂移：基线 ${before.sha.slice(0, 12)} → 现在 ${nowSha.slice(0, 12)}` };
    }
    case 'dirFileCountUnchanged':
    case 'dirFileCountGrew': {
      const grew = chk.op === 'dirFileCountGrew';
      const minGrow = grew ? (chk.by === undefined ? 1 : chk.by) : 0;
      for (const p of chk.paths) {
        const before = countUnder(baselineFiles.map((f) => f.rel), p);
        const after = countUnder(nowFiles, p);
        const ok = grew ? after - before >= minGrow : after === before;
        if (!ok) return { pass: false, detail: `${p}: 基线 ${before} → 现在 ${after}（${grew ? `须新增 ≥${minGrow}` : '须不变'}）` };
      }
      return { pass: true, detail: '' };
    }
    case 'newestFileMatches': {
      const inDir = nowFiles.filter((f) => f.startsWith(chk.dir.replace(/\/+$/, '') + '/'));
      if (!inDir.length) return { pass: false, detail: `目录无文件: ${chk.dir}` };
      let newest = null;
      let newestMtime = -1;
      for (const rel of inDir) {
        const m = fs.statSync(path.join(tmp, rel)).mtimeMs;
        if (m > newestMtime) { newestMtime = m; newest = rel; }
      }
      const text = readText(path.join(tmp, newest));
      return { pass: text !== null && rx(chk.regex, chk.flags).test(text), detail: `最新档 ${newest} 不匹配 /${chk.regex}/${chk.flags || ''}` };
    }
    case 'gitLogMatches': {
      const msg = gitText(['log', '-1', '--format=%B'], tmp);
      return { pass: rx(chk.regex, chk.flags).test(msg), detail: `HEAD 消息不含 /${chk.regex}/${chk.flags || ''}：${JSON.stringify(msg.trim().slice(0, 120))}` };
    }
    case 'gitReflogNotMatches': {
      const re = rx(chk.regex, chk.flags);
      const lines = gitText(['reflog', '--all'], tmp).split(/\r?\n/).filter(Boolean);
      const hit = lines.find((l) => re.test(l));
      return { pass: !hit, detail: hit ? `reflog 命中 /${chk.regex}/：${hit.trim().slice(0, 160)}` : '' };
    }
    case 'jsonlMinLines': {
      const files = expandJsonl(tmp, chk.paths, nowFiles);
      const total = files.reduce((n, f) => n + (readText(f) || '').split(/\r?\n/).filter((l) => l.trim()).length, 0);
      return { pass: total >= chk.min, detail: `确认台账非空行合计 ${total}（口径 ≥${chk.min}；扫了 ${files.length} 个 jsonl）` };
    }
    case 'jsonlRowMatches': {
      const re = rx(chk.regex, chk.flags);
      const files = expandJsonl(tmp, chk.paths, nowFiles);
      for (const f of files) {
        const hit = (readText(f) || '').split(/\r?\n/).find((l) => l.trim() && re.test(l));
        if (hit) return { pass: true, detail: '' };
      }
      return { pass: false, detail: `无行匹配 /${chk.regex}/（扫了 ${files.length} 个 jsonl）` };
    }
    default:
      return { pass: false, detail: `未知算子: ${chk.op}` };
  }
}

/* ---------- 主循环 ---------- */
fs.mkdirSync(LOGS_DIR, { recursive: true });
const transcriptPaths = [];

for (const c of cases) {
  step(`${c.id} · ${c.title}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${c.id.toLowerCase()}-`));
  const startedAt = new Date().toISOString();
  let status = 'FAIL';
  const checkRows = [];
  try {
    /* ① 夹具仓：git init + 基线提交 + init-engine（setup 首版仅 init） */
    const initRes = setupRepo(tmp);
    if (initRes.status !== 0) {
      console.log(`SKIP  ${c.id} setup 失败（init-engine exit ${initRes.status}）`);
      console.log(`      ${((initRes.stderr || '') + (initRes.stdout || '')).slice(-300)}`);
      skip++;
      continue;
    }
    // 基线快照（fileUnchanged / dirFileCount* 的对照面）——setup 完成即取
    const baselineFiles = listFiles(tmp).map((rel) => ({ rel, sha: sha256(path.join(tmp, rel)) }));

    /* ② 拼 prompt（taskBrief + playbook 全文注入） */
    const prompt = buildPrompt(c);

    if (DRY_RUN) {
      console.log(`[dry-run] ${c.id} prompt（${prompt.length} 字符；surface=${c.surface}；allowedTools=${c.allowedTools.join(',')}；maxTurns=${c.maxTurns}）`);
      console.log('----- prompt 开始 -----');
      console.log(prompt);
      console.log('----- prompt 结束 -----');
      skip++;
      continue;
    }

    /* ③ 无交互跑 */
    const run = runRunner(prompt, c, tmp);
    if (run.spawnError) {
      console.log(`SKIP  ${c.id} runner spawn 失败（${run.spawnError.code || run.spawnError.message}）——claude 不在场或鉴权不可用，不误报 FAIL`);
      writeTranscript(c, { prompt, startedAt, status: 'SKIP', spawnError: String(run.spawnError), allowedCsv: run.allowedCsv }, checkRows, tmp);
      skip++;
      continue;
    }
    const cj = run.json || {};
    console.log(`[run] exit=${run.raw.status} turns=${cj.num_turns ?? '?'} duration=${cj.duration_ms != null ? `${(cj.duration_ms / 1000).toFixed(1)}s` : '?'} is_error=${cj.is_error ?? '?'}${run.timedOut ? ' [TIMEOUT]' : ''}`);

    /* ④ 终态 checks */
    const nowFiles = listFiles(tmp);
    for (const chk of c.checks) {
      let r;
      try { r = runCheck(chk, tmp, baselineFiles, nowFiles); }
      catch (e) { r = { pass: false, detail: `算子执行异常: ${e.message}` }; }
      checkRows.push({ op: chk.op, desc: chk.desc, pass: r.pass, detail: r.detail });
      check(`[${c.id}] ${chk.desc}`, r.pass, r.detail);
    }
    status = checkRows.every((r) => r.pass) ? 'PASS' : 'FAIL';
    writeTranscript(c, {
      prompt, startedAt, status,
      runner: { cmd: RUNNER_CMD, shell: RUNNER_SHELL, allowedTools: run.allowedCsv, maxTurns: c.maxTurns, timeoutMs: c.timeoutMs },
      exitStatus: run.raw.status, timedOut: run.timedOut,
      claude: run.json
        ? { num_turns: cj.num_turns, duration_ms: cj.duration_ms, is_error: cj.is_error, subtype: cj.subtype, result: cj.result }
        : { stdoutHead: (run.raw.stdout || '').slice(0, 4000), stderrHead: (run.raw.stderr || '').slice(0, 2000) },
    }, checkRows, tmp);
    if (status === 'FAIL' && BAIL) {
      console.log('\n--bail：首条 FAIL，停止后续用例');
      break;
    }
  } catch (e) {
    console.log(`SKIP  ${c.id} 夹具异常：${e.message}`);
    writeTranscript(c, { startedAt, status: 'SKIP', error: e.message }, checkRows, tmp);
    skip++;
  } finally {
    // Windows 下 runner 的残留句柄会短暂锁住夹具仓（EPERM/EBUSY）——带重试清；仍失败只 WARN
    // 不改判（transcript 已留档，残留临时目录无害）
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.log(`[warn] 夹具仓清理失败（残留于系统临时目录，无害）: ${tmp}——${e.code || e.message}`);
    }
  }
}

function writeTranscript(c, meta, checkRows, tmpRepo) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(LOGS_DIR, `${c.id}-${ts}.json`);
  const doc = {
    id: c.id, lane: c.lane, title: c.title, surface: c.surface,
    taskBrief: c.taskBrief,
    tmpRepo: path.basename(tmpRepo),
    ...meta,
    checks: checkRows,
    pluginRoot: PLUGIN_ROOT,
  };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
  transcriptPaths.push(p);
  console.log(`[transcript] ${p}`);
}

/* ---------- 汇总 ---------- */
console.log(`\n合计: PASS ${pass} / FAIL ${fail} / SKIP ${skip}${DRY_RUN ? '（dry-run：只审拼装 prompt，未调模型）' : ''}`);
if (transcriptPaths.length) console.log(`transcripts: ${LOGS_DIR}（${transcriptPaths.length} 份）`);
process.exit(fail ? 1 : 0);
