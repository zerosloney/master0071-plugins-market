// 多语言 AST 分析层（tech-code-refactoring 插件 code-analyzer skill，与 analyze.mjs 配套）。
//
// 为什么存在：analyze.mjs 原有指标全部来自文本级正则启发式，会误计字符串/注释里的关键字，
// 且只能分析 JS/TS 系。本文件基于 vendored tree-sitter（web-tree-sitter 0.27.2 + 9 个语法 wasm，
// 全部在 vendor/ 目录、零 npm 依赖）提供精确的语法树指标：函数/类/方法/import 计数、
// 精确圈复杂度（1 + 分支节点计数）、函数级热点（函数名/行范围/函数内圈复杂度）。
//
// 分层约定（analyze.mjs 负责分发与降级，本文件不降级）：
//   - getEngine() 初始化失败（vendor 缺失 / wasm 加载失败 / WebAssembly 不可用）时抛错，
//     由 analyze.mjs 捕获后对该文件走启发式或纯计数降级，任何降级不得中断整轮分析。
//   - 语言按需懒加载：只加载目标目录实际出现过的语言，按语言缓存；语法加载失败同样抛错降级。
//   - 单文件 parse 报错由调用方 try/catch 后降级，本文件不吞异常、不中断。
//
//   import { getEngine, extractFileMetrics, releaseTree, LANG_BY_EXT, JS_FAMILY_LANGS,
//            LANGUAGE_MAPS, MAX_SOURCE_BYTES, resetEngineCache } from './ast.mjs';
//
// 约束：仅 import node: 内置模块；vendor/ 内容只读不改（见下方 dylink 格式适配说明）；
// main 与逻辑分离的纯函数均可被测试直接 import；全部注释中文。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量与语言映射
// ---------------------------------------------------------------------------

// vendor 资产目录（与本文件同目录的 vendor/），wasm 一律从磁盘读取、不改写
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');
const WEB_TREE_SITTER_JS = path.join(VENDOR_DIR, 'web-tree-sitter.js');

// 大文件防护阈值：超过 1MB 的单文件跳过 AST 解析走纯计数（防 wasm 超时/内存放大）
export const MAX_SOURCE_BYTES = 1024 * 1024;

// 扩展名 → tree-sitter 语言（grammar wasm 文件名取语言名，如 tree-sitter-python.wasm）
export const LANG_BY_EXT = {
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.jsx': 'tsx',
	'.tsx': 'tsx',
	'.ts': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.py': 'python',
	'.java': 'java',
	'.go': 'go',
	'.rs': 'rust',
	'.c': 'c',
	'.h': 'c',
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.hpp': 'cpp',
	'.hh': 'cpp',
};

// JS/TS 系语言：依赖图（相对路径）与正则启发式降级的适用范围；其余语言 import 仅计数不进图
export const JS_FAMILY_LANGS = new Set(['javascript', 'typescript', 'tsx']);

// ---------------------------------------------------------------------------
// 各语言「节点类型映射表」（数据驱动、集中定义；节点名以 vendor 语法 wasm 实测为准）
//
// 字段说明：
//   functions        函数类节点（含方法；文件级「函数数」与函数级热点的提取来源）
//   methods          按节点名即可判定的方法节点（与 methodInside 二选一或并用）
//   methodInside     需「类祖先」才判定为方法的节点：{ 节点名: [祖先类节点名...] }
//                    （python/rust/cpp 的方法与函数共用节点名，必须靠祖先区分）
//   classes          类/结构/接口/trait 类节点（文件级「类数」与 DDD 真实类名来源）
//   classNeedsBody   其中只有在带类体时才计数的节点（c/cpp 的 struct/class 前置声明
//                    与 typedef 引用没有类体，计入会把一个类型数多次）
//   classBodyNode    类体的子节点类型（配合 classNeedsBody 使用）
//   imports          import 类节点（仅计数；JS/TS 系另用于依赖图提取）
//   branchNodes      分支类节点（精确圈复杂度 = 1 + 分支节点计数）
//   branchOperators  需按操作符文本区分的分支节点：{ 节点名: [操作符...] }
//                    （binary_expression 同时承载算术与逻辑运算，只有 &&/||/?? 计分支）
//   branchSkipHead   首个子节点文本命中即不计分支：{ 节点名: [文本...] }
//                    （c/cpp 的 default 与 java 的 default 标签和 case 共用节点名，
//                    口径与启发式层一致：只计 case、不计 default）
//
// 与任务起点参考的差异（实测修正）：
//   - python：elif 是独立节点 elif_clause（嵌在 if_statement 内），必须单独计数；
//     match 语法为 match_statement/case_clause，计 case_clause；
//   - java：case 标签节点是 switch_label（传统与箭头 switch 共用），default 靠首 token 排除；
//   - go：case 是 expression_case（default 是独立节点 default_case 天然不计）；
//     类节点用 type_spec（struct/interface 声明的名字载体；含类型别名，口径见报告）；
//   - rust：match 分支是 match_arm；impl_item 是实现块不是类，不计类数；
//   - c/cpp：case 与 default 共用 case_statement，靠首 token 排除 default；
//     函数无 name 字段，函数名取 declarator→declarator 双层字段链。
const LANGUAGE_MAPS = {
	// javascript/typescript/tsx 三种语法对这些构造的节点名一致，共用一张表
	js: {
		functions: ['function_declaration', 'generator_function_declaration', 'function', 'generator_function', 'arrow_function', 'method_definition'],
		methods: ['method_definition'],
		classes: ['class_declaration', 'class', 'abstract_class_declaration', 'interface_declaration', 'enum_declaration'],
		imports: ['import_statement'],
		branchNodes: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression'],
		branchOperators: { binary_expression: ['&&', '||', '??'] },
	},
	typescript: null, // 构建时由 js 表展开（见下方 LANGUAGE_MAPS 装配段）
	python: {
		functions: ['function_definition'],
		methodInside: { function_definition: ['class_definition'] },
		classes: ['class_definition'],
		imports: ['import_statement', 'import_from_statement'],
		branchNodes: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause', 'boolean_operator', 'conditional_expression', 'case_clause'],
		branchOperators: {},
	},
	java: {
		functions: ['method_declaration', 'constructor_declaration'],
		methods: ['method_declaration', 'constructor_declaration'],
		classes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
		imports: ['import_declaration'],
		branchNodes: ['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause', 'ternary_expression', 'switch_label'],
		branchOperators: { binary_expression: ['&&', '||'] },
		branchSkipHead: { switch_label: ['default'] },
	},
	go: {
		functions: ['function_declaration', 'method_declaration'],
		methods: ['method_declaration'],
		classes: ['type_spec'],
		imports: ['import_declaration'],
		branchNodes: ['if_statement', 'for_statement', 'expression_case'],
		branchOperators: { binary_expression: ['&&', '||'] },
	},
	rust: {
		functions: ['function_item'],
		methodInside: { function_item: ['impl_item', 'trait_item'] },
		classes: ['struct_item', 'enum_item', 'trait_item'],
		imports: ['use_declaration'],
		branchNodes: ['if_expression', 'for_expression', 'while_expression', 'loop_expression', 'match_arm'],
		branchOperators: { binary_expression: ['&&', '||'] },
	},
	c: {
		functions: ['function_definition'],
		classes: ['struct_specifier'],
		classNeedsBody: ['struct_specifier'],
		classBodyNode: 'field_declaration_list',
		imports: ['preproc_include'],
		branchNodes: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'conditional_expression'],
		branchOperators: { binary_expression: ['&&', '||'] },
		branchSkipHead: { case_statement: ['default'] },
	},
	cpp: {
		functions: ['function_definition'],
		methodInside: { function_definition: ['class_specifier', 'struct_specifier'] },
		classes: ['class_specifier', 'struct_specifier'],
		classNeedsBody: ['class_specifier', 'struct_specifier'],
		classBodyNode: 'field_declaration_list',
		imports: ['preproc_include'],
		branchNodes: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'catch_clause', 'conditional_expression'],
		branchOperators: { binary_expression: ['&&', '||'] },
		branchSkipHead: { case_statement: ['default'] },
	},
};
// javascript 与 typescript/tsx 共用 js 表（tsx 语法 = typescript + JSX，节点名一致）
LANGUAGE_MAPS.javascript = LANGUAGE_MAPS.js;
LANGUAGE_MAPS.typescript = LANGUAGE_MAPS.js;
LANGUAGE_MAPS.tsx = LANGUAGE_MAPS.js;
export { LANGUAGE_MAPS };

// ---------------------------------------------------------------------------
// dylink 格式适配（不改 vendor/ 文件，仅在读取时于内存中重编码）
//
// 背景：vendor 里的 9 个语法 wasm 是旧版 emscripten 产出的 side module，其 dylink
// 自定义段是「扁平格式」（memorySize/memoryAlign/tableSize/tableAlign/needed 依次排布）；
// 而 web-tree-sitter 0.27.2 的加载器只认新版「子段格式」（段名 dylink.0，载荷按
// 子段 id=1 内存信息 / id=2 依赖列表 组织）。直接加载会因元数据解析为空而把函数表
// 写到偏移 0，运行时间接调用崩溃（table index is out of bounds）。
// 处理：加载前把扁平段重编码为子段段名与载荷，其余字节不动；段内子格式两种版本兼容。
// 若 vendor 未来换成新版 wasm（段名已是 dylink.0），本函数原样返回、自动旁路。
// ---------------------------------------------------------------------------

// 读取 LEB128 无符号整数，返回 [值, 下一偏移]
const readLEB = (buf, off) => {
	let value = 0;
	let shift = 0;
	let o = off;
	for (;;) {
		const b = buf[o++];
		value |= (b & 0x7f) << shift;
		if (!(b & 0x80)) break;
		shift += 7;
	}
	return [value >>> 0, o];
};

// 编码 LEB128 无符号整数为字节数组
const writeLEB = (value) => {
	const out = [];
	let v = value;
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
};

// 把旧版扁平 dylink 段重编码为 0.27 加载器要求的子段格式；非旧格式原样返回
function upgradeDylinkSection(buf) {
	// wasm 首段必为自定义段（id=0）；不是则原样返回交给上层报错
	if (buf[8] !== 0) return buf;
	const [sectionSize, nameOff] = readLEB(buf, 9);
	const sectionEnd = nameOff + sectionSize;
	const nameLen = buf[nameOff];
	const name = buf.subarray(nameOff + 1, nameOff + 1 + nameLen).toString('latin1');
	if (name !== 'dylink') return buf; // 已是 dylink.0 或其他段：旁路
	const payload = buf.subarray(nameOff + 1 + nameLen, sectionEnd);

	// 解析扁平载荷：memorySize、memoryAlign、tableSize、tableAlign、needed 列表
	const [memSize, o1] = readLEB(payload, 0);
	const [memAlign, o2] = readLEB(payload, o1);
	const [tableSize, o3] = readLEB(payload, o2);
	const [tableAlign, o4] = readLEB(payload, o3);
	const [neededCount, o5] = readLEB(payload, o4);
	const needed = [];
	let o = o5;
	for (let i = 0; i < neededCount; i++) {
		const [len, after] = readLEB(payload, o);
		needed.push(payload.subarray(after, after + len).toString('latin1'));
		o = after + len;
	}
	// 解码结果必须自洽（数值合理且载荷无剩余），否则视为未知格式，抛错走降级
	if (memSize === 0 || tableSize === 0 || memAlign > 16 || tableAlign > 4 || o !== payload.length) {
		throw new Error('语法 wasm 的 dylink 段格式无法识别（memSize=' + memSize + ' tableSize=' + tableSize + '）');
	}

	// 重新编码为子段格式：子段 1 = 内存/表信息，子段 2 = 依赖列表
	const memInfo = [...writeLEB(memSize), ...writeLEB(memAlign), ...writeLEB(tableSize), ...writeLEB(tableAlign)];
	const neededPayload = neededCount === 0 ? [0] : [...writeLEB(neededCount), ...needed.flatMap((s) => [...writeLEB(s.length), ...Buffer.from(s, 'latin1')])];
	const newPayload = [1, ...writeLEB(memInfo.length), ...memInfo, 2, ...writeLEB(neededPayload.length), ...neededPayload];
	const newName = 'dylink.0';
	const newSectionSize = 1 + newName.length + newPayload.length;
	return Buffer.concat([
		buf.subarray(0, 9), // magic + 版本 + 段 id
		Buffer.from(writeLEB(newSectionSize)),
		Buffer.from([newName.length]),
		Buffer.from(newName, 'latin1'),
		Buffer.from(newPayload),
		buf.subarray(sectionEnd), // 其余段原样保留
	]);
}

// ---------------------------------------------------------------------------
// 引擎加载（懒初始化 + 按语言缓存；失败不缓存，允许调用方下次重试）
// ---------------------------------------------------------------------------

let enginePromise = null; // 引擎初始化 promise（成功后常驻缓存）
const languageCache = new Map(); // 语言名 → 已加载的 Language 实例（仅缓存成功）

// 初始化 web-tree-sitter：动态 import vendored ESM，locateFile 指向 vendor 内的主 wasm。
// 任何一步失败都向上抛错，由 analyze.mjs 决定降级；成功后缓存供后续调用复用。
async function initParser() {
	if (typeof WebAssembly === 'undefined') {
		throw new Error('当前 Node 运行时不支持 WebAssembly，AST 引擎不可用');
	}
	// Windows 路径必须转 file:// URL 再进 ESM import，避免反斜杠被当作转义字符
	const mod = await import(pathToFileURL(WEB_TREE_SITTER_JS).href);
	const Parser = mod.Parser;
	const Language = mod.Language;
	if (!Parser || !Language || typeof Language.load !== 'function') {
		throw new Error('web-tree-sitter 模块缺少 Parser/Language 导出，版本不符');
	}
	// locateFile：emscripten 按 basename 询问主 wasm 位置，指向 vendor 目录
	await Parser.init({ locateFile: (basename) => path.join(VENDOR_DIR, basename) });
	return { Parser, Language };
}

// 懒加载一个语言的语法 wasm（读取 → dylink 重编码 → Language.load → 缓存）
async function loadLanguage(Language, lang) {
	let langObj = languageCache.get(lang);
	if (!langObj) {
		const wasmPath = path.join(VENDOR_DIR, `tree-sitter-${lang}.wasm`);
		const raw = fs.readFileSync(wasmPath);
		langObj = await Language.load(upgradeDylinkSection(raw));
		languageCache.set(lang, langObj);
	}
	return langObj;
}

// 获取 AST 引擎：返回 { parse(lang, source) → tree }。初始化或语法加载失败抛错（调用方降级）。
// parse 只把目标语言加载一次（按语言缓存）；语法 wasm 缺失等错误会在首次用到该语言时抛出。
export async function getEngine() {
	if (!enginePromise) {
		enginePromise = initParser().catch((err) => {
			enginePromise = null; // 失败不缓存：vendor 修复后允许重试（也便于测试模拟缺失）
			throw err;
		});
	}
	const { Parser, Language } = await enginePromise;
	const parser = new Parser();
	return {
		// 解析单个文件源码，返回 tree（调用方用完须 releaseTree 释放 wasm 内存）
		parse: async (lang, source) => {
			parser.setLanguage(await loadLanguage(Language, lang));
			return parser.parse(source);
		},
	};
}

// 释放解析树占用的 wasm 内存（长目录分析时逐文件释放，避免内存堆积）
export function releaseTree(tree) {
	if (tree && typeof tree.delete === 'function') tree.delete();
}

// 仅供测试：清空引擎缓存，模拟 vendor 缺失后重新走完整初始化流程
export function resetEngineCache() {
	enginePromise = null;
	languageCache.clear();
}

// ---------------------------------------------------------------------------
// 指标提取（纯函数：输入语法树，输出文件级指标与函数级明细；不做任何降级决策）
// ---------------------------------------------------------------------------

// 去掉字符串字面量的首尾引号
const stripQuotes = (text) => text.replace(/^['"`]/, '').replace(/['"`]$/, '');

// 函数节点命名：优先 name 字段；c/cpp 走 declarator→declarator 双层字段链；
// 匿名箭头函数取最近的变量/属性名兜底，仍无则记「(匿名)」
function functionNameOf(lang, node, parent) {
	const direct = node.childForFieldName('name');
	if (direct) return direct.text;
	if (lang === 'c' || lang === 'cpp') {
		const declarator = node.childForFieldName('declarator');
		const inner = declarator && declarator.childForFieldName('declarator');
		if (inner) return inner.text;
	}
	if (parent) {
		if (parent.type === 'variable_declarator') {
			const n = parent.childForFieldName('name');
			if (n) return n.text;
		} else if (parent.type === 'assignment_expression') {
			const l = parent.childForFieldName('left');
			if (l) return l.text;
		} else if (parent.type === 'pair') {
			const k = parent.childForFieldName('key');
			if (k) return k.text;
		}
	}
	return '(匿名)';
}

// JS/TS 系依赖提取（仅相对路径会进依赖图，但这里先原样收集，过滤交给 analyze.mjs 口径）：
// import ... from '<spec>' / 裸 import '<spec>' / export ... from '<spec>' 的 source 字段，
// 以及 require('<spec>') 调用表达式
function collectJsSpecs(node, specs) {
	if (node.type === 'import_statement' || node.type === 'export_statement') {
		const source = node.childForFieldName('source');
		if (source) specs.add(stripQuotes(source.text));
	} else if (node.type === 'call_expression') {
		const fn = node.childForFieldName('function');
		if (fn && fn.text === 'require') {
			const args = node.childForFieldName('arguments');
			const first = args && args.namedChild(0);
			if (first && first.type === 'string') specs.add(stripQuotes(first.text));
		}
	}
}

// 提取文件级 AST 指标与函数级明细。relPath 仅用于函数级明细的文件标注（报告展示用，
// 统一为 / 分隔）；lang 必须是 LANG_BY_EXT 中的语言；tree 是 parseSource 的产物。
// 返回字段：imports/exports/functions/methods/classes/classNames/complexity/depSpecs/functionsDetail。
// 口径说明（与启发式层的差异，报告「边界与口径」同步披露）：
//   - functions 为函数类节点总数（含方法）；methods 为其中方法的子集；
//   - complexity = 1 + 分支节点计数（分支口径见 LANGUAGE_MAPS.branchNodes/branchOperators）；
//   - depSpecs 仅 JS/TS 系收集；其他语言 import 只计数、不进依赖图；
//   - python 推导式里的 for/if 子句不计分支（口径略低于标准圈复杂度）。
export function extractFileMetrics(relPath, lang, tree) {
	const map = LANGUAGE_MAPS[lang];
	const functionSet = new Set(map.functions);
	const methodSet = new Set(map.methods ?? []);
	const methodInside = map.methodInside ?? {};
	const classSet = new Set(map.classes);
	const classNeedsBody = new Set(map.classNeedsBody ?? []);
	const classBodyNode = map.classBodyNode ?? null;
	const importSet = new Set(map.imports);
	const branchSet = new Set(map.branchNodes);
	const operatorMap = map.branchOperators ?? {};
	const skipHeadMap = map.branchSkipHead ?? {};
	const isJsFamily = JS_FAMILY_LANGS.has(lang);
	// 方法判定的祖先容器 = 类节点 + methodInside 声明的容器（如 rust 的 impl_item/trait_item
	// 是实现块、不进类数，但其中的 function_item 仍要判为方法）
	const containerSet = new Set([...classSet, ...Object.values(methodInside).flat()]);

	let imports = 0;
	let exports = 0;
	let methods = 0;
	let branches = 0;
	const classes = [];
	const classNames = [];
	const depSpecs = new Set();
	const functionsDetail = [];

	// 深度优先遍历（只递归命名子节点——匿名节点是关键字/操作符 token，不是构造节点；
	// 操作符文本由其所在的 binary_expression 父节点直接访问）。containerStack 支撑
	// methodInside 判定；fn 记录使分支归属最内层函数。
	const containerStack = [];
	const visit = (node, parent, fn) => {
		const type = node.type;

		if (importSet.has(type)) imports++;
		if (isJsFamily) {
			if (type === 'export_statement') exports++;
			collectJsSpecs(node, depSpecs);
		}

		// 容器节点（类或方法容器）：需要类体的类型先验体，再压栈；类节点同时计数并提取类名
		let pushedContainer = false;
		if (containerSet.has(type)) {
			let hasBody = !classNeedsBody.has(type);
			for (let i = 0; !hasBody && i < node.childCount; i++) {
				if (node.child(i).type === classBodyNode) hasBody = true;
			}
			if (hasBody) {
				containerStack.push(type);
				pushedContainer = true;
				if (classSet.has(type)) {
					classes.push(type);
					const name = node.childForFieldName('name');
					if (name) classNames.push(name.text);
				}
			}
		}

		// 函数节点：登记函数级明细（行范围 1 起、函数内圈复杂度基线 1）
		let ownFn = fn;
		if (functionSet.has(type)) {
			ownFn = {
				name: functionNameOf(lang, node, parent),
				lang,
				file: relPath.split(/[\\/]/).join('/'),
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
				lines: node.endPosition.row - node.startPosition.row + 1,
				complexity: 1,
			};
			functionsDetail.push(ownFn);
		}

		// 方法判定：节点名直接命中，或（methodInside）处于声明的容器祖先内
		if (methodSet.has(type) || (methodInside[type] && containerStack.some((t) => methodInside[type].includes(t)))) methods++;

		// 分支节点：文件级计数 + 归属最内层函数；首 token 命中排除表则不计（如 default）
		if (branchSet.has(type)) {
			const head = node.child(0);
			const skip = skipHeadMap[type];
			if (!skip || !head || !skip.includes(head.text)) {
				branches++;
				if (ownFn) ownFn.complexity++;
			}
		}
		// 逻辑操作符节点：binary_expression 等同时承载算术运算，仅命中操作符文本才计分支
		const operators = operatorMap[type];
		if (operators) {
			for (let i = 0; i < node.childCount; i++) {
				const c = node.child(i);
				if (!c.isNamed && operators.includes(c.text)) {
					branches++;
					if (ownFn) ownFn.complexity++;
				}
			}
		}

		for (let i = 0; i < node.childCount; i++) {
			const c = node.child(i);
			if (c.isNamed) visit(c, node, ownFn);
		}
		if (pushedContainer) containerStack.pop();
	};
	visit(tree.rootNode, null, null);

	return {
		imports,
		exports,
		functions: functionsDetail.length,
		methods,
		classes: classes.length,
		classNames,
		complexity: 1 + branches,
		depSpecs: [...depSpecs].sort(),
		functionsDetail,
	};
}
