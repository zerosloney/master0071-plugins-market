#!/usr/bin/env node
// manifest-lint.selftest.mjs — 守护自身的反证测试（2026-10-28 市场审查）
// manifest-lint 是「声明在、实体不在」的最后一道网；但网自己破了没人发现——它的解析口径与
// ci.yml / 垫片写法是正则耦合的，格式一改就可能静默解析到 0 条，于是检查"通过"等于没检查。
// 本套件在临时 git 仓里搭一个**四形俱全**的合法夹具（hooks 指针 / ${CLAUDE_PLUGIN_ROOT} 命令 /
// mcpServers env 三跳 / CI 引用），先断言全绿（证明各条都在真实执法，不是空转），
// 再逐条破坏，断言每条都能点名报红。
// 零依赖，Node ≥ 18：node scripts/manifest-lint.selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

let pass = 0;
let failCount = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { failCount++; console.log(`FAIL  ${desc}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
};

// ── 搭夹具 ──
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-selftest-'));
for (const d of ['scripts', 'plugins/demo/skills/demo-skill', 'plugins/demo/hooks', 'plugins/demo/mcp',
  'plugins/demo/.codex-plugin', 'plugins/demo/.omp-plugin', 'plugins/demo/.zcode-plugin',
  '.github/workflows', 'test']) fs.mkdirSync(path.join(REPO, d), { recursive: true });

const META = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'demo', version: '0.0.1', description: 'd',
  author: { name: 'a', url: 'u' }, homepage: 'u', repository: 'u', license: 'MIT', keywords: ['k'],
};
const writeJson = (rel, obj) => fs.writeFileSync(path.join(REPO, rel), JSON.stringify(obj, null, 2));
const put = (rel, text) => fs.writeFileSync(path.join(REPO, rel), text);

writeJson('plugins/demo/plugin.json', META);
for (const shim of ['.codex-plugin', '.omp-plugin']) writeJson(`plugins/demo/${shim}/plugin.json`, META);
// zcode 垫片把四形都用上：hooks 指针、mcpServers + userConfig 三跳
const ZCODE = {
  ...META,
  skills: './skills',
  hooks: './hooks',
  userConfig: { root: { type: 'string', description: 'worktree 根' } },
  mcpServers: { demo: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'], env: { DEMO_ROOT: '${user_config.root}' } } },
};
writeJson('plugins/demo/.zcode-plugin/plugin.json', ZCODE);
put('plugins/demo/skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: d\n---\nbody\n');
// 数字承诺测量面：2 个 MCP 工具 + 1 个 skill（文案在插件 README 里，写对才通过）
put('plugins/demo/mcp/tools.mjs', [
  'export const TOOLS = [', "  { name: 'demo_one', handler: () => 1 },",
  "  { name: 'demo_two', handler: () => 2 },", '];', '',
].join('\n'));
put('plugins/demo/mcp/server.mjs', '// 读取 DEMO_ROOT 的服务端\nconst root = process.env.DEMO_ROOT;\nexport default root;\n');
put('plugins/demo/README.md', '# demo\n\n本插件提供 2 个 MCP 工具与 1 个 skill，均随包分发。\n');
put('plugins/demo/hooks/hooks.json', JSON.stringify({
  hooks: { PreToolUse: [{ matcher: '[bB][aA][sS][hH]', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pretool-risk.mjs"', timeout: 15 }] }] },
}, null, 2));
put('plugins/demo/hooks/pretool-risk.mjs', '// hook 实体\n');
put('plugins/demo/mcp/server.mjs', '// 读取 DEMO_ROOT 的服务端\nconst root = process.env.DEMO_ROOT;\nexport default root;\n');
writeJson('plugins/demo/mcp.json', {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { demo: { type: 'stdio', command: 'node', args: ['./mcp/server.mjs'], cwd: '${PLUGIN_ROOT}' } },
});
put('test/committed.mjs', '// ok\n');
put('test/ghost.mjs', '// 磁盘有、索引无\n');
put('.github/workflows/ci.yml', ['name: ci', 'on: push', 'jobs:', '  t:', '    steps:', '      - run: |',
  '          node test/committed.mjs', '          node test/ghost.mjs', ''].join('\n'));
fs.copyFileSync(path.join(SRC_REPO, 'scripts', 'manifest-lint.mjs'), path.join(REPO, 'scripts', 'manifest-lint.mjs'));

const git = (args) => spawnSync(GIT, args, { cwd: REPO, encoding: 'utf8' });
git(['init', '-q']);
git(['add', 'plugins', 'test/committed.mjs', '.github', 'scripts']);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const lint = () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'manifest-lint.mjs')], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status, text: (r.stdout || '') + (r.stderr || '') };
};

// ── 基线：夹具入库后应全绿（若这里就红，说明夹具没构造对，后面所有断言都无意义）──
git(['add', 'test/ghost.mjs']);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'track ghost']);
const base = lint();
check('基线：四形俱全的合法夹具应通过', base.status === 0, base.text);

// ── 逐条破坏，断言点名报红 ──
const cases = [
  ['hooks 指针指向不存在的目录', /hooks 指针/, () => {
    writeJson('plugins/demo/.zcode-plugin/plugin.json', { ...ZCODE, hooks: './nope' });
  }, () => writeJson('plugins/demo/.zcode-plugin/plugin.json', ZCODE)],
  ['hook 入口文件缺失（声明在、实体不在）', /pretool-risk\.mjs.*不存在|引用 .*pretool/, () => {
    fs.rmSync(path.join(REPO, 'plugins', 'demo', 'hooks', 'pretool-risk.mjs'));
  }, () => put('plugins/demo/hooks/pretool-risk.mjs', '// hook 实体\n')],
  ['env 映射到 userConfig 里没有的键', /userConfig 无此键/, () => {
    const bad = { ...ZCODE, mcpServers: { demo: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'], env: { DEMO_ROOT: '${user_config.nope}' } } } };
    writeJson('plugins/demo/.zcode-plugin/plugin.json', bad);
  }, () => writeJson('plugins/demo/.zcode-plugin/plugin.json', ZCODE)],
  ['env 键在生产代码里没有读取点（设置页改了不生效）', /没有任何读取点/, () => {
    // 反例正文不得出现该键名（含注释）——否则会被 blob.includes 命中，反例自己失效
    put('plugins/demo/mcp/server.mjs', '// 这台不再读那个环境变量了\nexport default 0;\n');
  }, () => put('plugins/demo/mcp/server.mjs', '// 读取 DEMO_ROOT 的服务端\nconst root = process.env.DEMO_ROOT;\nexport default root;\n')],
  ['CI 引用了未入库的文件', /未入库/, () => {
    put('test/ghost.mjs', '// 磁盘有、索引无\n');
    git(['rm', '--cached', '-q', '--', 'test/ghost.mjs']);
    put('.github/workflows/ci.yml', ['name: ci', 'on: push', 'jobs:', '  t:', '    steps:', '      - run: |',
      '          node test/committed.mjs', '          node test/ghost.mjs', ''].join('\n'));
  }, () => { git(['add', 'test/ghost.mjs']); }],
  // 数字承诺对账：实现是 2 个工具 / 1 个 skill，文案改错就必须点名（这条规则曾因为
  // 「文本得含插件名」的二次守卫而静默空转，实测靠这两例才暴露）
  ['对外文案的工具数与实现不符', /声称 5 个/, () => {
    put('plugins/demo/README.md', '# demo\n\n本插件提供 5 个 MCP 工具与 1 个 skill。\n');
  }, () => put('plugins/demo/README.md', '# demo\n\n本插件提供 2 个 MCP 工具与 1 个 skill，均随包分发。\n')],
  ['对外文案的 skill 数与实现不符', /声称 3 个/, () => {
    put('plugins/demo/README.md', '# demo\n\n本插件提供 2 个 MCP 工具与 3 个 skill。\n');
  }, () => put('plugins/demo/README.md', '# demo\n\n本插件提供 2 个 MCP 工具与 1 个 skill，均随包分发。\n')],
];
for (const [desc, re, breakIt, restore] of cases) {
  breakIt();
  const r = lint();
  check(`破坏形态报红：${desc}`, r.status === 1 && re.test(r.text), `exit=${r.status}｜${r.text}`);
  restore();
  const back = lint();
  check(`还原后恢复通过：${desc}`, back.status === 0, back.text);
}

// ── 反向锚：确认解析口径真的读到了 CI 引用（读 0 条时脚本自身会报，这里再钉一次）──
{
  put('.github/workflows/ci.yml', ['name: ci', 'on: push', 'jobs:', '  t:', '    steps:', '      - run: |',
    '          echo 没有测试门', ''].join('\n'));
  const r = lint();
  check('ci.yml 解析不到任何测试门时必须自曝（防口径脱节=空转通过）',
    r.status === 1 && /未解析到任何/.test(r.text), `exit=${r.status}｜${r.text}`);
}

fs.rmSync(REPO, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
