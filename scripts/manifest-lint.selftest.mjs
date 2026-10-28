// 反证测试：把 manifest-lint 的「CI 引用文件必须已入库」放到一个可控的最小 git 仓里跑，
// 确认①未跟踪但磁盘存在的文件会被拦下（不是只查 existsSync）；②全部入库时通过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-neg-'));
for (const d of ['scripts', 'plugins', 'test', '.github/workflows']) fs.mkdirSync(path.join(REPO, d), { recursive: true });
fs.copyFileSync(path.join(SRC_REPO, 'scripts', 'manifest-lint.mjs'), path.join(REPO, 'scripts', 'manifest-lint.mjs'));

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const run = (args) => spawnSync(GIT, args, { cwd: REPO, encoding: 'utf8' });
const lint = () => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'manifest-lint.mjs')], { cwd: REPO, encoding: 'utf8' });

const plug = path.join(REPO, 'plugins', 'demo');
fs.mkdirSync(path.join(plug, 'skills', 'demo-skill'), { recursive: true });
const META = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'demo', version: '0.0.1', description: 'd',
  author: { name: 'a', url: 'u' }, homepage: 'u', repository: 'u', license: 'MIT', keywords: ['k'],
};
fs.writeFileSync(path.join(plug, 'plugin.json'), JSON.stringify(META, null, 2));
for (const shim of ['.codex-plugin', '.omp-plugin', '.zcode-plugin']) {
  fs.mkdirSync(path.join(plug, shim), { recursive: true });
  fs.writeFileSync(path.join(plug, shim, 'plugin.json'), JSON.stringify(META, null, 2));
}
fs.writeFileSync(path.join(plug, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\nbody\n');
fs.writeFileSync(path.join(REPO, 'test', 'committed.mjs'), '// ok\n');
fs.writeFileSync(path.join(REPO, 'test', 'ghost.mjs'), '// 磁盘有、索引无\n');
const CI = ['name: ci', 'on: push', 'jobs:', '  t:', '    steps:', '      - run: |',
  '          node test/committed.mjs', '          node test/ghost.mjs', ''].join('\n');
fs.writeFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), CI);

run(['init', '-q']);
run(['add', 'plugins', 'test/committed.mjs', '.github', 'scripts']);
run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const bad = lint();
const badText = (bad.stdout || '') + (bad.stderr || '');
console.log('--- 场景①：ghost.mjs 未入库，期望 exit=1 并点名 ---');
console.log(badText.trim());

// 场景②：把 ghost 入库（引用不变），应转为通过——证明拦的是「未入库」而不是「存在性」
run(['add', 'test/ghost.mjs']);
const good = lint();
console.log('--- 场景②：引用全部入库，期望 exit=0 ---');
console.log(((good.stdout || '') + (good.stderr || '')).trim());

const caseOne = bad.status === 1 && /ghost\.mjs/.test(badText) && /未入库/.test(badText);
const caseTwo = good.status === 0;
console.log(`\n场景① ${caseOne ? 'PASS' : 'FAIL'} | 场景② ${caseTwo ? 'PASS' : 'FAIL'}`);
process.exit(caseOne && caseTwo ? 0 : 1);
