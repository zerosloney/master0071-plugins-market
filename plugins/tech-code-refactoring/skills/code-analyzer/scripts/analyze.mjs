#!/usr/bin/env node
// 代码分析器（tech-code-refactoring 插件 code-analyzer skill 的核心脚本，本文件为全新原创实现）。
//
// 为什么存在：技术债盘点需要一个零依赖、跨平台、可离线运行的入口。指标引擎分两层：
//   1. AST 层（./ast.mjs，本文件负责分发）：基于 vendored tree-sitter 的精确语法树指标，
//      覆盖 JS/TS 系与 python/java/go/rust/c/cpp，含函数级复杂度热点；
//   2. 降级层（本文件的文本级正则启发式）：vendor 缺失 / wasm 加载失败 / WebAssembly
//      不可用 / 单文件 parse 报错时，该文件自动回退——JS/TS 走正则启发式，其他语言回纯计数。
// 任何降级都不抛异常中断整轮分析；实际生效的引擎在报告概览「分析引擎」一行如实披露。
//
//   node analyze.mjs --path <dir> [--output <file>] [--exclude <pattern>...] [--heuristic]
//
// 约束：仅 import node: 内置模块（零 npm 依赖）；无网络、无子进程、无删除操作；
// 只读源码 + 可选写一个输出文件。main 与分析逻辑分离，纯函数均可被测试直接 import。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getEngine, extractFileMetrics, releaseTree, LANG_BY_EXT, JS_FAMILY_LANGS, MAX_SOURCE_BYTES } from './ast.mjs';

// ---------------------------------------------------------------------------
// 常量与口径
// ---------------------------------------------------------------------------

// 无任何引擎可用的源码扩展名（只计入「未分析文件数」，报告「边界与口径」如实标注）；
// 可分析语言的全集见 ast.mjs 的 LANG_BY_EXT（AST 引擎），JS/TS 系降级走本文件正则启发式
const UNANALYZED_EXTS = new Set(['.rb', '.php']);
// 内置默认排除（路径片段包含即排除）
const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.d.ts'];
const BIG_FILE_LINES = 300; // 超大文件阈值
const TOP_N = 10; // 各榜单条数
const TODO_TOP_N = 5; // TODO 密度榜单条数
// 本地依赖省略扩展名时的试探顺序（TS 系优先，兼顾 JS 产物与 index 目录入口）
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

// 以下正则全部是启发式口径：会误计字符串/注释中的关键字，详见「边界与口径」
const RE_IMPORT = /^\s*import\s/gm; // 静态 import 行
const RE_REQUIRE = /\brequire\s*\(/g; // CommonJS require
const RE_EXPORT = /^\s*export\b/gm; // export 关键字行
const RE_FUNCTION_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*/gm;
const RE_ARROW_ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;
// 方法简写：缩进的 `name(args) {`（排除控制流关键字，避免 if/for/switch 被当方法）
const RE_METHOD_SHORTHAND = /^\s{2,}(?!(?:if|for|while|switch|catch|return|else|do|try|new)\b)(?:static\s+|async\s+|get\s+|set\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gm;
const RE_CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
// 圈复杂度：1 + if/for/while/case/catch/&&/||/??/三元 ? 的出现次数。
// `??` 排在三元模式之前，正则先匹配先消费，保证 `??` 只计一次；`?.` 因后随 `.` 不计。
const RE_CC = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?\s*[^.]/g;
const RE_TODO = /\b(?:TODO|FIXME|HACK)\b/g;
// 相对路径依赖提取：import ... from '<spec>' / 裸 import '<spec>' / require('<spec>')
const RE_FROM = /\bfrom\s*['"]([^'"]+)['"]/g;
const RE_BARE_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/gm;
const RE_REQUIRE_PATH = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_RELATIVE_SPEC = /^\.\.?\//; // 只认 ./ 与 ../ 开头的相对依赖

// DDD 类名后缀映射（顺序即优先级：长后缀在前，避免 AggregateRoot 被判成 Aggregate）
const DDD_SUFFIXES = [
	['AggregateRoot', '聚合根'],
	['Aggregate', '聚合根'],
	['ValueObject', '值对象'],
	['VO', '值对象'],
	['Entity', '实体'],
	['Service', '领域服务'],
	['Repository', '仓储'],
	['Event', '领域事件'],
	['Controller', '控制器'],
	['Handler', '处理器'],
];
// 目录分层约定（按路径段匹配，顶层与嵌套目录都算，如 src/core/x.ts 与 core/x.ts 同判领域层）
const DDD_LAYERS = [
	['领域层', ['domain', 'core']],
	['应用层', ['application', 'usecase']],
	['基础设施层', ['infrastructure', 'adapter']],
	['表现层', ['presentation', 'api', 'ui']],
];

const USAGE = `用法：node analyze.mjs --path <dir> [--output <file>] [--exclude <pattern>...] [--heuristic]

选项：
  --path, -p <dir>      待分析目录（默认：当前工作目录）
  --output, -o <file>   Markdown 报告输出文件（缺省时打印到 stdout，不写文件）
  --exclude, -e <模式>  排除的路径片段，可多次传入；片段包含即排除
                        内置默认排除：node_modules、.git、dist、build、.d.ts
  --heuristic           强制全库走启发式层（跳过 AST 引擎，用于测试与对比）
  --help, -h            显示本帮助

说明：默认 AST 引擎（vendored tree-sitter，覆盖 JS/TS 系与 python/java/go/rust/c/cpp），
     加载失败自动降级：JS/TS 走正则启发式、其他语言回纯计数，详见报告「边界与口径」。`;

// ---------------------------------------------------------------------------
// 基础纯函数
// ---------------------------------------------------------------------------

// 路径分隔符归一（Windows 反斜杠 / POSIX 斜杠统一为 /），比较一律基于归一后的形式
const toPosix = (p) => p.split(/[\\/]/).join('/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 路径片段排除：归一分隔符后「包含即排除」（node_modules、.d.ts、__tests__ 这类片段语义）
export function isExcluded(relPath, patterns) {
	const norm = toPosix(relPath);
	return patterns.some((p) => norm.includes(toPosix(p)));
}

// CLI 参数解析（纯函数，便于测试；缺值/未知参数直接抛错）
export function parseArgs(argv) {
	const opts = { path: process.cwd(), output: null, excludes: [], help: false, heuristic: false };
	const flags = {
		'-p': 'path', '--path': 'path',
		'-o': 'output', '--output': 'output',
		'-e': 'exclude', '--exclude': 'exclude',
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
		if (arg === '--heuristic') { opts.heuristic = true; continue; } // 布尔开关，不取值
		const key = flags[arg];
		if (!key) throw new Error(`未知参数「${arg}」，可用：--path/-p、--output/-o、--exclude/-e、--help/-h`);
		const value = argv[++i];
		if (value === undefined) throw new Error(`参数「${arg}」缺少取值`);
		if (key === 'exclude') opts.excludes.push(value);
		else opts[key] = value;
	}
	return opts;
}

// ---------------------------------------------------------------------------
// 文件级指标
// ---------------------------------------------------------------------------

// 拆行：统一 \r\n/\r 后按 \n 拆；末尾换行不算多一行；空文件按 0 行
const splitLines = (normalized) => {
	const lines = normalized.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	if (lines.length === 1 && lines[0] === '') return [];
	return lines;
};

// 逐行分类（空行/注释行/代码行）：块注释用跨行状态机，// 与 /* 均按启发式识别
const classifyLines = (lines) => {
	let empty = 0;
	let comment = 0;
	let inBlock = false;
	for (const line of lines) {
		if (inBlock) {
			comment++;
			if (line.includes('*/')) inBlock = false;
			continue;
		}
		if (/^\s*$/.test(line)) { empty++; continue; }
		if (/^\s*\/\//.test(line)) { comment++; continue; }
		if (line.includes('/*')) {
			// 行内出现块注释开始：整行计注释（哪怕前面有代码，启发式口径）
			comment++;
			const open = line.indexOf('/*');
			if (line.indexOf('*/', open + 2) === -1) inBlock = true;
			continue;
		}
	}
	return { total: lines.length, empty, comment, code: lines.length - empty - comment };
};

// 提取相对路径依赖的原始 spec（./x、../y），已去重排序；非相对依赖不收
const extractDepSpecs = (text) => {
	const specs = new Set();
	for (const re of [RE_FROM, RE_BARE_IMPORT, RE_REQUIRE_PATH]) {
		for (const m of text.matchAll(re)) specs.add(m[1]);
	}
	return [...specs].filter((s) => RE_RELATIVE_SPEC.test(s)).sort();
};

const countTodos = (text) => {
	const counts = { total: 0, todo: 0, fixme: 0, hack: 0 };
	for (const m of text.matchAll(RE_TODO)) {
		counts.total++;
		if (m[0] === 'TODO') counts.todo++;
		else if (m[0] === 'FIXME') counts.fixme++;
		else counts.hack++;
	}
	return counts;
};

// 换行归一（\r\n 与 \r 统一为 \n），AST/启发式/纯计数三个引擎共用
const normalizeContent = (content) => content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

// 单文件指标（纯函数）：给定相对路径与源码文本，产出全部文件级度量（正则启发式层，
// AST 不可用时 JS/TS 系文件的降级路径）
export function analyzeSource(relPath, content) {
	const normalized = normalizeContent(content);
	const lines = splitLines(normalized);
	const countOf = (re) => (normalized.match(re) ?? []).length;
	const classNames = [...normalized.matchAll(RE_CLASS)].map((m) => m[1]);
	return {
		path: toPosix(relPath),
		lines: classifyLines(lines),
		imports: countOf(RE_IMPORT) + countOf(RE_REQUIRE),
		exports: countOf(RE_EXPORT),
		functions: countOf(RE_FUNCTION_DECL) + countOf(RE_ARROW_ASSIGN) + countOf(RE_METHOD_SHORTHAND),
		functionBreakdown: {
			declarations: countOf(RE_FUNCTION_DECL),
			arrows: countOf(RE_ARROW_ASSIGN),
			methods: countOf(RE_METHOD_SHORTHAND),
		},
		classes: classNames.length,
		classNames,
		complexity: 1 + countOf(RE_CC),
		todos: countTodos(normalized),
		depSpecs: extractDepSpecs(normalized),
	};
}

// ---------------------------------------------------------------------------
// 引擎分发：AST 优先，降级层兜底（任何降级不抛异常，保证整轮分析完整）
// ---------------------------------------------------------------------------

// 纯计数指标（降级层最底层）：只有行分类与 TODO 计数，复杂度按基线 1 计
function countOnlyMetric(relPath, content) {
	const normalized = normalizeContent(content);
	return {
		path: toPosix(relPath),
		lines: classifyLines(splitLines(normalized)),
		imports: 0,
		exports: 0,
		functions: 0,
		classes: 0,
		classNames: [],
		complexity: 1,
		todos: countTodos(normalized),
		depSpecs: [],
		functionsDetail: [],
		engine: 'count',
	};
}

// 单文件引擎分发：AST 优先；>1MB 或 parse 失败或引擎不可用时降级——JS/TS 走正则启发式、
// 其他语言回纯计数；>1MB 的文件一律纯计数（大文件防护，含 JS/TS）。
// engine 为 null 表示引擎不可用（初始化失败）；--heuristic 时直接跳过 AST 分发。
async function analyzeOneFile(relPath, content, lang, engine, forcedHeuristic) {
	// 大文件防护：超过 1MB 的单文件跳过 AST（防 wasm 超时/内存放大）
	const oversized = Buffer.byteLength(content, 'utf-8') > MAX_SOURCE_BYTES;
	if (engine && !forcedHeuristic && !oversized) {
		let tree = null;
		try {
			tree = await engine.parse(lang, content);
		} catch {
			tree = null; // 单文件 parse 失败：走降级，不中断整轮
		}
		if (tree) {
			try {
				const normalized = normalizeContent(content);
				return {
					path: toPosix(relPath),
					lines: classifyLines(splitLines(normalized)),
					todos: countTodos(normalized),
					engine: 'ast',
					...extractFileMetrics(relPath, lang, tree),
				};
			} finally {
				releaseTree(tree);
			}
		}
	}
	if (!oversized && JS_FAMILY_LANGS.has(lang)) {
		return { ...analyzeSource(relPath, content), engine: 'heuristic' };
	}
	return countOnlyMetric(relPath, content);
}

// ---------------------------------------------------------------------------
// 依赖图与循环依赖
// ---------------------------------------------------------------------------

// 把某文件声明的相对 spec 解析为已分析文件集合内的规范路径（相对 --path，/ 分隔）。
// 省略扩展名时按 RESOLVE_EXTS 顺序试探，再试 index 入口；解析失败（目标不在集合内）不计入。
export function resolveLocalDeps(fromRel, depSpecs, fileSet) {
	const dir = path.posix.dirname(toPosix(fromRel));
	const hits = [];
	for (const spec of depSpecs) {
		const base = path.posix.normalize(path.posix.join(dir, spec));
		if (fileSet.has(base)) { hits.push(base); continue; }
		let hit = null;
		for (const ext of RESOLVE_EXTS) {
			if (fileSet.has(base + ext)) { hit = base + ext; break; }
		}
		if (!hit && !path.posix.extname(base)) {
			for (const ext of RESOLVE_EXTS) {
				const candidate = path.posix.join(base, 'index' + ext);
				if (fileSet.has(candidate)) { hit = candidate; break; }
			}
		}
		if (hit) hits.push(hit);
	}
	return hits;
}

// 由文件指标建本地依赖图：graph 为邻接表（邻居去重排序，保证遍历确定性），
// refs 为被引用计数（改动爆炸半径的参考口径）。
function buildDependencyGraph(metrics) {
	const fileSet = new Set(metrics.map((m) => m.path));
	const graph = new Map();
	const refs = new Map();
	for (const m of metrics) {
		const deps = [...new Set(resolveLocalDeps(m.path, m.depSpecs, fileSet))].sort(cmp);
		graph.set(m.path, deps);
		for (const dep of deps) refs.set(dep, (refs.get(dep) ?? 0) + 1);
	}
	return { graph, refs };
}

// 环规范化：同一环从不同起点被发现会得到不同旋转，统一取首元素字典序最小的旋转，
// key 以首元素闭合，从而每个环只报一次（按最小字典序起点）。
function canonicalizeCycle(cycle) {
	let best = null;
	for (let i = 0; i < cycle.length; i++) {
		const rotated = [...cycle.slice(i), ...cycle.slice(0, i)];
		const key = rotated.join('->');
		if (best === null || key < best.key) best = { key, cycle: rotated };
	}
	return { key: `${best.key}->${best.cycle[0]}`, cycle: best.cycle };
}

// DFS 找环（白/灰/黑三色）：灰点复现即得一个环，规范化后去重。邻居应有序，结果确定。
export function findCycles(graph) {
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map();
	const stack = [];
	const found = new Map();
	const visit = (node) => {
		color.set(node, GRAY);
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (!graph.has(next)) continue;
			const state = color.get(next);
			if (state === GRAY) {
				const start = stack.lastIndexOf(next);
				const canonical = canonicalizeCycle(stack.slice(start));
				found.set(canonical.key, canonical.cycle);
			} else if (state === undefined) {
				visit(next);
			}
		}
		stack.pop();
		color.set(node, BLACK);
	};
	for (const node of [...graph.keys()].sort(cmp)) {
		if (!color.has(node)) visit(node);
	}
	return [...found.values()].sort((a, b) => cmp(a.join('->'), b.join('->')));
}

// ---------------------------------------------------------------------------
// DDD 启发式
// ---------------------------------------------------------------------------

// 类名后缀 → DDD 元素类型；无命中返回 null
export function classifyDddElement(className) {
	for (const [suffix, label] of DDD_SUFFIXES) {
		if (className.endsWith(suffix)) return label;
	}
	return null;
}

// 目录分层：按路径段匹配（文件名不参与），多命中时取先声明的一层
export function classifyLayer(relPath) {
	const segs = toPosix(relPath).split('/').slice(0, -1).map((s) => s.toLowerCase());
	for (const [label, names] of DDD_LAYERS) {
		if (segs.some((s) => names.includes(s))) return label;
	}
	return null;
}

// bounded context 分组键：--path 下第一层子目录；根下散落文件归入「(根目录)」
const groupOf = (relPath) => {
	const i = relPath.indexOf('/');
	return i === -1 ? '(根目录)' : relPath.slice(0, i);
};

// ---------------------------------------------------------------------------
// 模块级汇总
// ---------------------------------------------------------------------------

// 汇总所有文件指标为报告所需的全部数据（不渲染文本，渲染见 renderReport）
export function summarize(metrics, collected = { unanalyzedByExt: {}, unreadable: 0 }) {
	const { graph, refs } = buildDependencyGraph(metrics);
	const cycles = findCycles(graph);

	const totalLines = metrics.reduce((s, m) => s + m.lines.total, 0);
	const emptyLines = metrics.reduce((s, m) => s + m.lines.empty, 0);
	const commentLines = metrics.reduce((s, m) => s + m.lines.comment, 0);
	const avgComplexity = metrics.length
		? metrics.reduce((s, m) => s + m.complexity, 0) / metrics.length
		: null;

	const complexityTop = [...metrics]
		.sort((a, b) => b.complexity - a.complexity || cmp(a.path, b.path))
		.slice(0, TOP_N)
		.map((m) => ({ path: m.path, complexity: m.complexity, lines: m.lines.total }));

	const bigFilesTop = [...metrics]
		.sort((a, b) => b.lines.total - a.lines.total || cmp(a.path, b.path))
		.slice(0, TOP_N)
		.map((m) => ({ path: m.path, lines: m.lines.total, oversized: m.lines.total > BIG_FILE_LINES }));

	const depHotspots = [...refs.entries()]
		.map(([p, count]) => ({ path: p, count }))
		.sort((a, b) => b.count - a.count || cmp(a.path, b.path))
		.slice(0, TOP_N);

	// DDD 元素：类名后缀命中清单
	const dddElements = [];
	for (const m of metrics) {
		for (const name of m.classNames) {
			const kind = classifyDddElement(name);
			if (kind) dddElements.push({ name, file: m.path, kind });
		}
	}
	dddElements.sort((a, b) => cmp(a.name, b.name) || cmp(a.file, b.file));

	// 目录分层：层 → 文件清单（示例最多带 3 个路径）
	const dddLayers = [];
	for (const [layer, names] of DDD_LAYERS) {
		const files = metrics.filter((m) => {
			const segs = m.path.split('/').slice(0, -1).map((s) => s.toLowerCase());
			return segs.some((s) => names.includes(s));
		}).map((m) => m.path);
		if (files.length > 0) dddLayers.push({ layer, count: files.length, examples: files.slice(0, 3) });
	}

	// 候选限界上下文：按顶层子目录分组，密度 = DDD 元素命中数 / 组内文件数，密度 > 0 即候选
	const groupFiles = new Map();
	for (const m of metrics) {
		const g = groupOf(m.path);
		groupFiles.set(g, (groupFiles.get(g) ?? 0) + 1);
	}
	const groupHits = new Map();
	for (const el of dddElements) {
		const g = groupOf(el.file);
		groupHits.set(g, (groupHits.get(g) ?? 0) + 1);
	}
	const candidateContexts = [...groupFiles.entries()]
		.map(([group, files]) => {
			const hits = groupHits.get(group) ?? 0;
			return { group, files, hits, density: hits / files };
		})
		.filter((c) => c.hits > 0)
		.sort((a, b) => b.density - a.density || cmp(a.group, b.group));

	// TODO 密度：处/千行，仅统计至少有 1 处标记的文件
	const todoTop = metrics
		.filter((m) => m.todos.total > 0 && m.lines.total > 0)
		.map((m) => ({ path: m.path, count: m.todos.total, lines: m.lines.total, perK: (m.todos.total / m.lines.total) * 1000 }))
		.sort((a, b) => b.perK - a.perK || cmp(a.path, b.path))
		.slice(0, TODO_TOP_N);

	const unanalyzedTotal = Object.values(collected.unanalyzedByExt).reduce((s, n) => s + n, 0);

	// 引擎分布与函数级热点：hotspots 仅在 AST 引擎实际产出过指标时存在（否则为 null，
	// 报告该节写「启发式模式无函数级指标」），排序按圈复杂度降序、同分按文件与起始行
	const engineCounts = { ast: 0, heuristic: 0, count: 0 };
	for (const m of metrics) {
		if (engineCounts[m.engine] !== undefined) engineCounts[m.engine]++;
	}
	const functionHotspots = engineCounts.ast === 0 ? null : metrics
		.flatMap((m) => m.functionsDetail ?? [])
		.sort((a, b) => b.complexity - a.complexity || cmp(a.file, b.file) || a.startLine - b.startLine)
		.slice(0, TOP_N);

	return {
		fileCount: metrics.length,
		paths: metrics.map((m) => m.path).sort(cmp),
		totalLines, emptyLines, commentLines,
		unanalyzedByExt: collected.unanalyzedByExt,
		unanalyzedTotal,
		unreadable: collected.unreadable,
		engineCounts,
		avgComplexity,
		complexityTop,
		functionHotspots,
		bigFilesTop,
		depHotspots,
		cycles,
		cycleCount: cycles.length,
		dddElements,
		dddLayers,
		candidateContexts,
		todoTop,
	};
}

// ---------------------------------------------------------------------------
// Markdown 报告渲染（章节顺序固定，报告文本中文）
// ---------------------------------------------------------------------------

const mdTable = (headers, rows) => {
	const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
	for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
	return lines;
};

export function renderReport(s) {
	const L = [];
	L.push('# 代码分析报告', '');

	L.push('## 概览', '');
	L.push(`- 分析文件数：${s.fileCount}（共 ${s.totalLines} 行，其中空行 ${s.emptyLines}、注释行 ${s.commentLines}）`);
	L.push(`- 分析引擎：AST ×${s.engineCounts.ast} 文件 / 启发式 ×${s.engineCounts.heuristic} / 仅计数 ×${s.engineCounts.count}`);
	const detail = Object.entries(s.unanalyzedByExt).map(([ext, n]) => `${ext}×${n}`).join('、');
	L.push(`- 未分析文件数：${s.unanalyzedTotal}（${detail || '无'}；仅计数，不产生指标）`);
	if (s.unreadable > 0) L.push(`- 读取失败：${s.unreadable} 个文件（已跳过，不计入任何指标）`);
	L.push(`- 平均圈复杂度：${s.avgComplexity === null ? '—（无已分析文件）' : `${s.avgComplexity.toFixed(2)}（口径见「边界与口径」）`}`);
	L.push(`- 循环依赖：${s.cycleCount} 个`);

	L.push('', '## 复杂度热点 top10', '');
	if (s.complexityTop.length === 0) {
		L.push('（无已分析源码文件）');
	} else {
		L.push(...mdTable(
			['排名', '文件', '圈复杂度', '行数'],
			s.complexityTop.map((m, i) => [String(i + 1), m.path, String(m.complexity), String(m.lines)]),
		));
	}

	L.push('', '## 函数级复杂度热点 top10', '');
	if (s.functionHotspots === null) {
		L.push('启发式模式无函数级指标。');
	} else if (s.functionHotspots.length === 0) {
		L.push('（AST 模式下未提取到函数）');
	} else {
		L.push(...mdTable(
			['排名', '函数', '语言', '文件', '行范围', '圈复杂度'],
			s.functionHotspots.map((f, i) => [String(i + 1), f.name, f.lang, f.file, `${f.startLine}-${f.endLine}`, String(f.complexity)]),
		));
		L.push('');
		L.push('> 函数内圈复杂度 = 1 + 函数体内分支节点数；嵌套函数的分支归属最内层函数。');
	}

	L.push('', '## 超大文件 top10', '');
	if (s.bigFilesTop.length === 0) {
		L.push('（无已分析源码文件）');
	} else {
		L.push(...mdTable(
			['排名', '文件', '行数', '备注'],
			s.bigFilesTop.map((m, i) => [String(i + 1), m.path, String(m.lines), m.oversized ? `⚠ 超过 ${BIG_FILE_LINES} 行` : '—']),
		));
	}

	L.push('', '## 依赖热点 top10', '');
	if (s.depHotspots.length === 0) {
		L.push('（无本地相对依赖引用）');
	} else {
		L.push(...mdTable(
			['排名', '模块', '被本地引用次数'],
			s.depHotspots.map((m, i) => [String(i + 1), m.path, String(m.count)]),
		));
		L.push('');
		L.push('> 被引用越多，改动爆炸半径越大。仅统计解析成功的本地相对依赖。');
	}

	L.push('', '## 循环依赖', '');
	if (s.cycles.length === 0) {
		L.push('未检测到循环依赖。');
	} else {
		// 环要写成闭合回路（首尾相接），首尾路径一目了然
		s.cycles.forEach((cycle, i) => L.push(`${i + 1}. \`${[...cycle, cycle[0]].join(' -> ')}\``));
	}

	L.push('', '## DDD 启发式识别', '');
	L.push('> 以下均为命名/目录约定的启发式推断，不代表真实领域建模。', '');
	L.push('### 领域元素（按类名后缀）', '');
	if (s.dddElements.length === 0) {
		L.push('未识别到符合 DDD 后缀约定的类。');
	} else {
		L.push(...mdTable(
			['类名', '所在文件', '推断类型'],
			s.dddElements.map((e) => [e.name, e.file, e.kind]),
		));
	}
	L.push('', '### 目录分层', '');
	if (s.dddLayers.length === 0) {
		L.push('未识别到分层目录约定。');
	} else {
		L.push(...mdTable(
			['层', '文件数', '示例'],
			s.dddLayers.map((l) => [l.layer, String(l.count), l.examples.join('、')]),
		));
	}
	L.push('', '### 候选限界上下文（按顶层子目录分组，密度 = DDD 元素数 / 文件数）', '');
	if (s.candidateContexts.length === 0) {
		L.push('未发现 DDD 元素密度大于 0 的顶层分组，无候选限界上下文。');
	} else {
		L.push(...mdTable(
			['分组', '文件数', 'DDD 元素命中', '密度'],
			s.candidateContexts.map((c) => [c.group, String(c.files), String(c.hits), c.density.toFixed(2)]),
		));
	}

	L.push('', '## TODO 密度 top5', '');
	if (s.todoTop.length === 0) {
		L.push('未发现 TODO/FIXME/HACK 标记。');
	} else {
		L.push(...mdTable(
			['排名', '文件', '数量', '行数', '密度（处/千行）'],
			s.todoTop.map((m, i) => [String(i + 1), m.path, String(m.count), String(m.lines), m.perK.toFixed(2)]),
		));
	}

	L.push('', '## 边界与口径', '');
	L.push('- 引擎分层：默认走 **AST 引擎**（vendored tree-sitter 0.27.2，`web-tree-sitter` + 各语言语法 wasm 均内置于本 skill 的 vendor/ 目录，零 npm 依赖、离线可用）；vendor 缺失、WebAssembly 不可用、语法 wasm 加载失败或单文件 parse 报错时，该文件自动降级——JS/TS 走文本级正则启发式，其他语言回纯计数（只有行分类与 TODO，复杂度按基线 1 计）；单文件超过 1MB 时跳过 AST 直接纯计数（防 wasm 超时/内存放大）。`--heuristic` 可强制全库走启发式层。实际生效分布见概览「分析引擎」行。');
	L.push('- AST 覆盖语言：.js/.mjs/.cjs→javascript、.jsx/.tsx→tsx、.ts/.mts/.cts→typescript、.py→python、.java→java、.go→go、.rs→rust、.c/.h→c、.cpp/.cc/.cxx/.hpp/.hh→cpp；.rb/.php 无语法 wasm，仅计入「未分析文件数」；其余非源码文件（如 .md/.json/.yaml）不计数、不分析。');
	L.push('- AST 圈复杂度口径：1 + 分支节点计数（分支类型映射表集中在 ast.mjs，节点名经 vendor 语法 wasm 实测核对）：if/elif/for/while/do/loop、switch 的 case（不含 default）、catch/except、match/case 分支、三元表达式、逻辑操作符 `&&`/`||`/`??`（算术运算不误计）；python 推导式内的 for/if 子句不计，口径略低于标准圈复杂度。');
	L.push('- AST 计数口径：函数数含方法；方法判定 java/go 按节点名、python（类内 def）/rust（impl/trait 内 fn）/cpp（类体内函数定义）按祖先容器；go 的类计数为 type 声明数（含类型别名）；c/cpp 的 struct/class 仅计带类体的定义（前置声明与 typedef 引用不计）。');
	L.push('- 函数级热点口径：AST 模式按函数提取函数名、行范围与函数内圈复杂度（分支归属最内层函数）；匿名函数取名最近变量/属性名，取不到记「(匿名)」；启发式模式无函数级指标。');
	L.push('- 本地依赖口径：仅统计 JS/TS 系文件的相对路径依赖（`./`、`../` 开头），且仅当解析结果落在已分析文件集合内才计入（省略扩展名按 .ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.jsx 顺序试探，含 index 入口）；AST 模式用 import/export-from/require 语法节点精确提取，启发式/降级模式用正则；python/java/go/rust/c/cpp 的 import 仅计数、不进依赖图、不参与环检测。');
	L.push('- 循环依赖口径：对本地依赖图做 DFS 找环；每个环按最小字典序起点规范化后去重，只报一次。');
	L.push('- 排除规则：`--exclude` 为路径片段包含匹配（分隔符归一后 `includes`，如 `build` 也会命中 `builder.ts` 这类文件名），内置默认排除 `node_modules`、`.git`、`dist`、`build`、`.d.ts`。');
	L.push('- DDD 识别口径：类名后缀与目录名的约定映射；AST 模式用语法树真实类名（覆盖全部 9 种语言，go 为 type 声明名），启发式/降级模式维持 JS/TS 正则；「候选限界上下文」按顶层子目录分组、密度 = DDD 元素命中数 / 组内文件数，密度 > 0 即列为候选，纯属启发式猜测。');
	L.push('- 启发式层残余口径（仅降级文件受影响）：圈复杂度按 `if`/`for`/`while`/`case`/`catch`/`&&`/`||`/`??`/三元 `?` 正则计数，字符串、注释中的关键字与 TS 类型标注中的 `?:` 会误计；函数计数为 `function` 声明、箭头赋值、方法简写三类正则之和；行分类（空/注释/代码）按 JS 注释习惯识别，python `#` 注释计入代码行。');
	L.push('- vendor 适配说明：vendored 语法 wasm 为旧版 emscripten 的扁平 dylink 格式，加载时在本文件内存中重编码为新版子段格式（ast.mjs `upgradeDylinkSection`），vendor/ 文件本身不做任何修改；若语法 wasm 换为新格式，该函数自动旁路。');
	return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 目录遍历与 CLI 入口
// ---------------------------------------------------------------------------

// 递归遍历（读目录名排序保证确定性；目录符号链接不跟进，避免环）：收集已分析/未分析文件
function walk(root, rel, excludes, out) {
	const abs = rel ? path.join(root, rel) : root;
	const entries = fs.readdirSync(abs, { withFileTypes: true })
		.sort((a, b) => cmp(a.name, b.name));
	for (const entry of entries) {
		const relPath = rel ? `${rel}/${entry.name}` : entry.name;
		if (isExcluded(relPath, excludes)) continue;
		if (entry.isDirectory()) {
			walk(root, relPath, excludes, out);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (LANG_BY_EXT[ext]) {
				out.analyzed.push(relPath);
			} else if (UNANALYZED_EXTS.has(ext)) {
				out.unanalyzedByExt[ext] = (out.unanalyzedByExt[ext] ?? 0) + 1;
			}
		}
	}
}

// 全量分析：遍历 + 逐文件引擎分发（AST 优先、降级兜底）+ 模块汇总。
// options.excludes 叠加在内置默认排除之上；options.engine 传 'heuristic' 等价于
// CLI 的 --heuristic（强制全库走启发式层，用于测试与对比）。异步：AST 引擎加载是异步的。
export async function analyzeDir(root, options = {}) {
	const absRoot = path.resolve(root);
	if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
		throw new Error(`不是可用目录：${root}`);
	}
	const excludes = [...DEFAULT_EXCLUDES, ...(options.excludes ?? [])];
	const collected = { analyzed: [], unanalyzedByExt: {}, unreadable: 0 };
	walk(absRoot, '', excludes, collected);
	const forcedHeuristic = (options.engine ?? 'ast') === 'heuristic';
	// 引擎只在整个目录存在可解析文件且未强制启发式时初始化；初始化失败则全库降级
	let engine = null;
	if (!forcedHeuristic && collected.analyzed.length > 0) {
		try {
			engine = await getEngine();
		} catch {
			engine = null; // vendor 缺失 / WebAssembly 不可用 / wasm 损坏：全库走降级层
		}
	}
	const metrics = [];
	for (const rel of collected.analyzed) {
		let content;
		try {
			content = fs.readFileSync(path.join(absRoot, rel), { encoding: 'utf-8' });
		} catch {
			// 单个文件读不出来不应让整次分析崩溃：计数并在概览如实披露
			collected.unreadable++;
			continue;
		}
		const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()];
		metrics.push(await analyzeOneFile(rel, content, lang, engine, forcedHeuristic));
	}
	return summarize(metrics, collected);
}

// CLI 入口：io 可注入（stdout/stderr 需提供 write），便于测试不产生真实终端输出。
// 返回退出码；--output 模式的「已写入」提示走 stderr，保持 stdout 只承载报告本身。
export async function main(argv = process.argv.slice(2), io = {}) {
	const stdout = io.stdout ?? process.stdout;
	const stderr = io.stderr ?? process.stderr;
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (err) {
		stderr.write(`参数错误：${err.message}\n\n${USAGE}\n`);
		return 1;
	}
	if (opts.help) {
		stdout.write(`${USAGE}\n`);
		return 0;
	}
	const absRoot = path.resolve(opts.path);
	if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
		stderr.write(`--path 不是可用目录：${opts.path}\n`);
		return 1;
	}
	const summary = await analyzeDir(absRoot, {
		excludes: opts.excludes,
		engine: opts.heuristic ? 'heuristic' : 'ast',
	});
	const report = renderReport(summary);
	if (opts.output) {
		const outFile = path.resolve(opts.output);
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, report, { encoding: 'utf-8' });
		stderr.write(`报告已写入：${outFile}\n`);
		return 0;
	}
	stdout.write(report);
	return 0;
}

// 仅在作为 CLI 直接运行时执行（被测试 import 时不产生副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
