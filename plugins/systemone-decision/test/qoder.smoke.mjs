// Qoder / Qoder CN 适配冒烟测试：按宿主加载器的真实规则校验 .qoder-plugin 两份清单，
// 再用清单里解析出的 command/args 真的拉起一次 MCP 服务器。不需要真实 API Key
// （initialize + tools/list 全程本地，不发网络请求）。
//
// 校验规则来自 Qoder 运行时（Qoder 与 Qoder CN 同一份代码，只有数据目录不同）：
//   · 组件路径字段必须以 ./ 开头；hooks / mcpServers 引用文件必须以 .json 结尾
//   · ${QODER_PLUGIN_ROOT} 与 ${CLAUDE_PLUGIN_ROOT} 会被替换成插件根（win32 下反斜杠转正斜杠），
//     相对路径不会被解析——子进程 cwd 是会话工作区，写 ./mcp/server.mjs 会找不到文件
//   · 市场清单 name 需匹配 ^[a-z0-9][-a-z0-9._]*$、owner 必填、市场名不得占用 Qoder 保留名
//   · ${user_config.X} 只有在用户显式写过插件配置时才替换；未配置时整段原样保留，
//     会作为字面量进子进程 env 污染取值链，所以本清单不使用它（配置走 SYSTEMONE_* 环境变量）
//
// 运行：node test/qoder.smoke.mjs（路径基于本文件解析，任意位置均可运行）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, '..');
const repoRoot = path.join(pluginRoot, '..', '..');

const MANIFEST_FILE = path.join(pluginRoot, '.qoder-plugin', 'plugin.json');
const MARKET_FILE = path.join(repoRoot, '.qoder-plugin', 'marketplace.json');

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
const market = JSON.parse(readFileSync(MARKET_FILE, 'utf8'));
const marketEntry = market.plugins.find((p) => p.name === 'systemone-decision');

// 加载器把插件根替换进字符串时，win32 会把 \ 归一成 /
const rootForHost = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const resolveRoot = (s) =>
  s.replace(/\$\{(?:QODER|CLAUDE)_PLUGIN_ROOT\}/g, () => rootForHost(pluginRoot));

const isComponentPath = (v) =>
  typeof v === 'string' && v.startsWith('./') && (v.endsWith('/') || existsSync(path.join(pluginRoot, v)));

let failed = false;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
};

// ---------- 1. 插件清单 ----------
check('清单基本信息与 marketEntry 一致', () => {
  for (const key of ['name', 'version', 'displayName', 'description']) {
    assert.ok(manifest[key], `清单缺 ${key}`);
  }
  assert.equal(manifest.name, 'systemone-decision');
  assert.equal(manifest.version, marketEntry.version, '清单版本与市场清单版本不一致（跑 node scripts/release.mjs --check）');
});

check('skills 路径符合加载器规则且 SKILL.md 可发现', () => {
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
  for (const s of skills) assert.ok(isComponentPath(s), `skills 路径必须以 ./ 开头且真实存在：${s}`);
  assert.ok(
    skills.some((s) => existsSync(path.join(pluginRoot, s, 'systemone-decision', 'SKILL.md'))),
    'SKILL.md 未被 skills 路径覆盖'
  );
});

check('hooks 是 .json 引用，内容按 Claude 式协议声明 UserPromptSubmit', () => {
  assert.ok(String(manifest.hooks).startsWith('./') && manifest.hooks.endsWith('.json'), `hooks 引用格式不符：${manifest.hooks}`);
  const hooksFile = path.join(pluginRoot, manifest.hooks);
  assert.ok(existsSync(hooksFile), `hooks 文件不存在：${manifest.hooks}`);
  const hooks = JSON.parse(readFileSync(hooksFile, 'utf8'));
  const entries = hooks.hooks?.UserPromptSubmit;
  assert.ok(Array.isArray(entries) && entries.length > 0, 'hooks.json 没有 UserPromptSubmit 条目');
  for (const group of entries) {
    for (const hook of group.hooks || []) {
      assert.equal(hook.type, 'command');
      // 共享的 hooks.json 用 ${CLAUDE_PLUGIN_ROOT}，Qoder 两端变量名都认
      assert.match(hook.command, /\$\{(?:QODER|CLAUDE)_PLUGIN_ROOT\}/, `hook 命令必须走插件根变量：${hook.command}`);
      assert.ok(resolveRoot(hook.command).includes('requirement-clarity.mjs'), 'hook 命令解析后不是预检脚本');
    }
  }
});

check('mcpServers 内联声明：脚本路径绝对化，且不残留 user_config 占位符', () => {
  const servers = manifest.mcpServers;
  assert.ok(servers && !Array.isArray(servers) && typeof servers === 'object', 'mcpServers 必须是内联对象（引用文件会带上不被解析的相对路径）');
  const server = servers.systemone;
  assert.ok(server, '缺 systemone server 声明');
  const strings = [server.command, ...(server.args || []), ...Object.values(server.env || {})].filter((v) => typeof v === 'string');
  for (const s of strings) {
    assert.ok(!s.includes('${user_config.'), `存在未配置的占位符会原样进 env：${s}`);
    assert.ok(!s.includes('${CLAUDE_PLUGIN_ROOT}') || !s.startsWith('./'), '路径写成相对');
  }
  const script = resolveRoot(server.args[server.args.length - 1]);
  assert.ok(path.isAbsolute(script), `args 里的脚本必须是插件根变量解析后的绝对路径：${server.args.join(' ')}`);
  assert.ok(existsSync(script), `解析出的脚本不存在：${script}`);
});

// ---------- 2. 市场清单 ----------
check('市场清单通过 Qoder schema 校验（name / owner / source / 保留名）', () => {
  assert.match(market.name, /^[a-z0-9][-a-z0-9._]*$/i, `市场名不符：${market.name}`);
  assert.ok(!/^(?:qoder|claude)[^a-z0-9]*(?:marketplace|plugins|official)$/i.test(market.name), '市场名撞了宿主保留名');
  assert.ok(market.owner?.name?.trim(), 'Qoder 的 owner 是必填项（缺了整个市场清单校验失败）');
  assert.ok(Array.isArray(market.plugins) && market.plugins.length > 0, 'plugins 为空');
  assert.ok(String(marketEntry.source).startsWith('./'), `source 必须以 ./ 开头：${marketEntry.source}`);
  assert.ok(existsSync(path.join(repoRoot, marketEntry.source)), `source 指向的目录不存在：${marketEntry.source}`);
});

// ---------- 3. 按清单真的拉起 MCP 服务器 ----------
const rpc = (child, id, method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);

const main = async () => {
  const server = manifest.mcpServers.systemone;
  const args = server.args.map(resolveRoot);
  const child = spawn(server.command, args, {
    env: { ...process.env, SYSTEMONE_API_KEY: 'test-key', UNISOUND_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const replies = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && replies.has(msg.id)) {
        replies.get(msg.id)(msg);
        replies.delete(msg.id);
      }
    }
  });
  child.on('error', (e) => {
    check(`清单里的 command（${server.command}）可执行`, () => {
      throw new Error(`spawn 失败：${e.message}——宿主直接 exec 这个命令，PATH 里必须有它`);
    });
    failed = true;
    process.exit(1);
  });

  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      replies.set(id, resolve);
      rpc(child, id, method, params);
      setTimeout(() => reject(new Error(`${method} 超时`)), 10000).unref?.();
    });

  try {
    const init = await call(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qoder-smoke', version: '0' },
    });
    check('按清单声明的 command/args 能完成 MCP initialize', () => {
      assert.equal(init.result.serverInfo.name, 'systemone-decision');
      assert.equal(init.result.protocolVersion, '2024-11-05');
    });

    const list = await call(2, 'tools/list', {});
    check('tools/list 返回 2 个工具（与清单 timeout 无关，纯本地）', () => {
      assert.deepEqual(
        list.result.tools.map((t) => t.name).sort(),
        ['systemone_decide', 'systemone_scenario']
      );
    });
  } catch (e) {
    failed = true;
    console.error(`FAIL  MCP 子进程交互\n      ${e.message}`);
  } finally {
    child.kill();
  }

  console.log(failed ? '\n有失败项' : '\n全部通过');
  process.exit(failed ? 1 : 0);
};

main();
