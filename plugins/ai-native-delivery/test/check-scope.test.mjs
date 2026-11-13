// check-scope.test.mjs — tmp git 仓 fixture（2026-10-09）
// 覆盖：越界检出 / 未落检出 / 白名单豁免 / --strict 退出码 / 无 plan exit 2 / 版本号 token 过滤
// 2026-11-13 判据移植（源 8f6a22f84 B 件）：S8-S11 声明粒度收紧（裸名非根件不算声明 /
// 根真实文件例外 / 带目录后缀 / `...` 段通配）；S2 夹具声明改带目录形态（裸名声明按新判据失效——
// 属判据收紧的正确行为，修夹具不为绿放水）。
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

// S2 未落检出（声明未变更）——声明用带目录形态（2026-11-13 收紧后裸名非根件不再算声明）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p2.md'), '## 改动面\n- src/ghost.md：计划改但没改\n');
  const r = run(root, ['workflow/plans/p2.md']);
  check('S2 未落件检出（src/ghost.md）', r.status === 0 && /未落件/.test(r.stdout) && /src[\\/]ghost\.md/.test(r.stdout), JSON.stringify({ status: r.status, out: r.stdout.slice(0, 300) }));
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

// S3b 归档件豁免（关单归档后的 workflow/archive/** 是台账面，不是产品面）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'archive', '2026-11', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p4.md'), ['## 改动面', '- src-a.md：改', ''].join(String.fromCharCode(10)));
  fs.writeFileSync(path.join(root, 'workflow', 'archive', '2026-11', 'plans', '2026-11-13-x.md'), ['---', '状态: done', '---', ''].join(String.fromCharCode(10)));
  const r = run(root, ['workflow/plans/p4.md']);
  check('S3b 归档件豁免（workflow/archive/** 不算越界）', r.status === 0 && !/workflow[\\/]archive/.test(r.stdout.split('未落件')[0]), JSON.stringify({ status: r.status, out: r.stdout.slice(0, 300) }));
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

// S7 quotepath=off（2026-11-05 对齐 verify-scope.mjs:122-129 同款参数；M2 事故同款）：
// 默认 core.quotepath=true 的机器上非 ASCII 路径被引号+八进制转义（"workflow/incidents/\344\270\255..."）——
// --base/--staged 分支本就不剥引号 → 白名单前缀失配 → 中文闭环随行件假越界；报告路径不可读。
// 夹具显式 git config core.quotepath true——判据不赌机器全局配置。
{
  const { root } = mkRepo();
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('config', 'core.quotepath', 'true');
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflow', 'incidents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'zh.md'), '## 改动面\n- docs/notes.md：改\n');
  const incRel = 'workflow/incidents/2026-11-05-事故复盘.md'; // 白名单豁免的中文随行件（未声明——闭环随行件不算越界）
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), '# N\n');
  fs.writeFileSync(path.join(root, incRel), '# 事故\n');
  g('add', 'docs/notes.md', incRel);
  const st = g('status', '--porcelain');
  check('S7 夹具自检：暂存面在且中文路径被 git 转义（quotepath=true 前提成立）',
    st.status === 0 && /\\3[0-9]{2}/.test(st.stdout), JSON.stringify({ out: st.stdout, err: st.stderr }));
  const r = run(root, ['workflow/plans/zh.md', '--staged', '--strict']);
  check('S7 --staged --strict：中文白名单随行件不假越界（修复前引号+转义击穿白名单 → exit 1）',
    r.status === 0, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  check('S7 报告无八进制转义且白名单随行件被正确豁免（对齐 → 不出越界清单）',
    !/\\3[0-9]{2}/.test(r.stdout) && r.stdout.includes('双向对齐'), r.stdout);
  // 工作区分支（status --porcelain 本就剥引号）：未声明的中文新文件仍须真越界被拦，且原样可读
  fs.writeFileSync(path.join(root, 'docs', '中文说明.md'), '# 中\n');
  const r2 = run(root, ['workflow/plans/zh.md', '--strict']);
  check('S7 工作区未声明中文新文件 → 真越界仍被拦（quotepath=off 不放水）且路径原样可读',
    r2.status === 1 && r2.stdout.includes('docs/中文说明.md'), `exit=${r2.status}\n${r2.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S8–S11 声明粒度收紧（2026-11-13 判据移植，源 8f6a22f84 B 件）----

// S8 裸文件名（非仓库根）不算声明：嵌套同名新文件不再被裸名声明兜住
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p8.md'), '## 改动面\n- nested-file.md：新建\n');
  fs.writeFileSync(path.join(root, 'docs', 'nested-file.md'), '# 新建\n');
  const r = run(root, ['workflow/plans/p8.md', '--strict']);
  check('S8 裸名声明失效：docs/nested-file.md 计越界 --strict exit 1', r.status === 1 && r.stdout.includes('越界件') && r.stdout.includes('docs/nested-file.md'), `exit=${r.status}\n${r.stdout}`);
  check('S8b 裸名不再入声明清单（未落件不点名 nested-file.md）', !/未落件[\s\S]*nested-file/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// S9 仓库根真实文件例外：裸名声明只认根上真实存在的文件
{
  const { root } = mkRepo();
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p9.md'), '## 改动面\n- tsconfig.json：改\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"a":1}\n');
  const r = run(root, ['workflow/plans/p9.md', '--strict']);
  check('S9 根真实文件例外：裸名 tsconfig.json 仍算声明，双向对齐 exit 0', r.status === 0 && r.stdout.includes('双向对齐'), `exit=${r.status}\n${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// S10 带目录后缀仍匹配：声明 deep/ok.md 覆盖 src/deep/ok.md
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p10.md'), '## 改动面\n- deep/ok.md：改\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'ok.md'), '# ok\n');
  const r = run(root, ['workflow/plans/p10.md', '--strict']);
  check('S10 带目录后缀：src/deep/ok.md 命中声明 deep/ok.md，双向对齐 exit 0', r.status === 0 && r.stdout.includes('双向对齐'), `exit=${r.status}\n${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// S11 `...` 段通配：省略中段但必须落到具体文件（不跨文件名、不整树覆盖）
{
  const { root } = mkRepo();
  fs.mkdirSync(path.join(root, 'workflow', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', 'plans', 'p11.md'), '## 改动面\n- src/.../ok.md：改\n');
  fs.writeFileSync(path.join(root, 'src', 'a', 'b', 'ok.md'), '# ok\n');
  fs.writeFileSync(path.join(root, 'src', 'a', 'b', 'ok2.md'), '# 未声明\n');
  const r = run(root, ['workflow/plans/p11.md', '--strict']);
  check('S11 `...` 通配命中中段省略：src/a/b/ok.md 不越界', r.status === 1 && !/越界件[\s\S]*src\/a\/b\/ok\.md/.test(r.stdout), `exit=${r.status}\n${r.stdout}`);
  check('S11b 通配不跨文件名：src/a/b/ok2.md 仍越界', r.status === 1 && /越界件[\s\S]*src\/a\/b\/ok2\.md/.test(r.stdout), r.stdout);
  check('S11c 通配声明已落件（未落件不出现在报告）', !/未落件/.test(r.stdout), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
