#!/usr/bin/env node
// check-doc-body-drift.mjs — 已关单文档正文漂移的提交期可见性 advisory（2026-11-11 判据移植，源 975a1785a）
// 缺口：改已关单（终态）workflow 文档正文在提交时刻完全不可见，直到下次关单 check-loop 确认指纹对账
// 才判「确认内容漂移」hard-block（根因 = 恢复类提交改回旧正文而未同步重录确认指纹，台账分片未随动）。
// 本脚本把该缺口前移到提交时刻打 advisory；执法面仍是关单时的确认指纹对账（判定口径零变化）。
// 触发口径：暂存面含 workflow/{intents,specs,plans,incidents}/*.md（INDEX.md 在 workflow/ 直下，天然
// 不在面内）且该文档当前状态属已确认终态（终态词表 = doc.status.terminal ∪ incident.status.terminal，
// workflow-enums.txt 两族并集）时——若暂存 diff 改了「正文」（排除：仅 frontmatter「状态:」行、仅
// 「确认指纹:」行——confirm-doc 自身流转只动这两行）而同笔暂存无对应确认台账变更
//（.agents/confirmations.d/<基名>.jsonl 分片或主台账 .agents/confirmations.jsonl 任一在场即算；
// append-compensation.mjs 的补偿行正落在分片，补偿路径天然不警）→ 打印 advisory：疑似改已关单正文
// 未重录指纹，确认后重录或说明。exit 0 恒不拦（advisory 不合门）。
// 用法：node <插件根>/scripts/check-doc-body-drift.mjs [--staged]（--staged 仅为可读性别名，本脚本恒查暂存面）
// 测试：node <插件根>/test/check-doc-body-drift.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { findProjectRoot, projectRoot } from './paths.mjs';

const DOC_RE = /^workflow\/(intents|specs|plans|incidents)\/[^/]+\.md$/;
// 终态并集（workflow-enums.txt：doc.status.terminal = done superseded cancelled；
// incident.status.terminal = fixed closed）——状态值以 frontmatter「状态:」为准，两族按目录自然分流。
const TERMINAL = new Set(['done', 'superseded', 'closed', 'cancelled', 'fixed']);
const MAIN_LEDGER = '.agents/confirmations.jsonl';

// 根解析（对齐 check-secrets.mjs 三态口径）：CHECK_DOC_DRIFT_ROOT（测试注缝）→ 项目 git 根 → cwd。
const ROOT = process.env.CHECK_DOC_DRIFT_ROOT || findProjectRoot() || projectRoot();

const git = (args) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', cwd: ROOT });

// fmStatusOf(abs)：frontmatter（首个 --- 块）内「状态:」值；无 frontmatter/键/文件不可读 → ''
function fmStatusOf(abs) {
  let lines;
  try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { return ''; }
  if (!/^---\s*$/.test(lines[0] || '')) return '';
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return '';
    const m = lines[i].match(/^状态:\s*(\S+)/);
    if (m) return m[1];
  }
  return '';
}

// bodyChangedInStagedDiff(rel)：暂存 diff（-U0 --no-renames）是否含「正文」变更——剔除状态行与指纹行后
// 仍有 +/- 内容行即视为正文变更。git 调用失败按无变更降级（advisory 不合门，不因基础设施误报）。
function bodyChangedInStagedDiff(rel) {
  const r = git(['diff', '--cached', '--unified=0', '--no-renames', '--', rel]);
  if (r.status !== 0) return false;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\')) continue; // “\ No newline at end of file”
    const content = line.slice(1).trim();
    if (!content) continue;
    if (/^状态:/.test(content) || /^确认指纹:/.test(content)) continue; // confirm-doc 自身流转面
    return true;
  }
  return false;
}

// ledgerRowStaged(rel, files)：同笔暂存是否携带**该 doc** 的确认台账行（重录/补偿行均形态）——
// 台账面 = 主台账（若暂存）∪ 该 doc 的分片（若暂存）；判据 = 台账暂存 diff 的新增行含 `"doc":"<rel>"`。
// 逐行对应而非「任一台账文件在场」：并录批次里他份的行不豁免本份（shard 按基名天然隔离；
// 主台账混合行靠行级判据收口）。
function ledgerRowStaged(rel, files) {
  const candidates = [MAIN_LEDGER, `.agents/confirmations.d/${path.basename(rel, '.md')}.jsonl`]
    .filter((f) => files.includes(f));
  for (const f of candidates) {
    const r = git(['diff', '--cached', '--unified=0', '--no-renames', '--', f]);
    if (r.status !== 0) continue;
    const added = String(r.stdout || '').split(/\r?\n/)
      .some((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(`"doc":"${rel}"`));
    if (added) return true;
  }
  return false;
}

// run(root = ROOT)：扫描暂存面，打印 advisory；恒返回 0（exit 0 恒不拦）。root 参数为测试注缝。
export function run(root = ROOT) {
  const staged = git(['diff', '--cached', '--name-only']);
  if (staged.status !== 0) return 0;
  const files = String(staged.stdout || '').split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  const docs = files.filter((f) => DOC_RE.test(f));
  if (!docs.length) return 0;
  const hits = [];
  for (const rel of docs) {
    const st = fmStatusOf(path.join(root, rel));
    if (!TERMINAL.has(st)) continue; // 非已确认终态（draft/approved/open 及删除件）不在 advisory 面
    if (!bodyChangedInStagedDiff(rel)) continue; // 仅状态行/指纹行变更 = confirm-doc 自身流转，不警
    if (ledgerRowStaged(rel, files)) continue; // 同笔已重录指纹 / 追加补偿行（append-compensation.mjs）→ 对账口径成立，不警
    hits.push({ rel, st });
  }
  if (hits.length) {
    console.error('[advisory][doc-body-drift] 检出疑似「改已关单正文未重录指纹」（本提示不合门，exit 0）：');
    for (const h of hits) {
      console.error(`  - ${h.rel}（状态 ${h.st}）：暂存 diff 改了正文，同笔暂存无对应确认台账变更（.agents/confirmations.d/${path.basename(h.rel, '.md')}.jsonl）`);
    }
    console.error('  口径：确认后同笔重录（confirm-doc / append-compensation 补偿行）或在提交说明中说明理由；否则下次关单确认指纹对账判「确认内容漂移」hard。');
  }
  return 0;
}

function main() {
  process.exit(run());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
