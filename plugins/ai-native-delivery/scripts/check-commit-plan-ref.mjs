#!/usr/bin/env node
// check-commit-plan-ref.mjs — 提交消息任务短名校验（判据移植 2026-11-12，advisory 先行不阻断）
// 用途：暂存产品路径被恰好一份覆盖 plan 收口时，提交消息任意位置须含该 plan 短名（文件名去 .md）——
//   让 `git log` 可按任务短名检索，消息 ↔ plan 可追溯。多 plan 覆盖时至少含其一。
// 语义与红线：只读裁决；**advisory 期 exit 恒 0**（警告打印不阻断），观察期后再议升硬门。
//   skip 情形：合并/squash/rebase/cherry-pick（isMergeLike）、未暂存产品路径、消息含 L0 trailer
//   （豁免 A 同判据复用——L0 是提交时豁免通道，不立 plan 即无短名可指）、覆盖 plan 为零
//   （顺序门已执法，这里不重判）。
//   判据全部复用 check-confirm-order.mjs 导出（collectStagedCoverage / coveringDocs / l0Judgement /
//   isMergeLike），短名边界匹配模板单源 .agents/config/commit-msg-rules.json planSlugRe。
// 用法：node <插件根>/scripts/check-commit-plan-ref.mjs <msgFile>（由 commit-msg 种子调用）
import fs from 'node:fs';
import path from 'node:path';
import { configDir, findProjectRoot, projectRoot } from './paths.mjs';
import { collectStagedCoverage, coveringDocs, l0Judgement, isMergeLike } from './check-confirm-order.mjs';

// 根解析（对齐 check-doc-body-drift 先例）：项目 git 根锚定，解析不到回退 cwd。
const ROOT = findProjectRoot() || projectRoot();
const RULES = path.join(configDir(ROOT), 'commit-msg-rules.json');
const msgFile = process.argv[2];

const warn = (lines) => {
  console.error('commit-msg ⚠（advisory）任务短名：');
  for (const l of lines) console.error(`  ${l}`);
};

if (isMergeLike()) {
  console.log('SKIP: 任务短名校验——合并/squash/rebase/cherry-pick');
  process.exit(0);
}
if (l0Judgement(msgFile)) {
  console.log('SKIP: 任务短名校验——L0 极简道（消息含 L0 trailer）');
  process.exit(0);
}

const cov = collectStagedCoverage();
if (cov.error) {
  warn(['暂存列表读不到，本次无法校验（advisory 期不阻断）']);
  process.exit(0);
}
if (!cov.products.length) {
  console.log('SKIP: 任务短名校验——未暂存产品路径');
  process.exit(0);
}

const covers = coveringDocs(cov.docs, cov.stagedAdded)
  .filter((d) => cov.products.some((p) => d.text.includes(p)));
if (!covers.length) {
  console.log('SKIP: 任务短名校验——无覆盖 plan（顺序门已执法，此处不重判）');
  process.exit(0);
}

let msg = '';
try { msg = fs.readFileSync(msgFile, 'utf8'); } catch { /* 读不到按空消息走 advisory */ }

let boundaryTpl = '(^|[^A-Za-z0-9-])<slug>($|[^A-Za-z0-9-])';
try {
  const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
  if (rules.planSlugRe) boundaryTpl = rules.planSlugRe;
} catch { /* 模板读不到用内联默认（advisory 期不 fail-closed） */ }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hitRe = (slug) => new RegExp(boundaryTpl.replace(/<slug>/g, esc(slug)));

const slugs = [...new Set(covers.map((d) => path.basename(d.rel, '.md')))];
const hits = slugs.filter((s) => hitRe(s).test(msg));

if (slugs.length === 1) {
  if (!hits.length) {
    warn([
      `本次提交由 plan「${slugs[0]}」覆盖，但提交消息未含任务短名。`,
      `建议写法：feat(${slugs[0]}): <摘要>  或正文任意位置提及 ${slugs[0]}。`,
      '（advisory 期不阻断；观察期后拟升硬门——git log 须可按任务短名检索）',
    ]);
  } else {
    console.log(`任务短名校验：消息已含「${slugs[0]}」✅`);
  }
} else if (!hits.length) {
  warn([
    `本次提交被 ${slugs.length} 份 plan 覆盖，提交消息须至少含其一短名：`,
    ...slugs.map((s) => `- ${s}`),
    '（advisory 期不阻断）',
  ]);
} else {
  const missed = slugs.filter((s) => !hits.includes(s));
  console.log(`任务短名校验：消息已含 ${hits.map((s) => `「${s}」`).join('')}✅${missed.length ? `（未提及：${missed.join('、')}——多 plan 合提建议拆分或补提）` : ''}`);
}
process.exit(0);
