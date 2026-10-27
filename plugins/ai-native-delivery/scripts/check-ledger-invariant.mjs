#!/usr/bin/env node
// check-ledger-invariant — confirmations 台账提交不变量（2026-10-02 ledger-ci-invariant；
// 2026-10-12 ledger-shard-invariant：校验面自单一主台账扩展到「主台账 + confirmations.d 分片」）
// 目的：把「台账本地可写」的伪造面从事后对质级升为机器可检出级（能力评审审计维度扣分项）。
// 台账不可变原则：confirmations 历史行禁删改——修正只能走追加补偿行（README 硬规则 6）。
//
// 分片形态（2026-10-10 中期方案；2026-10-12 起为 confirm-doc 默认写入口径）：
//   .agents/confirmations.d/<doc 基名>.jsonl —— 按 doc 分片，跨机/跨 worktree 确认不同 doc 时
//   写不同文件，从根上消除「每合并必冲突 + 手工重建」；同一 doc 被两端并发确认时由
//   .gitattributes 的 merge=jsonl-union 驱动取并集（本地须配 merge.jsonl-union.driver，
//   见 check-local-gates.mjs --fix）。本脚本给分片补上主台账同级的 append-only 前缀不变量——
//   否则分片是「无人校验的写入面」，被改写/删除无人知。
//
// 特许修剪（2026-10-09 user-directed-prune）：仓库所有者明令删除某批 workflow 文档并清理其台账行时，
//   允许**一次性、逐行对账**的修剪——暂存集须同时携带 .agents/config/ledger-prune-manifest.json
//   （{ts, authority, reason, removes:[被删行 sha256...], docs:[家族名...]}），门禁逐行核验
//   「新内容 = 旧内容 − manifest 所列各行」且每个哈希恰对应一行。未带 manifest 的删/改/重排仍全拦——
//   append-only 红线对其他一切场景不变；修剪凭据（被删行哈希）随 manifest 入库，事后可对质。
//
// 分片删除的唯一合法形态 = compact-ledgers 归并（2026-10-12）：分片被删时，该分片**全部非空行必须
//   已逐字存在于同一提交的主台账**（compact-ledgers 正是把这些行原样追加进主台账后才删片）——
//   认不出归并凭据的删片一律 hard fail，堵住「删片抹账」这条路。主台账自身永不因归并被删。
//   合并感知（2026-10-13 merge-aware-shard-delete）：分片内容从**各父**取并集后对账——合并解析收口
//   删片时，分片可能只在第二父侧（首父早已归并删片，实证 56c45b07：4 分片生于他端、首父无此路径，
//   单看 `${sha}^` 会把合法收口误判成「增删同提交」）。
//   终树补登追认（2026-10-13 merge-shard-restore-aware）：合并删片时缺行若已全部在终树主台账补登
//   （后续提交原样回append），视为丢失已追认——历史事实不可改写，终态无丢失即审计实质
//   （实证 56c45b07 丢失第二父分片行 1 行，同日补登）。
//
// 合并并集语义（2026-10-13 merge-union-aware）：多父提交不按线性前缀判，改验「并集无丢失」——
//   合并结果的行集合须 ⊇ 两父各自行集之并（一行不丢）且 ⊆ 该并集（一行不造）。jsonl-union 策略
//   （多 worktree 并行确认的根基）与线性前缀模型天生矛盾，本判据对齐审计实质：确认行不被丢、
//   不被造。合并通过后以合并 blob 续扫。
//
// 历史基线（2026-10-13 ledger-history-baseline，仓库所有者声明）：HISTORY_BASELINE 之前的提交不进
//   前缀扫描——该时代（manifest 特许修剪机制 2026-10-09 之前 + 合并感知 2026-10-13 之前）的删改
//   无对账凭据，原理上不可追溯验证（回填 manifest 须改写历史且属事后伪造授权）；基线由 owner
//   一次性 loud 声明，同「流程: legacy / 存量不回填」哲学。基线 blob 为可信起点，基线后提交照常
//   全扫。LEDGER_HISTORY_BASELINE 环境变量可覆盖（测试用）。2026-10-13 盘点：基线前存量标记 71 处
//   （union 合并改写 + 前 manifest 时代清理），详见当日修剪 #3 提交（f16504f）。
//   2026-10-14 基线前移（owner 声明）：PR 647 服务端合并（8c2e1b1d）对主台账取 develop 侧整块，
//   丢 main 侧 283 行——这 283 行所属 181 个 doc 中 174 个已随特许修剪离开工作树，实质解析正确；
//   但 TFS 服务端 PR 合并既不运行 jsonl-union 驱动、也无法附带修剪 manifest（该合并提交 manifest
//   仅声明 8 个早已落地的陈旧哈希，父母并集命中 0），丢行在「历史全扫」下原理上不可追溯补证。
//   基线自 7a69bc83 前移至 8c2e1b1d（合并后全树一致态为可信起点），基线后提交照常全扫，
//   终树行级校验不受基线影响、照常全量。
//   事件登记 workflow/papercuts.d/2026-10.md 2026-10-14 行；丢失行原件 git show c0269da8:.agents/confirmations.jsonl。
//   2026-10-15 再前移（owner 声明）：8c2e1b1d → b6cfd0db。远端提交 b8ce1247（远端机未挂 hooks，门禁
//     静默失效）单亲改写主台账中段（首异偏移 62995）——带入 18 行整块重复 + 尾部 ts 降序块 + 8 行孤儿
//     指针（合并时 --staged 并集对账已验零丢失，但该提交自身的前缀破坏无对账凭据、原理上不可追溯补证，
//     与 PR647 同病理）。b6cfd0db 是 b8ce1247 之后的最新一致态（本仓与 origin/develop 的合并基点），取为
//     可信起点——窗口同时覆盖两侧并行修复的各自提交：本仓「特许修剪 #6 + 等义回 append」（凭据
//     ledger-prune-manifest，50 行）与远端「特许重建 c22bc2b8」（凭据 ledger-rebuild-manifest，finalRows
//     289 行）。两条凭据路俱在（matchPrune / matchRebuild），审计面比只认单侧宽；基线后提交照常全扫，
//     终树行级校验照常全量。
//     事件登记 workflow/papercuts.d/2026-10.md 2026-10-15 行（两侧各一条 + 合并口径一条）。
//   2026-10-27 第六次前移（owner 声明）：9a0370e8 → e3ceb6c9（PR730 服务端合并后一致态）。
//     830027060b（2026-10-26 16:57，feature/phase2-MTO-PML 合 develop）与 e3ceb6c9（TFS 服务端合并
//     PR730）对 8 个分片整取单侧，父母并集分别丢 8/6/2/1/1/1/1/1 行；与 PR647/8c2e1b1d 同病理。
//     丢行已由本支 16670c10 保留、并经 6bd69a2d 本地合并按 jsonl-union 并集恢复（终树行集 = 父母并集，
//     实测 8 个分片在 HEAD 均无缺行），历史侧不可追溯部分按先例豁免。前移取最小豁免：仅覆盖这两个
//     合并提交，6bd69a2d 及之后仍全扫。事件登记 workflow/papercuts.d/2026-10.md 2026-10-27 行。
//
// 模式：
//   历史全扫（缺省，CI 机器门）：对主台账与每个分片各自遍历其提交历史（时间正序），每次变更必须以
//     旧 blob 为**逐字节前缀**（允许纯追加；禁止删行/改行/重排）——或前缀破坏但该提交树上有 manifest
//     恰好对账被删行（特许修剪认领，loud 记录后以新 blob 为基线继续）。分片另判「删除须已归并」。
//     再对终树（主台账 + 各分片）做行级校验（五项，见下）。
//     blob 读取走 git 对象库（入库 LF 归一口径），不受工作树 autocrlf 影响。
//   --staged（pre-commit 前置）：暂存的各台账文件必须以对应 HEAD blob 为逐字节前缀——或携带 manifest
//     的特许修剪；或携带 rebuild manifest（finalRows 指纹清单）的特许重建——去重/重排在保序语义下无
//     通道，owner 明令的一次性重建走此路（2026-10-15 ledger-rebuild-manifest，动机见 matchRebuild 头注）；
//     合并进行中（MERGE_HEAD 在场）先认「暂存行集恰为父母行集之并」的纯并集形态
//     （2026-10-15 staged-merge-union，与历史全扫 mergeUnionProblem 同口径——ours==base 时三方合并
//     整体取 theirs，行序重排必破坏前缀属假阳性），再认「父母并集 − manifest 所列行」的集合对账
//     （2026-10-14 staged-merge-prune，与历史全扫 mergePruneProblem 同口径）。
//     并集只判**行集合**（多父提交不判前缀），故合并提交可自行排序——两侧并行修复同一台账时（一侧
//     修剪、一侧重建，被删行在并集中复活），合并提交须把并集按 ts 归位，否则终树行级校验①当场红
//     （2026-10-15 拉取 origin/develop 实证：337 行并集尾部带回旧 ts 行）。
//
// 行级校验（终树，逐文件五项）：
//   ⓪ kind 判别（2026-10-27 confirm-task-row）：无 kind = doc 绑定行走①–⑤；kind:"task"（MCP confirm
//     任务级确认行）只验五字段在场 + 指纹 64 hex + 时序单调，不要求 doc/stage；其他 kind 值 = 违规行
//   ① ts 为 ISO 字符串且**该文件内**非降序（追加时序单调；跨文件不要求全局单调——分片并发追加下
//     全局单调不可满足也不必要，单文件单调才是 append-only 的真实不变量）
//   ② fingerprint 为 64 位 hex
//   ③ source=chat-delegated 行必有非空 quote（原话对质面）
//   ④ doc 匹配 workflow/(intents|specs|plans|incidents)/[^/]+.md 且当前树存在（**归档感知**，
//     2026-10-13 archive-aware-doc：四目录原路径未命中再探 workflow/archive/*/）——关单即归档移动
//     文件后行仍指向真实文档，移动轨迹由 git 历史承载；与 check-loop「配对门只扫四目录、归档件
//     不触发」的归档语义对齐
//   ⑤ stage ∈ 合法跳转终态集（approved/done/fixed/closed/superseded/cancelled）
//
// 静默条件：台账不存在 / 零提交历史（装户、新仓）/ --staged 且暂存未触任何台账或无 HEAD 版本。
// 已知边界：git log --follow 未用——各台账路径自创建无重命名（单一路径取史）；克隆深度不足时仅扫可得
//   历史（CI 侧 fetch-depth:0 兜全史，深度不足会告警声明边界，fail-open 于深度、fail-closed 于内容）。
// 用法：node check-ledger-invariant.mjs [--root <仓库根>] [--staged]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
};
const staged = argv.includes('--staged');
const ROOT = argOf('--root') || (staged ? process.cwd() : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const REL = '.agents/confirmations.jsonl';
const SHARD_DIR = '.agents/confirmations.d';
const MANIFEST_REL = '.agents/config/ledger-prune-manifest.json';
const REBUILD_MANIFEST_REL = '.agents/config/ledger-rebuild-manifest.json';
// 历史基线（owner 声明 2026-10-13，取当日台账 ts 全序恢复提交；2026-10-14 前移至 8c2e1b1d、
// 2026-10-15 再前移至 b6cfd0db、2026-10-16 四前移至 46beeb7152、2026-10-26 五前移至 9a0370e8、
// 2026-10-27 六前移至 e3ceb6c9（豁免 830027060b/e3ceb6c9 整取单侧丢行，同 PR647/b8ce1247 先例）——
// 六次皆 owner 声明，缘由详见头注；env 覆盖供测试）
const HISTORY_BASELINE = process.env.LEDGER_HISTORY_BASELINE || 'e3ceb6c901918db828774ddae9370788df0cda68';
const FILE = path.join(ROOT, REL);
const VALID_STAGES = new Set(['approved', 'done', 'fixed', 'closed', 'superseded', 'cancelled',
  'revert-draft', 'revert-open']); // 回退注记行（check-loop :822 认可；fingerprint 恒 n/a）

const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, ...opts });
const gitText = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// ---- blob 批量读取（2026-10-27 ledger-history-index）----
// 历史扫描对每个「路径 × 提交」「父 × 路径」都要读一次 blob——实测 2397 次 `git show` 共 122.7s，
// 是改掉 N 次 `git log`（159s）之后的剩余大头。`cat-file --batch` 一次喂完同样 2397 个对象名仅 0.5s。
// 语义等价：`git show <sha>:<path>` = `cat-file --batch` 取同一对象；对象不存在时前者非零退出、
// 后者回「missing」（映射为 null，与 tryBlob 的契约一致）。结果按 ref 永久缓存（索引内同一 ref 只读一次）。
//
// 批处理时机：全部待读 ref 一次性预取（调用方在扫描开始前传 refs 列表，见 warmBlobs）。
// 未预取到的 ref 退回逐个 spawnSync——保持「索引未覆盖/浅克隆」场景的原语义，不 fail-open。
const _blobCache = new Map();
const _blobBatchDone = new Set();
function warmBlobs(refs) {
  const pending = [...new Set(refs)].filter((r) => !_blobCache.has(r) && !_blobBatchDone.has(r));
  if (!pending.length) return;
  pending.forEach((r) => _blobBatchDone.add(r));
  const CHUNK = 2000; // 输入缓冲与输出缓冲双控；单批 ~30MB 输出
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const r = spawnSync('git', ['cat-file', '--batch'], {
      cwd: ROOT,
      input: slice.map((ref) => `${ref}\n`).join(''),
      maxBuffer: 512 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) continue; // 整批失败 → 落回逐个读
    const buf = r.stdout;
    let off = 0;
    for (const ref of slice) {
      const nl = buf.indexOf(0x0a, off);
      if (nl < 0) break;
      const header = buf.toString('utf8', off, nl);
      off = nl + 1;
      const parts = header.split(' ');
      if (parts.length >= 3) {
        const size = Number(parts[2]);
        if (Number.isFinite(size)) {
          _blobCache.set(ref, buf.subarray(off, off + size));
          off += size + 1; // 内容后跟一个 LF
          continue;
        }
      }
      _blobCache.set(ref, null); // missing / ambiguous
    }
  }
}
const blobOf = (ref) => {
  if (_blobCache.has(ref)) {
    const b = _blobCache.get(ref);
    if (b === null) throw new Error(`blob 不存在: ${ref}`);
    return b;
  }
  return git(['show', ref]);
};
// tryBlob：安全读 blob，失败返回 null 且**不向父进程外泄 git fatal 噪声**（删片场景读当前提交必失败，
// 那是预期路径不是错误——execFileSync 会把 fatal 直通 stderr 刷屏，2026-10-12 H3/H4 实证）。
const tryBlob = (ref) => {
  if (_blobCache.has(ref)) return _blobCache.get(ref);
  const r = spawnSync('git', ['show', ref], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const linesOf = (buf) => buf.toString('utf8').split('\n').filter((l, i, a) => !(l === '' && i === a.length - 1) && l !== '');
const isShard = (rel) => rel.startsWith(`${SHARD_DIR}/`) && rel.endsWith('.jsonl');

// ④ 归档感知存在性（2026-10-13 archive-aware-doc）：四目录原路径未命中再探 workflow/archive/*/——
// 归档是 sanctioned 的文档生命周期事件，行的审计价值（指向真实文档）不受移动影响；真消失（既不在
// 四目录也无归档批次）仍拦。
const docExists = (doc) => {
  if (fs.existsSync(path.join(ROOT, doc))) return true;
  const m = /^workflow\/(intents|specs|plans|incidents)\/([^/]+)\.md$/.exec(doc);
  if (!m) return false;
  try {
    const arcRoot = path.join(ROOT, 'workflow', 'archive');
    for (const batch of fs.readdirSync(arcRoot)) {
      if (fs.existsSync(path.join(arcRoot, batch, m[1], `${m[2]}.md`))) return true;
    }
  } catch { /* archive 目录不存在 */ }
  return false;
};

// 特许修剪对账：cur === head − manifest.removes 各行（保序）；每个哈希恰命中一行且该行 doc ∈ manifest.docs。
// 返回 null（无 manifest/不匹配+原因）或 {removed, docs}。
const matchPrune = (headBuf, curBuf, manifest) => {
  if (!manifest || !Array.isArray(manifest.removes) || !manifest.removes.length) return { err: 'manifest 缺失或 removes 为空' };
  const head = linesOf(headBuf);
  const cur = linesOf(curBuf);
  const want = new Set(manifest.removes);
  const kept = head.filter((l) => !want.has(sha256(l)));
  const removedLines = head.filter((l) => want.has(sha256(l)));
  if (removedLines.length !== manifest.removes.length) return { err: `manifest 哈希命中 ${removedLines.length} 行 ≠ 声明 ${manifest.removes.length} 行（哈希不存在或重复）` };
  if (kept.join('\n') !== cur.join('\n')) return { err: '暂存内容 ≠ HEAD − manifest 所列行（存在 manifest 之外的增删改）' };
  const docs = new Set(manifest.docs || []);
  for (const l of removedLines) {
    try {
      const doc = JSON.parse(l).doc || '';
      if (docs.size && !docs.has(path.basename(doc).replace(/\.md$/, ''))) return { err: `被删行 doc ${doc} 不在 manifest.docs 清单内` };
    } catch { return { err: '被删行非 JSON' }; }
  }
  return { removed: removedLines.length, docs: [...docs] };
};
const loadManifest = (ref) => {
  // spawnSync + status 判定：execFileSync 失败时 stderr 直通父进程（历史扫描探针在旧提交无 manifest 时
  // 刷屏 fatal 噪声，2026-10-09 修剪实战暴露）——探测失败必须静默归 null
  // 2026-10-27：命中 warmBlobs 预取缓存时零 spawn（历史扫描每次前缀破坏都要探两本 manifest）。
  if (_blobCache.has(ref)) {
    const b = _blobCache.get(ref);
    if (b === null) return null;
    try { return JSON.parse(b.toString('utf8')); } catch { return null; }
  }
  try {
    const r = spawnSync('git', ['show', ref], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout);
  } catch { return null; }
};

// 特许重建对账（2026-10-15 ledger-rebuild-manifest，owner 明令的一次性重建通道）：终态 = HEAD − 声明
//   副本数（多重集差集逐哈希对账），行内容零改动、零新增（cur − head 须空）、终态既有行不得增副本；
//   且终态逐行指纹与 manifest.finalRows 严格有序一致（钉死最终形态，排序外夹带必被检出）。
//   动机：b8ce1247 带病入库（远端机未挂 hooks）引入 18 行整块重复 + 尾部 ts 降序块——「去重 + 重排」
//   在保序修剪语义下无合法通道（manifest 修剪要求 kept 保序、append-only 禁中段改写），本路补齐；
//   凭据 = finalRows 全量指纹清单随 rebuild manifest 入库，事后逐行可对质。
// 返回 null（无 manifest/不匹配+原因）或 { removed, rows }。
const matchRebuild = (headBuf, curBuf, manifest) => {
  // removes 允许为空（2026-10-16 纯重排放宽）：行内容零改动、零新增的前提下，行序调整由 finalRows
  // 指纹清单逐行钉死；仓库现役 manifest（.agents/config/ledger-rebuild-manifest.json，2026-10-18
  // 分片按 ts 稳定排序）即 removes: [] 形态，旧守卫要求非空会把它判成「manifest 缺失」。
  if (!manifest || !Array.isArray(manifest.removes) || !Array.isArray(manifest.finalRows) || !manifest.finalRows.length) return { err: 'rebuild manifest 缺失或 finalRows 为空' };
  const multiset = (lines) => { const m = new Map(); for (const l of lines) { const h = sha256(l); m.set(h, (m.get(h) || 0) + 1); } return m; };
  const head = multiset(linesOf(headBuf));
  const cur = multiset(linesOf(curBuf));
  // ① head − cur 须恰为声明差集（副本数逐哈希对账；cur 增既有行副本 = 禁）
  const diff = new Map();
  for (const [h, c] of head) {
    const d = c - (cur.get(h) || 0);
    if (d < 0) return { err: `终态比 HEAD 多出既有行副本 ${h.slice(0, 12)}…（rebuild 禁增行）` };
    if (d > 0) diff.set(h, d);
  }
  const want = new Map(manifest.removes.map((r) => [r.hash, r.copies]));
  if (diff.size !== want.size || [...want.entries()].some(([h, c]) => diff.get(h) !== c)) return { err: '差集对账失败：实际删除副本 ≠ manifest.removes 声明' };
  // ② cur − head 须空（零新增、零内容改写）
  for (const [h] of cur) if (!head.has(h)) return { err: `终态含 HEAD 没有的行 ${h.slice(0, 12)}…（rebuild 禁造行）` };
  // ③ 终态逐行指纹有序一致
  const curHashes = linesOf(curBuf).map(sha256);
  if (curHashes.length !== manifest.finalRows.length || curHashes.some((h, i) => h !== manifest.finalRows[i])) return { err: '终态行序/指纹与 manifest.finalRows 不一致' };
  return { removed: [...diff.values()].reduce((a, b) => a + b, 0), rows: curHashes.length };
};

const problems = [];
const fail = (msg) => { console.error(msg); process.exit(1); };

// 终树主台账行集（CRLF 归一；补登追认的比对基准——与行级校验「终树」同语义）
// 补登追认按**语义身份**比对：{doc, stage, fingerprint} 三元组——补登合法形态是补偿行
// （原 ts 早于尾行时须记现时刻 + note，内容字段沿原行），逐字节比对会漏掉全部合法补偿。
const finalLedgerRows = () => {
  try {
    return fs.readFileSync(path.join(ROOT, REL), 'utf8').replace(/\r\n/g, '\n').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } });
  } catch { return null; }
};
const restoredInFinal = (missingLines, finRows) => {
  if (!finRows) return false;
  return missingLines.every((l) => {
    let e;
    try { e = JSON.parse(l); } catch { return false; }
    return finRows.some((r) => r && r.doc === e.doc && r.stage === e.stage && r.fingerprint === e.fingerprint);
  });
};

// ---- 分片删除合法性：该分片全部非空行须逐字存在于同一提交的主台账（compact-ledgers 归并凭据）----
// 返回 null = 合法归并；否则返回原因串。
// 读法要点：分片在**该提交已被删除**，其内容从各父取并集（2026-10-13 merge-aware-shard-delete）——
//   合并收口删片时分片可能只在第二父（首父已归并删片，实证 56c45b07），单读 `${sha}^:<rel>` 会误判；
//   主台账取该提交当时的版本（归并行把分片原样追加进主台账后同提交删片，故主台账须含全部行）。
const shardDeleteReason = (sha, rel) => {
  const mainBuf = tryBlob(`${sha}:${REL}`);
  if (mainBuf === null) return `该提交无主台账 ${REL}——无法认定归并`;
  const shardLines = new Set();
  let foundInParent = false;
  for (const p of parentShas(sha)) {
    const b = tryBlob(`${p}:${rel}`);
    if (b === null) continue;
    foundInParent = true;
    for (const l of linesOf(b)) if (l.trim()) shardLines.add(l);
  }
  if (!foundInParent) return `父提交 ${sha.slice(0, 10)}^ 中无此分片（增删同提交？）——无法认定归并`;
  const mainLines = new Set(linesOf(mainBuf).filter((l) => l.trim()));
  const missing = [...shardLines].filter((l) => !mainLines.has(l));
  if (missing.length) {
    // 终树补登追认（merge-shard-restore-aware）：缺行已按语义身份回append进终树主台账 → 丢失已追认
    if (restoredInFinal(missing, finalLedgerRows())) {
      console.error(`[info] ${sha.slice(0, 10)}：${rel} 合并删片缺 ${missing.length} 行已在终树主台账补登（例：${missing[0].slice(0, 60)}…）——丢失追认，续扫`);
      return null;
    }
    return `删除时分片有 ${missing.length} 行不在同提交主台账内（例：${missing[0].slice(0, 60)}…）——只有 compact-ledgers 归并后才允许删片`;
  }
  return null;
};

// ---- 历史前缀扫描（单台账路径；2026-10-12 起主台账与分片共用）----
// allowShardDelete：分片允许「已归并后删片」这一种合法消失形态；主台账永不因归并被删。
// 返回该路径的提交史（空 = 从未入库：装户/新仓/尚在暂存区）——零史路径整体跳过，与原实现
// 「零提交历史即静默」的契约一致（行级校验也只覆盖有史的路径，否则新仓首版会被 doc 不存在误杀）。
//
// 历史索引（2026-10-27 ledger-history-index）：此前每路径各跑一次 `git log --full-history`，
// 293 条路径实测 159.4s（全门 479~798s 的主要构成）。改为**一次** `git log -m --full-history
// --name-only` 建「路径 → 提交（按时间升序）」倒排，再按路径取。等价性已逐路径比对验证：
// 293/293 完全一致（`-m` 必需——合并提交默认不输出文件列表，漏了 280 条路径的合并提交）。
// 索引构建 0.8s；代价是常驻内存一个 Map，且 --staged 档不建索引（只查暂存前缀）。
let _historyIndex;
const historyIndex = () => {
  if (_historyIndex !== undefined) return _historyIndex;
  _historyIndex = new Map();
  try {
    const out = gitText(['log', '-m', '--full-history', '--reverse', '--name-only',
      '--pretty=format:@@%H', '--', SHARD_DIR, REL]);
    let cur = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('@@')) { cur = line.slice(2).trim(); continue; }
      const p = line.trim();
      if (!cur || !p) continue;
      if (p !== REL && !isShard(p)) continue;
      let arr = _historyIndex.get(p);
      if (!arr) { arr = []; _historyIndex.set(p, arr); }
      if (arr[arr.length - 1] !== cur) arr.push(cur); // -m 会对同一提交重复列出同一路径（合并两亲）
    }
  } catch { /* 非 git / 无历史：空索引 → 各路径零史即静默（与原契约一致） */ }
  return _historyIndex;
};

function historyShas(rel) {
  // --full-history 语义保留：不做历史简化——TREESAME 合并也入列，防「合并丢一侧行」被简化隐藏。
  return historyIndex().get(rel) || [];
}

// 基线后提交集（含基线可达性探测；基线不在本仓 → null = 基线不生效，全史扫描——外来 fixture 场景）
let _postBaseline;
const postBaselineSet = () => {
  if (_postBaseline !== undefined) return _postBaseline;
  try {
    gitText(['rev-parse', '--verify', '--quiet', `${HISTORY_BASELINE}^{commit}`]);
    _postBaseline = new Set(gitText(['rev-list', `${HISTORY_BASELINE}..HEAD`]).split(/\s+/).filter(Boolean));
  } catch {
    _postBaseline = null;
  }
  return _postBaseline;
};

// 多父提交的父列表（%P 全父）
// 批量取（2026-10-27 ledger-history-index）：原先每提交一次 `git log -1 --format=%P`，
// 895 个唯一提交实测 14.7s；`git rev-list --parents <sha...>` 一次取完（实测 0.3s/300 提交）。
// 惰性：仅当首次被问到时一次性取全部已知提交的父表（索引内的提交 + HEAD）。
let _parentMap;
const parentMap = () => {
  if (_parentMap !== undefined) return _parentMap;
  _parentMap = new Map();
  try {
    const all = new Set(['HEAD']);
    for (const shas of historyIndex().values()) for (const s of shas) all.add(s);
    const list = [...all];
    const CHUNK = 200; // 命令行长度上限保护
    for (let i = 0; i < list.length; i += CHUNK) {
      const out = gitText(['rev-list', '--parents', ...list.slice(i, i + CHUNK)]);
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) continue;
        _parentMap.set(parts[0], parts.slice(1));
      }
    }
  } catch { /* 非 git：空表 → 各提交按无父处理（原实现同样退化为空数组） */ }
  return _parentMap;
};
const parentShas = (sha) => {
  const m = parentMap().get(sha);
  if (m) return m;
  // 兜底：索引未覆盖的提交（如 --rev 扫他树、浅克隆）仍逐个取，保持原语义
  try {
    return gitText(['log', '-1', '--format=%P', sha]).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
};

// 合并并集对账：cur 行集须恰为各父行集之并（无丢失、无凭空新增）。返回 null = 认可；否则返回原因。
// 父提交无此路径（单侧新增）跳过该父；行比对按整行字符串（与 linesOf/前缀判据同粒度）。
// 2026-10-15 staged-merge-union：签名自 sha 改收 parents 数组——--staged 合并态无提交 sha，
//   由调用方传 [HEAD, MERGE_HEAD…]；历史全扫与 --staged 共用本判据（不新开口子）。
const mergeUnionProblem = (parents, rel, curBuf) => {
  const curLines = new Set(linesOf(curBuf));
  const parentLines = new Set();
  for (const p of parents) {
    const b = tryBlob(`${p}:${rel}`);
    if (b === null) continue;
    for (const l of linesOf(b)) parentLines.add(l);
  }
  const lost = [...parentLines].filter((l) => !curLines.has(l));
  if (lost.length) return `合并丢失 ${lost.length} 行（例：${lost[0].slice(0, 60)}…）——union 合并不得丢行`;
  const made = [...curLines].filter((l) => !parentLines.has(l));
  if (made.length) return `合并凭空多出 ${made.length} 行（例：${made[0].slice(0, 60)}…）——合并结果须为各父行集之并`;
  return null;
};

// 合并携带 manifest 的特许修剪对账（2026-10-13 merge-prune-set，独立复核②实修）：集合口径——
//   每个 removes 哈希须恰命中父母并集中一行；cur 行集须恰为「父母并集 − 被删行集」。
//   支持「分支上修剪、合并时落地」的合法形态（修剪凭据随合并入库）；对父母并集对账（非第一父）
//   堵住 p2 独有行借 p1 相对 manifest 无凭据消失（复核实证二）。返回 null = 认可；否则原因串。
const mergePruneProblem = (parents, rel, curBuf, manifest) => {
  if (!manifest || !Array.isArray(manifest.removes) || !manifest.removes.length) return 'manifest 缺失或 removes 为空';
  const union = new Set();
  for (const p of parents) {
    const b = tryBlob(`${p}:${rel}`);
    if (b === null) continue;
    for (const l of linesOf(b)) union.add(l);
  }
  const want = new Set(manifest.removes);
  const removed = [...union].filter((l) => want.has(sha256(l)));
  if (removed.length !== manifest.removes.length) return `manifest 哈希在父母并集中命中 ${removed.length} 行 ≠ 声明 ${manifest.removes.length} 行`;
  const removedSet = new Set(removed);
  const expected = [...union].filter((l) => !removedSet.has(l));
  const expectedSet = new Set(expected);
  const curLines = new Set(linesOf(curBuf));
  const extra = [...curLines].filter((l) => !expectedSet.has(l));
  if (extra.length) return `合并多出对账外 ${extra.length} 行（例：${extra[0].slice(0, 60)}…）`;
  const stillLost = expected.filter((l) => !curLines.has(l));
  if (stillLost.length) return `合并仍丢失 manifest 外 ${stillLost.length} 行（例：${stillLost[0].slice(0, 60)}…）`;
  const docs = new Set(manifest.docs || []);
  if (docs.size) {
    for (const l of removed) {
      try {
        const doc = JSON.parse(l).doc || '';
        if (!docs.has(path.basename(doc).replace(/\.md$/, ''))) return `被删行 doc ${doc} 不在 manifest.docs 清单内`;
      } catch { return '被删行非 JSON'; }
    }
  }
  return null;
};

function scanHistory(rel, { allowShardDelete }) {
  const allShas = historyShas(rel);
  if (!allShas.length) return allShas;
  let shas = allShas;
  // 历史基线：只走基线后提交（详见头注）——DAG 感知比对下各提交自对己父，无需线性化起点
  const post = postBaselineSet();
  if (post) {
    const kept = shas.filter((sha) => post.has(sha));
    if (kept.length !== shas.length) {
      console.error(`[info] ${rel}：${shas.length - kept.length} 个前基线提交按 HISTORY_BASELINE 声明豁免（owner 授权，见脚本头注）`);
    }
    shas = kept;
  }
  for (const sha of shas) {
    let cur;
    try { cur = blobOf(`${sha}:${rel}`); } catch {
      // 删除提交不是静默边界（复核 P2 收口）：主台账在 append-only 世界里永不应删除——任一历史提交删除
      // 主台账即 hard fail（否则「删除→次提交重加」会把重加 blob 当新基线绕过前缀判据）。
      if (!allowShardDelete) {
        problems.push(`- [台账删除] ${sha.slice(0, 10)}：该提交删除了 ${rel}（append-only 世界禁删文件）`);
        continue;
      }
      const reason = shardDeleteReason(sha, rel);
      if (reason) {
        problems.push(`- [分片删除] ${sha.slice(0, 10)}：删除 ${rel} —— ${reason}`);
        continue;
      }
      console.error(`[info] ${sha.slice(0, 10)}：${rel} 归并后删除（compact-ledgers 形态，全部行已在主台账对账）`);
      continue;
    }
    // DAG 感知基准：本提交第一父的 blob（2026-10-13 dag-aware-base）——线性化「前一承」在分支汇合处
    // 会拿另一侧提交当基准产生伪前缀破坏（M2 夹具实证）；根提交（无父）视为新文件起步。
    const parents = parentShas(sha);
    const base = parents.length ? tryBlob(`${parents[0]}:${rel}`) : null;
    if (base === null) continue; // 首现（父无此路径）：无基线可比，行级校验兜底
    if (parents.length >= 2) {
      // 多父提交无条件走并集对账（2026-10-13 复核②实修：前缀通过不得短路——ours-resolution 合并
      // 树与第一父逐字节同 blob，嵌套判法对静默丢行全盲）
      const unionFail = mergeUnionProblem(parents, rel, cur);
      if (!unionFail) {
        console.error(`[info] ${sha.slice(0, 10)}：合并并集无丢失——union 合并语义认可，续扫`);
        continue;
      }
      // union 不过 → manifest 集合对账（分支修剪合并落地；对父母并集对账，非第一父）
      const setFail = mergePruneProblem(parents, rel, cur, loadManifest(`${sha}:${MANIFEST_REL}`));
      if (!setFail) {
        console.error(`[info] ${sha.slice(0, 10)}：合并携带特许修剪——父母并集集合对账通过`);
        continue;
      }
      problems.push(`- [前缀破坏] ${sha.slice(0, 10)}（合并）：${rel} 并集对账失败：${unionFail}；修剪集合对账：${setFail}`);
      continue;
    }
    if (!cur.subarray(0, base.length).equals(base)) {
      // 前缀破坏 → 该提交树上携带 manifest 且逐行对账 = 特许修剪（loud 记录）；
      //   修剪不匹配再试特许重建（rebuild manifest + finalRows 指纹清单，2026-10-15 ledger-rebuild-manifest）
      const m = matchPrune(base, cur, loadManifest(`${sha}:${MANIFEST_REL}`));
      if (m && !m.err) {
        console.error(`[info] ${sha.slice(0, 10)}：特许修剪 ${m.removed} 行（${(m.docs || []).length} 家族）——manifest 对账通过`);
      } else {
        const rb = matchRebuild(base, cur, loadManifest(`${sha}:${REBUILD_MANIFEST_REL}`));
        if (rb && !rb.err) {
          console.error(`[info] ${sha.slice(0, 10)}：特许重建 ${rb.removed > 0 ? `${rb.removed} 副本` : '纯重排（零删除、零新增）'} → 终态 ${rb.rows} 行——finalRows 指纹对账通过`);
        } else {
        let off = 0;
        while (off < Math.min(base.length, cur.length) && base[off] === cur[off]) off++;
        const removed = base.length > cur.length;
        problems.push(`- [前缀破坏] ${sha.slice(0, 10)}（父 ${parents[0].slice(0, 10)}）：${rel} 历史内容被${removed ? `删减 ${base.length - cur.length}B` : `改写（首异偏移 ${off}，旧 ${base.length}B → 新 ${cur.length}B）`}${m && m.err ? `；特许修剪对账失败：${m.err}` : ''}${rb && rb.err ? `；特许重建对账失败：${rb.err}` : ''}`);
        }
      }
    }
  }
  return allShas; // 交回该路径的全量提交史，供调用方判定「有史才进行级校验」
}

// ---- 行级校验（单文件终树，五项）----
function checkRows(text, label) {
  const rows = String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  let prevTs = '';
  rows.forEach((e, idx) => {
    const at = `${label} 第 ${idx + 1} 行`;
    if (!e || typeof e !== 'object') { problems.push(`- [行级] ${at}：非 JSON 对象行`); return; }
    // kind 判别（2026-10-27 confirm-task-row）：无 kind = doc 绑定行走既有五项校验（行为零变化）；
    //   kind:"task" = MCP confirm 的任务级确认行——只验 {ts,task,decision,evidence,fingerprint} 五字段
    //   在场 + 指纹 64 hex（① 时序单调照常：append-only 不变量与行形态无关），不要求 doc/stage；
    //   其他 kind 值 = 违规行（拼错判别键即拦，防「看似新形态实为 typo」的行静默溜进台账）。
    if (typeof e.kind === 'string' && e.kind !== 'task') {
      problems.push(`- [行级] ${at}：未知 kind「${e.kind}」（合法值只有 task；doc 绑定行不写 kind）`);
      return;
    }
    if (e.kind === 'task') {
      if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) problems.push(`- [行级] ${at}：ts 非 ISO 字符串`);
      else {
        if (prevTs && e.ts < prevTs) problems.push(`- [行级] ${at}：ts ${e.ts} 早于前行 ${prevTs}（追加时序非单调）`);
        prevTs = e.ts;
      }
      for (const k of ['task', 'decision', 'evidence']) {
        if (typeof e[k] !== 'string' || !e[k].trim()) problems.push(`- [行级] ${at}：task 行缺非空 ${k}`);
      }
      if (typeof e.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(e.fingerprint)) {
        problems.push(`- [行级] ${at}：fingerprint 非 64 位 hex`);
      }
      return;
    }
    if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) problems.push(`- [行级] ${at}：ts 非 ISO 字符串`);
    else {
      if (prevTs && e.ts < prevTs) problems.push(`- [行级] ${at}：ts ${e.ts} 早于前行 ${prevTs}（追加时序非单调）`);
      prevTs = e.ts;
    }
    const isRevertNote = typeof e.stage === 'string' && e.stage.startsWith('revert-');
    if (isRevertNote) {
      if (e.fingerprint !== 'n/a') problems.push(`- [行级] ${at}：回退注记行 fingerprint 恒为「n/a」`);
    } else if (typeof e.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(e.fingerprint)) {
      problems.push(`- [行级] ${at}：fingerprint 非 64 位 hex`);
    }
    // ④' 承诺面指纹（approved-content-binding 2026-10-27）：纯增字段、向后兼容——存量行无此键即跳过；
    // 有则须为 16 位 hex（判据单源 stage-gates.commitmentFingerprint）。
    if (typeof e.commit !== 'undefined' && (typeof e.commit !== 'string' || !/^[0-9a-f]{16}$/.test(e.commit))) {
      problems.push(`- [行级] ${at}：commit 非 16 位 hex（承诺面指纹）`);
    }
    if (e.source === 'chat-delegated' && !(typeof e.quote === 'string' && e.quote.trim())) problems.push(`- [行级] ${at}：chat-delegated 行缺非空 quote（原话对质面）`);
    if (typeof e.doc !== 'string' || !/^workflow\/(intents|specs|plans|incidents)\/[^/]+\.md$/.test(e.doc)) {
      problems.push(`- [行级] ${at}：doc 路径不在 workflow 四目录协议内`);
    } else if (!docExists(e.doc)) {
      problems.push(`- [行级] ${at}：doc ${e.doc} 在当前树不存在（四目录与归档批次均未命中）`);
    }
    if (!VALID_STAGES.has(e.stage)) problems.push(`- [行级] ${at}：stage「${e.stage || '缺失'}」不在合法跳转终态集`);
  });
}

// ---- 台账路径全集：主台账 + 历史上出现过的全部分片 ----
// 历史分片名单复用 historyIndex()（2026-10-27）——不再单独跑一次 log，且与 historyShas 同源，
// 避免「路径全集」与「各路径提交史」两处口径漂移。
function ledgerPaths() {
  const rels = [REL];
  try {
    for (const p of historyIndex().keys()) if (isShard(p) && !rels.includes(p)) rels.push(p);
  } catch { /* 非 git 或无历史：仅主台账 */ }
  // 工作区里新出现（尚未入库）的分片也要进行 --staged 前缀判定
  try {
    const dir = path.join(ROOT, SHARD_DIR);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const f of fs.readdirSync(dir)) {
        const p = `${SHARD_DIR}/${f}`;
        if (isShard(p) && !rels.includes(p)) rels.push(p);
      }
    }
  } catch { /* 忽略 */ }
  return rels;
}

// ---- --staged：各暂存台账文件 ⊇ 对应 HEAD 版本，或携带 manifest 的特许修剪 ----
// 合并态口径（2026-10-14 staged-merge-prune）：MERGE_HEAD 在场时暂存内容是**多父合并结果**，单看 HEAD
//   一父不够——「分支上修剪、合并时落地」的合法形态下暂存 = 父母并集 − removes，其中还含对方分支的
//   新增/补偿行，故严格等式（HEAD − removes）必然不等而误拦（2026-10-14 实测：本仓合并 origin/develop
//   时 HEAD 529 行、远端修剪后 283 行，等式差 37 行全是对方合法新增）。此时在严格等格外**再试父母并集
//   集合对账**——与历史全扫同一函数 mergePruneProblem、同一口径，不新开口子：manifest 哈希须在并集中
//   恰命中、并集 − 被删行须与暂存逐行相等（既禁丢行也禁凭空行）。非合并态不启用，单父写入红线不变。
const mergeParents = (() => {
  const r = spawnSync('git', ['rev-parse', 'MERGE_HEAD'], { cwd: ROOT, encoding: 'utf8' }); // octopus 可多行
  if (r.status !== 0) return null; // 非合并态；spawnSync 吞 stderr，不外泄 fatal 噪声
  const shas = String(r.stdout || '').split(/\s+/).filter(Boolean);
  if (!shas.length) return null;
  const h = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return [String(h.stdout || '').trim(), ...shas];
})();
if (staged) {
  const stagedHit = gitText(['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only']).split(/\r?\n/);
  const touched = ledgerPaths().filter((rel) => stagedHit.includes(rel));
  if (!touched.length) process.exit(0);
  for (const rel of touched) {
    const headExists = (() => { try { gitText(['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]); return true; } catch { return false; } })();
    if (!headExists) continue; // 首次入库：无 HEAD 基线，历史全扫与终树行级校验覆盖
    let head, cur;
    try {
      head = blobOf(`HEAD:${rel}`);
      cur = blobOf(`:${rel}`); // 暂存区
    } catch {
      continue; // 对象读取异常（如极端并发）交由 CI 全扫兜底
    }
    if (!cur.subarray(0, head.length).equals(head)) {
      // 前缀破坏 → 尝试特许修剪对账（manifest 必须同在暂存集）
      const manifest = loadManifest(`:${MANIFEST_REL}`);
      const m = matchPrune(head, cur, manifest);
      if (m && !m.err) {
        console.log(`台账不变量（--staged）— ${rel} 特许修剪通过：移除 ${m.removed} 行（${(m.docs || []).length} 家族）——凭据 ${MANIFEST_REL} 随笔入库，被删行可在 git 历史对质`);
        continue;
      }
      // 特许重建对账（2026-10-15 ledger-rebuild-manifest）：rebuild manifest 须同在暂存集
      const rb = matchRebuild(head, cur, loadManifest(`:${REBUILD_MANIFEST_REL}`));
      if (rb && !rb.err) {
        console.log(`台账不变量（--staged）— ${rel} 特许重建通过：${rb.removed > 0 ? `删重复副本 ${rb.removed} 行` : '纯重排（零删除、零新增）'}、终态 ${rb.rows} 行与 finalRows 指纹清单逐行一致——凭据 ${REBUILD_MANIFEST_REL} 随笔入库，差集可对质`);
        continue;
      }
      // 合并态：严格等式不适用 → 先纯并集对账（2026-10-15 staged-merge-union：与历史全扫同一函数
      // mergeUnionProblem、同一判据。实战动机：本地侧自分叉基线未动台账时，三方合并整体取远端版——
      // 其行序相对 HEAD 可为重排/中插（远端按 ts 时序插入），前缀判据必假阳性；并集「无丢失、无凭空行」
      // 才是审计实质。判负再落 manifest 修剪对账，与历史全扫的判定顺序一致）。
      const unionFail = mergeParents ? mergeUnionProblem(mergeParents, rel, cur) : '非合并态';
      if (!unionFail) {
        console.log(`台账不变量（--staged）— ${rel} 合并并集无丢失认可（${mergeParents.length} 父）——暂存行集恰为父母行集之并（无丢失、无凭空行），union 语义与历史全扫同口径`);
        continue;
      }
      const setErr = mergeParents ? mergePruneProblem(mergeParents, rel, cur, manifest) : '非合并态';
      if (!setErr) {
        console.log(`台账不变量（--staged）— ${rel} 合并携带特许修剪通过：父母并集集合对账认可（${mergeParents.length} 父）——凭据 ${MANIFEST_REL} 随笔入库，被删行可在 git 历史对质`);
        continue;
      }
      let off = 0;
      while (off < Math.min(head.length, cur.length) && head[off] === cur[off]) off++;
      problems.push(`- [台账重写] ${rel} 暂存内容不是 HEAD 的前缀扩展（首异偏移 ${off}，HEAD ${head.length}B → 暂存 ${cur.length}B）${m && m.err ? `；特许修剪对账失败：${m.err}` : ''}${rb && rb.err ? `；特许重建对账失败：${rb.err}` : ''}${mergeParents ? `；合并并集集合对账亦失败：${setErr}` : ''}${mergeParents ? `；合并纯并集对账失败：${unionFail}` : ''}`);
    }
  }
  if (problems.length) {
    console.error('台账不可变（--staged）— BLOCK:\n' + problems.join('\n'));
    console.error('  修法：台账历史行禁删改——误写走追加补偿行（node .agents/scripts/confirm-doc.mjs ...）；所有者明令清理须携带逐行 sha256 的 ledger-prune-manifest.json 同笔暂存');
    if (problems.some((p) => p.startsWith('- [台账重写] .agents/confirmations.d/'))) {
      console.error('  分片重写另因：分片按 doc 命名、单端追加；跨端并发确认同一 doc 时须有 merge=jsonl-union 驱动（node .agents/scripts/check-local-gates.mjs --fix 配置）——驱动生效则合并自动取并集、不破坏前缀');
    }
    process.exit(1);
  }
  process.exit(0);
}

// ---- 历史全扫（缺省）----
// 有提交史的路径才进历史扫描**与终树行级校验**——零史路径（装户/新仓/尚在暂存区）整体跳过，
// 与原实现「零提交历史即静默」的契约一致（否则新仓首版会被 doc 不存在误杀）。
const withHistory = new Set();
{
  // 批量预取（2026-10-27 ledger-history-index）：扫描会读「每路径每提交的 blob」与「每父每路径的 blob」，
  // 先按索引把全部候选 ref 一次喂给 cat-file（2397 次 show 122.7s → 一次批读 0.5s）。
  // 只预取基线后的提交——基线前的提交在 scanHistory 里本就被过滤，不读其 blob。
  const post = postBaselineSet();
  const rels = ledgerPaths();
  const refs = [];
  for (const rel of rels) {
    const shas = (historyIndex().get(rel) || []).filter((s) => !post || post.has(s));
    for (const sha of shas) {
      refs.push(`${sha}:${rel}`);
      const parents = parentMap().get(sha) || [];
      for (const p of parents) refs.push(`${p}:${rel}`);
    }
  }
  // manifest 也走批读（每次前缀破坏都要探测两本）
  for (const sha of new Set(refs.map((r) => r.split(':')[0]))) {
    refs.push(`${sha}:${MANIFEST_REL}`, `${sha}:${REBUILD_MANIFEST_REL}`);
  }
  warmBlobs(refs);
}
for (const rel of ledgerPaths()) {
  const shas = scanHistory(rel, { allowShardDelete: isShard(rel) });
  if (shas && shas.length) withHistory.add(rel);
}

// ---- 行级校验（终树：主台账 + 各现存分片；仅覆盖有提交史的路径）----
const finalRels = [REL];
try {
  const dir = path.join(ROOT, SHARD_DIR);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir)) {
      const p = `${SHARD_DIR}/${f}`;
      if (isShard(p)) finalRels.push(p);
    }
  }
} catch { /* 忽略 */ }
for (const rel of finalRels) {
  if (!withHistory.has(rel)) continue; // 零提交历史：无基线可校验，静默跳过
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  checkRows(text, rel === REL ? '主台账' : path.basename(rel));
}

if (problems.length) {
  console.error(`台账不可变（历史全扫）— HARD-BLOCK:\n\n${problems.join('\n')}\n`);
  console.error('  修法：台账历史行禁删改（append-only 前缀不变量）——误写只能追加补偿行；确需撤销历史提交请 git revert 后重新追加。篡改属审计事件，保留现场联系仓库所有者。');
  process.exit(1);
}
process.exit(0);
