#!/usr/bin/env node
// check-plan.mjs 的 node:test 回归（2026-10-29 从 extras/poteto-mode-scripts/check-plan.test.ts 移植）。
//
// 为什么存在：check-plan.mjs 是**已发布**的零依赖 node 脚本（skills/poteto-mode/scripts/，随装随用），
// 但它此前唯一的测试是 bun:test 形态、住在 extras/（默认不加载、CI 明写不纳入，Windows 下还有平台性
// 失败）——这批已发布代码在**任何平台都没有 CI 守护**。本文件用 node:test 重写同一组断言，
// 落进标准 test/ 目录、进 ci.yml 的 pstack 门，双平台零依赖运行。
// bun 原件保留在 extras/（上游 vendored 文件，改动它会给上游同步制造噪音）。
//
//   node test/check-plan.test.mjs     # 或由 ci.yml 执行
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'poteto-mode', 'scripts', 'check-plan.mjs');
const rule =
	"Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";

const validPlan = `# Demo

## How to read this
One box is one unit of work and names the evidence. Check a box only when its evidence exists. See playbooks/.
${rule}

## Program checklist
### Arm the program
- [ ] Write the standing orders. Read the playbook from the installed plugin. Arm the hourly audit tick.
### Spawn owners
- [ ] Spawn one owner per PR.
### PR mechanics
- [ ] Open each PR ready.
### Verdict and merge
- [ ] Record each verdict.
### Boot recipe
\`git show origin/main:\` /loop 1h status message
- [ ] Boot each live lane.

## PR 1
**Depends on.** None.
**Files.**
- [ ] Do the thing.
**Build.**
- [ ] Do the thing.
**You see.**
- [ ] Do the thing.
**Verify, unit.** ${rule}
- [ ] Check the thing.
**Verify, live.** ${rule} Ten lanes on the configured \`swarm workers\` model at the PR head
${Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. Save \`lane-${i + 1}.png\`. Pass when evidence exists.`).join("\n")}
**Verify, perf.** ${rule}
- [ ] Metric. Recorded.
- [ ] Probe. Recorded.
- [ ] Baseline. Recorded.
- [ ] Rule. Recorded.
**Review gate.** None.
**Merge.**
- [ ] Merge when approved.

## Close the program
- [ ] Close.

## Appendix Prototype evidence
Recorded.
`;

const runPlan = (example, expectedExit) => {
	const directory = mkdtempSync(join(tmpdir(), "check-plan-test-"));
	const file = join(directory, "plan.md");
	writeFileSync(file, validPlan + example);
	try {
		const result = spawnSync(process.execPath, [checker, file], { encoding: "utf8" });
		assert.equal(result.status, expectedExit, `exit=${result.status} stderr=${result.stderr}`);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

describe("check-plan.mjs", () => {
	it("accepts ordinary, indented, and longer closing fences", () => {
		for (const indent of ["", " ", "  ", "   "])
			runPlan(`${indent}\`\`\`markdown\n## Example only\n${indent}\`\`\`\n`, 0);
		runPlan("```markdown\n## Example only\n````\n", 0);
	});

	it("accepts nested backticks and tilde info strings", () => {
		runPlan("````markdown\n```markdown\n## Example only\n```\n````\n", 0);
		runPlan("~~~markdown `info`\n## Example only\n ~~~\n", 0);
	});

	it("keeps mismatched, shorter, and suffixed closers inside the fence", () => {
		runPlan("````markdown\n~~~\n## Example only\n````\n", 0);
		runPlan("````markdown\n```\n## Example only\n````\n", 0);
		runPlan("````markdown\n``` info\n## Example only\n````\n", 0);
	});

	it("rejects headings and prose outside a proper close", () => {
		for (const suffix of ["  ", "\t"]) {
			const heading = runPlan(`\`\`\`markdown\n## Example only\n\`\`\`${suffix}\n## Example only\n`, 1);
			assert.match(heading.stderr, /"## Example only" after Close the program is not an appendix/);
		}

		const prose = runPlan("```markdown\nThis prose has a mid-sentence colon: inside code\n```\nThis prose has a mid-sentence colon: bad.\n", 1);
		assert.match(prose.stderr, /mid-sentence colon/);
	});

	it("rejects backtick info strings containing a backtick", () => {
		const result = runPlan("```markdown `invalid`\n## Example only\n```\n", 1);
		assert.match(result.stderr, /"## Example only" after Close the program is not an appendix/);
	});
});
