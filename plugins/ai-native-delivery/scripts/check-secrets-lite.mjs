#!/usr/bin/env node
// check-secrets-lite：纯 Node 密钥兜底扫描（判据移植自引擎密钥门降级档；零二进制零网络）
// 动机：CI agent 无外网 / 二进制落不了盘时，密钥门原为 loud-skip——门表看着绿、实际没扫。
//   本脚本零二进制、零网络；check-secrets.mjs 在 gitleaks 不可用时自动接续（GITLEAKS_BIN/PATH/
//   .agents/tools 三级全空），也可 SECRETS_SCAN_LITE=1 或 --lite 强制。
// 规则分两档：
//   ① 强特征（前缀/私钥块/JWT/连接串口令）：所有文件执法，误报极低；**基线豁免不适用**——
//      强特征一旦命中即是真凭证形态，不因文件在基线清单而放行。
//   ② 宽泛 key=value（generic-api-key 同类）与连接串口令：只对「基线豁免清单之外」的文件执法，
//      且要求值含数字/符号、熵达标、非代码表达式续写。
// 豁免口径（与 gitleaks 基线同源）：.gitleaks-baseline.json 出现过的文件按**文件级**豁免
//   （存量命中的值在基线内已 redact，无法按值匹配）。基线是使用项目自有资产：从扫描根读取、
//   不随插件分发；本项目无存量豁免时用 `[]`（空豁免清单）起步即可执法。
//   代价（明示）：基线文件内**新增**的弱特征密钥会漏，由可装机环境的 gitleaks 全量补。
// 基线缺失 = exit 2（无豁免清单则全树必爆红，与 gitleaks detect 同口径 fail-closed）。
// 行内豁免：同行含 `gitleaks:allow` 或 `secrets-lite:allow` 即跳过（与 gitleaks 同形）。
// 用法：node <插件根>/scripts/check-secrets-lite.mjs [--root <扫描根>] [--staged | --range <a>..<b>] [--json]
//   根解析优先级：--root 参数 → 调用方显式传入（wrapper 接续）→ CHECK_SECRETS_ROOT → 项目 git 根 → cwd
//   --staged 只扫暂存区新增行；--range 只扫给定范围新增行；缺省 = 全部 git 跟踪文件
// 退出码：0 无泄漏；1 发现泄漏；2 配置/参数失守
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnGit } from './git-core.mjs';
import { findProjectRoot } from './paths.mjs';

const argOf = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

// 根解析（不锚插件目录——密钥扫描的目标根必须可传：插件安装目录跨项目共享，扫它毫无意义）
const defaultRoot = (argv = []) =>
  argOf(argv, '--root') || process.env.CHECK_SECRETS_ROOT || findProjectRoot() || process.cwd();

const STRONG_RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-pat-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'square-access-token', re: /\bsq0atp-[0-9A-Za-z_-]{22}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const GENERIC_RULE = {
  id: 'generic-api-key',
  re: /(?:api[_-]?key|apikey|access[_-]?key|secret|token|passwd|password|pwd|_auth|authorization)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})["']?/i,
};

// 连接串口令：值与形态都强（`Password=xxx`），但载体常与配置文件共存，故与 generic 同档——
// 只对豁免清单外的文件执法。
const CRED_RULE = {
  id: 'connection-string-password',
  // 值限定为「无空白/分号/引号、不含点号与括号」的字面量——含 `.`/`(` 的必是代码表达式（process.env.X 等）
  re: /\b(?:password|pwd)\s*=\s*(?!\*|\$|<|\{)[A-Za-z0-9_\-+/=]{12,}(?![A-Za-z0-9_.])/i,
};

const PLACEHOLDER = /^(?:x{4,}|0{4,}|your|my|example|sample|changeme|placeholder|dummy|fake|redacted|todo|none|null|undefined|test)/i;
const ALLOW_MARK = /(?:gitleaks|secrets-lite):allow/;
const SKIP_PATH = [/^\.git\//, /(?:^|\/)node_modules\//, /^tmp\//, /(?:^|\/)dist\//, /^\.agents\/tools\//];
const MAX_BYTES = 2 * 1024 * 1024;

const entropy = (s) => {
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  let h = 0;
  for (const n of m.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
};

const redact = (s) => (s.length <= 8 ? '***' : `${s.slice(0, 4)}***${s.slice(-2)}`);

// 宽泛规则的残余误报过滤
const weakNoise = (line, m) => {
  const v = m[1];
  if (PLACEHOLDER.test(v)) return true;
  if (entropy(v) < 3.5) return true;
  if (!/\d/.test(v)) return true;                                  // 纯字母 = 标识符 / 常量名
  if (/^[0-9a-f]{8,20}$/i.test(v)) return true;                    // 短 hex = assembly token / GUID 片段
  if ((v.match(/-/g) || []).length >= 3) return true;              // 多连字符 = 描述性短语
  if (/^[A-Za-z0-9_$]/.test(line.slice(m.index + m[0].length))) return true; // 值后续写 = 代码表达式
  return false;
};

// 单行判定 → { rule, secret } 或 null
export const matchLine = (line, { generic }) => {
  if (ALLOW_MARK.test(line)) return null;
  for (const r of STRONG_RULES) {
    const m = r.re.exec(line);
    if (m) return { rule: r.id, secret: redact(m[0]) };
  }
  if (!generic) return null;
  const m = GENERIC_RULE.re.exec(line);
  if (m && !weakNoise(line, m)) return { rule: GENERIC_RULE.id, secret: redact(m[1]) };
  const c = CRED_RULE.re.exec(line);
  if (c) {
    const v = c[0].replace(/^[^=]*=/, '').trim();
    // 口令须含数字或符号（纯大写/驼峰标识符不算）
    if ((/\d/.test(v) || /[^A-Za-z0-9_]/.test(v)) && !PLACEHOLDER.test(v)) {
      return { rule: CRED_RULE.id, secret: redact(v) };
    }
  }
  return null;
};

export const loadBaselineFiles = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (e && typeof e.File === 'string') set.add(e.File.replace(/\\/g, '/'));
  }
  return set;
};

const isExempt = (file, baselineFiles) => baselineFiles.has(file);
const skipped = (p) => SKIP_PATH.some((re) => re.test(p));

const readIfText = (abs) => {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return null; // 二进制
    return buf.toString('utf8');
  } catch { return null; }
};

const scanText = (file, text, baselineFiles, hits) => {
  const generic = !isExempt(file, baselineFiles);
  let ln = 0;
  for (const line of text.split(/\r?\n/)) {
    ln += 1;
    const hit = matchLine(line, { generic });
    if (hit) hits.push({ file, line: ln, rule: hit.rule, secret: hit.secret });
  }
};

const scanWorkingTree = (root, baselineFiles) => {
  // 根必须就是 git 顶层：扫描根指到子目录时 git 会回上层仓库，路径全 stat 失败 →
  // scanned=0 的假绿。此处 fail-loud（下面对 scanned=0 也再兜一层）。
  const top = spawnGit(['rev-parse', '--show-toplevel'], root);
  if (top.error || top.status !== 0) throw new Error(`git rev-parse --show-toplevel 失败（${root} 不是 git 工作区？）：${top.stderr || top.status || top.error?.code}`);
  const topPath = path.resolve(String(top.stdout || '').trim());
  if (topPath !== path.resolve(root)) throw new Error(`扫描根 ${root} 不是 git 顶层（顶层为 ${topPath}）——拒跑，避免扫空目录假绿`);
  const r = spawnGit(['ls-files', '-z'], root);
  if (r.status !== 0) throw new Error(`git ls-files 失败：${r.stderr || r.status}`);
  const files = String(r.stdout || '').split('\0').map((s) => s.replace(/\\/g, '/')).filter(Boolean);
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (skipped(f)) continue;
    const text = readIfText(path.join(root, f));
    if (text === null) continue;
    scanned += 1;
    scanText(f, text, baselineFiles, hits);
  }
  return { hits, scanned, unit: '文件' };
};

// 增量：只判 git diff 的新增行（-U0 下无上下文行，行号取新侧）
const scanDiff = (root, range, baselineFiles) => {
  const args = range === 'staged' ? ['diff', '--cached', '-U0', '--no-color'] : ['diff', '-U0', '--no-color', range];
  const r = spawnGit(args, root);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.status}`);
  const hits = [];
  let file = null;
  let ln = 0;
  let scanned = 0;
  for (const raw of String(r.stdout || '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { ln = Number(hunk[1]); continue; }
    if (!file || !raw.startsWith('+')) continue;
    const line = raw.slice(1);
    if (!skipped(file)) {
      scanned += 1;
      const hit = matchLine(line, { generic: !isExempt(file, baselineFiles) });
      if (hit) hits.push({ file, line: ln, rule: hit.rule, secret: hit.secret });
    }
    ln += 1;
  }
  return { hits, scanned, unit: '新增行' };
};

export const scan = ({ root, mode = 'all', range = null, baseline } = {}) => {
  const baselinePath = baseline || path.join(root, '.gitleaks-baseline.json');
  if (!fs.existsSync(baselinePath)) {
    const err = new Error(`基线缺失 ${baselinePath}——无豁免清单则全树必爆红，拒跑（重建：gitleaks detect --redact 全量报告存为该文件；无存量项目用 [] 起步）`);
    err.code = 'NO_BASELINE';
    throw err;
  }
  const baselineFiles = loadBaselineFiles(baselinePath);
  const res = mode === 'staged' ? scanDiff(root, 'staged', baselineFiles)
    : mode === 'range' ? scanDiff(root, range, baselineFiles)
      : scanWorkingTree(root, baselineFiles);
  return { ...res, baselineFiles: baselineFiles.size };
};

export const main = (argv = process.argv.slice(2), root = defaultRoot(argv)) => {
  const cliRoot = argOf(argv, '--root');
  if (cliRoot) root = path.resolve(cliRoot);
  const rangeIdx = argv.indexOf('--range');
  const range = rangeIdx >= 0 ? argv[rangeIdx + 1] : null;
  const mode = argv.includes('--staged') ? 'staged' : range ? 'range' : 'all';
  if (mode === 'range' && (!range || range.startsWith('-'))) {
    console.error('[secrets-lite] ❌ --range 需要一个范围参数（<a>..<b>）');
    return 2;
  }
  let res;
  try {
    res = scan({ root, mode, range });
  } catch (e) {
    console.error(`[secrets-lite] ❌ ${e.message}`);
    return 2;
  }
  if (argv.includes('--json')) console.log(JSON.stringify(res.hits, null, 1));
  const scopeNote = mode === 'all' ? '工作树全量' : mode === 'staged' ? '暂存增量' : `增量 ${range}`;
  if (mode === 'all' && res.scanned === 0) {
    console.error(`[secrets-lite] ❌ 扫描面为 0 ${res.unit}（根 ${root}）——空扫不算通过，按配置失守拒跑`);
    return 2;
  }
  if (res.hits.length) {
    for (const h of res.hits.slice(0, 50)) console.error(`[secrets-lite] ❌ ${h.file}:${h.line} ${h.rule} ${h.secret}`);
    if (res.hits.length > 50) console.error(`[secrets-lite] …共 ${res.hits.length} 处，仅列前 50`);
    console.error(`[secrets-lite] ❌ 发现 ${res.hits.length} 处疑似密钥（${scopeNote}｜${res.scanned} ${res.unit}）——删除该密钥或作废轮换；确属误报则同行加 secrets-lite:allow`);
    return 1;
  }
  console.log(`[secrets-lite] ✅ 无泄漏（${scopeNote}｜${res.scanned} ${res.unit}｜基线豁免文件 ${res.baselineFiles}）`);
  return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
