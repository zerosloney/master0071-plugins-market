// check-loop-sections/s04-refs.mjs — 4. 引用有效性 [warning]（.agents/ 路径须存在；skills 特例允许用户级 ~/.agents/s
// （2026-10-10 收敛系列 4b 自 check-loop.mjs 原位切出，段体逐字未改；基础设施由 kit 供给。）
import {
  fs, os, path, spawnSync, createHash, createRequire, fileURLToPath,
  loadEnums, runCheck16, auditEnabled, loadKitPolicy, hasFreshVerifyLine, laneOfDoc, MARK_RE, approvedTraceIndex,
  SCRIPT_DIR, GIT, REV_ARG, REV, ROOT, ENUMS, inSet, stOkDoc,
  spawnGit, gitOut, linesOf, fmGet, WF, DOC_DIRS, blockers, warnings, kitPolicy, isTracked, docFiles,
  addedDateOf, warnEvidenceExempt, VERIFY_GREEN_RE, verifyEvidenceTruth,
  delegationResultRows, versionGreater, fmStatus, bindingSha256, readdirOrNull, isDirectoryOrNull,
} from '../check-loop-kit.mjs';

export function run() {
// --- 4. 引用有效性 [warning]（.agents/ 路径须存在；skills 特例允许用户级 ~/.agents/skills）---
{
  // 引用可带 {a,b,c} 花括号展开（仓库通写法 `fill-{intent,spec,plan}.mjs`）或 `*` 通配（`fill-*.mjs`）——
  // 花括号展开逐路查存在，任一路存在即有效；`*` 按目录枚举 glob 匹配，命中即有效；全不中才算断档
  // （2026-09-26 审查修复：正则字符类不含 {} *，曾把 `fill-{intent,spec,plan}.mjs` / `fill-*.mjs`
  //   截断成 `fill-` 误报引用断档）
  const refRe = /\.agents\/(commands|hooks|scripts|skills|roles)\/[A-Za-z0-9_][A-Za-z0-9_./{},，*-]*/g;
  const expandRef = (ref) => {
    const m = ref.match(/^([^{]*)\{([^}]*)\}(.*)$/);
    if (!m) return [ref];
    return m[2].split(/[,，]/).map((v) => m[1] + v.trim() + m[3]);
  };
  // globExists：`*` 通配引用按目录枚举匹配（仅文件名层，`*` 不跨 /；目录不存在 = false）
  const globExists = (ref) => {
    const re = new RegExp('^' + path.basename(ref).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*') + '$');
    try { return fs.readdirSync(path.dirname(path.join(ROOT, ref))).some((f) => re.test(f)); } catch { return false; }
  };
  const refExists = (r) => (r.includes('*') ? globExists(r) : fs.existsSync(path.join(ROOT, r)));
  const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
  const files = [];
  if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) files.push('AGENTS.md');
  for (const e of readdirOrNull(ROOT) || []) {
    const p = path.join(ROOT, e, 'AGENTS.md');
    if (isDirectoryOrNull(path.join(ROOT, e)) && fs.existsSync(p)) files.push(path.join(e, 'AGENTS.md'));
  }
  for (const f of readdirOrNull(path.join(ROOT, WF)) || []) {
    if (f.endsWith('.md')) files.push(`${WF}/${f}`); // workflow 根级 *.md（README 等）
  }
  for (const sub of DOC_DIRS) {
    const dir = path.join(ROOT, WF, sub);
    // 仅扫活跃态（draft/approved/open）——终态件的引用是历史叙述（提及已改名/已废文件属常态），
    // 扫了只会产生不可消除的 advisory 噪声，真漏点被淹没（audit-gate-hardening）
    const activeSet = sub === 'incidents' ? ENUMS['incident.status.active'] : ENUMS['doc.status.active'];
    for (const f of readdirOrNull(dir) || []) {
      if (!f.endsWith('.md') || !(f === '_TEMPLATE.md' || /^\d/.test(f))) continue;
      if (f !== '_TEMPLATE.md' && !inSet(fmGet(path.join(dir, f), '状态'), activeSet)) continue;
      files.push(`${WF}/${sub}/${f}`);
    }
  }
  const cmdDir = path.join(ROOT, '.agents', 'commands');
  for (const f of readdirOrNull(cmdDir) || []) {
    if (f.endsWith('.md')) files.push(`.agents/commands/${f}`);
  }
  for (const rel of files) {
    const text = linesOf(path.join(ROOT, rel));
    if (!text) continue;
    const seen = new Set();
    for (const line of text) {
      for (const m of line.matchAll(refRe)) {
        const ref = m[0];
        if (seen.has(ref)) continue;
        seen.add(ref);
        const refs = expandRef(ref);
        if (refs.some(refExists)) continue;
        if (refs.some((r) => r.startsWith('.agents/skills/') && !r.includes('*') && fs.existsSync(path.join(HOME_DIR, r)))) continue;
        warnings.push(`- [WARN 引用断档] ${rel.split(path.sep).join('/')} 引用不存在的文件:${ref}`);
      }
    }
  }
}
}
