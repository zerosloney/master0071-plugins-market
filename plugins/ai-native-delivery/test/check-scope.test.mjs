// check-scope.test.mjs — tmp git 仓 fixture（2026-10-09）
// 覆盖：越界检出 / 未落检出 / 白名单豁免 / --strict 退出码 / 无 plan exit 2 / 版本号 token 过滤
// 2026-11-13 判据移植（源 8f6a22f84 B 件）：S8-S11 声明粒度收紧（裸名非根件不算声明 /
// 根真实文件例外 / 带目录后缀 / `...` 段通配）；S2 夹具声明改带目录形态（裸名声明按新判据失效——
// 属判据收紧的正确行为，修夹具不为绿放水）。
// 2026-11-20 S14-S15 KNOWN_EXT 白名单守护（008f8fd +'.html' 根修回归）：.html 声明放行
// （确认时刻 suspiciousDeclarations 与推送门 declAccepted 双口径）+ 非白名单扩展（.exe）仍拦。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// S12 声明形态早期反馈（papercut 根修 2026-11-13）：suspiciousDeclarations 直接单测——
// 缩写/会被丢弃的 token 暴露，散文/URL/版本号/合法声明不误报
{
  const { suspiciousDeclarations, declAccepted } = await import(pathToFileURL(CLI).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-sus-'));
  fs.writeFileSync(path.join(root, 'src-a.md'), '# A\n', 'utf8'); // 根真实文件（裸名接受判据夹具）
  const plan = path.join(root, 'p.md');
  fs.writeFileSync(plan, [
    '## 改动方案',
    '- `plugins/x/plugin.json`：版本位（带目录+已知扩展名，合法）',
    '- `.codex/.omp/.zcode` 三宿主缩写（形似路径但会被丢弃——应被标记）',
    '- `src/.../ok.md`：通配声明（合法）',
    '- 引用 `v1.2.2` 与 `https://github.com/x/y`（散文 token，不应误报）',
    '正文段落里出现的 `.codex/.omp/.zcode` 不在 bullet 行，不判',
    '',
    '## 其他节',
    '- `.codex/.omp/.zcode` 非声明节不判',
  ].join('\n'), 'utf8');
  const sus = suspiciousDeclarations(plan, root);
  check('S12 缩写 token 被标记（含行号）', sus.length === 1 && sus[0].token === '.codex/.omp/.zcode' && sus[0].line === 3, JSON.stringify(sus));
  check('S12b 合法声明/通配/散文/URL/版本号/非 bullet 均不误报',
    !sus.some((s) => /plugin\.json|ok\.md|v1\.2\.2|github/.test(s.token)), JSON.stringify(sus));
  check('S12c declAccepted 单源判据：带目录+已知扩展名 / 真实文件 / 裸名+未知扩展 的三态',
    declAccepted('a/b.json', root) === true
    && declAccepted('src-a.md', root) === true
    && declAccepted('v1.2.2', root) === false
    && declAccepted('.codex/.omp/.zcode', root) === false,
    '');
  fs.rmSync(root, { recursive: true, force: true });
}

// S13 抓取表达力扩容（2026-11-18 推送实证）：extractDeclared 三正则——
// 无扩展名带目录（vendored LICENSE-*）与点开头根文件（.gitignore）两类真实形态入声明清单；
// 散文 / 裸词由 declAccepted 兜底拒绝不爆炸；三正则重叠命中与重复声明行去重
{
  const { extractDeclared } = await import(pathToFileURL(CLI).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-ext-'));
  fs.mkdirSync(path.join(root, 'vendor', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vendor', 'dir', 'LICENSE-foo'), 'license\n'); // 无扩展名带目录，真实存在
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');             // 点开头根文件，真实存在
  const plan = path.join(root, 'p.md');
  fs.writeFileSync(plan, [
    '## 改动面',
    '- vendor/dir/LICENSE-foo：vendored 许可文件（带目录无扩展名）',
    '- .gitignore：点开头根文件',
    '- 散文行混写 and/or README 之类裸词（无真实文件，不得入声明）',
  ].join('\n'), 'utf8');
  const declared = extractDeclared(plan, root);
  check('S13 带目录无扩展名文件被抓取（vendored LICENSE 形态）', declared.includes('vendor/dir/LICENSE-foo'), JSON.stringify(declared));
  check('S13b 点开头根文件被抓取（.gitignore 形态）', declared.includes('.gitignore'), JSON.stringify(declared));
  check('S13c 散文 and/or 与裸词 README 不入声明（declAccepted 兜底防爆炸）',
    !declared.includes('and/or') && !declared.includes('README'), JSON.stringify(declared));
  // 去重：同一 token 多行重复声明 + TOKEN_RE/PATH_RE 重叠命中 → 只计一次
  fs.writeFileSync(plan, [
    '## 改动面',
    '- src/ok.md：改',
    '- src/ok.md：改（重复声明行）',
    '- vendor/dir/LICENSE-foo：改',
    '- .gitignore：改',
  ].join('\n'), 'utf8');
  const deduped = extractDeclared(plan, root);
  const cnt = (t) => deduped.filter((x) => x === t).length;
  check('S13d 声明去重：重复行与多正则重叠命中均只计一次',
    cnt('src/ok.md') === 1 && cnt('vendor/dir/LICENSE-foo') === 1 && cnt('.gitignore') === 1, JSON.stringify(deduped));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- S14–S15 KNOWN_EXT 白名单守护（008f8fd 根修回归，2026-11-14 +'.html'）----

// S14 .html 声明放行：插件已分发 board/dev-tour.html 而扩展集落后时，声明在确认时刻
// （suspiciousDeclarations）与推送范围门（declAccepted → 越界判定）双拦。夹具根刻意不放真实文件——
// 「真实文件例外」（realFile）会兜底放行致变异不可杀，KNOWN_EXT 必须是唯一放行路径
{
  const { extractDeclared, declAccepted, suspiciousDeclarations } = await import(pathToFileURL(CLI).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-known-'));
  const plan = path.join(root, 'p.md');
  fs.writeFileSync(plan, [
    '## 改动面',
    '- `dist/board.html`：插件分发的模板件',
    '- `dist/tool.exe`：形似路径的二进制附件（非白名单扩展，应被标记）',
  ].join('\n'), 'utf8');
  check('S14 .html 放行（推送门口径）：declAccepted 接受 dist/board.html 且入声明清单',
    declAccepted('dist/board.html', root) === true && extractDeclared(plan, root).includes('dist/board.html'),
    JSON.stringify({ acc: declAccepted('dist/board.html', root), declared: extractDeclared(plan, root) }));
  const sus = suspiciousDeclarations(plan, root);
  check('S14b .html 放行（确认时刻口径）：suspiciousDeclarations 不标记 dist/board.html',
    !sus.some((s) => s.token === 'dist/board.html'), JSON.stringify(sus));
  fs.rmSync(root, { recursive: true, force: true });
}

// S15 非白名单扩展仍拦（守住 KNOWN_EXT 不无限放宽）：.exe 不在白名单且非真实文件 →
// 声明被弃（extractDeclared 不收 → 变更件计越界）、确认时刻 suspicious 标记（行号+token）
{
  const { extractDeclared, declAccepted, suspiciousDeclarations } = await import(pathToFileURL(CLI).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-known-'));
  const plan = path.join(root, 'p.md');
  fs.writeFileSync(plan, [
    '## 改动面',
    '- `dist/tool.exe`：二进制附件（非白名单扩展，应被标记）',
  ].join('\n'), 'utf8');
  check('S15 .exe 仍拦（推送门口径）：declAccepted 拒绝 dist/tool.exe 且不入声明清单',
    declAccepted('dist/tool.exe', root) === false && !extractDeclared(plan, root).includes('dist/tool.exe'),
    JSON.stringify({ acc: declAccepted('dist/tool.exe', root), declared: extractDeclared(plan, root) }));
  const sus = suspiciousDeclarations(plan, root);
  check('S15b .exe 仍拦（确认时刻口径）：suspicious 标记 dist/tool.exe（行号 2）',
    sus.length === 1 && sus[0].token === 'dist/tool.exe' && sus[0].line === 2, JSON.stringify(sus));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
