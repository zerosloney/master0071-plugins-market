#!/usr/bin/env node
// 跨端查询契约对账门禁（2026-09-21，incident 2026-09-21-validation-contract-gate-scope；
// intent 2026-09-18-query-contract-gate 预留的第二次升级授权落地）
// 用法：node .agents/scripts/check-query-contract.mjs [--help]
// 口径：frontend/src/api/*.ts 中每个 interface *Query* 的**直接字段声明**，
//   与后端 class *QueryDto 的属性名做 camelCase↔PascalCase 归一后比对，
//   报出「前端有、后端无」的字段。page/pageSize 由共享契约基类 PagedQueryDto 提供，视为合法。
// 违例一次性列出 → exit 1；全通过 → exit 0。
// 测试：node .agents/scripts/check-query-contract.test.mjs（解析器与对账函数可注入目录/映射）
//
// ⚠️ 启发式覆盖边界（有意简化，不得假装全量）：
//   1. 只解析 TS 的 `interface *Query*` **直接字段声明**（`name?: type` 形态），
//      不覆盖 extends 继承、Omit<>、类型别名（type X = {...}）、对象展开等形态——
//      用了这些形态的查询参数会漏抓，属已知盲区。
//   2. 后端只扫 class *QueryDto 的直接 public 属性（`public <T> <Name> { get` 形态），
//      不继承解析基类（除 page/pageSize 白名单外）、不解析控制器内联 [FromQuery] 参数。
//   3. 字段名比对按大小写不敏感归一（camelCase↔PascalCase↔全大写缩写词如 projectID↔ProjectID 均可对上）。
//   4. 名称映射：前端 XQuery ↔ 后端 XQueryDto（大小写不敏感）；名字不一致的用
//      EXPLICIT_PAIRS 显式登记；后端无对应 DTO 的用 EXEMPT_INTERFACES 登记理由——
//      两者之外的对不上即违例，不允许静默跳过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './paths.mjs';

// ROOT 解析（2026-10-27 插件化改道）：项目 git 根（findProjectRoot；插件形态不锚脚本上两级）
// → 旧锚 <script>/../..（源仓形态行为不变）。前后端目录位（frontend/src/api、backend）为
// 项目布局适配点，随使用项目自有布局调整。
const ROOT = findProjectRoot() || path.resolve(SCRIPT_DIR, '..', '..');
const FRONTEND_API_DIR = path.join(ROOT, 'frontend', 'src', 'api');
const BACKEND_DIR = path.join(ROOT, 'backend');

// 前后端命名不一致的显式映射：前端接口名 → 后端 DTO 名
const EXPLICIT_PAIRS = {
  BaseCodeApplyQuery: 'BaseCodeApplyItemQueryDto',
};

// 后端非 QueryDto 形态的豁免（接口名 → 理由）；豁免会在输出中打印，不静默
const EXEMPT_INTERFACES = {
  // 后端对应端点为 CodeTemplateController 的内联 [FromQuery] 参数（category-levels / spec-attributes），
  // 无 QueryDto 类；脚本不解析 action 签名（见头部覆盖边界第 2 条），登记豁免。
  CategoryLevelQuery: '后端为 CodeTemplateController 内联 [FromQuery] 参数，非 QueryDto',
  SpecAttributeQuery: '后端为 CodeTemplateController 内联 [FromQuery] 参数，非 QueryDto',
};

// 字段级豁免（'接口名.字段名' → 理由）；豁免会在输出中打印，不静默
// 字段级豁免：仅用于「确属存量漂移、已登记处置意向」的项。落地修复后必须移除对应豁免，门禁恢复硬拦。
// 现无登记项：2026-09-21 命中的 PMLQuery.projectID 已随 incident 2026-09-21-pml-project-filter-ignored
// （后端 PMLQueryDto 补 ProjectID + 服务过滤）落地修复，豁免已移除。
const EXEMPT_FIELDS = {
};

// 共享契约基类 PagedQueryDto 提供的分页参数，前后端同义，视为合法
const PAGING_FIELDS = new Set(['page', 'pagesize']);

function listFilesRecursive(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// 提取块内容：从 start（第一个 '{' 的下标）到深度归零的 '}'，返回 [body, endIdx)
function extractBraceBlock(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return [text.slice(start + 1, i), i];
    }
  }
  return null; // 括号不配对（多行注释吞括号等），交给调用方按启发式局限处理
}

function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

// 前端：解析 apiDir 中 interface *Query* 的直接字段声明
export function parseFrontendQueryInterfaces(apiDir = FRONTEND_API_DIR) {
  const result = [];
  for (const file of listFilesRecursive(apiDir, '.ts')) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    const re = /interface\s+(\w*Query\w*)[^{]*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const blockStart = text.indexOf('{', m.index);
      const block = extractBraceBlock(text, blockStart);
      if (!block) {
        result.push({ name, file: rel, line: text.slice(0, m.index).split('\n').length, fields: [], unparsed: true });
        continue;
      }
      const fields = [];
      for (const rawLine of block[0].split('\n')) {
        const line = stripLineComment(rawLine).trim();
        if (!line || line.startsWith('*') || line.startsWith('/*')) continue;
        const fm = line.match(/^(\w+)\??\s*:/);
        if (fm) fields.push(fm[1]);
      }
      result.push({
        name, file: rel,
        line: text.slice(0, m.index).split('\n').length,
        fields, unparsed: false,
      });
    }
  }
  return result;
}

// 后端：解析 backendDir 中 class *QueryDto 的直接 public 属性
export function parseBackendQueryDtos(backendDir = BACKEND_DIR) {
  const result = [];
  for (const file of listFilesRecursive(backendDir, '.cs')) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    const re = /class\s+(\w*QueryDto)\b[^{]*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const blockStart = text.indexOf('{', m.index);
      const block = extractBraceBlock(text, blockStart);
      if (!block) continue; // 同上：括号不配对按局限处理（后端编译门会先拦这类损坏）
      const props = new Set();
      for (const rawLine of block[0].split('\n')) {
        const line = stripLineComment(rawLine).trim();
        const pm = line.match(/^public\s+[\w?<>,.\[\]\s]+?\s(\w+)\s*\{\s*get/);
        if (pm) props.add(pm[1].toLowerCase()); // 归一为小写入库，与前端字段比对口径一致
      }
      result.push({ name, file: rel, props });
    }
  }
  return result;
}

// 对账：返回 { violations, exempted, paired, backendCount }。映射与豁免可注入（测试面）。
export function compareContracts(frontend, backendDtos, options = {}) {
  const {
    explicitPairs = EXPLICIT_PAIRS,
    exemptInterfaces = EXEMPT_INTERFACES,
    exemptFields = EXEMPT_FIELDS,
    pagingFields = PAGING_FIELDS,
  } = options;

  const backendByName = new Map(backendDtos.map((d) => [d.name.toLowerCase(), d]));
  const violations = [];
  const exempted = [];
  const paired = [];

  for (const itf of frontend) {
    if (exemptInterfaces[itf.name]) {
      exempted.push(`${itf.name}（${itf.file}:${itf.line}）— ${exemptInterfaces[itf.name]}`);
      continue;
    }
    const dtoName = explicitPairs[itf.name] ?? `${itf.name}Dto`;
    const dto = backendByName.get(dtoName.toLowerCase());
    if (!dto) {
      violations.push(
        `${itf.file}:${itf.line}  ${itf.name} — 后端无对应 QueryDto（期望 ${dtoName}），无法对账；` +
        `若后端契约存在但命名不同，请在脚本 EXPLICIT_PAIRS 登记；确无后端契约的请删接口或在 EXEMPT_INTERFACES 写明理由`);
      continue;
    }
    paired.push(`${itf.name} ↔ ${dto.name}`);
    for (const field of itf.fields) {
      const fieldKey = `${itf.name}.${field}`;
      if (exemptFields[fieldKey]) {
        exempted.push(`${fieldKey}（${itf.file}:${itf.line}）— ${exemptFields[fieldKey]}`);
        continue;
      }
      if (pagingFields.has(field.toLowerCase())) continue;
      if (!dto.props.has(field.toLowerCase())) {
        violations.push(
          `${itf.file}:${itf.line}  ${itf.name}.${field} — 后端 ${dto.name} 无对应属性（前端有、后端无，静默失效）`);
      }
    }
  }

  return { violations, exempted, paired, backendCount: backendByName.size };
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node .agents/scripts/check-query-contract.mjs [--help]（见脚本头部口径与覆盖边界）');
    process.exit(0);
  }

  const frontend = parseFrontendQueryInterfaces();
  const { violations, exempted, paired, backendCount } = compareContracts(frontend, parseBackendQueryDtos());

  console.log(`[查询契约对账] 前端 Query 接口 ${frontend.length} 个（配对 ${paired.length}、豁免 ${exempted.length}）、后端 QueryDto ${backendCount} 个`);
  for (const e of exempted) console.log(`  豁免：${e}`);

  if (violations.length > 0) {
    console.error(`\n[查询契约对账] 发现 ${violations.length} 处违例（前端声明了后端不接受的查询能力）：`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\n处置：删除前端多声明的字段，或后端 QueryDto 确需该参数时两端同步补齐（另走需求流程）。');
    process.exit(1);
  }

  console.log('[查询契约对账] 全部通过（0 违例）。注意：本检查为启发式，extends/Omit/类型别名等形态不在覆盖范围（见脚本头）。');
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
