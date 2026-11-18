// analyze.mjs 的 node:test 回归（与 pstack/test/check-plan.test.mjs 同款直跑形式）。
//
// 为什么存在：analyze.mjs 是零依赖纯函数式脚本（skills/code-analyzer/scripts/），
// main 与分析逻辑分离，本文件直接 import 纯函数断言指标数值（可控小样本手工算好期望值），
// 并用注入式 I/O 覆盖 CLI 行为。本文件固定走启发式层（engine: 'heuristic'）与降级口径，
// AST 层的指标与降级测试在 ast.test.mjs。不依赖网络与外部路径：fixture 用 mkdtempSync
// 建在系统临时目录（含循环依赖对、其他语言样本、默认排除目标），测完 rmSync 清理。
//
//   node test/analyze.test.mjs     # 可直跑，或由 CI 执行
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
	analyzeDir,
	analyzeSource,
	classifyDddElement,
	classifyLayer,
	findCycles,
	isExcluded,
	main,
	parseArgs,
	renderReport,
} from '../skills/code-analyzer/scripts/analyze.mjs';

// ---------------------------------------------------------------------------
// fixture：每处指标都是手工数出来的可控小样本（行尾统一补 \n）
// ---------------------------------------------------------------------------

// 31 行：空行 6、注释行 4；2 类 + 3 方法简写 + 2 function 声明 + 1 箭头赋值；
// 复杂度 4（1 + if + || + 三元）；export 4 行。
const orderTs = [
	'// 订单聚合样本：函数、类、复杂度分支都放在这个文件里。',
	'/* 块注释',
	'   第二行 */',
	'export class OrderAggregate {',
	"  private status = 'new';",
	'',
	'  addItem(item) {',
	"    if (item === 'a') {",
	'      return 1;',
	'    }',
	'    return 0;',
	'  }',
	'',
	'  // 行注释：方法简写上方',
	'  cancel() {}',
	'}',
	'',
	'export class OrderRepository {',
	'  find(id) {',
	"    return id || 'unknown';",
	'  }',
	'}',
	'',
	'export function formatOrder(order) {',
	"  const label = order ? order.id : 'empty';",
	'  return label;',
	'}',
	'',
	"const buildLabel = (prefix) => prefix + '!';",
	'',
	'export function noop() {}',
];

// 6 行：与 b.ts 构成循环依赖；TODO 一处。
const aTs = [
	"import { orderTotal } from './b';",
	'// TODO: 拆分循环依赖',
	'',
	'export function orderA() {',
	'  return orderTotal();',
	'}',
];

// 4 行：复杂度 2（1 + 三元）。
const bTs = [
	"import { orderA } from './a';",
	'export function orderTotal() {',
	'  return orderA() ? 1 : 0;',
	'}',
];

// 8 行：FIXME 与 HACK 各一处（首行注释文本不含任何标记词，避免干扰计数；TODO 样本在 a.ts）。
const serviceJs = [
	'// 用户服务样本：标记计数见下方各处。',
	'export class UserService {',
	'  handle(evt) {',
	'    // FIXME: 补充参数校验',
	"    if (!evt) throw new Error('no event'); // HACK: 临时防御",
	"    return evt.type || 'none';",
	'  }',
	'}',
];

// 3 行：仅一个实体类。
const entityTs = [
	'export class OrderEntity {',
	'  id = 0;',
	'}',
];

// 1 行：无 DDD 后缀的普通文件。
const plainTs = [
	'export const util = () => 1;',
];

// 3 行：require('path') 计入 import 数，但非相对依赖不进依赖图。
const libJs = [
	'// vendor 库文件：--exclude 片段与 require 依赖口径测试用。',
	"const path = require('path');",
	'module.exports = { v: 1 };',
];

// 其他语言样本：启发式模式下回纯计数（行分类按 JS 习惯，# 注释计代码行）；AST 模式下真实解析。
const samplePy = [
	'# 示例：启发式模式纯计数 / AST 模式精确解析。',
	'def foo():',
	'    pass',
];

// 默认排除目标：.d.ts。
const typesDts = [
	'export interface Brand {',
	'  id: number;',
	'}',
];

// 默认排除目标：node_modules。
const nodeModulesIndexJs = [
	'module.exports = 1;',
];

const buildFixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'analyze-test-'));
	const put = (rel, lines) => {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, `${lines.join('\n')}\n`, { encoding: 'utf-8' });
	};
	put('a.ts', aTs);
	put('b.ts', bTs);
	put('sample.py', samplePy);
	put('types.d.ts', typesDts);
	put('src/order.ts', orderTs);
	put('src/service.js', serviceJs);
	put('src/core/entity.ts', entityTs);
	put('src/plain.ts', plainTs);
	put('vendor/lib.js', libJs);
	put('node_modules/pkg/index.js', nodeModulesIndexJs);
	return root;
};

// pstack 同款模式：fixture 建在临时目录，用完即删；summary 每次现算，测试互不依赖顺序。
// options 透传 analyzeDir（本文件主要用 engine: 'heuristic' 固定走启发式层）。
const withFixture = async (fn, options) => {
	const root = buildFixture();
	try {
		await fn(root, await analyzeDir(root, options));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

// 注入式 I/O：把 main 的 stdout/stderr 收进字符串，不产生真实终端输出。
const captureIo = () => {
	const io = { stdout: '', stderr: '' };
	const make = (key) => ({ write: (s) => { io[key] += s; } });
	return { io, stdout: make('stdout'), stderr: make('stderr') };
};

describe('analyze.mjs', () => {
	it('parseArgs：默认值、可重复的 --exclude、--heuristic 开关、缺值与未知参数报错', () => {
		assert.deepEqual(parseArgs([]), { path: process.cwd(), output: null, excludes: [], help: false, heuristic: false });
		assert.deepEqual(parseArgs(['-p', 'x', '--exclude', 'a', '-e', 'b']), { path: 'x', output: null, excludes: ['a', 'b'], help: false, heuristic: false });
		assert.equal(parseArgs(['--help']).help, true);
		assert.equal(parseArgs(['--heuristic']).heuristic, true); // 布尔开关，不取值
		assert.throws(() => parseArgs(['--path']), /缺少取值/);
		assert.throws(() => parseArgs(['--nope', 'x']), /未知参数/);
	});

	it('analyzeSource：order.ts 文件级指标与手工期望值精确一致', () => {
		const m = analyzeSource('src/order.ts', `${orderTs.join('\n')}\n`);
		assert.deepEqual(m.lines, { total: 31, empty: 6, comment: 4, code: 21 });
		assert.equal(m.imports, 0);
		assert.equal(m.exports, 4);
		assert.equal(m.functions, 6);
		assert.deepEqual(m.functionBreakdown, { declarations: 2, arrows: 1, methods: 3 });
		assert.equal(m.classes, 2);
		assert.deepEqual(m.classNames, ['OrderAggregate', 'OrderRepository']);
		assert.equal(m.complexity, 4);
		assert.deepEqual(m.todos, { total: 0, todo: 0, fixme: 0, hack: 0 });
		assert.deepEqual(m.depSpecs, []);
	});

	it('analyzeSource：import/require 计数与相对依赖提取', () => {
		const a = analyzeSource('a.ts', `${aTs.join('\n')}\n`);
		assert.equal(a.imports, 1);
		assert.equal(a.exports, 1);
		assert.deepEqual(a.depSpecs, ['./b']);
		assert.deepEqual(a.todos, { total: 1, todo: 1, fixme: 0, hack: 0 });

		const lib = analyzeSource('vendor/lib.js', `${libJs.join('\n')}\n`);
		assert.equal(lib.imports, 1); // require( 计入 import 数
		assert.deepEqual(lib.depSpecs, []); // 非相对依赖不提取
	});

	it('classifyDddElement：类名后缀映射正确', () => {
		const cases = [
			['OrderAggregate', '聚合根'],
			['AggregateRoot', '聚合根'], // 长后缀优先，不被判成 Aggregate 之外的东西
			['OrderAggregateRoot', '聚合根'],
			['OrderEntity', '实体'],
			['MoneyValueObject', '值对象'],
			['PaymentVO', '值对象'],
			['OrderService', '领域服务'],
			['UserRepository', '仓储'],
			['OrderCreatedEvent', '领域事件'],
			['OrderController', '控制器'],
			['ErrorHandler', '处理器'],
			['Helper', null],
			['UserServiceImpl', null], // 不含完整后缀则不命中
		];
		for (const [name, expected] of cases) assert.equal(classifyDddElement(name), expected, name);
	});

	it('classifyLayer：目录分层识别（含顶层与嵌套路径段）', () => {
		const cases = [
			['src/domain/order.ts', '领域层'],
			['src/core/entity.ts', '领域层'],
			['application/usecase.ts', '应用层'],
			['src/infrastructure/db.ts', '基础设施层'],
			['src/adapter/http.ts', '基础设施层'],
			['presentation/page.ts', '表现层'],
			['src/api/main.ts', '表现层'],
			['web/ui/Button.tsx', '表现层'],
			['src/utils/helper.ts', null],
		];
		for (const [p, expected] of cases) assert.equal(classifyLayer(p), expected, p);
	});

	it('analyzeDir：模块级汇总与手工期望值精确一致（启发式层口径）', async () => {
		await withFixture((root, s) => {
			assert.equal(s.fileCount, 8); // 7 个 JS/TS + sample.py 纯计数
			assert.equal(s.totalLines, 59); // 6+4+31+8+3+1+3 + sample.py 3
			assert.equal(s.emptyLines, 7); // a.ts 1 + order.ts 6
			assert.equal(s.commentLines, 8); // 1+4+2+1（sample.py 的 # 注释按 JS 习惯计代码行）
			assert.deepEqual(s.unanalyzedByExt, {}); // .py 已可分析，.rb/.php 不在 fixture 中
			assert.equal(s.unanalyzedTotal, 0);
			assert.equal(s.avgComplexity.toFixed(2), '1.75'); // 13/7 + sample.py 1 = 14/8
			assert.equal(s.engineCounts.ast, 0); // 强制启发式：无 AST 文件
			assert.equal(s.engineCounts.heuristic, 7);
			assert.equal(s.engineCounts.count, 1); // sample.py 纯计数
			assert.equal(s.functionHotspots, null); // 启发式模式无函数级指标
			assert.equal(s.cycleCount, 1);
			assert.deepEqual(s.cycles, [['a.ts', 'b.ts']]);
			assert.equal(s.complexityTop[0].path, 'src/order.ts');
			assert.equal(s.complexityTop[0].complexity, 4);
			assert.equal(s.bigFilesTop[0].path, 'src/order.ts');
			assert.equal(s.bigFilesTop[0].lines, 31);
			assert.equal(s.bigFilesTop[0].oversized, false);
			assert.deepEqual(s.depHotspots, [{ path: 'a.ts', count: 1 }, { path: 'b.ts', count: 1 }]);
			assert.deepEqual(
				s.dddElements.map((e) => `${e.name}=${e.kind}`),
				['OrderAggregate=聚合根', 'OrderEntity=实体', 'OrderRepository=仓储', 'UserService=领域服务'],
			);
			assert.deepEqual(s.dddLayers, [{ layer: '领域层', count: 1, examples: ['src/core/entity.ts'] }]);
			assert.deepEqual(s.candidateContexts, [{ group: 'src', files: 4, hits: 4, density: 1 }]);
			assert.deepEqual(s.todoTop.map((t) => t.path), ['src/service.js', 'a.ts']);
			assert.equal(s.todoTop[0].count, 2); // FIXME + HACK
			assert.equal(s.todoTop[0].perK.toFixed(2), '250.00'); // 2 处 / 8 行
			assert.equal(s.todoTop[1].perK.toFixed(2), '166.67'); // a.ts：1 处 / 6 行
		}, { engine: 'heuristic' });
	});

	it('--exclude 片段排除生效', async () => {
		await withFixture(async (root) => {
			const filtered = await analyzeDir(root, { excludes: ['vendor'], engine: 'heuristic' });
			assert.equal(filtered.fileCount, 7); // 8 - vendor/lib.js
			assert.equal(filtered.totalLines, 56); // 59 - vendor/lib.js 3 行
			assert.ok(filtered.paths.every((p) => !p.includes('vendor')));
			assert.ok(filtered.paths.includes('src/order.ts'));
		}, { engine: 'heuristic' });
	});

	it('默认排除：node_modules 与 .d.ts 不进分析', async () => {
		await withFixture((root, s) => {
			assert.ok(s.paths.every((p) => !p.includes('node_modules')));
			assert.ok(s.paths.every((p) => !p.endsWith('.d.ts')));
			assert.ok(!s.paths.includes('types.d.ts'));
			assert.equal(s.unanalyzedTotal, 0); // .py 已可分析；.d.ts 被默认排除连计数都不进
		}, { engine: 'heuristic' });
	});

	it('isExcluded：路径分隔符归一后做片段包含匹配', () => {
		assert.equal(isExcluded('a\\b\\node_modules\\x.js', ['node_modules']), true);
		assert.equal(isExcluded('a/b/node_modules/x.js', ['node_modules']), true);
		assert.equal(isExcluded('types.d.ts', ['.d.ts']), true);
		assert.equal(isExcluded('src/order.ts', ['vendor']), false);
	});

	it('renderReport：章节标题齐全且按固定顺序，含循环依赖两侧路径', async () => {
		await withFixture((root, s) => {
			const report = renderReport(s);
			const headings = [
				'# 代码分析报告',
				'## 概览',
				'## 复杂度热点 top10',
				'## 函数级复杂度热点 top10',
				'## 超大文件 top10',
				'## 依赖热点 top10',
				'## 循环依赖',
				'## DDD 启发式识别',
				'## TODO 密度 top5',
				'## 边界与口径',
			];
			let last = -1;
			for (const h of headings) {
				const idx = report.indexOf(h);
				assert.ok(idx > last, `缺章节或顺序不对：${h}`);
				last = idx;
			}
			assert.ok(report.includes('a.ts -> b.ts -> a.ts'));
			assert.ok(report.includes('a.ts'));
			assert.ok(report.includes('b.ts'));
			assert.ok(report.includes('未分析文件数：0'));
			assert.ok(report.includes('分析引擎：AST ×')); // 默认 AST 模式，引擎行如实披露
		});
	});

	it('findCycles：三节点环规范化去重、无环与自环', () => {
		const graph = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
		assert.deepEqual(findCycles(graph), [['a', 'b', 'c']]);
		assert.deepEqual(findCycles(new Map([['a', ['b']], ['b', []]])), []);
		assert.deepEqual(findCycles(new Map([['x', ['x']]])), [['x']]);
	});

	it('空目录（含非源码文件）：诚实零报告不崩溃', async () => {
		const root = mkdtempSync(join(tmpdir(), 'analyze-empty-'));
		try {
			writeFileSync(join(root, 'README.md'), '# 纯文档插件\n', { encoding: 'utf-8' });
			const s = await analyzeDir(root);
			assert.equal(s.fileCount, 0);
			assert.equal(s.unanalyzedTotal, 0);
			const report = renderReport(s);
			assert.ok(report.includes('未检测到循环依赖。'));
			assert.ok(report.includes('平均圈复杂度：—'));
			assert.ok(report.includes('未分析文件数：0'));
			assert.ok(report.includes('（无已分析源码文件）'));
			assert.ok(report.includes('启发式模式无函数级指标。')); // 无 AST 产出时该节如实降级
			assert.ok(report.includes('未识别到符合 DDD 后缀约定的类。'));
			assert.ok(report.includes('未发现 TODO/FIXME/HACK 标记。'));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('main：stdout 模式（--output 缺省时报告打到 stdout，不写文件）', async () => {
		await withFixture(async (root) => {
			const { io, stdout, stderr } = captureIo();
			const code = await main(['--path', root], { stdout, stderr });
			assert.equal(code, 0);
			assert.ok(io.stdout.includes('# 代码分析报告'));
			assert.ok(io.stdout.includes('## 循环依赖'));
			assert.equal(io.stderr, '');
		});
	});

	it('main：--output 模式写入文件且含全部章节标题，stdout 不再打报告', async () => {
		await withFixture(async (root) => {
			const outDir = mkdtempSync(join(tmpdir(), 'analyze-out-'));
			const outFile = join(outDir, 'report.md');
			try {
				const { io, stdout, stderr } = captureIo();
				const code = await main(['--path', root, '--output', outFile], { stdout, stderr });
				assert.equal(code, 0);
				const text = readFileSync(outFile, { encoding: 'utf-8' });
				for (const h of ['## 概览', '## 复杂度热点 top10', '## 函数级复杂度热点 top10', '## 超大文件 top10', '## 依赖热点 top10', '## 循环依赖', '## DDD 启发式识别', '## TODO 密度 top5', '## 边界与口径']) {
					assert.ok(text.includes(h), h);
				}
				assert.ok(!io.stdout.includes('# 代码分析报告')); // 报告本体不占 stdout
				assert.ok(io.stderr.includes('报告已写入'));
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
	});

	it('main：非法目录退出码 1 并给 stderr 提示', async () => {
		await withFixture(async (root) => {
			const { io, stdout, stderr } = captureIo();
			const code = await main(['--path', join(root, 'no-such-dir')], { stdout, stderr });
			assert.equal(code, 1);
			assert.ok(io.stderr.includes('不是可用目录'));
		});
	});
});
