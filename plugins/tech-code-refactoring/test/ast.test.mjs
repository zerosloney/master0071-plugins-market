// ast.mjs（多语言 AST 层）与 analyze.mjs AST 分发/降级的 node:test 用例。
//
// 为什么存在：AST 层的指标口径是「数据驱动映射表 + 语法树精确计数」，每张映射表的节点名
// 都经过 vendor 语法 wasm 实测核对；本文件用可控小样本（期望值手工计算并写死）逐语言
// 断言精确值，并覆盖三条关键路径：函数级热点、--heuristic 强制启发式、vendor 缺失降级。
//
// 注意：wasm 加载测试即真实加载（不加 mock）——需要运行环境支持 WebAssembly（Node 18+）。
//   node test/ast.test.mjs    # 可直跑，或由 CI 执行
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	getEngine,
	extractFileMetrics,
	releaseTree,
	resetEngineCache,
	LANG_BY_EXT,
	JS_FAMILY_LANGS,
	MAX_SOURCE_BYTES,
	LANGUAGE_MAPS,
} from '../skills/code-analyzer/scripts/ast.mjs';
import { analyzeDir, main, renderReport } from '../skills/code-analyzer/scripts/analyze.mjs';

// 测试环境信息先打出来（wasm 真实加载依赖 WebAssembly，Node 18+ 自带）
console.log(`[ast.test] 测试环境 Node ${process.version}，WebAssembly ${typeof WebAssembly === 'undefined' ? '不可用（AST 用例将失败）' : '可用'}`);

// ---------------------------------------------------------------------------
// fixture：每处指标都是手工数出来的可控小样本（行尾统一补 \n；期望值与 vendor wasm 实测一致）
// ---------------------------------------------------------------------------

// python：import×2；1 类（DDD 领域服务）+ 2 函数（1 方法）；分支 = if + boolean_operator
// + for + while + conditional_expression 共 5 → 文件复杂度 6；create 复杂度 5、top 复杂度 2
const pySample = [
	'import os',
	'from typing import List',
	'class OrderService:',
	'    def create(self, x):',
	'        if x and x > 0:',
	'            return x',
	'        for i in range(x):',
	'            while x:',
	'                x -= 1',
	'        return 0',
	'def top(x):',
	'    return x if x else 0',
].join('\n');

// java：import×1；1 类（DDD 仓储）+ 1 方法；分支 = if + 三元 + catch 共 3 → 复杂度 4
const javaSample = [
	'import java.util.List;',
	'public class OrderRepository {',
	'    public List<String> find(int x) {',
	'        if (x > 0) {',
	'            return null;',
	'        }',
	'        try {',
	'            int c = x > 1 ? 1 : 2;',
	'        } catch (RuntimeException e) {',
	'        }',
	'        return null;',
	'    }',
	'}',
].join('\n');

// go：import×1；1 类型（type_spec，DDD 口径记类）+ 2 函数（1 方法）；
// 分支 = if + && + for + case（default 不计）共 4 → 文件复杂度 5
const goSample = [
	'package main',
	'import "fmt"',
	'type Store struct {',
	'\tn int',
	'}',
	'func (s Store) Get(x int) int {',
	'\tif x > 0 && x < 10 {',
	'\t\treturn x',
	'\t}',
	'\tfor i := 0; i < 3; i++ {',
	'\t\tfmt.Println(i)',
	'\t}',
	'\tswitch x {',
	'\tcase 1:',
	'\t\treturn 1',
	'\tdefault:',
	'\t\treturn 0',
	'\t}',
	'\treturn 0',
	'}',
	'func Run() {}',
].join('\n');

// rust：1 struct + 1 enum（类数 2，impl 不计类）+ 2 函数（impl 内 get 是方法）；
// 分支 = for + while + match_arm×2 + if 共 5 → 文件复杂度 6；total 复杂度 5、get 复杂度 2
const rustSample = [
	'struct Order { id: u8 }',
	'enum Status { A }',
	'fn total(x: u8) -> u8 {',
	'    let mut r = 0;',
	'    for i in 0..x {',
	'        r += i;',
	'    }',
	'    while r > 0 {',
	'        r -= 1;',
	'    }',
	'    match x {',
	'        1 => 1,',
	'        _ => 0,',
	'    }',
	'}',
	'impl Order {',
	'    fn get(&self) -> u8 {',
	'        if self.id > 0 { 1 } else { 0 }',
	'    }',
	'}',
].join('\n');

// c：#include×2；1 struct（带类体才计数）；1 函数；分支 = if + && + 三元 + for + case
// （default 不计）共 5 → 复杂度 6
const cSample = [
	'#include <stdio.h>',
	'#include "local.h"',
	'struct Point { int x; int y; };',
	'int helper(int a) {',
	'    if (a > 0 && a < 100)',
	'        return a ? 1 : 0;',
	'    for (int i = 0; i < a; i++) {}',
	'    switch (a) {',
	'    case 1:',
	'        break;',
	'    default:',
	'        break;',
	'    }',
	'    return 0;',
	'}',
].join('\n');

// tsx：import×1、export×1；3 函数（Button/go/匿名 onClick 箭头）；分支 = && 共 1 → 复杂度 2
const tsxSample = [
	"import React from 'react';",
	'type Props = { label: string };',
	'export const Button = ({ label }: Props) => {',
	'    const go = () => label;',
	'    return (',
	'        <button onClick={() => go()}>',
	'            {label && <b>{label}</b>}',
	'        </button>',
	'    );',
	'};',
].join('\n');

// js：依赖提取样本——import './util' + require('./helper') 进图，require('path') 非相对不进
const appJsSample = [
	"import { x } from './util';",
	"const p = require('./helper');",
	"const q = require('path');",
	'export function use() { return x(p, q); }',
].join('\n');

// js：被 app.js（import）与 helper.js（require）引用 → 被引用 2 次
const utilJsSample = [
	'export class DataRepository {',
	'  static noop() { return 1; }',
	'}',
].join('\n');

// js：require 相对依赖 → 依赖图边 helper.js → util.js
const helperJsSample = [
	"const u = require('./util');",
	'module.exports = u;',
].join('\n');

// js：函数级热点样本——complex 复杂度 8（if+&&+if+||+for+while+三元 = 7 分支），simple 复杂度 1
const hotJsSample = [
	'function complex(a, b) {',
	'  if (a && b) return 1;',
	'  if (a || b) return 2;',
	'  for (let i = 0; i < 3; i++) {',
	'    while (a) { a = 0; }',
	'  }',
	'  return a ? b : 0;',
	'}',
	'function simple() { return 1; }',
].join('\n');

// js：AST 模式下用真实类名做 DDD 后缀映射（领域层目录 + 实体后缀）
const entityTsSample = [
	'export class OrderEntity {',
	'  id = 0;',
	'}',
].join('\n');

// 集成 fixture：10 个文件全走 AST（engineCounts.ast === 10）
const buildFixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'ast-test-'));
	const put = (rel, text) => {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, `${text}\n`, { encoding: 'utf-8' });
	};
	put('src/svc.py', pySample);
	put('src/OrderRepository.java', javaSample);
	put('src/main.go', goSample);
	put('src/lib.rs', rustSample);
	put('src/lib.c', cSample);
	put('src/Button.tsx', tsxSample);
	put('src/app.js', appJsSample);
	put('src/util.js', utilJsSample);
	put('src/helper.js', helperJsSample);
	put('src/hot.js', hotJsSample);
	put('src/core/OrderEntity.ts', entityTsSample);
	return root;
};

// 注入式 I/O：把 main 的 stdout/stderr 收进字符串，不产生真实终端输出
const captureIo = () => {
	const io = { stdout: '', stderr: '' };
	const make = (key) => ({ write: (s) => { io[key] += s; } });
	return { io, stdout: make('stdout'), stderr: make('stderr') };
};

describe('ast.mjs 基础口径', () => {
	it('LANG_BY_EXT：扩展名映射与任务约定一致，JS 家族判定正确', () => {
		assert.deepEqual(LANG_BY_EXT['.js'], 'javascript');
		assert.deepEqual(LANG_BY_EXT['.mjs'], 'javascript');
		assert.deepEqual(LANG_BY_EXT['.cjs'], 'javascript');
		assert.deepEqual(LANG_BY_EXT['.jsx'], 'tsx');
		assert.deepEqual(LANG_BY_EXT['.tsx'], 'tsx');
		assert.deepEqual(LANG_BY_EXT['.ts'], 'typescript');
		assert.deepEqual(LANG_BY_EXT['.mts'], 'typescript');
		assert.deepEqual(LANG_BY_EXT['.cts'], 'typescript');
		assert.deepEqual(LANG_BY_EXT['.py'], 'python');
		assert.deepEqual(LANG_BY_EXT['.java'], 'java');
		assert.deepEqual(LANG_BY_EXT['.go'], 'go');
		assert.deepEqual(LANG_BY_EXT['.rs'], 'rust');
		assert.deepEqual(LANG_BY_EXT['.c'], 'c');
		assert.deepEqual(LANG_BY_EXT['.h'], 'c');
		assert.deepEqual(LANG_BY_EXT['.cpp'], 'cpp');
		assert.deepEqual(LANG_BY_EXT['.cc'], 'cpp');
		assert.deepEqual(LANG_BY_EXT['.cxx'], 'cpp');
		assert.deepEqual(LANG_BY_EXT['.hpp'], 'cpp');
		assert.deepEqual(LANG_BY_EXT['.hh'], 'cpp');
		for (const l of ['javascript', 'typescript', 'tsx']) assert.ok(JS_FAMILY_LANGS.has(l), l);
		for (const l of ['python', 'java', 'go', 'rust', 'c', 'cpp']) assert.ok(!JS_FAMILY_LANGS.has(l), l);
		assert.equal(MAX_SOURCE_BYTES, 1024 * 1024);
		// javascript/typescript/tsx 三种语法这些构造节点名一致，映射表共用
		assert.equal(LANGUAGE_MAPS.javascript, LANGUAGE_MAPS.typescript);
		assert.equal(LANGUAGE_MAPS.typescript, LANGUAGE_MAPS.tsx);
	});
});

describe('ast.mjs 各语言 AST 指标（真实 wasm 加载，期望值手算写死）', () => {
	let engine;
	before(async () => {
		engine = await getEngine();
	});
	const metricsOf = async (lang, rel, source) => {
		const tree = await engine.parse(lang, source);
		try {
			return extractFileMetrics(rel, lang, tree);
		} finally {
			releaseTree(tree);
		}
	};

	it('python：类/方法/if/elif/for/while/except/boolean_operator/conditional 精确计数', async () => {
		const m = await metricsOf('python', 'src/svc.py', pySample);
		assert.equal(m.imports, 2); // import_statement + import_from_statement
		assert.equal(m.exports, 0);
		assert.equal(m.functions, 2);
		assert.equal(m.methods, 1); // 类内的 def 才是方法
		assert.equal(m.classes, 1);
		assert.deepEqual(m.classNames, ['OrderService']);
		assert.equal(m.complexity, 6); // 1 + if/布尔/for/while/三元 共 5 分支
		assert.deepEqual(m.depSpecs, []); // 非 JS 系 import 仅计数不进依赖图
		assert.deepEqual(m.functionsDetail, [
			{ name: 'create', lang: 'python', file: 'src/svc.py', startLine: 4, endLine: 10, lines: 7, complexity: 5 },
			{ name: 'top', lang: 'python', file: 'src/svc.py', startLine: 11, endLine: 12, lines: 2, complexity: 2 },
		]);
	});

	it('java：class/method/if/catch/ternary/import 精确计数，DDD 类名来自语法树', async () => {
		const m = await metricsOf('java', 'src/OrderRepository.java', javaSample);
		assert.equal(m.imports, 1);
		assert.equal(m.functions, 1);
		assert.equal(m.methods, 1);
		assert.equal(m.classes, 1);
		assert.deepEqual(m.classNames, ['OrderRepository']);
		assert.equal(m.complexity, 4); // 1 + if + 三元 + catch
		assert.equal(m.functionsDetail.length, 1);
		assert.deepEqual(m.functionsDetail[0], { name: 'find', lang: 'java', file: 'src/OrderRepository.java', startLine: 3, endLine: 12, lines: 10, complexity: 4 });
	});

	it('go：func/method/if/for/expression_case 精确计数，default 不计分支', async () => {
		const m = await metricsOf('go', 'src/main.go', goSample);
		assert.equal(m.imports, 1);
		assert.equal(m.functions, 2);
		assert.equal(m.methods, 1); // method_declaration 带接收者
		assert.equal(m.classes, 1); // type_spec 口径
		assert.deepEqual(m.classNames, ['Store']);
		assert.equal(m.complexity, 5); // 1 + if + && + for + case（default 不计）
		assert.deepEqual(m.functionsDetail, [
			{ name: 'Get', lang: 'go', file: 'src/main.go', startLine: 6, endLine: 20, lines: 15, complexity: 5 },
			{ name: 'Run', lang: 'go', file: 'src/main.go', startLine: 21, endLine: 21, lines: 1, complexity: 1 },
		]);
	});

	it('rust：fn/struct/enum/impl/match_arm 精确计数，impl 内 fn 是方法且 impl 不计类', async () => {
		const m = await metricsOf('rust', 'src/lib.rs', rustSample);
		assert.equal(m.imports, 0);
		assert.equal(m.functions, 2);
		assert.equal(m.methods, 1); // impl 内的 get
		assert.equal(m.classes, 2); // struct + enum（impl 不是类）
		assert.deepEqual(m.classNames, ['Order', 'Status']);
		assert.equal(m.complexity, 6); // 1 + for + while + match_arm×2 + if
		assert.deepEqual(m.functionsDetail, [
			{ name: 'total', lang: 'rust', file: 'src/lib.rs', startLine: 3, endLine: 15, lines: 13, complexity: 5 },
			{ name: 'get', lang: 'rust', file: 'src/lib.rs', startLine: 17, endLine: 19, lines: 3, complexity: 2 },
		]);
	});

	it('c：function/struct/#include 精确计数，case_statement 的 default 不计分支', async () => {
		const m = await metricsOf('c', 'src/lib.c', cSample);
		assert.equal(m.imports, 2); // preproc_include
		assert.equal(m.functions, 1);
		assert.equal(m.methods, 0); // c 无类概念
		assert.equal(m.classes, 1); // 带类体的 struct_specifier
		assert.deepEqual(m.classNames, ['Point']);
		assert.equal(m.complexity, 6); // 1 + if + && + 三元 + for + case（default 不计）
		assert.deepEqual(m.functionsDetail, [
			{ name: 'helper', lang: 'c', file: 'src/lib.c', startLine: 4, endLine: 15, lines: 12, complexity: 6 },
		]);
	});

	it('tsx：箭头组件/嵌套匿名箭头/jsx 内逻辑操作符精确计数', async () => {
		const m = await metricsOf('tsx', 'src/Button.tsx', tsxSample);
		assert.equal(m.imports, 1);
		assert.equal(m.exports, 1);
		assert.equal(m.functions, 3); // Button + go + 匿名 onClick
		assert.equal(m.methods, 0);
		assert.equal(m.classes, 0);
		assert.equal(m.complexity, 2); // 1 + &&（jsx 表达式内）
		// 匿名箭头归属最内层函数：&& 在 Button 体内、onClick 箭头自身复杂度 1
		assert.deepEqual(m.functionsDetail, [
			{ name: 'Button', lang: 'tsx', file: 'src/Button.tsx', startLine: 3, endLine: 10, lines: 8, complexity: 2 },
			{ name: 'go', lang: 'tsx', file: 'src/Button.tsx', startLine: 4, endLine: 4, lines: 1, complexity: 1 },
			{ name: '(匿名)', lang: 'tsx', file: 'src/Button.tsx', startLine: 6, endLine: 6, lines: 1, complexity: 1 },
		]);
	});
});

describe('analyze.mjs AST 分发与函数级热点', () => {
	it('analyzeDir：全库 AST 分发，引擎行/热点表/多语言 DDD/依赖图精确一致', async () => {
		const root = buildFixture();
		try {
			const s = await analyzeDir(root);
			assert.equal(s.fileCount, 11); // 10 个样本 + OrderEntity.ts
			assert.deepEqual(s.engineCounts, { ast: 11, heuristic: 0, count: 0 });
			assert.equal(s.unanalyzedTotal, 0);
			// 函数级热点：complex（8 分支）排第一；simple 复杂度 1 排不进前十（截断正确）
			assert.equal(s.functionHotspots.length, 10);
			assert.equal(s.functionHotspots[0].name, 'complex');
			assert.equal(s.functionHotspots[0].complexity, 8);
			assert.equal(s.functionHotspots[0].lang, 'javascript');
			assert.equal(s.functionHotspots[0].file, 'src/hot.js');
			assert.ok(s.functionHotspots.every((f, i) => i === 0 || s.functionHotspots[i - 1].complexity >= f.complexity)); // 复杂度降序
			// 多语言 DDD：AST 模式用真实类名，py/java/ts 类全部参与
			assert.ok(s.dddElements.some((e) => e.name === 'OrderService' && e.kind === '领域服务' && e.file === 'src/svc.py'));
			assert.ok(s.dddElements.some((e) => e.name === 'OrderRepository' && e.kind === '仓储' && e.file === 'src/OrderRepository.java'));
			assert.ok(s.dddElements.some((e) => e.name === 'OrderEntity' && e.kind === '实体' && e.file === 'src/core/OrderEntity.ts'));
			// AST 依赖提取：import + require 相对路径进图，require('path') 不进；被引用计数正确
			assert.deepEqual(s.depHotspots, [{ path: 'src/util.js', count: 2 }, { path: 'src/helper.js', count: 1 }]);
			assert.equal(s.cycleCount, 0);
			const report = renderReport(s);
			assert.ok(report.includes('分析引擎：AST ×11 文件 / 启发式 ×0 / 仅计数 ×0'));
			assert.ok(report.includes('| complex | javascript | src/hot.js |'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('>1MB 大文件防护：跳过 AST 走纯计数，不触发 wasm 解析', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ast-big-'));
		try {
			// 约 1.2MB 的普通 JS（每行 200 字节 × 6000 行），无分支无函数
			const line = `const pad = '${'a'.repeat(180)}';`;
			const big = Array.from({ length: 6000 }, () => line).join('\n');
			assert.ok(Buffer.byteLength(big, 'utf-8') > MAX_SOURCE_BYTES);
			writeFileSync(join(root, 'big.js'), `${big}\n`, { encoding: 'utf-8' });
			const s = await analyzeDir(root);
			assert.deepEqual(s.engineCounts, { ast: 0, heuristic: 0, count: 1 });
			assert.equal(s.totalLines, 6000);
			assert.equal(s.avgComplexity.toFixed(2), '1.00'); // 纯计数复杂度基线 1
			assert.equal(s.functionHotspots, null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('--heuristic（engine: heuristic）：py fixture 回纯计数、js 走正则启发式', async () => {
		const root = buildFixture();
		try {
			const s = await analyzeDir(root, { engine: 'heuristic' });
			assert.equal(s.engineCounts.ast, 0);
			assert.equal(s.engineCounts.heuristic, 6); // app/util/helper/hot/Button/OrderEntity
			assert.equal(s.engineCounts.count, 5); // py/java/go/rust/c
			assert.equal(s.functionHotspots, null); // 启发式模式无函数级指标
			const report = renderReport(s);
			assert.ok(report.includes('分析引擎：AST ×0 文件 / 启发式 ×6 / 仅计数 ×5'));
			assert.ok(report.includes('启发式模式无函数级指标。'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('vendor 缺失降级：临时改名 vendor 目录，js 回正则启发式不崩（测完恢复）', async () => {
		const vendorDir = fileURLToPath(new URL('../skills/code-analyzer/scripts/vendor', import.meta.url));
		const backupDir = `${vendorDir}-test-bak`;
		assert.ok(existsSync(vendorDir), 'vendor 目录应存在');
		resetEngineCache(); // 清掉前面用例已缓存的引擎，确保真实走「缺失」路径
		renameSync(vendorDir, backupDir);
		let summary = null;
		try {
			const root = buildFixture();
			try {
				summary = await analyzeDir(root); // 不抛异常：全库降级
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		} finally {
			renameSync(backupDir, vendorDir); // 无论断言成败都恢复目录
			resetEngineCache();
		}
		assert.ok(summary);
		assert.deepEqual(summary.engineCounts, { ast: 0, heuristic: 6, count: 5 });
		assert.equal(summary.functionHotspots, null);
		// 正则启发式依赖提取照常工作：app.js(import+require) 与 helper.js(require) 的相对边仍在
		assert.deepEqual(summary.depHotspots, [{ path: 'src/util.js', count: 2 }, { path: 'src/helper.js', count: 1 }]);
	});

	it('main：--heuristic CLI 冒烟，引擎行与降级提示如实输出', async () => {
		const root = buildFixture();
		try {
			const { io, stdout, stderr } = captureIo();
			const code = await main(['--path', root, '--heuristic'], { stdout, stderr });
			assert.equal(code, 0);
			assert.ok(io.stdout.includes('分析引擎：AST ×0 文件 / 启发式 ×6 / 仅计数 ×5'));
			assert.ok(io.stdout.includes('启发式模式无函数级指标。'));
			assert.equal(io.stderr, '');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
