#!/usr/bin/env node
// gen-workflow-index.mjs 的 fixture 驱动测试
// 现场构造临时 workflow 根，以「换 cwd」方式运行被测脚本（脚本按相对路径 'workflow/' 读盘）。
// 断言：①活跃（draft/approved/open）逐行出表、终态折叠进档案计数（含 fixed incident）、验收勾验统计；
//       ②--check 一致 exit 0 / 漂移 exit 1（失败路径）；③缺 `模块:` 容忍显示 —。
// 用法：node test/gen-workflow-index.test.mjs（在仓库任意目录执行均可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 插件化落位（2026-10-27 迁移）：引擎脚本在 ../scripts/（原与测试同目录的源仓形态）
const GEN = path.join(SCRIPT_DIR, '..', 'scripts', 'gen-workflow-index.mjs');
const USAGE = '用法：node test/gen-workflow-index.test.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n${detail}` : ''}`); }
};

const doc = (fm, title, body = '') => `---\n${fm}\n---\n# ${title}\n\n${body}\n`;

// mkfix：建临时 workflow 根（4 个子目录齐备——生成器按目录枚举，缺目录会 throw）
const mkfix = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-workflow-index-test-'));
  for (const d of ['intents', 'specs', 'plans', 'incidents']) fs.mkdirSync(path.join(root, 'workflow', d), { recursive: true });
  const w = path.join(root, 'workflow');
  fs.writeFileSync(path.join(w, 'intents', '2026-09-21-alpha.md'), doc(
    '状态: approved\n级别: L1\n日期: 2026-09-21\n模块: pipeline',
    'INTENT — 在跑的需求甲',
    '## 验收标准（可测试）\n- [x] 已验项（证据：实跑）\n- [ ] 未验项\n',
  ), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-21-alpha.md'), doc(
    '状态: approved\n级别: L1\n模块: pipeline',
    'PLAN — 在跑的需求甲',
  ), 'utf8');
  fs.writeFileSync(path.join(w, 'plans', '2026-09-19-beta.md'), doc(
    '状态: done\n级别: L1\n模块: material',
    'PLAN — 已完结的需求乙',
  ), 'utf8');
  fs.writeFileSync(path.join(w, 'incidents', '2026-09-18-gamma.md'), doc(
    '状态: fixed\n级别: L2\n发现: 2026-09-18\n模块: material',
    'INCIDENT — 已修复未收口的事故丙',
  ), 'utf8');
  fs.writeFileSync(path.join(w, 'intents', '_TEMPLATE.md'), doc('状态: draft\n级别: L1', 'INTENT — 模板不该进表'), 'utf8');
  return root;
};

const run = (root, args = []) => spawnSync(process.execPath, [GEN, ...args], { cwd: root, encoding: 'utf8' });

// ---- 场景 1：主路径——活跃逐行 + 终态折叠 + 验收统计 ----
{
  const root = mkfix();
  const r = run(root);
  const idx = fs.readFileSync(path.join(root, 'workflow', 'INDEX.md'), 'utf8');
  check('场景 1：生成器 exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 1：活跃 2 行（approved intent + approved plan）', idx.includes('## 活跃（2）'), idx.split('\n').slice(0, 14).join('\n'));
  check('场景 1：活跃行含 7 字段（类型/级别/状态/日期/模块/标题/验收）',
    /\| INTENT \| L1 \| approved \| 2026-09-21 \| pipeline \| 在跑的需求甲 \| ☑1\/2 \|/.test(idx),
    idx.split('\n').filter((l) => l.startsWith('| INTENT')).join('\n'));
  check('场景 1：终态折叠为档案 2 篇（done plan + fixed incident）', idx.includes('## 档案计数（2，不进表）'), '');
  check('场景 1：档案按类型×模块计数', idx.includes('| PLAN | material | 1 |') && idx.includes('| INCIDENT | material | 1 |'), '');
  check('场景 1：终态构成行含 done 1 · fixed 1', /终态构成：.*done 1.*fixed 1/.test(idx), idx.split('\n').slice(-2).join('\n'));
  check('场景 1：_TEMPLATE.md 不进表', !idx.includes('模板不该进表'), '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2：--check 一致 exit 0 / 漂移 exit 1 / 重生成后复原（失败路径）----
{
  const root = mkfix();
  run(root);
  const ok = run(root, ['--check']);
  check('场景 2：生成后 --check exit 0', ok.status === 0, `exit=${ok.status}\n${ok.stdout}${ok.stderr}`);
  const p = path.join(root, 'workflow', 'intents', '2026-09-21-alpha.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('状态: approved', '状态: done'), 'utf8');
  const drift = run(root, ['--check']);
  check('场景 2：文档状态变更后 --check exit 1（漂移）', drift.status === 1, `exit=${drift.status}\n${drift.stdout}${drift.stderr}`);
  check('场景 2：漂移提示含重生成命令', /gen-workflow-index\.mjs 重新生成/.test(drift.stderr), drift.stderr);
  run(root);
  const ok2 = run(root, ['--check']);
  check('场景 2：重生成后 --check 复原 exit 0', ok2.status === 0, `exit=${ok2.status}\n${ok2.stdout}${ok2.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 2b：CRLF 检出形态（fresh clone）--check 不误报（2026-09-30 行尾归一）----
{
  const root = mkfix();
  run(root);
  const ip = path.join(root, 'workflow', 'INDEX.md');
  fs.writeFileSync(ip, fs.readFileSync(ip, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  const crlf = run(root, ['--check']);
  check('场景 2b：INDEX 为 CRLF 检出形态 → --check exit 0（行尾归一，不假阳性）',
    crlf.status === 0, `exit=${crlf.status}\n${crlf.stdout}${crlf.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 3：缺 `模块:` 容忍显示 —（不报错、不阻断）----
{
  const root = mkfix();
  const p = path.join(root, 'workflow', 'plans', '2026-09-21-alpha.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('模块: pipeline\n', ''), 'utf8');
  const r = run(root);
  const idx = fs.readFileSync(path.join(root, 'workflow', 'INDEX.md'), 'utf8');
  check('场景 3：缺模块字段仍 exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 3：模块列显示 —', /^\| PLAN \| L1 \| approved \| .* \| — \|/m.test(idx), idx.split('\n').filter((l) => l.startsWith('| PLAN | approved')).join('\n'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 4：非法参数 exit 1 ----
{
  const root = mkfix();
  const r = run(root, ['--nope']);
  check('场景 4：未知参数 exit 1', r.status === 1 && /未知参数/.test(r.stderr), `exit=${r.status}\n${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 5：kebab-case H1 不被连字符截断（2026-09-24 前缀正则收窄回归）----
{
  const root = mkfix();
  fs.writeFileSync(path.join(root, 'workflow', 'intents', '2026-09-22-kebab.md'), doc(
    '状态: draft\n级别: L1\n日期: 2026-09-22\n模块: pipeline',
    'workflow-doc-retrieval',
  ), 'utf8');
  const r = run(root);
  const idx = fs.readFileSync(path.join(root, 'workflow', 'INDEX.md'), 'utf8');
  check('场景 5：kebab-case H1 完整保留（未被截成末段）', idx.includes('| workflow-doc-retrieval |') && !idx.includes('| retrieval |'), idx.split('\n').filter((l) => l.includes('retrieval')).join('\n'));
  check('场景 5：em-dash 前缀仍正常剥离', idx.includes('| 在跑的需求甲 |'), '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 6：END 锚点被截断 → fail-loud 不写盘（2026-09-24：原 append 分支产生双生成区）----
{
  const root = mkfix();
  run(root);
  const p = path.join(root, 'workflow', 'INDEX.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('<!-- GENERATED:END -->', ''), 'utf8');
  const r = run(root);
  check('场景 6：END 锚点缺失 → exit 1', r.status === 1, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 6：报错点名锚点不完整', (r.stderr || '').includes('锚点不完整'), r.stderr);
  check('场景 6：未写盘（无双重生成区）', (fs.readFileSync(p, 'utf8').match(/GENERATED:BEGIN/g) || []).length === 1, '');
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 场景 7：从子目录调用也落在 git 仓库根（2026-10-29）----
// 旧实现把 INDEX 路径写成 CWD 相对的 'workflow/INDEX.md'：从 <repo>/sub 调用 → exit 0 且
// 把 sub/workflow/INDEX.md 写出来，仓库根那份一动不动，输出还只说「已生成 workflow/INDEX.md」。
// 静默落错位，没有任何一方会去读那份文件。现在统一走 paths.mjs 的 projectRoot()。
{
  const root = mkfix();
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.invalid');
  git('config', 'user.name', 't');
  git('add', '.');
  git('-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub, { recursive: true });

  const r = spawnSync(process.execPath, [GEN], { cwd: sub, encoding: 'utf8' });
  check('场景 7：从子目录调用 exit 0', r.status === 0, `exit=${r.status}\n${r.stdout}${r.stderr}`);
  check('场景 7：INDEX 生成在仓库根（不是 sub/）', fs.existsSync(path.join(root, 'workflow', 'INDEX.md')), r.stdout);
  check('场景 7：不在 sub/workflow 制造副本', !fs.existsSync(path.join(sub, 'workflow', 'INDEX.md')), r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log(`\n${USAGE}`);
  process.exit(1);
}
process.exit(0);
