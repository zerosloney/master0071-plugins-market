// check-local-gates.test.mjs — 门卫上岗自检：配置齐全放行 / 缺 hooksPath 阻断 / 插件形态判据切换（黑盒夹具仓）
// 2026-10-27 插件化修复：判据按部署形态分两套（源仓形态 core.hooksPath+.githooks 五钩子；插件形态
//   git 实际会执行的 pre-commit / pre-push 两执法点）。回归护栏：插件形态下输出绝不可出现
//   「设 core.hooksPath」指引——该设置会整体接管 git 钩子查找，使 init-engine 装好的钩子静默失效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-local-gates.mjs', import.meta.url)); // 插件化落位（2026-10-27 迁移）：测试在 test/，被测件在 ../scripts/
const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
const git = (cwd, args) => spawnSync(gitBin, args, { cwd, encoding: 'utf8' });
const jsonlDriver = 'node .agents/scripts/git-merge-jsonl.mjs %O %A %B';

const mkRepo = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-gates-test-'));
  git(tmp, ['init', '-q']);
  return tmp;
};

// 源仓形态夹具：.githooks 五钩子 + .gitattributes + 三条 git config + 项目侧引擎脚本副本标记
const tmp = mkRepo();
try {
  check('S0 临时仓 init', git(tmp, ['init', '-q']).status === 0);
  fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(tmp, '.githooks', h), '', 'utf8');
  }
  fs.mkdirSync(path.join(tmp, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.agents', 'scripts', 'check-loop.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(tmp, '.gitattributes'), [
    'backend/shared/App.Api/appsettings.json merge=ours', // 脱敏泛化（2026-10-27）：appsettings 路径按使用项目替换
    '.agents/*.jsonl merge=jsonl-union',
    'workflow/gate-metrics.d/*.jsonl merge=jsonl-union', // 2026-11 契约扩展：gate-metrics 月分片同受并集驱动
    '',
  ].join('\n'), 'utf8');
  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  git(tmp, ['config', 'merge.ours.driver', 'true']);
  git(tmp, ['config', 'merge.jsonl-union.driver', jsonlDriver]);

  const ok = run(tmp);
  check('S1 源仓形态配置齐全 → exit 0 且打印 PASS', ok.status === 0 && /\[PASS\]/.test(ok.stdout), ok.stdout.slice(-200) + ok.stderr.slice(-200));
  // 2026-10-28 通用化：dotnet 改为**项目识别驱动**——项目根无 .NET 标记时不查、也不打印 dotnet 行
  //（与浏览器探测同待遇：仅回显，不拦上岗）。此前无条件要求，且探测只查 Windows 标准安装位置，
  // ubuntu CI 上没有 dotnet，把这条「应全绿」用例与 S4 一起拖红。
  // 断言随之从「有 [提示] dotnet 行」改为「门卫结论为 PASS 且未因 dotnet 拦下」——后者才是要守住的性质。
  check('S1 无 .NET 标记 → dotnet 不作上岗前提（不出现 [缺失] dotnet）',
    ok.status === 0 && !/\[缺失\]\s*dotnet/.test(ok.stdout), ok.stdout.slice(-240));

  git(tmp, ['config', '--unset', 'core.hooksPath']);
  const missing = run(tmp);
  check('S2 源仓形态缺 hooksPath → exit 1 且点名修复命令',
    missing.status === 1 && /core\.hooksPath/.test(missing.stdout) && /git config core\.hooksPath \.githooks/.test(missing.stdout),
    missing.stdout.slice(-300));

  git(tmp, ['config', 'core.hooksPath', '.githooks']);
  fs.rmSync(path.join(tmp, '.githooks', 'pre-push'));
  const missingHook = run(tmp);
  check('S3 源仓形态钩子文件缺失 → exit 1 且点名文件', missingHook.status === 1 && /pre-push/.test(missingHook.stdout),
    missingHook.stdout.slice(-300));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 插件形态夹具：无项目侧脚本副本；钩子装在 git 默认钩子目录（init-engine 的安装面）
const tmp2 = mkRepo();
try {
  const hooksDir = path.join(tmp2, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(hooksDir, h), '', 'utf8');

  const ok2 = run(tmp2);
  check('S4 插件形态钩子在位 → exit 0 且判据为两执法点',
    ok2.status === 0 && /钩子在位（pre-commit \/ pre-push）/.test(ok2.stdout),
    ok2.stdout.slice(-300) + ok2.stderr.slice(-200));
  check('S4 插件形态输出绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/git config core\.hooksPath \.githooks/.test(ok2.stdout),
    ok2.stdout.slice(-400));

  fs.rmSync(path.join(hooksDir, 'pre-commit'));
  const bad2 = run(tmp2);
  check('S5 插件形态钩子缺失 → exit 1 且点名 pre-commit + 修复指向 init-engine',
    bad2.status === 1 && /pre-commit/.test(bad2.stdout) && /init-engine\.mjs/.test(bad2.stdout),
    bad2.stdout.slice(-400));
  check('S5 插件形态钩子缺失时绝不含「设 core.hooksPath」指引（自伤回归护栏）',
    !/git config core\.hooksPath \.githooks/.test(bad2.stdout),
    bad2.stdout.slice(-400));
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// 项目识别分支（2026-10-28 通用化）：dotnet 只对「项目根有 .NET 标记」的项目生效——
// 通用项目（Node/Python/Go…）不依赖 dotnet，缺失不得拦上岗（S1/S4 夹具无标记，天然覆盖）；
// 有标记时恢复硬查，登记机制（runtime-env.local.md）可解。
const tmp3 = mkRepo();
try {
  const hooksDir3 = path.join(tmp3, '.git', 'hooks');
  fs.mkdirSync(hooksDir3, { recursive: true });
  for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(hooksDir3, h), '', 'utf8');
  // .NET 项目标记：出现即恢复 dotnet 硬查
  fs.writeFileSync(path.join(tmp3, 'App.sln'), 'fixture\n', 'utf8');
  // 登记打桩：把 dotnet 登记为本机 node 可执行文件（--version 有输出），不依赖机器装没装 dotnet
  fs.mkdirSync(path.join(tmp3, '.agents', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(tmp3, '.agents', 'notes', 'runtime-env.local.md'),
    `| 工具 | 路径 |\n| --- | --- |\n| dotnet | ${process.execPath} |\n`, 'utf8');

  const ok3 = run(tmp3);
  check('S6 有 .NET 标记 → dotnet 必查且经登记可解 → exit 0',
    ok3.status === 0 && /\[echo\] dotnet → /.test(ok3.stdout),
    ok3.stdout.slice(-300));
} finally {
  fs.rmSync(tmp3, { recursive: true, force: true });
}

// S6b 有标记但机器解析不到 dotnet → exit 1 且点名 dotnet（装了 dotnet 的机器跳过本断言：
// PATH/标准位置命中时无法在黑盒夹具里伪造「缺失」，该分支由无 dotnet 的裸机覆盖）
const tmp4 = mkRepo();
try {
  const hooksDir4 = path.join(tmp4, '.git', 'hooks');
  fs.mkdirSync(hooksDir4, { recursive: true });
  for (const h of ['pre-commit', 'pre-push']) fs.writeFileSync(path.join(hooksDir4, h), '', 'utf8');
  fs.writeFileSync(path.join(tmp4, 'App.sln'), 'fixture\n', 'utf8');

  const dotnetResolvable =
    fs.existsSync('C:/Program Files/dotnet/dotnet.exe') ||
    (() => { const r = spawnSync('dotnet', ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0; })();
  if (dotnetResolvable) {
    console.log('SKIP S6b 本机可解析 dotnet（PATH/标准位置命中）——「有标记而缺失 → 拦上岗」分支由无 dotnet 的机器覆盖');
  } else {
    const bad3 = run(tmp4);
    check('S6b 有 .NET 标记而 dotnet 缺失 → exit 1 且点名 dotnet',
      bad3.status === 1 && /dotnet/.test(bad3.stdout),
      bad3.stdout.slice(-300));
  }
} finally {
  fs.rmSync(tmp4, { recursive: true, force: true });
}

// S7 契约覆盖守卫（2026-11 Minor）：.gitattributes 只保 .agents/*.jsonl、缺 workflow/gate-metrics.d/*.jsonl
// 行 → 门卫判缺（跨机合并月分片走默认策略会静默丢别机快照——退役判据燃料缺损）。修复前该形态判绿（RED）。
const tmp5 = mkRepo();
try {
  fs.mkdirSync(path.join(tmp5, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(tmp5, '.githooks', h), '', 'utf8');
  }
  fs.mkdirSync(path.join(tmp5, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp5, '.agents', 'scripts', 'check-loop.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(tmp5, '.gitattributes'), [
    'backend/shared/App.Api/appsettings.json merge=ours',
    '.agents/*.jsonl merge=jsonl-union',
    // 故意缺：workflow/gate-metrics.d/*.jsonl merge=jsonl-union
    '',
  ].join('\n'), 'utf8');
  git(tmp5, ['config', 'core.hooksPath', '.githooks']);
  git(tmp5, ['config', 'merge.ours.driver', 'true']);
  git(tmp5, ['config', 'merge.jsonl-union.driver', jsonlDriver]);

  const bad5 = run(tmp5);
  check('S7 缺 gate-metrics.d/*.jsonl 契约行 → exit 1 且点名 gate-metrics',
    bad5.status === 1 && /gate-metrics\.d/.test(bad5.stdout), bad5.stdout.slice(-300));
} finally {
  fs.rmSync(tmp5, { recursive: true, force: true });
}

// S8 子目录调用一致性（2026-11 市场审查 M11）：③.gitattributes / ④.githooks / ⑥runtime-env.local.md
// 此前是 cwd 相对读——子目录调用时读到「仓库根文件全缺失」，与 ①-② 的仓库根判据自相矛盾
//（同一次调用一半看仓库根、一半看调用者所在子目录）。修复后三处锚 ROOT（paths.mjs 单源），
// 子目录调用与根目录裁决一致。源仓形态夹具覆盖最严：三处读点在该形态下全部进执法面
//（插件形态 .gitattributes 只出提示、.githooks 不判，夹不住回归）。
const tmp6 = mkRepo();
try {
  fs.mkdirSync(path.join(tmp6, '.githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push', 'post-commit']) {
    fs.writeFileSync(path.join(tmp6, '.githooks', h), '', 'utf8');
  }
  fs.mkdirSync(path.join(tmp6, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp6, '.agents', 'scripts', 'check-loop.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(tmp6, '.gitattributes'), [
    'backend/shared/App.Api/appsettings.json merge=ours',
    '.agents/*.jsonl merge=jsonl-union',
    'workflow/gate-metrics.d/*.jsonl merge=jsonl-union',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(tmp6, 'App.sln'), 'fixture\n', 'utf8');
  // 登记打桩：dotnet → node 本体（fs.existsSync 恒真，--version 有输出）——⑥ 的登记读点是否
  // 锚仓库根，看子目录调用时这条回显是否还在（cwd 相对读会读空 → 回显降级为「未登记」）。
  fs.mkdirSync(path.join(tmp6, '.agents', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(tmp6, '.agents', 'notes', 'runtime-env.local.md'),
    `| 工具 | 路径 |\n| --- | --- |\n| dotnet | ${process.execPath} |\n`, 'utf8');
  git(tmp6, ['config', 'core.hooksPath', '.githooks']);
  git(tmp6, ['config', 'merge.ours.driver', 'true']);
  git(tmp6, ['config', 'merge.jsonl-union.driver', jsonlDriver]);

  const rootRun = run(tmp6);
  check('S8 根目录调用 → exit 0 且 PASS（夹具自证齐全）',
    rootRun.status === 0 && /\[PASS\]/.test(rootRun.stdout), rootRun.stdout.slice(-300));
  const sub = path.join(tmp6, 'sub', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  const subRun = run(sub);
  const echoLine = (out) => (/^\s*\[echo\] dotnet → (.*)$/m.exec(out) || [])[1] || '';
  check('S8 子目录调用 → 与根目录裁决一致（exit 0 且 PASS，无任何 [缺失]）',
    subRun.status === 0 && /\[PASS\]/.test(subRun.stdout) && !/\[缺失\]/.test(subRun.stdout),
    subRun.stdout.slice(-300));
  check('S8 子目录调用 → runtime-env.local.md 登记仍生效（dotnet 回显同根目录）',
    subRun.status === 0 && echoLine(subRun.stdout) !== '' && echoLine(subRun.stdout) === echoLine(rootRun.stdout),
    `root=[${echoLine(rootRun.stdout)}] sub=[${echoLine(subRun.stdout)}]`);
} finally {
  fs.rmSync(tmp6, { recursive: true, force: true });
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
