// check-loop-sections/s05-adapters.mjs — 5. 子智能体角色契约 + 宿主 Adapter 一致性 + 旧委派残留 + 钉死模型 [warning] ---
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
// --- 5. 子智能体角色契约 + 宿主 Adapter 一致性 + 旧委派残留 + 钉死模型 [warning] ---
{
  const cmdFiles = () => (readdirOrNull(path.join(ROOT, '.agents', 'commands')) || [])
    .filter((f) => f.endsWith('.md')).map((f) => `.agents/commands/${f}`);
  // 宿主 commands/ 适配枚举（P1-2 补口：命令适配层纳入门禁）——定义在本块（旧版误置于检查4
  // 的 for 循环内、作用域外引用致 ReferenceError，check-loop 崩溃）。codebuddy/trae/opencode 三宿主。
  const hostCmdFiles = () => {
    const out = [];
    for (const h of ['.codebuddy', '.trae', '.opencode']) {
      for (const f of readdirOrNull(path.join(ROOT, h, 'commands')) || []) {
        if (f.endsWith('.md')) out.push(`${h}/commands/${f}`);
      }
    }
    return out;
  };
  // existsSync 守卫（2026-10-06-check19-entry-enoent 同类）：AGENTS.md 等可合法缺失（调用方按空数组
  // 判定本就预期缺失态），fail-loud fs 读下按缺省跳过、不再响亮出账；其余调用方路径另有上游守卫
  const textOf = (rel) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? (linesOf(p) || []) : [];
  };
  for (const role of ['implementer', 'independent-reviewer', 'ui-verifier']) {
    const rolePath = `.agents/roles/${role}.md`;
    if (!fs.existsSync(path.join(ROOT, rolePath))) {
      warnings.push(`- [WARN 角色缺失] 公共角色契约不存在:${rolePath}`);
      continue;
    }
    if (fs.existsSync(path.join(ROOT, '.opencode', 'agents'))) {
      const p = `.opencode/agents/${role}.md`;
      if (!fs.existsSync(path.join(ROOT, p))) warnings.push(`- [WARN Adapter 缺失] OpenCode 缺 ${role}:${p}`);
      else {
        if (!/^mode:\s*subagent\s*$/m.test(textOf(p).join('\n'))) warnings.push(`- [WARN Adapter 无效] OpenCode ${role} 未声明 mode:subagent:${p}`);
        if (!textOf(p).some((l) => l.includes(rolePath))) warnings.push(`- [WARN Adapter 断线] OpenCode ${role} 未引用公共角色:${rolePath}`);
      }
    }
    if (fs.existsSync(path.join(ROOT, '.trae', 'agents'))) {
      const p = `.trae/agents/${role}.md`;
      if (!fs.existsSync(path.join(ROOT, p))) warnings.push(`- [WARN Adapter 缺失] Trae 缺 ${role}:${p}`);
      else {
        if (!new RegExp(`^name:\\s*${role}\\s*$`, 'm').test(textOf(p).join('\n'))) warnings.push(`- [WARN Adapter 无效] Trae ${role} 的 name 与文件名不一致:${p}`);
        if (!textOf(p).some((l) => l.includes(rolePath))) warnings.push(`- [WARN Adapter 断线] Trae ${role} 未引用公共角色:${rolePath}`);
      }
    }
    const zc = `.zcode/agents/${role}.md`;
    if (fs.existsSync(path.join(ROOT, zc))) { // .zcode/agents/ 现为入库件（2026-10-05 起宿主一律入库）；缺失只说明宿主未装，不告警，存在时校验一致性
      if (!new RegExp(`^name:\\s*["']?${role}["']?\\s*$`, 'm').test(textOf(zc).join('\n'))) warnings.push(`- [WARN Adapter 无效] ZCode ${role} 的 name 与文件名不一致:${zc}`);
      if (!textOf(zc).some((l) => l.includes(rolePath))) warnings.push(`- [WARN Adapter 断线] ZCode ${role} 未引用公共角色:${rolePath}`);
    }
    const cb = `.codebuddy/agents/${role}.md`;
    if (fs.existsSync(path.join(ROOT, cb))) { // .codebuddy/agents/ 现为入库件（2026-10-09 起宿主一律入库）；缺失只说明宿主未装，不告警，存在时校验一致性
      if (!new RegExp(`^name:\\s*["']?${role}["']?\\s*$`, 'm').test(textOf(cb).join('\n'))) warnings.push(`- [WARN Adapter 无效] CodeBuddy ${role} 的 name 与文件名不一致:${cb}`);
      if (!textOf(cb).some((l) => l.includes(rolePath))) warnings.push(`- [WARN Adapter 断线] CodeBuddy ${role} 未引用公共角色:${rolePath}`);
    }
    const omp = `.omp/agents/${role}.md`;
    if (fs.existsSync(path.join(ROOT, omp))) { // .omp/agents/ 现为入库件；缺失只说明宿主未装，不告警，存在时校验一致性
      if (!new RegExp(`^name:\\s*["']?${role}["']?\\s*$`, 'm').test(textOf(omp).join('\n'))) warnings.push(`- [WARN Adapter 无效] OMP ${role} 的 name 与文件名不一致:${omp}`);
      if (!textOf(omp).some((l) => l.includes(rolePath))) warnings.push(`- [WARN Adapter 断线] OMP ${role} 未引用公共角色:${rolePath}`);
    }
    const cited = ['AGENTS.md', ...cmdFiles()].some((f) => textOf(f).some((l) => l.includes(rolePath)));
    if (!cited) warnings.push(`- [WARN 命令断线] 工作流未引用公共角色:${rolePath}`);
  }
  // --- 命令指针壳（2026-10-10 收敛系列 3 倒做）---
  // opencode / trae / codebuddy 的 commands 不再复制权威正文。壳必须写出
  // `.agents/commands/<name>.md`，且正文保持短（非空行 ≤ 12）。复制整篇权威源 = 过厚。
  // 未登记 30 天使用前不得恢复逐字副本。zcode 用 .dwf.ts、omp 无 commands，不进本检查
  // （dwf 的加载契约由下方专属检查覆盖）。
  // 副本缺失仍不报（宿主可以只暴露命令子集）。wf- 前缀用于避开宿主内置 slash command。
  {
    const POINTER_CMD_HOSTS = ['.opencode', '.trae', '.codebuddy'];
    const POINTER_BODY_MAX = 12;
    const bodyLinesOf = (rel) => {
      const lines = textOf(rel);
      let body = lines;
      if (/^---\s*$/.test(lines[0] || '')) {
        for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { body = lines.slice(i + 1); break; }
      }
      return body.filter((l) => l.trim() !== '');
    };
    for (const host of POINTER_CMD_HOSTS) {
      const dir = path.join(ROOT, host, 'commands');
      if (!fs.existsSync(dir)) continue;
      for (const f of readdirOrNull(dir) || []) {
        if (!f.endsWith('.md')) continue;
        let name = f.slice(0, -3);
        if (name.startsWith('wf-')) name = name.slice(3);
        const authRel = `.agents/commands/${name}.md`;
    // 权威文件不存在：wf-* 由下方「命令适配悬空」出账；非 wf- 自定义命令不报。
    if (!fs.existsSync(path.join(ROOT, authRel))) continue;
    const rel = `${host}/commands/${f}`;
    const joined = textOf(rel).join('\n');
    if (!joined.includes(authRel)) {
      warnings.push(`- [WARN 指针壳断线] ${rel} 未指向权威源 ${authRel}`);
      continue;
    }
    if (bodyLinesOf(rel).length > POINTER_BODY_MAX) {
      warnings.push(`- [WARN 指针壳过厚] ${rel} 正文超过 ${POINTER_BODY_MAX} 行——禁止复制 ${authRel}，只留指向权威源的壳`);
    }
  }
  }
  // --- zcode 工作流编排面（.zcode/workflows/*.dwf.ts）加载契约 [warning]（2026-10-16 治理收编）---
  // dwf 是 zcode 宿主的编排权威（对应三宿主的 commands 指针壳层；上方指针壳检查明言不覆盖 dwf）。
  // 只查加载契约：首部 /* zcode-workflow 元数据头 + description/whenToUse 字段——宿主按头解析
  // 工作流清单，头缺失 = 工作流对宿主不可见；脚本体由宿主编译期校验，此处不做 TS 解析。
  {
    for (const f of readdirOrNull(path.join(ROOT, '.zcode', 'workflows')) || []) {
      if (!f.endsWith('.dwf.ts')) continue;
      const rel = `.zcode/workflows/${f}`;
      const text = textOf(rel).join('\n');
      if (!/^\s*\/\*\s*zcode-workflow\b/.test(text)) {
        warnings.push(`- [WARN dwf 元数据缺失] ${rel} 缺 zcode-workflow 元数据头（首部 /* zcode-workflow）`);
        continue;
      }
      if (!/^description:/m.test(text)) warnings.push(`- [WARN dwf 元数据缺失] ${rel} 元数据头缺 description 字段`);
      if (!/^whenToUse:/m.test(text)) warnings.push(`- [WARN dwf 元数据缺失] ${rel} 元数据头缺 whenToUse 字段`);
    }
  }
  // --- 宿主注记环境事实单源 [warning]（2026-10-25 优化7）---
  // AGENTS.md 单源纪律：环境事实（路径/端口/版本）只登记 .agents/notes/runtime-env.md §6（本机绝对
  // 路径另有 git-ignore 的 runtime-env.local.md），别处禁止复制原文——宿主壳此前无机器判据（指针壳
  // 门只查断线/过厚，查不出内联事实）。判据 = 四宿主适配目录 + .zcode/agents 薄壳的 .md/.json 出现
  // 内联环境事实：已登记端口槽字面量（8932/8933/5203/9222，§6.1/§4）、盘符绝对路径（X:\）、Unix 家
  // 目录。.zcode/workflows 不进本检查（zcode 编排权威，另行治理）；.agents/notes/ 是登记处不在扫描面。
  {
    const ENV_FACT_RE = /\b(8932|8933|5203|9222)\b|[A-Za-z]:\\|(^|[\s"'`(=])\/(Users|home)\//;
    const envHits = [];
    const walkHost = (rel) => {
      const abs = path.join(ROOT, rel);
      let ents;
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        const child = `${rel}/${ent.name}`;
        if (ent.isDirectory()) walkHost(child);
        else if (/\.(md|json)$/.test(ent.name)) {
          textOf(child).forEach((l, i) => { if (ENV_FACT_RE.test(l)) envHits.push(`${child}:${i + 1}:${l.trim().slice(0, 80)}`); });
        }
      }
    };
    for (const h of ['.opencode', '.trae', '.codebuddy', '.omp', '.zcode/agents']) walkHost(h);
    if (envHits.length) {
      warnings.push(`- [WARN 宿主注记环境事实] 宿主壳内联环境事实（端口/绝对路径按单源纪律只登记 .agents/notes/runtime-env.md §6，壳内留指针；.zcode/workflows 不在本检查面）:\n${envHits.join('\n')}`);
    }
  }
  }
  // --- opencode agent bash 权限镜像 settings.json（安全下限）[warning] ---
  // settings.json 的 permissions.deny/ask 是全局安全下限，但 opencode 不消费该文件（唯一消费者是
  // Trae pre-shell-check）→ 对 opencode 长期零执行。B+ 方案：deny/ask 镜像进 .opencode/agents/*.md 的
  // permission.bash，本检查防镜像漂移。判据：
  //   - 只查「缺失」：settings 每条 deny/ask 必须在「允许 bash」的 agent 里有对应规则（pattern 去掉全部
  //     * 后与 settings 条目相等）；agent 可有额外角色级规则（implementer 额外禁 commit/push）。
  //   - permission.bash 为标量 deny（全禁）视为天然满足下限，跳过。
  //   - allow 清单已于 2026-10-28 从模板与闸里移除（它在判定链末端空转，且内容含 git commit/push，
  //     与 implementer 角色契约（禁提交推送）直接冲突），故此处不再有「不镜像 allow」这一条。
  {
    let settings = null;
    try { settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'settings.json'), 'utf8')); } catch { /* 缺失/坏 JSON → 跳过 */ }
    const denyList = settings?.permissions?.deny || [];
    const askList = settings?.permissions?.ask || [];
    const bashRulesOf = (rel) => {
      const lines = textOf(rel);
      const fm = []; let seen = 0;
      for (const l of lines) { if (/^---\s*$/.test(l)) { seen++; if (seen === 2) break; continue; } if (seen === 1) fm.push(l); }
      for (const l of fm) { const m = l.match(/^\s{2}bash:\s*(.+?)\s*$/); if (m) return { scalar: m[1].replace(/^["']|["']$/g, '') }; }
      const rules = new Map(); let inBash = false;
      for (const l of fm) {
        if (/^\s{2}bash:\s*$/.test(l)) { inBash = true; continue; }
        if (!inBash) continue;
        if (!/^\s{4}/.test(l)) break;
        const m = l.match(/^\s{4}["']?([^"']+)["']?:\s*(\S+)\s*$/);
        if (m) rules.set(m[1], m[2].replace(/^["']|["']$/g, ''));
      }
      return { rules };
    };
    const norm = (p) => p.replace(/\*/g, '');
    if (denyList.length || askList.length) {
      for (const f of readdirOrNull(path.join(ROOT, '.opencode', 'agents')) || []) {
        if (!f.endsWith('.md')) continue;
        const rel = `.opencode/agents/${f}`;
        const { scalar, rules } = bashRulesOf(rel);
        if (scalar === 'deny') continue;
        for (const [list, action, label] of [[denyList, 'deny', 'deny'], [askList, 'ask', 'ask']]) {
          for (const item of list) {
            const covered = rules && [...rules.entries()].some(([p, a]) => a === action && norm(p) === item);
            if (!covered) warnings.push(`- [WARN 权限镜像漂移] ${rel} 缺 settings.json permissions.${label}「${item}」的 bash ${action} 规则`);
          }
        }
      }
    }
  }
  // --- CodeBuddy gates.json 镜像 settings.json（安全下限）[warning] ---
  // .codebuddy/hooks/gates.json 是 PreToolUse 命令门禁的清单单源。settings.json 的每条 deny/ask
  // 必须在 gates.json 对应数组里存在，或列在 exempt 中（须写明 reason）。判据取「条目字符串相等」，
  // 不做语义比较——语义增强（如强推 token 化判定）由 exempt 显式声明，不静默放过。
  {
    let settingsCb = null;
    try { settingsCb = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'settings.json'), 'utf8')); } catch { /* 缺失/坏 JSON → 跳过 */ }
    const gatesRel = '.codebuddy/hooks/gates.json';
    let gatesCb = null;
    try { gatesCb = JSON.parse(fs.readFileSync(path.join(ROOT, gatesRel), 'utf8')); } catch { /* 缺失/坏 JSON → 下方出账 */ }
    if (settingsCb && settingsCb.permissions) {
      if (!gatesCb) {
        warnings.push(`- [WARN 权限镜像缺失] ${gatesRel} 不存在或非法 JSON——PreToolUse 命令门禁将回退内置清单`);
      } else {
        const exemptCb = new Set((gatesCb.exempt || []).map((e) => e && e.item).filter(Boolean));
        for (const [label] of [['deny'], ['ask']]) {
          const coveredCb = new Set((gatesCb[label] || []).map((g) => g && g.pat).filter(Boolean));
          for (const item of settingsCb.permissions[label] || []) {
            if (coveredCb.has(item) || exemptCb.has(item)) continue;
            warnings.push(`- [WARN 权限镜像漂移] ${gatesRel} 缺 settings.json permissions.${label}「${item}」——如属刻意缺省，加入 exempt 并注明 reason`);
          }
        }
      }
    }
  }
  // 旧委派残留 / 钉死模型（grep -nH 行格式 file:line:content）
  const legacyRe = /(^subagent:|subagent_type=|general_purpose_task|browser_use)/;
  const legacyHits = [];
  for (const f of ['AGENTS.md', ...cmdFiles(), ...hostCmdFiles()]) {
    textOf(f).forEach((l, i) => { if (legacyRe.test(l)) legacyHits.push(`${f}:${i + 1}:${l}`); });
  }
  if (legacyHits.length) warnings.push(`- [WARN 旧委派残留] 主规则或阶段命令仍含宿主特定/旧委派声明:\n${legacyHits.join('\n')}`);
  const modelHits = [];
  for (const h of ['.opencode', '.trae', '.zcode', '.codebuddy']) {
    for (const f of readdirOrNull(path.join(ROOT, h, 'agents')) || []) {
      if (!f.endsWith('.md')) continue;
      const rel = `${h}/agents/${f}`;
      textOf(rel).forEach((l, i) => { if (/^model:/.test(l) && !/^model:\s*inherit/.test(l)) modelHits.push(`${rel}:${i + 1}:${l}`); });
    }
  }
  if (modelHits.length) warnings.push(`- [WARN 宿主耦合] 薄 Adapter 不应固定模型:\n${modelHits.join('\n')}`);

  // 宿主命令适配一致性（P1-2 补口）：wf-<name>.md 须有权威 .agents/commands/<name>.md
  for (const f of hostCmdFiles()) {
    const parts = f.split('/');
    if (parts.length !== 3 || parts[1] !== 'commands') continue;
    if (!parts[2].startsWith('wf-') || !parts[2].endsWith('.md')) continue;
    const name = parts[2].slice(3, -3);
    const auth = `.agents/commands/${name}.md`;
    if (!fs.existsSync(path.join(ROOT, auth))) warnings.push(`- [WARN 命令适配悬空] ${f} 无对应权威:${auth}`);
  }
}
}
