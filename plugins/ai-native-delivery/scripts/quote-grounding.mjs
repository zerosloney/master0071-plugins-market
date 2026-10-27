#!/usr/bin/env node
// quote-grounding — --delegated 引文接地校验（2026-10-22 delegated-quote-grounding）
//
// 为什么需要：`--delegated "<用户原话>"` 是免 TTY 的委托代录形态，quote 是**事后对质的唯一证据**。
// 但历史台账暴露该证据可空洞化——quote 与目标文档毫无指涉关系（如代录 spec 却记「提交并关单」，
// 或把 A 件的话记到 B 件头上），此时「用户确认过这份文档」无法被证伪，确认门退化成 AI 自证。
//
// 判据（三层，任一成立即接地）：
//   ① 逐字命中：规范化后 quote 整体是目标文档（含同名家族）的子串；
//   ② 逐字锚点：与目标文档的最长逐字公共片段 ≥ GROUND_ANCHOR_MIN（默认 8 字）——
//      足以证明 quote 谈的是这份文档的具体内容，而不是「随便哪件都能说」的话；
//   ③ 纯放行语：剥掉 RELEASE_LEXICON（放行/工序/收尾通用词）后残余 ≤ RESIDUAL_TOLERANCE
//      （默认 2）——quote 不含可被误配的具体内容，无从「伪造指向」，放行不损失证据力。
// 三层都不成立 → 残余内容在目标文档里找不到落点 = 引文说的不是这份文档，判为**不接地**
// （默认 advisory 放行并留痕；`--strict-quote` 才拒绝落账——见下方实测取舍）。
//
// 实测（2026-10-22，temp/probe26–29 回放 873 行历史委托）——**为什么默认只 WARN 不硬拦**：
//   K=8：真文档通过 90.0%，但同一引文对**无关文档**也通过 71.2%（判别力仅 19pt）；
//        且 L2/L3 误杀 17.9%、L1 误杀 8.2%。
//   K=4：误杀降到 3.4%，但无关文档通过率 91.2% —— 几乎零判别力。
//   结论：中文口语是**复述**而非引用（「多条MTO单明细手动代用…定额记录」这类真原话对不上任何
//   8 字逐字串），词面判据无法在「误杀合规口语」与「放过误配」之间同时成立。故：
//     · 默认 advisory（WARN + 台账行记 quoteGrounding，供事后审计与趋势）；
//     · 客观缺陷才硬拦：quote 空、目标文档在活跃目录与归档里都不存在；
//     · 需要收硬时由调用方显式 `--strict-quote`（策略选择，不是默认）。
//   换言之：**能机器证伪的只有「quote 是不是空/指向不存在的文档」；「quote 是否真的授权了这份文档」
//   机器证不了**——那半边靠 review/design/test 的强制独立复核兜。
//
// 设计取舍（刻意不做的事）：
// - **不做模糊相似度**（n-gram 覆盖率 / token 比例 / LCS 长度比）：历史 873 条委托行的实测
//   （tmp/probe19–24）显示这类判据在中文短句上要么放过几乎全部误配，要么误杀大量合规短句，
//   单独使用只提供「跑过了」的错觉。逐字锚点是唯一可对质的证据形态。
// - **不做跨文档反查**（「残余命中他件即判误配」）：同名家族外的命中无法区分「用户顺口提了邻件」
//   与「真的记串了」，误报代价高于收益。
// - **不回溯历史行**：本校验只在写入时把关；存量 quote 一字不改（check-loop 不据此追责）。
//
// 家族范围：同名 intent/spec/plan/incident 整族，且**跨 workflow/archive/** 解析——归档不是失效
// （spec 生命周期口径 2026-10-16），实测 208 条「目标文档不存在」的委托行里 205 条只是被归档改名。

import fs from 'node:fs';
import path from 'node:path';

// 最长逐字锚点下限（规范化后字符数）。取 8：中文里 8 字连续逐字相同，偶然重合概率可忽略，
// 同时容得下「确认第三点库存扣减口径」这类短指涉。
export const GROUND_ANCHOR_MIN = 8;

// 残余容忍（剥通用词后仍剩下的字符数上限）。只为吸收「即 / 就 / 的」这类残留语气字，
// 不作为放宽闸口——真正的门槛是「残余必须能在文档里找到落点」。
export const RESIDUAL_TOLERANCE = 2;


// 通用放行 / 工序 / 收尾词表：这些词在仓库任何一份 workflow 文档里都可能出现，不构成指涉。
// 按**最长优先**匹配剥除（「提交并关单」先于「提交」「关单」）。
export const RELEASE_LEXICON = [
  // 放行本身
  '可以可以', '可以', '好', '行', '没问题', '没意见', '同意', '通过', '放行', '准了',
  '可', '好的', '行吧', '就', '即', '那就', '那么', '这', '那', '这么', '你要',
  '确认', '已确认', '确定', '批准', '认可', '继续', '接着', '往下', '开干', '干活', '动手',
  '进入', '动工', '开工', '开始',
  // 提交 / 收尾 / 分支 / 合入
  '提交并关单', '提交并', '提交', '推送', '合入', '合并', '收尾', '关单', '落态', '记账', '记一笔',
  '上推', '推上去', '分支', '主干', '远程', '到',
  '不要推送', '不推送', '不用推送', '不用合并', '不要合并', '不合并', '不必合并',
  '不要提交', '不用提交', '不必',
  // 验证 / 工序
  '测试', '自测', '实测', '复测', '全量', '门禁', '门', '静态', '验证', '校验', '检查',
  '验收', '证据', '对照', '回归', '冒烟', '绿', '红',
  '由我自己测试', '由我测试', '我自己测', '自己测', '我来测', '我测', '由我',
  '去除', '去掉', '移除', '删掉', '删',
  // 指代文档 / 工作物
  '文档', '文件', '代码', '改动', '变更', '修改', '问题', '需求', '方案', '页面', '功能',
  '事项', '任务', '内容', '清单', '记录', '台账', '结论', '笔记', '小节', '章节',
  '阶段', '流程', '确认后', '放行后', '同源同批',
  // 文档类型名（用户说「plan 确认」时不构成对具体某一份的指涉）
  'plan', 'spec', 'intent', 'incident', 'design', 'build', 'review', 'test', 'deploy',
  // 时间 / 顺序 / 数量
  '现在', '马上', '立即', '直接', '顺便', '一起', '然后', '之后', '先', '再', '按', '照',
  '第一', '第二', '第三', '第四', '点', '步', '共', '全部', '所有', '都', '也', '并',
  '一份', '两份', '三份', '两件', '三处', '两处', '一次', '两次',
  '完毕', '完成', '做完', '改完', '修完', '补充', '补齐', '落地', '处理', '修', '补', '改',
  '走', '跑', '执行', '照做', '照此', '依旧', '按此',
  // 结构助词 / 语气
  '的话', '了', '吧', '呀', '啊', '嗯', '对', '是', '要', '想', '请', '帮我', '帮忙',
  '们', '我们', '你', '我', '他', '其',
];

// normalizeQuote(s)：小写 + 去空白 + 去中英标点/引号/括号（保留字母数字汉字）。
// 不做同义/繁简/拼音归一——归一越狠，锚点越容易被「看起来像」骗过。
export function normalizeQuote(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~\u2000-\u206f\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g, '');
}

// longestCommonAnchor(a, b)：最长公共**连续**子串长度（规范化入参，O(n*m) 时间 / O(min) 空间）。
// 引文短（<200 字）、文档 ~40KB，单次确认一份文档，成本可忽略；取滚动一维 DP 避免二维分配。
export function longestCommonAnchor(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (!s || !t) return 0;
  const n = s.length;
  let prev = new Uint32Array(n + 1);
  let cur = new Uint32Array(n + 1);
  let best = 0;
  for (let j = 1; j <= t.length; j++) {
    const tc = t.charCodeAt(j - 1);
    for (let i = 1; i <= n; i++) {
      if (s.charCodeAt(i - 1) === tc) {
        const v = prev[i - 1] + 1;
        cur[i] = v;
        if (v > best) best = v;
      } else {
        cur[i] = 0;
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
    cur.fill(0);
  }
  return best;
}

// hasAnchorAtLeast(q, hay, k)：q 的任一 k-gram 是否出现在 hay 里（等价于「最长逐字锚点 ≥ k」，
// 但用原生 indexOf 判存在、不建二维表）。等价性：长度 ≥k 的公共连续片段必含一个 q 的 k-gram。
export function hasAnchorAtLeast(q, hay, k) {
  if (k <= 0 || !q || !hay) return false;
  for (let i = 0; i + k <= q.length; i++) {
    if (hay.includes(q.slice(i, i + k))) return true;
  }
  return false;
}

// stripRelease(q)：按最长优先把 RELEASE_LEXICON 从规范化引文里剥掉，返回残余（已归一）。
export function stripRelease(normalized) {
  const sorted = [...RELEASE_LEXICON].sort((x, y) => y.length - x.length);
  let out = String(normalized ?? '');
  for (const w of sorted) {
    if (!w) continue;
    const nw = normalizeQuote(w);
    if (nw) out = out.split(nw).join('');
  }
  // 剥完剩下的编号（「第 1 点」/「方案 2」/「①-③」）不构成指涉
  return out.replace(/[0-9]+/g, '').replace(/[\u2460-\u2473\u2474-\u2487]/g, '');
}

// groundQuote({quote, docText, familyTexts})：接地裁决（纯函数，无 IO）。
// 返回 { ok, reason: 'empty'|'verbatim'|'anchor'|'generic'|'ungrounded', anchor, residual }。
// reason 供调用方给出可执行的拒绝提示（不只是一个 false）。
export function groundQuote({ quote, docText, familyTexts = [] } = {}) {
  const q = normalizeQuote(quote);
  if (!q) return { ok: false, reason: 'empty', anchor: 0, residual: '' };

  const haystacks = [normalizeQuote(docText), ...familyTexts.map((t) => normalizeQuote(t))]
    .filter(Boolean);

  // ① 逐字命中
  for (const hay of haystacks) {
    if (hay.includes(q)) return { ok: true, reason: 'verbatim', anchor: q.length, residual: '' };
  }

  // ② 最长逐字锚点（先判存在，命中即止；未命中才在失败路径精确算长度供诊断）
  if (haystacks.some((hay) => hasAnchorAtLeast(q, hay, GROUND_ANCHOR_MIN))) {
    return { ok: true, reason: 'anchor', anchor: GROUND_ANCHOR_MIN, residual: '' };
  }
  let anchor = 0;
  for (const hay of haystacks) {
    const len = longestCommonAnchor(q, hay);
    if (len > anchor) anchor = len;
  }

  // ③ 纯放行语
  const residual = stripRelease(q);
  if (residual.length <= RESIDUAL_TOLERANCE) {
    return { ok: true, reason: 'generic', anchor, residual };
  }

  return { ok: false, reason: 'ungrounded', anchor, residual };
}

// resolveDocText(root, doc)：目标文档正文；活跃路径缺失时回落到同名归档件。
// 返回 { text, archived } 或 null。归档回落是关键：208 条「目标文档不存在」的委托行里
// 205 条只是被 archive-on-close 归档改名，按「缺档」处理会误杀合规历史。
export function resolveDocText(root, doc) {
  const relDoc = String(doc || '').replace(/\\/g, '/');
  try {
    return { text: fs.readFileSync(path.join(root, relDoc), 'utf8'), archived: false };
  } catch {
    const base = path.basename(relDoc, '.md');
    if (!base) return null;
    const archiveRoot = path.join(root, 'workflow', 'archive');
    let batches = [];
    try { batches = fs.readdirSync(archiveRoot, { withFileTypes: true }); } catch { return null; }
    for (const b of batches.filter((x) => x.isDirectory())) {
      for (const t of ['intents', 'specs', 'plans', 'incidents']) {
        try {
          const p = path.join(archiveRoot, b.name, t, `${base}.md`);
          return { text: fs.readFileSync(p, 'utf8'), archived: true };
        } catch { /* 继续找 */ }
      }
    }
    return null;
  }
}

// resolveFamilyTexts(root, doc)：读同名家族正文（四类型 + 全归档批次），排除目标文档自身。
// 只读、缺失容忍。家族=同一主题的 intent/spec/plan/incident，引文指向族内任一都是「同一件事」。
export function resolveFamilyTexts(root, doc) {
  const base = path.basename(String(doc || ''), '.md');
  if (!base) return [];
  const relDoc = String(doc || '').replace(/\\/g, '/');
  const out = [];
  const seen = new Set();

  const push = (abs) => {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (rel === relDoc || seen.has(rel)) return;
    seen.add(rel);
    try { out.push(fs.readFileSync(abs, 'utf8')); } catch { /* 缺失容忍 */ }
  };

  for (const t of ['intents', 'specs', 'plans', 'incidents']) {
    push(path.join(root, 'workflow', t, `${base}.md`));
  }
  const archiveRoot = path.join(root, 'workflow', 'archive');
  let batches = [];
  try { batches = fs.readdirSync(archiveRoot, { withFileTypes: true }); } catch { return out; }
  for (const b of batches.filter((x) => x.isDirectory())) {
    for (const t of ['intents', 'specs', 'plans', 'incidents']) {
      push(path.join(archiveRoot, b.name, t, `${base}.md`));
    }
  }
  return out;
}
