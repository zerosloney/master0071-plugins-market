#!/usr/bin/env node
// pr-body.mjs — PR 体三件套生成器（2026-11-13 插件原生新增，forge-free）
//
// 把 commands/review.md 既有「PR 体三件套」约定（Summary / Evidence / Merge Danger）变成可执行
// 生成器：从真实 diff 提 Summary、从最近 verify 绿行取 Evidence、从变更面推 Merge Danger。
// 输出 stdout（agent 复制贴任何 forge——GitHub / TFS / 任何形态）；**禁编造**——每节标数据来源，
// 取不到的数据明写「未运行」或「未取得」，不填占位修辞。
//
// 用法：node <插件根>/scripts/pr-body.mjs --base <ref> [--head <ref>] [--root <仓库根>]
// 退出码：0 生成成功；1 git/IO 错误；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

const argv = process.argv.slice(2);
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const BASE = argOf('base');
const HEAD = argOf('head', 'HEAD');
const ROOT = path.resolve(argOf('root') || process.cwd());

if (!BASE) {
  console.error('用法：node pr-body.mjs --base <ref> [--head <ref>] [--root <仓库根>]');
  process.exit(2);
}

const MAX_BUF = 32 * 1024 * 1024;
function git(args, cwd = ROOT) {
  return spawnSync(GIT, args, { cwd, encoding: 'utf-8', maxBuffer: MAX_BUF });
}
function gitOut(args, cwd = ROOT) {
  const r = git(args, cwd);
  if (r.status !== 0) return null;
  return String(r.stdout).trim();
}

// ---- 解析 base..head 与 diff 面 ----
const baseSha = gitOut(['rev-parse', '--verify', `${BASE}^{commit}`]);
const headSha = gitOut(['rev-parse', '--verify', `${HEAD}^{commit}`]);
if (!baseSha || !headSha) {
  console.error(`pr-body: 基准解析失败（base=${BASE} head=${HEAD}）——两 ref 都须可 rev-parse`);
  process.exit(1);
}
const mergeBase = gitOut(['merge-base', baseSha, headSha]) || baseSha;

// core.quotepath=off：非 ASCII 路径不转义（git 上游默认 true 会输出 C 转义串，区域分组/Door 分类全失效）
const statRaw = gitOut(['-c', 'core.quotepath=off', 'diff', '--stat', `${mergeBase}..${headSha}`]) || '';
const numstat = gitOut(['-c', 'core.quotepath=off', 'diff', '--numstat', `${mergeBase}..${headSha}`]) || '';
const nameOnly = (gitOut(['-c', 'core.quotepath=off', 'diff', '--name-only', `${mergeBase}..${headSha}`]) || '')
  .split(/\r?\n/).filter(Boolean);
const commitLog = (gitOut(['log', '--oneline', `${mergeBase}..${headSha}`]) || '')
  .split(/\r?\n/).filter(Boolean);

if (!nameOnly.length) {
  console.error(`pr-body: ${BASE}..${HEAD} 之间没有文件变更——不生成空正文`);
  process.exit(1);
}

// ---- Summary：文件分组 + 实际行为（来自 diff 与 commit 消息，不写意图修辞）----
const groups = {};
for (const f of nameOnly) {
  const top = f.includes('/') ? f.split('/')[0] : '(根)';
  (groups[top] ||= []).push(f);
}
const topKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
let adds = 0, dels = 0;
for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
  const [a, d] = line.split('\t');
  if (a !== '-') adds += Number(a) || 0;
  if (d !== '-') dels += Number(d) || 0;
}
const summaryLines = [
  `- ${nameOnly.length} 个文件变更（+${adds}/−${dels}），涉及 ${topKeys.length} 个顶层区域：${topKeys.map((k) => `${k}(${groups[k].length})`).join('、')}`,
  ...commitLog.slice(0, 5).map((c) => `- ${c}`),
];
if (commitLog.length > 5) summaryLines.push(`- …等 ${commitLog.length} 个提交`);

// ---- Evidence：最近 verify 绿行（取不到明写「未运行」）----
let evidenceLines = [];
const verif = path.join(ROOT, '.agents', 'verifications.jsonl');
if (fs.existsSync(verif)) {
  const rows = fs.readFileSync(verif, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  // 取 head 提交树内最近的绿行
  const green = rows.filter((r) => r.exitCode === 0 && r.headShort && headSha.startsWith(r.headShort))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))[0];
  if (green) {
    evidenceLines.push(`- verify 全绿凭证行：exit 0 @ ${green.headShort}（${green.ts || '时间未记'}）`);
    if (green.logPath) evidenceLines.push(`  日志：\`${green.logPath}\``);
  }
}
if (!evidenceLines.length) {
  // 回退：最近一次任何绿行（标注非本提交）
  const verifAny = fs.existsSync(verif)
    ? fs.readFileSync(verif, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).filter((r) => r.exitCode === 0).pop()
    : null;
  if (verifAny) {
    evidenceLines.push(`- **未取得本提交范围的 verify 凭证**（最近一次绿行属 ${verifAny.headShort || '未知提交'}，非本 PR 范围）`);
  } else {
    evidenceLines.push('- **未运行**（无 verifications.jsonl 绿行可引用）——合入前应跑 verify 留凭证');
  }
}

// ---- Merge Danger：Door / Blast Radius / Rollback ----
const doors = [];
if (nameOnly.some((f) => /(^|\/)(migrations?|db|schema|prisma|sql)\//i.test(f) || /\.sql$/i.test(f))) doors.push('DB/Schema');
if (nameOnly.some((f) => /(^|\/)(api|routes?|controllers?|endpoints?)\//i.test(f))) doors.push('API');
if (nameOnly.some((f) => /(^|\/)(config|settings|\.env|infra|k8s|docker)/i.test(f))) doors.push('配置');
if (nameOnly.some((f) => /(^|\/)(auth|permissions?|middleware)/i.test(f))) doors.push('权限');
if (nameOnly.some((f) => /package(-lock)?\.json$|pnpm-lock\.yaml$|\.csproj$|go\.(mod|sum)$/.test(f))) doors.push('依赖');
const doorText = doors.length ? doors.join(' / ') : '无';

const radius = topKeys.length <= 1 && nameOnly.length <= 5 ? '局部'
  : topKeys.length <= 3 ? '模块'
  : '全局';

const revertRisk = doors.includes('DB/Schema') ? '（注意：含 schema/迁移变更——revert 后须确认迁移可逆）'
  : doors.includes('配置') ? '（注意：含配置变更——revert 后核对配置回归）' : '';

// ---- 组装输出 ----
const out = [
  '## Summary',
  '',
  ...summaryLines,
  '',
  '> 数据来源：git diff --stat/--numstat 与 git log（实际变更，非意图描述）',
  '',
  '## Evidence',
  '',
  ...evidenceLines,
  '',
  '> 数据来源：.agents/verifications.jsonl 绿行（取不到时如实标注）',
  '',
  '## Merge Danger',
  '',
  `- **Door**: ${doorText}`,
  `- **Blast Radius**: ${radius}`,
  `- **Rollback**: \`git revert ${headSha.slice(0, 12)}\`${revertRisk}`,
  '',
  '> 数据来源：diff 文件路径分类（Door）、顶层区域跨度（Radius）、head SHA（Rollback）',
  '',
].join('\n');

process.stdout.write(out);
process.exit(0);
