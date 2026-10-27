// check-scope.test.mjs — tmp git 仓 fixture（2026-10-09）
// 覆盖：越界检出 / 未落检出 / 白名单豁免 / --strict 退出码 / 无 plan exit 2 / 版本号 token 过滤
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 取 CLI 路径须走 fileURLToPath：`new URL(...).pathname` 对非 ASCII 检出路径会百分号编码
// （如 worktree `MTO变更-1017-01` → `MTO%E5%8F%98%E6%9B%B4-1017-01`），子进程按坏路径启动 → status 1 / 空 stdout，
// 整窝用例假红（2026-10-17 实证于中文名工作树；ASCII 路径下两者等价，故存量一直没暴露）
// 插件化落位（2026-10-27 迁移）：被测脚本在 ../scripts/（原与测试同目录的源仓形态）
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-scope.mjs');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'src-a.md'), '# A\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { root, g };
}

const run = (root, planArgs = []) => spawnSync(process.execPath, [CLI, ...planArgs, '--root', root], { cwd: root, encoding: 'utf8' });

// S1 越界检出（工作区默认口径，含未跟踪）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p1.md'), '## 改动面\n- src-a.md：改\n- src-new.md：新建\n');
  fs.writeFileSync(path.join(root, 'src-b.md'), '# B 越界\n'); // 未跟踪新文件，未声明
  const r = run(root, ['workflow/plans/p1.md']);
  check('S1 越界件检出（未跟踪 src-b.md）', r.status === 0 && /越界件/.test(r.stdout) && /src-b\.md/.test(r.stdout), JSON.stringify({ status: r.status, out: r.stdout.slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S2 未落检出（声明未变更）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p2.md'), '## 改动面\n- src-ghost.md：计划改但没改\n');
  const r = run(root, ['workflow/plans/p2.md']);
  check('S2 未落件检出（src-ghost.md）', r.status === 0 && /未落件/.test(r.stdout) && /src-ghost\.md/.test(r.stdout), JSON.stringify({ status: r.status, out: r.stdout.slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S3 白名单豁免（workflow 台账随行件不算越界）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'intents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p3.md'), '## 改动面\n- src-a.md：改\n');
  fs.writeFileSync(path.join(root, 'src-a.md'), '# A2\n');
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-10-09-x.md'), '---\n状态: draft\n---\n');
  const r = run(root, ['workflow/plans/p3.md']);
  check('S3 台账随行件豁免（workflow/intents 不算越界）', r.status === 0 && !/workflow[\\/]intents/.test(r.stdout.split('未落件')[0]), JSON.stringify({ status: r.status, out: r.stdout.slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S4 --strict 越界 exit 1；无越界 exit 0
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p4.md'), '## 改动面\n- src-a.md：改\n');
  fs.writeFileSync(path.join(root, 'src-a.md'), '# A2\n');
  check('S4a 无越界 --strict exit 0', run(root, ['workflow/plans/p4.md', '--strict']).status === 0);
  fs.writeFileSync(path.join(root, 'src-rogue.md'), '# rogue\n');
  check('S4b 越界 --strict exit 1', run(root, ['workflow/plans/p4.md', '--strict']).status === 1);
  check('S4c 越界无 --strict exit 0（advisory）', run(root, ['workflow/plans/p4.md']).status === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// S5 无 plan exit 2（fail-loud）
{
  const { root } = mkRepo();
  const r = run(root, ['workflow/plans/nope.md']);
  check('S5 plan 不存在 exit 2', r.status === 2, JSON.stringify({ status: r.status }));
  fs.rmSync(root, { recursive: true, force: true });
}

// S6 版本号伪 token 过滤（v1.2.2 不入声明清单）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p6.md'), '## 改动面\n- src-a.md：升级到 v1.2.2\n');
  fs.writeFileSync(path.join(root, 'src-a.md'), '# A2\n');
  const r = run(root, ['workflow/plans/p6.md']);
  check('S6 版本号 token 不产生未落噪声', r.status === 0 && !/1\.2\.2/.test(r.stdout), JSON.stringify({ out: r.stdout.slice(0, 300) }));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
