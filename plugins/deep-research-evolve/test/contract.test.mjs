// deep-research-evolve 静态契约检查。
//
// 本插件是纯提示词包（无脚本、无 MCP），没有运行时行为可以断言——同 agent-pipelines/test/contract.mjs
// 一路，这里守住的是「跨文件契约不漂移」：四个 SKILL.md 各自演化时，最容易悄悄失配的两处是
//   ① 档案库根解析（谁定义、谁引用、回退路径写在哪一份文件里）
//   ② evolve schedule 的 payload 写法（斜杠命令形态在宿主之间不统一）
//
// 断言以「语义锚点 + 禁止字面量」组织，而不是逐句比对文案：文案可改，语义锚点与被禁的旧写法不可改。
//
//   node plugins/deep-research-evolve/test/contract.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const evolve = read('skills/evolve/SKILL.md');
const deepResearch = read('skills/deep-research/SKILL.md');
const benchmark = read('skills/benchmark/SKILL.md');
const visualReport = read('skills/visual-report/SKILL.md');
const readme = read('README.md');

// 四个技能各自的正文
const SKILLS = { evolve, deepResearch, benchmark, visualReport };
// 会写档案库的三个技能（evolve 是定义方，不在「引用方」里）
const WRITING = { deepResearch, benchmark, visualReport };

describe('档案库根解析（目录冲突修复）', () => {
	it('解析规则只在 evolve 定义一次，其余技能不得复制定义', () => {
		assert.match(evolve, /档案库根解析/, 'evolve 应定义档案库根解析');
		for (const [name, text] of Object.entries(SKILLS)) {
			if (name === 'evolve') continue;
			assert.doesNotMatch(text, /research-evolve/, `${name} 复制了回退路径定义，应只引用 evolve`);
		}
	});

	it('解析规则含占用检查三要素：标记文件、不得写入、停下上报', () => {
		assert.match(evolve, /research-log\.jsonl/, '应认标记文件 research-log.jsonl');
		assert.match(evolve, /不得写入/, '应明确「不得写入他人目录」');
		assert.match(evolve, /停止/, '回退路径也被占用时应停止并上报');
	});

	it('旧的写死路径硬约束已清除', () => {
		for (const [name, text] of Object.entries(SKILLS)) {
			assert.doesNotMatch(text, /写入仅限\s*`?research\/`?\s*目录/, `${name} 仍把写入目标写死为 research/`);
		}
	});

	it('新硬约束「写入仅限档案库根」在 evolve 与 deep-research 生效', () => {
		assert.match(evolve, /写入仅限档案库根/);
		assert.match(deepResearch, /写入仅限档案库根/);
	});

	it('三个写档案的技能都带档案库根门且指向 evolve 的单源定义', () => {
		for (const [name, text] of Object.entries(WRITING)) {
			assert.match(text, /档案库根/, `${name} 缺档案库根门`);
			assert.match(text, /档案库根解析/, `${name} 未指向 evolve 的「档案库根解析」`);
		}
	});

	it('任何提到 research/ 路径的技能都带档案库根语义（防新增技能漏写门）', () => {
		for (const [name, text] of Object.entries(SKILLS)) {
			if (!/research\//.test(text)) continue;
			assert.match(text, /档案库根/, `${name} 提到 research/ 路径但无档案库根语义`);
		}
	});
});

describe('evolve schedule payload 兼容性修复', () => {
	it('不再硬编码命名空间/非命名空间两种斜杠命令', () => {
		assert.doesNotMatch(evolve, /`\/evolve revisit <slug>`/, '旧的非命名空间写法仍在');
		assert.doesNotMatch(evolve, /\/deep-research-evolve:evolve\s+revisit/, '旧的命名空间写法仍在');
	});

	it('payload 用自然语言，并要求观察宿主实际调用形态', () => {
		assert.match(evolve, /自然语言/, 'payload 应写自然语言指令');
		assert.match(evolve, /观察/, '应要求观察宿主实际暴露的调用形态');
	});

	it('创建后要求回读校验，不默认成功', () => {
		assert.match(evolve, /回读/, '创建后应回读任务校验');
	});
});

describe('README 与技能一致', () => {
	it('README 同步档案库根约定', () => {
		assert.match(readme, /档案库根/);
	});
});
