// verify-scope.mjs — verify.mjs diff 面增量关单的纯逻辑（verify-diet 2026-10-21 ②；复核修复 2026-10-21）
// 口径：--scope 取「基线..HEAD ∪ 工作区(含暂存) ∪ untracked」变更面，未被面触及的产品**重门**跳过；
// 密钥扫描 + wiki 三方一致性 + 关单主干引擎门恒跑（scripts-syntax/workflows-check/rule-budget/
// effective-policy 秒级、check-loop / lane-surface-ci 是关单本体——后端改动可能使 wiki 断言漂移，
// 故 wiki 门也不按面裁剪）。engine-tests（verify-diet 二批 2026-10-21 P0-1）按引擎代码面裁剪（见下）。
// 面触及对应路径 = 相应门自然回列（skipped 收缩）。
// 基线选择：优先「最近一次全量（非 scope）绿行」的 headShort（调用方自本地台账 ∪ 仓库凭证
// workflow/verify-evidence.md 读出，须为 HEAD 祖先），否则回落 merge-base(origin/main, HEAD)。
// 前者让 scope 在长生命特性分支上可用（上次全量绿后只动文档 → 增量）；后者是冷启动基线。
// 仓库凭证兜底（verify-evidence-fallback 2026-10-22）：新 worktree 无本地台账时不再必然重付全量税。
// 两态都**过包含**（基线越旧面越大 → 产品门多跑，安全侧）。
// fail-loud：基线解析失败 / diff 面为空 → 抛错拒增量（跑全量），不猜。
// 面源三路（复核 P1 修复）：committed diff 须 --no-renames（rename 只报目的地会隐藏产品源路径）、
// 工作区 diff、untracked（ls-files --others——未 add 的新后端文件也必须算面，否则 scope 凭证对
// 「含未编译后端代码的树」做假担保）。凭证：scope 绿行 entry.scope = { mode, base, baseSource,
// skipped, fileCount }——gen-verify-evidence 渲染进摘要行；hasFreshVerifyLine 认其为合法关单凭证
// （面计算已担保「基线以来未触对应产品路径」，与 24h 窗同信任级；关单前新提交须重跑——先提交、后跑门）。

// 产品重门 ←→ 变更面匹配（前缀大小写不敏感——case-only 改名 / Linux CI 检出下不逃逸）。
// backend 面含 .sql 后缀兜底（防根级数据维护 SQL 绕过；存量 SQL 全在 backend/ 下已由前缀覆盖）；
// 亦含 scripts/verify/backend/（backend-build/backend-test 门的执行器自身——2026-10-24 复核 P1 修复：
// 该路径此前 face/scope/语法门/run-tests 四重守护全不触及，只改执行器的提交会静默跳过整个 backend 门）。
// 收窄到 backend/ 子目录（2026-10-24 复核 m3）：business/（约 70 个 UI 实测脚本）与 e2e/ 改动不驱动
// backend 重门；新增共享模块须放 scripts/verify/backend/ 或在此显式加前缀。
export const PRODUCT_FACES = [
  {
    face: 'backend',
    gates: ['backend-build', 'backend-test'],
    match: (f) => /^(backend|tests|scripts\/verify\/backend)\//i.test(f) || /\.(cs|sln|csproj|props|targets|sql)$/i.test(f),
  },
  {
    face: 'frontend',
    gates: ['frontend-lint', 'frontend-unit-test', 'frontend-build'],
    match: (f) => /^frontend\//i.test(f),
  },
];

// 台账触及面（2026-10-24 复核 P1）：ledger-invariant 不再无条件退 CI-only——本地默认档（diff）在
// commit/worktree/untracked 触及 confirmations 台账或其 manifest 时回列全史扫描（台账改动才付 ~90s），
// 未触及仍 loud-skip。全量档（无 scope）与 CI 照跑。判据只加字段，不改 GATE_FACES/skipped 口径
// （避免与既有门表计数、--list 契约耦合）。
export const LEDGER_TOUCH_RE = /^\.agents\/confirmations(?:\.jsonl|\.d\/)|^\.agents\/config\/ledger-.*manifest\.json$/i;

// 引擎自检面（2026-10-23 改口径）：engine-code 触面 → engine-tests 全量；业务面 → verify 降为 --fast
// （不再整门跳过）。面 = .agents/ 全部 + .githooks/（pre-push.test 等直读钩子源）+ 根 package.json。workflow/ 文档不进面。
export const ENGINE_TEST_FACE = {
  face: 'engine-code',
  gates: ['engine-tests'],
  match: (f) => /^(\.agents|\.githooks)\//i.test(f) || /^package\.json$/i.test(f),
};

const GATE_FACES = [...PRODUCT_FACES, ENGINE_TEST_FACE];

// 仓库级绿凭证（verify-evidence-fallback 2026-10-22）：workflow/verify-evidence.md 是入库的追加保全
// 摘要（gen-verify-evidence.mjs 生成），每行 = 某基线提交过全量门禁全绿。本地台账
// （.agents/verifications.jsonl）per-worktree 且 gitignore——新 worktree 无绿行时默认档会退回全量
// （verify.mjs 24h 兜底）。本解析把「仓库级绿行」纳入基线候选：跨树/跨机不再重付全量税；基线仍须过
// merge-base --is-ancestor（非祖先 = 别的分支/rebase 残留，拒用）。
// 只认全量行：末列以 `scope=`（门被裁过）或 `fast=`（engine-tests 降 --fast 的裁剪绿，
// 2026-10-24 复核 P1-5）开头的是增量/降档凭证，不能当全量锚；其余（`—` 或 runId）皆全量。
export const EVIDENCE_REL = 'workflow/verify-evidence.md';
const EVIDENCE_ROW_RE = /^\|\s*`([0-9a-f]{7,40})`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/;

/** 解析摘要文件 → 全量绿行 [{ headShort, ts }]（坏行/表头/scope 行跳过，不抛）。 */
export function parseEvidenceGreens(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.trim().match(EVIDENCE_ROW_RE);
    if (!m) continue;
    // skip-env（2026-10-27 anchor-envskip）：带 CI-only 门跳过标记的绿行实跑门数 < 门表，
    // 与 scope/fast 同属「裁剪凭证」，不得作全量锚（否则跨机基线建立在漏跑门的树上）。
    if (/^(scope|fast|skip-env)=/.test(m[5].trim())) continue;
    const ts = m[2].trim();
    if (!Number.isFinite(Date.parse(ts))) continue;
    out.push({ headShort: m[1], ts });
  }
  return out;
}

/**
 * 纯分类：变更路径数组（POSIX 斜杠）→ { touched:Set<face>, skippedGateIds:string[], matched:string[] }。
 * 路径按「面序」归属——一条路径只归一个面（backend/tests 前缀优先于扩展名兜底的次序即数组序）。
 */
export function classifyFace(files) {
  const touched = new Set();
  const matched = [];
  for (const raw of files || []) {
    const f = String(raw).replace(/\\/g, '/');
    for (const pf of GATE_FACES) {
      if (pf.match(f)) { touched.add(pf.face); matched.push(f); break; }
    }
  }
  const skippedGateIds = GATE_FACES.filter((pf) => !touched.has(pf.face)).flatMap((pf) => pf.gates);
  return { touched, skippedGateIds, matched };
}

/**
 * 组装 scope：git(args) 注入（返回 { status, stdout }，cwd=仓库根），便于夹具测试；
 * baseHint = 调用方选出的「最近全量绿行 headShort」（可为 null）；baseSourceHint = 该 hint 的来源
 * （'ledger' 本地台账 | 'evidence' 仓库凭证），原样写进凭证供审计对质。
 * 返回 { baseShort, baseSource:'ledger'|'evidence'|'origin/main', fileCount, touched, skippedGateIds, matched }；
 * 任何解析失败抛 Error（中文，直出 stderr）。
 */
export function computeDiffScope(git, baseHint = null, baseSourceHint = 'ledger') {
  const out = (args) => {
    const r = git(args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败——无法确定增量基线（先 git fetch origin，或跑全量 verify）`);
    return String(r.stdout || '').trim();
  };
  const head = out(['rev-parse', 'HEAD']);
  let base = null;
  let baseSource = null;
  if (baseHint) {
    const anc = git(['merge-base', '--is-ancestor', baseHint, head]);
    if (anc.status === 0) { base = baseHint; baseSource = baseSourceHint; }
  }
  if (!base) {
    base = out(['merge-base', 'origin/main', 'HEAD']);
    baseSource = 'origin/main';
  }
  const baseShort = out(['rev-parse', '--short', base]);
  const committed = out(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${base}..${head}`])
    .split(/\r?\n/).filter(Boolean);
  const worktree = out(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', 'HEAD'])
    .split(/\r?\n/).filter(Boolean);
  // untracked 亦须 quotepath=off（2026-10-24 复核 M2）：默认 core.quotepath=true 时非 ASCII 路径被
  // 加引号转义（"backend/\344\270\255..."），前缀与扩展名双双失配 → 新后端文件逃出变更面、scope 绿行假担保
  const untracked = out(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/).filter(Boolean);
  const files = [...new Set([...committed, ...worktree, ...untracked])];
  if (!files.length) {
    throw new Error('diff 面为空（基线以来无任何变更）——无增量依据，跑全量 verify');
  }
  const cls = classifyFace(files);
  return {
    baseShort,
    baseSource,
    fileCount: files.length,
    touched: cls.touched,
    skippedGateIds: cls.skippedGateIds,
    matched: cls.matched,
    // 台账触及（ledger-invariant 本地回列判据；见头注 LEDGER_TOUCH_RE）
    ledgerTouched: files.some((f) => LEDGER_TOUCH_RE.test(String(f).replace(/\\/g, '/'))),
  };
}
