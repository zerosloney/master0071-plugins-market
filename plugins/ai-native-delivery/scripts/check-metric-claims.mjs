#!/usr/bin/env node
// check-metric-claims — 检查 16「量化断言指标签名对账」实现（claim-exceeds-fix 引入；
// check16-inline-debt 自 check-loop.mjs 原内联块迁出为独立模块——检查 16 自带三层子结构
// （登记表解析 / 装户取数器载入 / 签名扫描），内联时与检查 1-15 的主扫描流搅在同一文件；
// 迁出后 check-loop 只留判据摘要 + ctx 组装 + 调用，判据语义 / 消息文案 / exit 语义零变化）。
// 判据（与 check-loop.mjs 头部检查项清单 16 同源）：
//   活跃态文档（draft/approved/open）中的 `{{指标名}}`（小写点分）签名须替换为实时值，留签名=未回填=warning；
//   只查显式签名、不全文扫数字（历史叙述假阳性恒 0）；未登记签名 / 取数器缺失 → fail-loud 出账；
//   登记表缺失 → 静默跳过（未启用该检查的装户零噪声）；装户自有指标走 .agents/metric-derivers.cjs（CJS 契约，内置优先）。
// 契约：runCheck16(ctx) 由 check-loop.mjs 调用（调用位置在检查 15 之后——warnings 按插入序输出，
//   位置变化会改变输出行序）；ctx 显式携带本检查引用的外层符号（以代码实际引用集为准）：
//   ROOT / ENUMS / docFiles / fmGet / inSet / isTracked / linesOf / readdirOrNull / warnings。
//   不隐式读 check-loop 闭包——迁出前后行为逐字节一致（check-loop 全量输出 diff 基线验证）。
//   docFiles / isTracked 使扫描面与取数面和检查 1-15 同口径（tracked 过滤链单源定义于 check-loop.mjs docFiles）。
// 本文件除 node:* 内置模块外仅 import 同目录 ledger-loader.mjs（台账统一视图；先例：check-loop.mjs import 同目录 workflow-enums.mjs）。
// 测试：node templates/_agents/scripts/check-loop.test.mjs（黑盒跑整脚本，场景组「检查 16」）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadAllConfirmations } from './ledger-loader.mjs';

export function runCheck16(ctx) {
  const { ROOT, ENUMS, docFiles, fmGet, inSet, isTracked, linesOf, readdirOrNull, warnings } = ctx;
  const mcFile = path.join(ROOT, '.agents', 'metric-claims.txt');
  if (fs.existsSync(mcFile)) {
    const ledgerLines = () => {
      // 台账统一视图（主台账+分片透明合并，坏行跳过、同 doc|stage|fingerprint 键去重取末次——同检查 15 口径）
      const ls = loadAllConfirmations(ROOT);
      return { total: ls.length, withBatch: ls.filter((e) => e && 'batch' in e).length };
    };
    // 内置取数器：全部本地确定性、零网络。**装户零配置即用**（不依赖任何装户文件）。
    // **取数与扫描面同口径（复核 P2；check16-inline-debt 起单源化）**：文档扫描与取数统计
    //   统一走 ctx.docFiles()——过滤链（.md ∧ 数字前缀 ∧ tracked）全仓唯一定义于 check-loop.mjs 的
    //   docFiles，本文件不再自持 countDocs 复刻。首版独立 readdir 数盘面曾把并行会话的**未跟踪**新档
    //   算进取数（盘面 60 / HEAD 59），令「签名填对了」却是别的读者复现不出的数；单源后
    //   「扫描看得到的文档集 == 取数统计的文档集」由构造保证，口径漂移在编译期即不可能。
    const derivers = {
      'ledger.lines': () => ledgerLines().total,
      'ledger.linesWithBatch': () => ledgerLines().withBatch,
      'ledger.linesWithoutBatch': () => ledgerLines().total - ledgerLines().withBatch,
      'docs.count.intents': () => docFiles('intents').length,
      'docs.count.specs': () => docFiles('specs').length,
      'docs.count.plans': () => docFiles('plans').length,
      'docs.count.incidents': () => docFiles('incidents').length,
      'docs.count.all': () => docFiles('intents').length + docFiles('specs').length + docFiles('plans').length + docFiles('incidents').length,
    };
    // ---- 装户侧取数器（adopter-derivers；修「owned 登记表配 managed 取数器」P1）----
    // 背景：登记表是 owned（装户自增指标），取数器却曾硬编码在本文件（managed）——装户一新增指标
    // 就报「无取数器」，唯一出路是改本文件，而那是 managed：sync 永久报「本地已改」+ doctor WARN
    // + 本脚本因供应链防线**跳过执行**（门禁静默停摆）。故改为分层：
    //   ① 内置优先（行为与今完全一致，装户零配置可用）；② 未命中则查装户模块 `.agents/metric-derivers.cjs`
    // **必须是 CJS（`.cjs` + module.exports）**（2026-09-28 跨版本实测修正）：
    //   首版约定 `.mjs` 并用 `createRequire` 载入，在 Node v24.12 上实测可用（**故本机没暴露问题**）；
    //   但跨版本实测（真下 18.20.5 / 20.18.0 / 22.11.0 二进制跑）**三者全部 `ERR_REQUIRE_ESM`**——
    //   `require(esm)` 只在 Node ≥20.19 / ≥22.12 默认可用，Node 18 从未支持。而本仓 engines 写
    //   `>=18.0.0`、CI 矩阵跑 18/22 → **装户取数功能在 CI 目标版本上完全不可用**（fail-loud 正常、
    //   不崩，但功能不工作）。故改用 CJS：`createRequire` 载入 `.cjs` 在 18/20/22/24 全线可用，
    //   且**仍是同步**（无须把本脚本改成 async 主线）。契约要求同步函数也与本检查「零网络、
    //   本地确定性」的前提一致（异步的唯一真实收益是网络/并发 IO，此处都不允许）。
    // **失败一律响亮、绝不静默降级**（沿 claim-exceeds-fix「假绿比红危险」与本检查自身语法错教训）：
    // 若载入失败就「只用内置指标」，装户会看到「引用了 my.metric → 未登记」，看起来像**自己忘了登记**，
    // 而真因是模块坏了——他会去 registry 反复核对，问题永远查不到。故载入/调用失败均出明确 WARN。
    const adopterModRel = '.agents/metric-derivers.cjs';
    // 旧路径（首版 .mjs）：若存在则**明确提示已改用 .cjs**，避免装户对着「无取数器」查不出所以然
    const adopterLegacyRel = '.agents/metric-derivers.mjs';
    let adopterState = null; // { ok:true, derivers } | { ok:false, errors:[...] } —— 懒载入 + 单次运行内缓存
    const loadAdopterDerivers = () => {
      if (adopterState) return adopterState;
      const abs = path.join(ROOT, adopterModRel);
      if (!fs.existsSync(abs)) {
        // 常见误写：仍用首版的 .mjs 路径 → 给出可操作的迁移指引（而非任其对着「无取数器」猜）
        if (fs.existsSync(path.join(ROOT, adopterLegacyRel))) {
          adopterState = {
            ok: false,
            errors: [`${adopterModRel} 不存在，但发现旧版路径 ${adopterLegacyRel}——该路径已于 2026-09-28 弃用（\`require(esm)\` 在 Node 18/22 不可用，实测 ERR_REQUIRE_ESM）。请改名为 ${adopterModRel} 并把写法改为 CommonJS：\`module.exports = { derivers: { ... } }\``],
          };
          return adopterState;
        }
        adopterState = { ok: true, derivers: {} }; // 缺失=正常态，零告警
        return adopterState;
      }
      try {
        const req = createRequire(import.meta.url);
        const mod = req(abs);
        // CJS / ESM 双兼容取导出：CJS 走 module.exports.derivers；若装户误用了 ESM 语法而环境恰好
        // 支持（新 Node 的 require(esm)），default 里也可能挂 derivers——两处都认，避免假阴性。
        const d = (mod && mod.derivers) || (mod && mod.default && mod.default.derivers);
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
          adopterState = { ok: false, errors: [`${adopterModRel} 未导出 \`derivers\` 对象（实际导出形态：${d === undefined ? '无 derivers 键' : Array.isArray(d) ? 'array' : typeof d}）——载入失败不降级，请用 \`module.exports = { derivers: { ... } }\``] };
          return adopterState;
        }
        adopterState = { ok: true, derivers: d };
      } catch (e) {
        const hint = /ERR_REQUIRE_ESM/.test(String(e && e.code)) ? `（该错误表示模块被当成了 ESM——本契约要求 CommonJS：文件后缀 .cjs 且用 \`module.exports = { derivers: {...} }\`）` : '';
        adopterState = { ok: false, errors: [`${adopterModRel} 载入失败：${String(e && e.message ? e.message : e).split('\n')[0]}${hint}——载入失败不降级（静默降级会让你误以为「忘了登记」而非「模块坏了」）`] };
      }
      return adopterState;
    };
    // deriverCtx：注入给装户取数器的同步辅助（免其重复造轮子；check16-inline-debt 迁出时
    // 自 `ctx` 改名——runCheck16 的参数 ctx 已被外层符号注入契约占用，避免遮蔽混淆）
    // **glob 逐字符转义**（自查修正）：首版用「先整体转义特殊字符、再 replace 星号」的写法，
    // 实测 `src/**/*.ts` 匹配不到 `src/a/b/c.ts`、「**/*.md」匹配不到 `a/b/c.md`——因为 `**/`
    // 在被替换前已被字符类转义破坏。改为逐字符状态机，语义明确：
    //   `**/` → 任意层级（含零层）；`**` → 任意（可跨 /）；`*` → 段内任意（不跨 /）；`?` → 段内单字符
    //   其余一律字面转义（故 `a.b.sql` 的点是字面点、`[`/`{` 也按字面处理——本 helper 不承诺
    //   字符类 / 花括号展开，避免装户误以为支持完整 glob 语法；不支持即按字面匹配，行为可预测）
    const globToRegExp = (p) => {
      const s = String(p);
      let re = '';
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '*' && s[i + 1] === '*') {
          if (s[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // `**/` 含零层
          else { re += '.*'; i += 1; }                        // `**` 跨段
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
      }
      return new RegExp('^' + re + '$');
    };
    // 遍历时**跳过重目录 + 防环**（自查 + 复核 P2 修正）：
    // · 剪枝 node_modules / .git / cache——无剪枝时 `deriverCtx.glob('**/*')` 会走进依赖树，既慢又会把
    //   依赖文件算进取数（对「我项目有多少个 X」是错的数）。
    // · **visited 集合防环**：复核实测软链接/junction 成环时递归到 depth 128、同一文件重复 64 份
    //   才被 statSync 的 ELOOP 拦下；POSIX 无 MAX_PATH 时该递归无界。故按**真实路径**去重。
    const WALK_SKIP = new Set(['node_modules', '.git', 'cache']);
    const walkFiles = (dir, out = [], rel = '', visited = new Set()) => {
      let real = dir;
      try { real = fs.realpathSync(dir); } catch { /* 不可解析则按原路径处理 */ }
      if (visited.has(real)) return out; // 环 → 剪枝
      visited.add(real);
      for (const e of readdirOrNull(dir) || []) {
        if (WALK_SKIP.has(e)) continue;
        const abs = path.join(dir, e);
        const r = rel ? `${rel}/${e}` : e;
        let st = null;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) walkFiles(abs, out, r, visited);
        else out.push(r);
      }
      return out;
    };
    const deriverCtx = {
      root: ROOT,
      read: (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } },
      glob: (pattern) => { const re = globToRegExp(pattern); return walkFiles(ROOT).filter((r) => re.test(r)); },
      countFiles: (dir, pred) => walkFiles(path.join(ROOT, dir)).filter((r) => (typeof pred === 'function' ? pred(r) : true)).length,
    };
    // resolveDeriver(name) → { fn } | { error }（**绝不抛出**：引擎不因装户代码崩溃）
    const resolveDeriver = (name) => {
      if (derivers[name]) return { fn: derivers[name], builtin: true };
      const st = loadAdopterDerivers();
      if (!st.ok) return { error: st.errors.join('；') };
      const fn = st.derivers[name];
      if (typeof fn !== 'function') {
        if (fn !== undefined) return { error: `${adopterModRel} 的「${name}」不是函数（实际类型：${typeof fn}）` };
        return { error: `无对应取数器——内置 8 个指标均不含该名，${adopterModRel} 亦未定义（登记了却没实现＝其实没查）` };
      }
      return { fn, builtin: false };
    };
    // 装户模块载入失败：**独立成条**（adopter-derivers）。
    // 关键设计（真绿 vs 假绿的分界）：载入失败若只表现为「该指标无取数器」，装户会看到
    // 「引用了 my.metric → 未登记」，看起来像**自己忘了登记**，而真因是模块坏了——他会去 registry
    // 反复核对，永远查不到。故此处单独出一条，明示文件与错误，与「真的没登记」可区分。
    //
    // **仅在真的需要装户指标时才报**（复核 P2 更正）：首版在解析登记表前无条件出账——若登记表只有
    // 内置指标、而装户留了个半成品模块（或模块坏掉但没人用），会平白多一条不可消除的 advisory。
    // 沿本仓红线「无判定依据的行不产出噪声」：先看登记表是否真的有**非内置**指标，再决定报不报。
    const mcLines = (linesOf(mcFile) || []).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const hasAdopterMetric = mcLines.some((l) => {
      const mm = /^([A-Za-z][\w.]*)\s*=\s*([A-Za-z][\w.]*)$/.exec(l);
      return mm && !derivers[mm[1]];
    });
    const adopterLoad = loadAdopterDerivers();
    if (!adopterLoad.ok && hasAdopterMetric) {
      for (const e of adopterLoad.errors) warnings.push(`- [WARN 装户取数器载入失败] ${e}`);
    }
    // 解析登记表：`<指标名> = <取数表达式>`（表达式须与指标名同形，二者不一致即登记笔误）
    const declared = new Map();
    const precedenceWarned = new Set(); // 同名 advisory 按指标去重（复核 P2 更正：首版按行重复出账）
    for (const line of mcLines) {
      const m = /^([A-Za-z][\w.]*)\s*=\s*([A-Za-z][\w.]*)$/.exec(line);
      if (!m) { warnings.push(`- [WARN 指标登记] .agents/metric-claims.txt 行格式非法（应为 \`指标名 = 取数表达式\`）：${line}`); continue; }
      if (m[1] !== m[2]) { warnings.push(`- [WARN 指标登记] 登记名与取数表达式不一致：${m[1]} ≠ ${m[2]}`); continue; }
      const r = resolveDeriver(m[1]);
      if (r.error) {
        // 无取数器（内置无 + 装户模块无同名）或装户模块载入失败 → 明示可操作方向
        const hint = adopterLoad.ok
          ? `若为项目自有指标，请在 ${adopterModRel} 的 derivers 中实现（契约见 .agents/metric-claims.txt 头部）`
          : `且 ${adopterModRel} 载入失败（见上方「装户取数器载入失败」条目——**这不是「忘了登记」**）`;
        warnings.push(`- [WARN 指标登记] 指标「${m[1]}」无对应取数器（fail-loud：登记了却没实现＝其实没查）——内置 8 指标不含该名，${hint}`);
        // **不 continue**：该指标在 registry 里确实登记过，故仍计入 declared——
        // 否则引用它的文档会被误报为「未登记」（把「模块坏了」伪装成「忘了登记」，正是本单要防的假绿）。
        // 取数失败在扫描阶段以「指标取数失败」单独出账，两条信息不互相掩盖。
      } else if (r.builtin && adopterLoad.ok && typeof adopterLoad.derivers[m[1]] === 'function' && !precedenceWarned.has(m[1])) {
        // 内置与装户同名：内置优先（保持本仓/存量行为稳定），并明示装户定义被忽略（**按指标去重**）
        precedenceWarned.add(m[1]);
        warnings.push(`- [WARN 指标登记] 指标「${m[1]}」由引擎内置提供，${adopterModRel} 中的同名定义**被忽略**（内置优先）——如需改用自有实现，请换一个指标名`);
      }
      declared.set(m[1], true);
    }
    // 扫活跃态文档（沿检查 4 现有尺度：终态件的历史数字是历史叙述，不扫）。
    // tracked-only 口径（check16-inline-debt T2，与检查 1-15 统一）：
    //   子目录走 ctx.docFiles(sub)——过滤链（.md ∧ 数字前缀 ∧ tracked）全仓唯一处定义，首版独立
    //   readdir 扫描不含 tracked 过滤，会把并行会话的**未跟踪**半成品也拖进对账面（别人的草稿不该
    //   拦我的 push——沿仓库模式「只扫已提交(HEAD)内容」总口径）；
    //   根级 workflow/*.md 滤 .md ∧ tracked（无数字前缀约束——README/INDEX/delegations 等本无前缀，
    //   维持现状；根级本无 _TEMPLATE，无需显式排除）。
    const activeSet16 = (sub) => (sub === 'incidents' ? ENUMS['incident.status.active'] : ENUMS['doc.status.active']);
    const scanFiles16 = [];
    for (const sub of ['intents', 'specs', 'plans', 'incidents']) {
      for (const abs of docFiles(sub)) {
        if (!inSet(fmGet(abs, '状态'), activeSet16(sub))) continue;
        scanFiles16.push({ rel: path.relative(ROOT, abs).split(path.sep).join('/'), abs });
      }
    }
    for (const f of readdirOrNull(path.join(ROOT, 'workflow')) || []) {
      const abs = path.join(ROOT, 'workflow', f);
      if (f.endsWith('.md') && isTracked(abs)) scanFiles16.push({ rel: `workflow/${f}`, abs });
    }
    for (const { rel, abs } of scanFiles16) {
      const ls = linesOf(abs) || [];
      ls.forEach((line, i) => {
        // 签名形态收窄为**小写点分**（如 `{{ledger.lines}}`）：装户模板占位符是全大写 SCREAMING_CASE
        // （构建命令 / 看板端口 / 项目名三类，由 init 渲染替换，非本检查对象）
        // ——不收窄会对这些合法的模板占位符产生大量假阳性（实测：本仓 plans 内 11 处）。
        // **转义（2026-09-28，本检查在自己的文档上抓到该需求）**：讲语法 / 举例 / 引用告警原文的
        // 文档在签名前加反斜杠（`\{{ledger.lines}}`）表示「此处是示意、非断言」——否则本检查
        // 会把「文档在教怎么用签名」误判为「作者忘了回填」。选显式转义而非「同句含『如/例』等标记词
        // 即豁免」的启发式：后者会按措辞松紧漂移，且作者能无意中触发豁免而漏过真断言。
        // **转义按「逐个出现」生效、不按整行**（复核自查 P1 更正）：首版实现是「行内出现任一 `\{{`
        // 即整行跳过」，实测可被这样藏住真断言——`… \{{a.b}} 示意… {{ledger.lines}} 未回填` 整行静默
        // 放过。故改为用带后顾的否匹配排除转义位，同行的真签名照常出账。
        for (const m of line.matchAll(/(?<!\\)\{\{([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)\}\}/g)) {
          const name = m[1];
          if (!declared.has(name)) {
            warnings.push(`- [WARN 指标未登记] ${rel}:${i + 1} 引用 {{${name}}} 但 .agents/metric-claims.txt 未登记该指标（未登记＝无从对账）`);
            continue;
          }
          const r = resolveDeriver(name);
          if (r.error) {
            // 取数器不可用（含装户模块载入失败 / 无该名 / 定义非法）——**响亮出账，绝不静默跳过**
            warnings.push(`- [WARN 指标取数失败] ${rel}:${i + 1} {{${name}}} 无法取数：${r.error}`);
            continue;
          }
          let real;
          try {
            real = r.fn(deriverCtx);
          } catch (e) {
            warnings.push(`- [WARN 指标取数失败] ${rel}:${i + 1} {{${name}}} 取数器抛异常：${String(e && e.message ? e.message : e).split('\n')[0]}`);
            continue;
          }
          // 返回值必须是有限数字：Promise（误写 async）/ NaN / 字符串 / undefined 一律拦下并明示类型
          if (typeof real !== 'number' || !Number.isFinite(real)) {
            const kind = real && typeof real.then === 'function' ? 'Promise（本检查要求**同步**函数，请去掉 async/await）' : `${typeof real}${typeof real === 'number' ? `（${real}）` : ''}`;
            warnings.push(`- [WARN 指标取数失败] ${rel}:${i + 1} {{${name}}} 取数器返回值不是有限数字：${kind}`);
            continue;
          }
          // 判据：签名**必须**被替换为实时值——留有 `{{...}}` 即视为未回填（写作期占位，关单前须落实）
          warnings.push(`- [WARN 指标待回填] ${rel}:${i + 1} {{${name}}} 实时值 = ${real}——请把签名替换为该数字（留签名＝未回填）`);
        }
        // **形态不符的签名也不静默放过（复核 P2 更正）**：首版只认严格小写点分形态，于是
        // `{{Ledger.Lines}}` / `{{ ledger.lines }}`（含空格）这类**明显本意是签名**的写法
        // 既不匹配、也不出账——静默漏过，且绕开了「未登记」的 fail-loud。此处补一道：
        // 非转义的 `{{...}}` 中，凡**不是**严格形态、且**不是**装户模板占位符（全大写 SCREAMING_CASE）
        // 的，一律提示形态不符（作者才能立刻发现笔误）。
        for (const m of line.matchAll(/(?<!\\)\{\{([^{}]+)\}\}/g)) {
          const raw = m[1];
          if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(raw)) continue; // 严格形态，上面已处理
          if (/^[A-Z][A-Z0-9_]*$/.test(raw)) continue; // 装户模板占位符（init 渲染对象，非本检查面）
          warnings.push(`- [WARN 指标形态] ${rel}:${i + 1} \`{{${raw}}}\` 不是合法签名形态（应为小写点分，如 {{ledger.lines}}）——若本意是量化断言，请改正形态；若只是举例，请加反斜杠转义`);
        }
      });
    }
  }
}
