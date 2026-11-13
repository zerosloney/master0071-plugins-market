#!/usr/bin/env node
// doctor.test.mjs — doctor.mjs 安装自检黑盒测试（2026-11 doctor 工单新增）
// 手法同 install.test.mjs：mkdtemp 临时 git 仓 spawn 真实 CLI。断言：
// ①健康仓（init 后 doctor）全 ✓ exit 0 + runDoctor/formatChecks 库面形状；②删台账 → 台账 ✗
// exit 1 且修复行含 init-engine 命令；③删台账内已装文件 → 一致性 ✗ 点名该文件；④改已装文件
// 内容 → 一致性 ✗ 点名；⑤删 pre-commit 钩子 → hooks ✗；⑥抹 gitignore 标记块 → ✗；⑦settings.json
// 写坏 JSON / deny 删一条种子自带地板项 → ✗；⑧engine.json 改 policyVersion → 漂移 ✗ 且 detail
// 同含种子值与项目值；⑨非 git 目录 --root → 项目根 ✗ exit 1 不崩溃、其余检查项照常出列。
// 零依赖，Node ≥ 18 直接运行：node test/doctor.test.mjs（node --test 亦可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, PLUGIN_CONFIG_TEMPLATES_DIR } from '../scripts/paths.mjs';
import { runDoctor, formatChecks } from '../scripts/doctor.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(TEST_DIR, '..', 'scripts', 'doctor.mjs');
const INIT = path.join(TEST_DIR, '..', 'scripts', 'init-engine.mjs');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
// 七个检查面名称（与 doctor.mjs 检查项一一对应，出列齐全性断言用）
const CHECK_NAMES = ['项目根', '安装台账', '已装文件与台账一致', 'git hooks', '.gitignore 标记块', 'settings.json deny 地板', 'engine.json policyVersion'];

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

const mkRepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
  spawnSync(GIT, ['init', '-q'], { cwd: d });
  return d;
};
const runDoctorCli = (root) => spawnSync(process.execPath, [DOCTOR, '--root', root], { encoding: 'utf8' });
const runInit = (root) => spawnSync(process.execPath, [INIT, '--root', root], { encoding: 'utf8' });

// failLine(out, name) / fixLineOf(out, name)：按检查名定位「✗ 名称 …」行与其下一行缩进的修复行——
// 逐检查项断言，不做全输出模糊匹配。
const failLine = (out, name) => out.split('\n').find((l) => l.includes('✗') && l.includes(name)) || '';
const fixLineOf = (out, name) => {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.includes('✗') && l.includes(name));
  return i === -1 ? '' : (lines[i + 1] || '');
};

// ---- ① 健康仓：init 后 doctor 全 ✓ exit 0；库面 runDoctor / formatChecks 形状 ----
{
  const root = mkRepo();
  const init = runInit(root);
  check('① 前置：init-engine exit 0', init.status === 0, `exit=${init.status} ${init.stderr}`);
  const r = runDoctorCli(root);
  check('① 健康仓 doctor exit 0', r.status === 0, `exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  check('① 输出全 ✓（无任何 ✗ 行）', r.stdout.includes('✓') && !r.stdout.includes('✗'), r.stdout);
  check('① 七个检查面齐全出列', CHECK_NAMES.every((n) => r.stdout.includes(n)), r.stdout);
  const lib = runDoctor(root);
  check('① runDoctor 返回 {ok:true, checks 共 7 项}', lib.ok === true && Array.isArray(lib.checks) && lib.checks.length === 7, JSON.stringify(lib.checks && lib.checks.map((c) => ({ ok: c.ok, name: c.name }))));
  check('① 检查项形状 {ok, name, detail, fix}',
    lib.checks.every((c) => typeof c.ok === 'boolean' && typeof c.name === 'string' && typeof c.detail === 'string' && typeof c.fix === 'string')
    && lib.checks.every((c) => c.ok === true || c.fix !== ''), JSON.stringify(lib.checks));
  check('① formatChecks 渲染 ✓ 行（供测试 import 的库面）', formatChecks(lib.checks).includes('✓ 项目根'), formatChecks(lib.checks).split('\n')[0]);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ② 删安装台账 → 台账 ✗、exit 1、修复行含 init-engine 命令 ----
{
  const root = mkRepo();
  runInit(root);
  fs.rmSync(path.join(root, '.agents', 'install-manifest.json'));
  const r = runDoctorCli(root);
  check('② 删台账 → exit 1', r.status === 1, `exit=${r.status} ${r.stdout}`);
  check('② 台账检查 ✗（点名缺失/领养语义）', /✗.*安装台账/.test(r.stdout) && /领养/.test(failLine(r.stdout, '安装台账')), failLine(r.stdout, '安装台账'));
  check('② 修复行含可直接执行的 init-engine 命令', fixLineOf(r.stdout, '安装台账').includes('init-engine.mjs') && fixLineOf(r.stdout, '安装台账').includes('--root'), fixLineOf(r.stdout, '安装台账'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ③ 删台账内已装文件 → 一致性 ✗ 且点名该文件 ----
{
  const root = mkRepo();
  runInit(root);
  const victim = path.join(root, '.agents', 'config', 'mechanism-registry.md');
  check('③ 前置：victim 在台账内且盘上存在', fs.existsSync(victim), victim);
  fs.rmSync(victim);
  const r = runDoctorCli(root);
  check('③ exit 1 且一致性检查 ✗', r.status === 1 && /✗.*已装文件与台账一致/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('③ detail 点名缺失文件', failLine(r.stdout, '已装文件与台账一致').includes('mechanism-registry.md'), failLine(r.stdout, '已装文件与台账一致'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④ 改台账内已装文件内容 → 一致性 ✗ 且点名该文件 ----
{
  const root = mkRepo();
  runInit(root);
  const victim = path.join(root, '.agents', 'config', 'engine.json');
  fs.appendFileSync(victim, '\n<!-- 用户手改 -->\n');
  const r = runDoctorCli(root);
  check('④ exit 1 且一致性检查 ✗', r.status === 1 && /✗.*已装文件与台账一致/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('④ detail 点名被改文件', failLine(r.stdout, '已装文件与台账一致').includes('.agents/config/engine.json'), failLine(r.stdout, '已装文件与台账一致'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ④b 运行时账本（workflow/ 骨架文档）被改写 → 只核存在性，不报失配（自举实证修口）----
{
  const root = mkRepo();
  runInit(root);
  fs.appendFileSync(path.join(root, 'workflow', 'INDEX.md'), '\n<!-- 引擎重生成 -->\n');
  const r = runDoctorCli(root);
  check('④b 运行时账本改写后 doctor 仍全绿', r.status === 0 && !/✗/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤ 删 pre-commit 钩子 → hooks ✗ ----
{
  const root = mkRepo();
  runInit(root);
  fs.rmSync(path.join(root, '.git', 'hooks', 'pre-commit'));
  const r = runDoctorCli(root);
  check('⑤ exit 1 且 hooks 检查 ✗', r.status === 1 && /✗.*git hooks/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('⑤ detail 点名 pre-commit 缺失', failLine(r.stdout, 'git hooks').includes('pre-commit 缺失'), failLine(r.stdout, 'git hooks'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑤b commit-msg 两态（2026-11-12 L0/L1 快速道移植，语义照 post-commit 先例）----
{
  const root = mkRepo();
  runInit(root);
  fs.rmSync(path.join(root, '.git', 'hooks', 'commit-msg'));
  const r = runDoctorCli(root);
  check('⑤b1 台账有记录而盘上被删 → ✗ 点名 commit-msg 缺失（被删态）',
    r.status === 1 && failLine(r.stdout, 'git hooks').includes('commit-msg 缺失（安装台账有记录，盘上被删）'), failLine(r.stdout, 'git hooks'));
  fs.rmSync(root, { recursive: true, force: true });

  // 旧装两态：抹掉台账中 commit-msg 记录 → 模拟旧版安装从未装过
  const root2 = mkRepo();
  runInit(root2);
  fs.rmSync(path.join(root2, '.git', 'hooks', 'commit-msg'));
  const manifestPath2 = path.join(root2, '.agents', 'install-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath2, 'utf8'));
  for (const k of Object.keys(manifest.files)) if (k.endsWith('/commit-msg')) delete manifest.files[k];
  fs.writeFileSync(manifestPath2, JSON.stringify(manifest));
  const r2 = runDoctorCli(root2);
  check('⑤b2 台账无记录 → ✗ 旧版安装「从未装过」可读说明（非误报被删）',
    r2.status === 1 && failLine(r2.stdout, 'git hooks').includes('commit-msg 未安装（当前插件版本新增的顺序门钩子'), failLine(r2.stdout, 'git hooks'));
  fs.rmSync(root2, { recursive: true, force: true });

  // 在位但指向损坏：改写 baked CONFIRM_ORDER_SCRIPT 为不存在路径 → ✗ 点名
  const root3 = mkRepo();
  runInit(root3);
  const cmPath = path.join(root3, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(cmPath, fs.readFileSync(cmPath, 'utf8').replace(/const CONFIRM_ORDER_SCRIPT = "(?:[^"\\]|\\.)*"/, 'const CONFIRM_ORDER_SCRIPT = "<broken>/gone.mjs"'));
  const r3 = runDoctorCli(root3);
  check('⑤b3 commit-msg 在位但指向的引擎脚本不存在 → ✗ 点名',
    r3.status === 1 && failLine(r3.stdout, 'git hooks').includes('commit-msg 指向的引擎脚本不存在'), failLine(r3.stdout, 'git hooks'));
  fs.rmSync(root3, { recursive: true, force: true });
}

// ---- ⑥ 抹掉 .gitignore 标记块 → gitignore ✗ ----
{
  const root = mkRepo();
  runInit(root);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  const r = runDoctorCli(root);
  check('⑥ exit 1 且标记块检查 ✗', r.status === 1 && /✗.*\.gitignore 标记块/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  check('⑥ detail 点名标记块缺失', /缺失/.test(failLine(r.stdout, '.gitignore 标记块')), failLine(r.stdout, '.gitignore 标记块'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑦ settings.json：写坏 JSON / deny 删一条种子自带地板项 → 各自 ✗ ----
{
  const root = mkRepo();
  runInit(root);
  const settings = path.join(root, '.agents', 'settings.json');
  fs.writeFileSync(settings, '{ broken json', 'utf8');
  const r1 = runDoctorCli(root);
  check('⑦a 坏 JSON → exit 1 且 deny 地板检查 ✗', r1.status === 1 && /✗.*settings\.json deny 地板/.test(r1.stdout), `exit=${r1.status} ${r1.stdout}`);
  check('⑦a detail 交代 pretool-risk 回退语义（地板执法不中断）', /内置 deny 地板/.test(failLine(r1.stdout, 'settings.json deny 地板')), failLine(r1.stdout, 'settings.json deny 地板'));

  // 删一条**种子自带**的地板项（git reset --hard 在 BUILTIN.deny 且在种子 deny 里——文件级基线）
  const seed = JSON.parse(fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'settings.json'), 'utf8'));
  seed.permissions.deny = seed.permissions.deny.filter((d) => d !== 'git reset --hard');
  fs.writeFileSync(settings, JSON.stringify(seed, null, 2), 'utf8');
  const r2 = runDoctorCli(root);
  check('⑦b 删地板项 → exit 1 且 deny 地板检查 ✗', r2.status === 1 && /✗.*settings\.json deny 地板/.test(r2.stdout), `exit=${r2.status} ${r2.stdout}`);
  check('⑦b detail 点名被删地板项', failLine(r2.stdout, 'settings.json deny 地板').includes('git reset --hard'), failLine(r2.stdout, 'settings.json deny 地板'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑧ engine.json 改 policyVersion → 漂移 ✗ 且 detail 同含项目值与种子值 ----
{
  const root = mkRepo();
  runInit(root);
  const seedV = JSON.parse(fs.readFileSync(path.join(PLUGIN_CONFIG_TEMPLATES_DIR, 'engine.json'), 'utf8')).policyVersion;
  const projV = seedV - 1;
  const engineFile = path.join(root, '.agents', 'config', 'engine.json');
  const body = JSON.parse(fs.readFileSync(engineFile, 'utf8'));
  body.policyVersion = projV;
  fs.writeFileSync(engineFile, JSON.stringify(body, null, 2), 'utf8');
  const r = runDoctorCli(root);
  check('⑧ exit 1 且 policyVersion 检查 ✗', r.status === 1 && /✗.*engine\.json policyVersion/.test(r.stdout), `exit=${r.status} ${r.stdout}`);
  const line = failLine(r.stdout, 'engine.json policyVersion');
  check('⑧ detail 同含项目值与种子值（漂移可见）', line.includes(String(projV)) && line.includes(String(seedV)) && line.includes('漂移'), line);
  check('⑧ 修复行给两个选项、无强制命令', /确认/.test(fixLineOf(r.stdout, 'engine.json policyVersion')) && /手改/.test(fixLineOf(r.stdout, 'engine.json policyVersion')), fixLineOf(r.stdout, 'engine.json policyVersion'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- ⑨ 非 git 目录 --root → 项目根 ✗、exit 1、不崩溃、其余检查项照常出列（独立失败）----
{
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-nogit-'));
  const r = runDoctorCli(plain);
  check('⑨ 非 git 目录 exit 1（不崩溃，有完整输出）', r.status === 1 && r.stdout.trim().length > 0, `exit=${r.status} error=${r.error} stdout=${r.stdout} stderr=${(r.stderr || '').slice(0, 200)}`);
  check('⑨ 项目根 ✗（不可锚定为 git 仓库根）', /✗ 项目根/.test(r.stdout), r.stdout);
  check('⑨ 其余检查项照常出列（一项 ✗ 不中断其余）', CHECK_NAMES.every((n) => r.stdout.includes(n)), r.stdout);
  fs.rmSync(plain, { recursive: true, force: true });
}

// ---- ⑩ post-commit（2026-11-11 Dreaming 移植）：健康在场 ✓ / 删钩子（台账有记录）→「被删」✗ /
//      旧装模拟（台账无记录）→ 可读说明 ✗ 而非「被删」误报 ----
{
  const root = mkRepo();
  runInit(root);
  // ⑩a 健康仓：hooks ✓ detail 认得 post-commit advisory 提醒
  const ok = runDoctorCli(root);
  check('⑩a 健康仓 hooks ✓ 且点名 post-commit advisory', ok.status === 0 && /✓ git hooks.*post-commit/.test(ok.stdout), ok.stdout);
  // ⑩b 删 post-commit 文件（安装台账仍有记录）→ 真缺失 ✗ + 修复命令
  fs.rmSync(path.join(root, '.git', 'hooks', 'post-commit'));
  const r1 = runDoctorCli(root);
  check('⑩b 删 post-commit → hooks ✗ 且判「台账有记录，盘上被删」',
    r1.status === 1 && /✗ git hooks/.test(r1.stdout) && /post-commit 缺失（安装台账有记录，盘上被删）/.test(failLine(r1.stdout, 'git hooks')), failLine(r1.stdout, 'git hooks'));
  check('⑩b 修复行含 init-engine 命令', fixLineOf(r1.stdout, 'git hooks').includes('init-engine.mjs'), fixLineOf(r1.stdout, 'git hooks'));
  // ⑩c 旧装模拟：台账记录一并抹掉（该钩子从未装过）→ ✗ 但 detail 是「未安装 / 旧版安装 / 不影响门禁」可读说明
  const manifestFile = path.join(root, '.agents', 'install-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  delete manifest.files['.git/hooks/post-commit'];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
  const r2 = runDoctorCli(root);
  const line = failLine(r2.stdout, 'git hooks');
  check('⑩c 旧装（从未装过）→ ✗ 且 detail 为可读说明（未安装/旧版安装）',
    r2.status === 1 && /post-commit 未安装/.test(line) && /旧版安装/.test(line), line);
  check('⑩c 不误报「被删」且说明不装不影响门禁', !/盘上被删/.test(line) && /不影响门禁/.test(line), line);
  // ⑩d 补装后（重跑 init）→ hooks 恢复 ✓
  runInit(root);
  const r3 = runDoctorCli(root);
  check('⑩d 重跑 init 补装 → doctor 恢复全绿', r3.status === 0 && fs.existsSync(path.join(root, '.git', 'hooks', 'post-commit')), r3.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// 汇总 + 退出码（同 install.test.mjs 口径：断言全挂必须让进程退出码变红）
console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
