#!/usr/bin/env node
// append-compensation.mjs — 关单后裁定回填补偿行生成器（maintain.md §4.4，2026-10-24）
// 背景：2026-10-24 采购合同合入评审整改批踩坑——补偿行指纹按「直接哈希当前内容」手搓，被 check-loop 15
//   「确认内容漂移」HARD-BLOCK（正确口径 = bindingSha256：状态行回填 prev 后再哈希）。本工具把口径收口为单源。
// 判据单源（三处全部复用既有权威实现，禁手搓）：
//   - 指纹 = binding.mjs 的 bindingSha256（与 s15 校验端同一函数；2026-10-28 起自 check-loop-kit
//     切出到零副作用模块——此前 import kit 会连带执行其顶层根解析/枚举加载，非 git 目录下静默 exit 0）
//   - prev = 该 doc 末次同 stage 台账行的 prev（§4.4「prev 沿用原行」）
//   - 写入 = confirm-doc.mjs 的 appendLedger（分片/主台账口径与确认门同一出口）
// 拒绝面（fail-loud；防把 s15 的绑定降级路径改造成失配 hard）：
//   - 文档非终态（approved/open 等）→ 前向跳转走 confirm-doc，无补偿面
//   - 台账无该 doc+stage 行 / 末次行缺 prev（schema 演进前存量）→ 无补偿基底，追加反而制造失配
//   - 内容未变（与末次确认行指纹一致）→ 无可补偿的漂移
//   - 缺 --quote → 用户裁定原话是补偿行的法律依据，禁空
// 用法：node <插件根>/scripts/append-compensation.mjs <doc...> --quote "<用户原话>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { bindingSha256 } from './binding.mjs';
import { loadAllConfirmations } from './ledger-loader.mjs';
import { appendLedger } from './confirm-doc.mjs';
import { projectRoot } from './paths.mjs';

export const TERMINAL_STAGES = ['done', 'closed', 'superseded', 'cancelled'];

// pickLastRow(rows, rel, stage)：该 doc 指定 stage 的末次台账行（append-only 末次生效，与 s15 同口径）
export function pickLastRow(rows, rel, stage) {
  const hits = rows.filter((e) => e && e.doc === rel && e.stage === stage && typeof e.fingerprint === 'string');
  return hits.length ? hits[hits.length - 1] : null;
}

// buildCompensation(lines, stage, lastRow, quote, ts)：纯函数——产出补偿行或拒绝原因
export function buildCompensation(lines, stage, lastRow, quote, ts) {
  if (!TERMINAL_STAGES.includes(stage)) {
    return { ok: false, reason: `非终态（${stage}）——前向跳转走 confirm-doc，无补偿面` };
  }
  if (!lastRow) {
    return { ok: false, reason: `台账无 stage=${stage} 行——未经确认门落态，无补偿基底` };
  }
  if (!lastRow.prev) {
    return { ok: false, reason: `末次 stage=${stage} 行缺 prev（schema 演进前存量）——s15 本就绑定降级，追加补偿行反而制造失配` };
  }
  const fp = bindingSha256(lines, lastRow.prev);
  if (fp === lastRow.fingerprint) {
    return { ok: false, reason: '内容与末次确认行一致——无可补偿的漂移（先改正文再跑本工具）' };
  }
  return {
    ok: true,
    row: {
      ts, doc: lastRow.doc, stage, fingerprint: fp, prev: lastRow.prev,
      source: 'chat-delegated', quote, quoteGrounding: 'verbatim',
      batch: randomBytes(3).toString('hex'), seq: 1, of: 1,
    },
  };
}

// fmStatusOf(lines)：frontmatter（首 --- 块）内「状态:」值；无 frontmatter/键 → ''
function fmStatusOf(lines) {
  if (!/^---\s*$/.test(lines[0] || '')) return '';
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  for (let i = 1; i > 0 && i < (end === -1 ? lines.length : end); i++) {
    const m = lines[i].match(/^状态:\s*(\S+)/);
    if (m) return m[1];
  }
  return '';
}

function main() {
  const args = process.argv.slice(2);
  const docs = [];
  let quote = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quote') quote = args[++i] ?? '';
    else docs.push(args[i]);
  }
  if (!docs.length || !quote) {
    console.error('用法：node <插件根>/scripts/append-compensation.mjs <doc...> --quote "<用户原话>"');
    console.error('  done/closed 等终态文档改正文后，按 §4.4 同批补重确认补偿行（指纹=bindingSha256 单源口径）');
    process.exit(2);
  }
  // 根锚定 git root（paths.mjs 单源）：补偿行写进仓库根的台账，不落进调用时的子目录。
  const root = projectRoot();
  const ledger = loadAllConfirmations(root);
  let fail = 0;
  for (const p of docs) {
    const rel = path.relative(root, path.resolve(p)).split(path.sep).join('/');
    let lines;
    try {
      lines = fs.readFileSync(path.resolve(p), 'utf8').split(/\r?\n/);
    } catch {
      console.error(`✗ ${rel}：文件不可读`);
      fail++;
      continue;
    }
    const stage = fmStatusOf(lines);
    const lastRow = pickLastRow(ledger, rel, stage);
    const r = buildCompensation(lines, stage, lastRow, quote, new Date().toISOString());
    if (!r.ok) {
      console.error(`✗ ${rel}：${r.reason}`);
      fail++;
      continue;
    }
    const ledgerFile = appendLedger(root, r.row);
    // 落点打绝对路径：相对路径看不出补偿行进了仓库根还是调用时的子目录。
    console.log(`✓ ${rel} ${stage} 补偿行（prev=${r.row.prev}，指纹 ${r.row.fingerprint.slice(0, 16)}，quote=「${quote}」）→ 台账 ${ledgerFile}`);
  }
  if (fail) console.error(`完成：${docs.length - fail} 成功 / ${fail} 拒绝`);
  process.exitCode = fail ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
