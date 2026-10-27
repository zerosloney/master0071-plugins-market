// check-loop-kit.mjs — 闭环门禁基础设施层（2026-10-10 收敛系列 4a：自 check-loop.mjs 原位切出，
//   逐字未改；check-loop.mjs 以解构铺平消费、段体零漂移）。被 import 即执行（ROOT 解析/枚举加载
//   /git 索引构建）——沿主脚本「无 isMain 守卫」既有语义，仅限 check-loop.mjs 与 section 模块 import。
// 拆分挂起（2026-10-11 C6 定案）：本层「~30 符号含可变共享态铺给全部 24 段」是迁移装置的历史遗留
//   （零观测故障 + 高爆炸半径）——缓修，触发条件 = 下次必触本层时以零漂移技法（机械 re-export 垫片 +
//   逐字节等价比对）改窄接口，勿顺手重构。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnums } from './workflow-enums.mjs';
import { delegationRowsOf } from './delegation-presence.mjs';
import { runCheck16 } from './check-metric-claims.mjs';
import { auditEnabled, loadKitPolicy, hasFreshVerifyLine } from './policy.mjs';
import { laneOfDoc } from './stage-gates.mjs';
// MARK_RE：incident 留痕形态的单源（第七轮复核 N3——此前 check-loop 内联复制一份同口径字面量，
// 两处靠注释与人工同步；改为复用 stage-gates.mjs 的导出，从结构上消除漂移可能）
import { MARK_RE, approvedTraceIndex, commitmentFingerprint } from './stage-gates.mjs';
import { GIT, spawnGit as coreSpawnGit, gitOut as coreGitOut, clearGitCache } from './git-core.mjs';
// 路径收口（2026-10-27 插件化迁移）：脚本落位 / 项目根 / 台账根常量由 paths.mjs 单源供给。
// 脚本是插件资产（留插件内，不落用户项目）；项目根仍 git root 锚定（CHECK_LOOP_ROOT fixture 注入原样保留）。
import { PLUGIN_SCRIPTS_DIR, findProjectRoot, WF_REL } from './paths.mjs';

const SCRIPT_DIR = PLUGIN_SCRIPTS_DIR;

function usage() {
  console.error('check-loop: 用法 node check-loop.mjs [--rev <sha>] [--all | --hygiene]');
  console.error('  默认只跑硬门（配对/判低/指纹/证据/发版未收口）。--hygiene 只跑卫生段。--all 两段都跑。');
  process.exit(1);
}
function takeOpts() {
  const args = process.argv.slice(2);
  const opts = { rev: null, mode: 'hard' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rev') {
      opts.rev = args[++i] ?? '';
      if (!opts.rev) usage();
    } else if (args[i] === '--all') {
      if (opts.mode === 'hygiene') usage();
      opts.mode = 'all';
    } else if (args[i] === '--hygiene') {
      if (opts.mode === 'all') usage();
      opts.mode = 'hygiene';
    } else usage();
  }
  return opts;
}
// 仅当本模块由 check-loop.mjs 直接运行时解析 CLI 参数；被其他脚本 import（如 append-compensation.mjs
// 复用 bindingSha256）时不得解析——否则 import 侧会因参数不匹配直接 usage() 退出（2026-10-25 实测踩坑）。
const IS_CHECK_LOOP_MAIN = (process.argv[1] || '').endsWith('check-loop.mjs');
const { rev: REV_ARG, mode: LOOP_MODE } = IS_CHECK_LOOP_MAIN ? takeOpts() : { rev: null, mode: 'hard' };
if (REV_ARG && process.env.CHECK_LOOP_ROOT) {
  console.error('check-loop: CHECK_LOOP_ROOT 与 --rev 不能同时使用');
  process.exit(1);
}
if (REV_ARG && /^0+$/.test(REV_ARG)) {
  console.error(`check-loop: --rev 不是提交 ${REV_ARG}`);
  process.exit(1);
}
let REV = null;

// ---- 根目录与枚举单源 ----
let ROOT;
let MAIN_ROOT;
if (process.env.CHECK_LOOP_ROOT) {
  ROOT = path.resolve(process.env.CHECK_LOOP_ROOT);
  if (!fs.existsSync(ROOT)) {
    console.error('check-loop: CHECK_LOOP_ROOT 不可访问:' + process.env.CHECK_LOOP_ROOT);
    process.exit(1);
  }
  MAIN_ROOT = ROOT;
} else {
  const top = findProjectRoot(); // git root 锚定（rev-parse --show-toplevel），不锚 cwd——paths.mjs 单源
  if (top === null) {
    if (REV_ARG) {
      console.error(`check-loop: --rev 剥不到提交 ${REV_ARG}`);
      process.exit(1);
    }
    console.error('check-loop: 不在 git 仓库内,跳过扫描');
    process.exit(0);
  }
  ROOT = top.trim();
  MAIN_ROOT = ROOT;
  if (REV_ARG) {
    const peeled = gitOut(['rev-parse', '--verify', `${REV_ARG}^{commit}`]);
    if (!peeled) {
      console.error(`check-loop: --rev 剥不到提交 ${REV_ARG}`);
      process.exit(1);
    }
    REV = peeled.trim();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rev-'));
    const wt = path.join(parent, 'wt');
    const main = ROOT;
    const add = spawnSync(GIT, ['worktree', 'add', '--detach', '--quiet', wt, REV], {
      cwd: main, encoding: 'utf8',
    });
    if (add.status !== 0) {
      fs.rmSync(parent, { recursive: true, force: true });
      console.error(`check-loop: 导出提交失败 ${REV_ARG}\n${add.stderr || add.stdout || ''}`);
      process.exit(1);
    }
    process.on('exit', () => {
      spawnSync(GIT, ['worktree', 'remove', '--force', wt], { cwd: main });
      fs.rmSync(parent, { recursive: true, force: true });
    });
    ROOT = wt;
    clearGitCache(); // 换根（main→worktree）后作废缓存（core 键含 cwd，此为防御性清空）
  }
}
// 枚举单源（<root>/.agents/config/workflow-enums.txt——fixture 契约：缺文件/缺键 fail-loud）
let ENUMS;
try {
  ENUMS = loadEnums(path.join(ROOT, '.agents', 'config', 'workflow-enums.txt'));
} catch (e) {
  const msg = String(e.message || '');
  if (msg.includes('不可读')) {
    console.error(`check-loop: 缺 ${path.join('.agents', 'config', 'workflow-enums.txt')}(枚举单源)——本仓自有件，从 git 历史恢复后重试`);
  } else {
    console.error('check-loop: 枚举单源 ' + msg);
  }
  process.exit(1);
}
const inSet = (v, arr) => arr.includes(v);
const stOkDoc = (st) => inSet(st, ENUMS['doc.status.confirmed']);

// git 调用单源（2026-10-10 收敛系列 5）：git-core 供给（记忆化/瞬时重试/基础设施响亮出账），
// cwd 恒本仓 ROOT。语义沿革（2026-10-05-gitout-fail-open）见 git-core.mjs 头注。
function spawnGit(args) {
  return coreSpawnGit(args, ROOT);
}
function gitOut(args, { ok = () => true } = {}) {
  return coreGitOut(args, ROOT, { ok });
}

// 测试绿凭证只在本机。--rev 把 ROOT 换成临时 worktree，gitignore 的 verifications.jsonl
// 不会出现在那棵树上。文件不在树上时回退主工作区；树上已有文件仍以树为准。
// 非 --rev（含 CHECK_LOOP_ROOT）不回退，避免夹具读到开发者自己的凭证。
function readVerifyLedgerText() {
  const name = path.join('.agents', 'verifications.jsonl');
  const primary = path.join(ROOT, name);
  try {
    if (fs.existsSync(primary)) return fs.readFileSync(primary, 'utf8');
    if (!REV || !MAIN_ROOT || path.resolve(MAIN_ROOT) === path.resolve(ROOT)) return null;
    const fallback = path.join(MAIN_ROOT, name);
    if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8');
  } catch {
    return null;
  }
  return null;
}

// ---- frontmatter 受限子集读取（fm_get 语义：首行 --- 进入、下一 --- 闭合、键在行首、首个命中、值两侧去空白）----
// fs 读取同走 fail-loud（2026-10-05-gitout-fail-open 实现期诊断追加，与 spawnGit 同一故障类）：
// readFileSync 瞬时异常（宿主资源压力 EMFILE/共享冲突类）重试一次，仍失败响亮出账（进程级去重）
// 后按 null 降级——调用方按空文档跳过该件，但异常本身不再静默
let fsReadWarned = new Set();
const fileLinesCache = new Map();
function linesOf(file) {
  if (!fileLinesCache.has(file)) {
    let lines = null;
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch (e) {
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { lines = null; }
      if (!lines && !fsReadWarned.has(file)) {
        fsReadWarned.add(file);
        console.error(`check-loop: 文档读取异常 ${path.basename(file)}（${e.code || e.message}）——按空文档降级，检查面可能收窄`);
      }
    }
    fileLinesCache.set(file, lines);
  }
  return fileLinesCache.get(file);
}
function fmGet(file, key) {
  const lines = linesOf(file);
  if (!lines) return '';
  const isDelim = (l) => /^---\s*$/.test(l);
  if (!isDelim(lines[0] || '')) return '';
  for (let i = 1; i < lines.length; i++) {
    if (isDelim(lines[i])) return '';
    if (lines[i].startsWith(key + ':')) return lines[i].slice(key.length + 1).trim();
  }
  return '';
}

const WF = WF_REL; // 台账根相对位（'workflow'）——paths.mjs 单源（§5.2 项目级不变量）
const DOC_DIRS = ['intents', 'specs', 'plans', 'incidents'];
const blockers = [];
const warnings = [];
// audit:false（init 新装）只保留 blockers。缺省与 audit:true 保持全量警告。
// 硬规则：配对 / 验收勾验的阻断 / 确认留痕 / 发版草稿。卫生项走 warnings。
const kitPolicy = loadKitPolicy(ROOT);
if (!auditEnabled(kitPolicy)) {
  warnings.push = () => warnings.length;
}

// ---- 已提交(HEAD)过滤：仓库模式只扫 tracked（fixture 模式恒真；ls-tree 失败退化全扫）----
let trackedSet = null; // null = 不过滤
if (!process.env.CHECK_LOOP_ROOT) {
  const out = gitOut(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'workflow']);
  if (out !== null) trackedSet = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
}
const isTracked = (abs) => trackedSet === null || trackedSet.has(path.relative(ROOT, abs).split(path.sep).join('/'));
const docFiles = (sub) => {
  const dir = path.join(ROOT, WF, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && /^\d/.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => isTracked(f))
    .sort();
};


// --- 共享：文件「首次加入 git」的日期索引（check8-git-anchor）---
// 用途：检查 8 的生效日锚从**可手填的文件名前缀**（项目命名规范本身即 `YYYY-MM-DD-<主题>`，作者
// 日常手写该前缀，「写早」零成本、顺手即发生——一条 hard 门可被平凡绕过）改为**首次加入 git 的日期**。
// **诚实边界（复核 P1 更正）**：该锚取 `git log --diff-filter=A --format=@%aI`，即 **author date
// （作者自报时间戳）**，**不是** commit 时刻——`git commit --date=<过去>` 一条参数即可伪造，故
// 「锚不可手填」的说法**不成立**。本改动的确切收益是：关掉「改文件名（日常必写、零成本）」这条通道，
// 把伪造成本抬到「主动加参数伪造时间戳」——后者与「伪造台账」同属**本地信任边界内不可机器防**的范畴
// （事后对质靠 git 历史与台账）。此处如实声明，不宣称「通道已关闭」。
// 口径：git 按时间新→旧遍历，同一文件首遇即最早那次加入（与检查 10 的 addpath 同款判据）。
// 非 git / 命令失败 → null，调用方按既有「非 git 跳过」语义退化（不 fail-loud）。
// 注：检查 10 需要的是「文件→加入 commit」+「commit→文件清单」两份映射（判断同提交是否触及迁移 SQL），
// 与本索引「文件→日期」不同构，故**不合并**——避免把两处判据耦死。
const addedDates = (() => {
  if (gitOut(['rev-parse', '--git-dir']) === null) return null;
  const log = gitOut(['log', '--diff-filter=A', '--format=@%aI', '--name-only']);
  if (log === null) return null;
  const m = new Map();
  let cur = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) { cur = line.slice(1); continue; }
    if (line.trim() && cur && !m.has(line.trim())) m.set(line.trim(), cur); // 新→旧序首遇 = 最早
  }
  return m;
})();
// 某文档「首次加入日期」（YYYY-MM-DD）；不可判定（非 git / 查不到）返回 ''
const addedDateOf = (absDoc) => {
  if (!addedDates) return '';
  const rel = path.relative(ROOT, absDoc).split(path.sep).join('/');
  const iso = addedDates.get(rel);
  return iso ? iso.slice(0, 10) : '';
};


// 豁免/放行分支出账（fail-loud 口径——「裁决消失」不可归因的教训：豁免路径零痕迹；
// 2026-10-05-check8-digit-sha-misfire）：按 type 进程级去重，每类至多一条；stderr 不改 stdout 协议
const evidenceExemptWarned = new Set();
function warnEvidenceExempt(type, base) {
  if (evidenceExemptWarned.has(type)) return;
  evidenceExemptWarned.add(type);
  console.error(`check-loop: 证据豁免 ${type} ${base}——该文档的验收证据未做真相核验`);
}

// 证据真相校验：检查证据字符串是否包含合法的 commit SHA，且该 commit 触及了 plan 声明的文件
// 测试绿声明对账（verify-evidence）：ctx = { verifyRelevant, hasFresh } 时，无 SHA 且命中
// 关键词的证据走凭证对账——有 24h 绿行 → verify 型豁免出账；无 → verify-missing（聚合段出 warning，
// 灰度第一档非 blocker）。ctx 由调用方按「intent 加入 git ≥ verifySince（v5 锚）」组装；锚不可判定
// → ctx null → 维持 text 豁免（无判定依据不产出告警）。关键词表最小集起步（check2-datetime 先例：
// 只豁免实证形态，变体实证再扩）。
const VERIFY_GREEN_RE = /测试通过|测试全绿|测试绿|全绿/;
// 证据残差单源（大写预筛与 rev-parse 失败分类共用同一判据，防两份字面量漂移）：
// 剔除 SHA 与泛指词后的残余内容——非空（项目名/路径/单据上下文）→ external 豁免；
// 为空（纯「commit a1b2c3d」「提交 a1b2c3d」）→ 本地引用伪造，硬拦。
// 多 SHA（2026-10-27）：剔除**全部** hex token 再判残差——否则同一行里的另一个 SHA 会充当
// 「上下文」，把裸引用的伪造 SHA 误判成 external 而豁免（行内互洗白面）。
const evidenceResidue = (evidenceStr, sha) => evidenceStr.replace(sha, '')
  .replace(/\b[a-f0-9]{7,40}\b/gi, '')
  .replace(/证据[：:]|commit|提交|[（）()。—-]/gi, '')
  // 连接词/停顿（多 SHA 行常见「A 与 B」「A、B」）：不构成可核验上下文，剔除后仍判伪造。
  .replace(/[与和及、,，;；:：\/]+/g, '')
  .trim();

// 多 SHA（2026-10-27 evidence-multi-sha）：证据行常同时引实现提交与「同款记录」的关单提交，
// 此前只取首个 token → 实现提交排在后面时被判「未触及声明文件」（实测误拦 2026-10-27 plan）。
// 现全部核验：任一「实质放行」（sha/process）即通过；但若同批还有「解析成功却未触及、且非 docs
// 记录型」的 SHA → 仍拦（防「真 SHA + 伪造 SHA」混排洗白）。无实质放行时优先报伪造、其次无关。
function verifyEvidenceTruth(evidenceStr, planBase, root, ctx) {
  const shaTokens = [...new Set([...evidenceStr.matchAll(/\b([a-f0-9]{7,40})\b/gi)].map((m) => m[1]))];
  if (!shaTokens.length) {
    if (ctx && ctx.verifyRelevant && VERIFY_GREEN_RE.test(evidenceStr)) {
      if (ctx.hasFresh) {
        warnEvidenceExempt('verify', planBase);
        return { ok: true, type: 'verify' };
      }
      return { ok: true, type: 'verify-missing' };
    }
    warnEvidenceExempt('text', planBase);
    return { ok: true, type: 'text' };
  }
  const verdicts = shaTokens.map((t) => verifyOneSha(t, evidenceStr, planBase));
  const pass = verdicts.find((v) => v.ok && (v.type === 'sha' || v.type === 'process'));
  if (pass) {
    // 已有实质放行时，只拦「伪造」（不存在的 SHA）——那是硬错。
    // irrelevant 的旁证提交（同批 fix/chore 提交、实测脚本提交）不拦：它们不是伪造，
    // 且实测三条存量 done plan 都是「真实现提交 + 旁证提交」形态（2026-10-27 复核）。
    const forged = verdicts.find((v) => !v.ok && v.type === 'forged');
    return forged || pass;
  }
  const forgedOnly = verdicts.find((v) => !v.ok && v.type === 'forged');
  if (forgedOnly) return forgedOnly;
  const firstBad = verdicts.find((v) => !v.ok);
  return firstBad || verdicts[0];
}

// 单 SHA 核验（verifyEvidenceTruth 的核验主体；多 SHA 版逐 token 调用）。
function verifyOneSha(shaRaw, evidenceStr, planBase) {
  let sha = shaRaw;
  // 大写 A-F 预筛（perf-evidence-git-memoize）：含大写 A-F 的 token（业务单据号
  // BCCAC121100001 类）占证据 hex token 相当比例且 rev-parse 必失败（对象名的规范输出恒小写），
  // 逐个 spawn 纯耗——带上下文残余的（单据号典型形态）直接按 external 豁免，不再实证。
  // 纯数字 token 不预筛：全数字短 SHA 真实存在（2026-10-05-check8-digit-sha-misfire 锚），必须实证。
  // 诚实边界（2026-10-10 实证：git hex 解析大小写不敏感——大写拼写的真 SHA 可解析成功）：
  // - 裸引用形态（残差为空）本会硬拦——为防「真 SHA 被人工大写粘贴」误拦，小写化 rev-parse 兜底，
  //   解析成功则回正常核验链；大小写不敏感 ⇒ 小写化解析与原 token 逐点等价，行为与现行一致。
  // - 带上下文形态的放宽面：真 SHA 被大写粘贴且带上下文 → 不再进交集核验、按 external 豁免
  //   （git 工具链输出恒小写，该形态仅罕见人工转换产生——接受并在此声明）。
  if (/[A-F]/.test(sha)) {
    const residue = evidenceResidue(evidenceStr, sha);
    if (residue.length > 0) {
      warnEvidenceExempt('external', planBase);
      return { ok: true, type: 'external' };
    }
    const lowerProbe = spawnGit(['rev-parse', sha.toLowerCase()]);
    if (lowerProbe.status !== 0) return { ok: false, type: 'forged', msg: `提交 ${sha} 不存在` };
    sha = sha.toLowerCase();
  }
  // 直连走 spawnGit（与 gitOut 同一 loud+retry 通道，注释互引）：spawn 异常不再被静默算作业务失败；
  // 重试后仍异常按下方 status!==0 判定（fail-closed 保持——本地核验不了就按伪造拦）
  const revParse = spawnGit(['rev-parse', sha]);
  if (revParse.status !== 0) {
    // 纯数字串且解析失败 → 时间戳/ID 维持文本豁免（2026-10-05-check8-digit-sha-misfire：形态守卫
    // 曾把全数字短 SHA≈4.4%/夹具 误分类为文本致核验静默跳过——改由 rev-parse 实证分流）。
    // 纪律：文本启发式须可被实证兜底，禁以字符形态抢先分类。
    // 兜底成立的前提是「解析失败 = 业务裁决（git 可用、对象不存在）」。git 自身起不来（revParse.error，
    // 基础设施异常，重试后仍异常）时实证无从发生，数字形态不得抢先豁免——否则「全数字短 SHA + git 缺失」
    // 正好落进无人兜底的静默降级（2026-10-09 AI-Native 架构审查修复：:225 intentional-simple 声称的
    // 「仍异常走拦截语义」在本分支实为放行；夹具是否踩中取决于哈希运气，≈4.4%/夹具）。
    // 装户无 git 仓（status 128、非 r.error）不受影响——那是合法装户语义，维持豁免。
    if (/^\d+$/.test(sha) && !revParse.error) {
      warnEvidenceExempt('text', planBase);
      return { ok: true, type: 'text' };
    }
    // 区分本地伪造与外部仓库引用（残差判据单源 evidenceResidue——与上方大写预筛共用，防漂移）
    const residue = evidenceResidue(evidenceStr, sha);
    if (residue.length > 0) {
      warnEvidenceExempt('external', planBase);
      return { ok: true, type: 'external' };
    }
    return { ok: false, type: 'forged', msg: `提交 ${sha} 不存在` };
  }

  // 解析成功（含纯数字短 SHA 命中提交/ref 的情形）→ 真相核验
  const planPath = path.join(ROOT, WF, 'plans', planBase + '.md');
  if (!fs.existsSync(planPath)) {
    warnEvidenceExempt('no-plan', planBase);
    return { ok: true, type: 'no-plan' }; // 缺 plan 走 Check 1 拦截
  }

  const planLines = linesOf(planPath) || [];
  const declaredFiles = [];
  // 扫描「改动面」「任务拆解」「改动方案」或「改动文件清单」（2026-10-11 C4 收尾发现：2026-09-23 期
  // 存量 L2 plan 用「改动文件清单」节名，提取面为空 → 一切 SHA 证据误判「未触及声明文件」——arrival
  // 关单实证；扩名而非改档，存量 done 档内容受指纹绑定禁改）
  let inDeclaredSec = false;
  for (const line of planLines) {
    if (/^##\s+(改动面|任务拆解|改动方案|改动文件清单)/.test(line)) { inDeclaredSec = true; continue; }
    if (inDeclaredSec && /^##\s+/.test(line)) { inDeclaredSec = false; continue; }
    if (inDeclaredSec) {
      const fileMatch = line.match(/([a-zA-Z0-9._\/-]+\.[a-zA-Z0-9]+)/);
      if (fileMatch) declaredFiles.push(fileMatch[1]);
    }
  }

  const show = spawnGit(['show', '--name-only', sha]);
  if (show.status !== 0) return { ok: false, type: 'error', msg: `无法读取提交 ${sha} 的文件列表` };
  
  const changedFiles = show.stdout.split(/\r?\n/).filter(Boolean);
  const hasIntersection = changedFiles.some(f => declaredFiles.some(df => f.includes(df) || df.includes(f)));

  if (!hasIntersection) {
    // 过程证据（check-evidence-process）：执行器驱动的提交可作验收证据——提交信息带
    // 「pipeline-run <runId>」标记（docsCommit 四种格式共有段，runId 严格形态 日期8-时间4-主题-尾；
    // 与 run 事件流同源，git 历史留痕可对质）。只救 irrelevant：forged（SHA 不存在）在前已判，其余判据不动。
    // 记录型标志（2026-10-06-v114-backflow-batch）：docs 系 Conventional Commit（冒烟报告 / 留痕 / 关单台账）
    // 不触 plan 声明面属预期——是否降级豁免由检查 8 聚合段判（须同文档存在可过检实现证据），此处只出标志。
    const subj = spawnGit(['log', '-1', '--format=%s', sha]);
    const recordCommit = subj.status === 0 && /^docs[(:]/.test(subj.stdout.trim());
    if (subj.status === 0 && /pipeline-run [0-9]{8}-[0-9]{4}-[A-Za-z0-9-]+/.test(subj.stdout)) {
      warnEvidenceExempt('process', planBase);
      return { ok: true, type: 'process' };
    }
    return { ok: false, type: 'irrelevant', msg: `提交 ${sha} 未触及 plan 声明的任何文件`, recordCommit };
  }

  return { ok: true, type: 'sha' };
}


function delegationResultRows(file) {
  // 分片感知读（ledger-shard-ledgers）：主台账 ∪ delegations.d/*.md，单源 = ledger-shards。
  // 原实现自行拼 shardDir 并逐文件读，与 agg-delegations/wf-journal 三处各写一份（口径漂移面）；
  // 现统一走 readDelegationsText。file 为显式注入路径时只读该文件（测试语义不变）。
  // 行解析单源 = delegation-presence.parseDelegationRows（2026-10-25 优化4 起，与 confirm-doc done
  // 前置写入拦截门共用——检查 18 事后对账与关单时刻拦截同一口径，一边改另一边须跟）。
  return delegationRowsOf(path.dirname(path.dirname(file)), file);
}

function versionGreater(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

function fmStatus(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] || '')) return '';
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return '';
    if (lines[i].startsWith('状态:')) return lines[i].slice('状态:'.length).trim();
  }
  return '';
}


// bindingSha256：done 内容绑定的复原重算（检查 15 专用）——confirm-doc.mjs computeFingerprint 的逆推：
// lines 已 CRLF 归一（split(/\r?\n/)），frontmatter 区内首个「状态:」行保分隔符换值为 prev（`状态:  done`
// 双空格 → `状态:  approved`——与前向按原行字面计算对称，非规范分隔符不误伤；行尾空白等更奇异格式仍会
// 失配，触发前提本身已违反「确认落态唯一入口」约定，接受），全文剔「确认指纹:」行后 join('\n') 再 sha256。
function bindingSha256(lines, prevStatus) {
  const isDelim = (l) => /^---\s*$/.test(l);
  const out = [];
  let i = 0;
  if (isDelim(lines[0] || '')) {
    out.push(lines[0]);
    let replaced = false;
    for (i = 1; i < lines.length; i++) {
      if (isDelim(lines[i])) { out.push(lines[i]); i++; break; }
      if (!replaced && /^状态:/.test(lines[i])) {
        out.push(lines[i].replace(/^(\s*状态:\s*)\S.*$/, `$1${prevStatus}`));
        replaced = true;
      } else out.push(lines[i]);
    }
  }
  for (; i < lines.length; i++) out.push(lines[i]);
  return createHash('sha256').update(out.filter((l) => !/^确认指纹:/.test(l)).join('\n'), 'utf8').digest('hex');
}

function readdirOrNull(dir) {
  try { return fs.readdirSync(dir); } catch { return null; }
}
function isDirectoryOrNull(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}


export {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, readVerifyLedgerText, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, LOOP_MODE, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
  commitmentFingerprint,
};
