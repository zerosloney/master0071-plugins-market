#!/usr/bin/env node
// worktree-ops MCP server 的端到端冒烟测试。
//
// 在系统临时目录里造一个一次性 git 仓库 + 一个一次性配置目录，用 stdio JSON-RPC
// 驱动真实的 server.mjs，逐条断言工具行为，最后清理临时目录。
// 不需要真实仓库、不需要网络、不需要任何凭据。
//
//   node test/smoke.mjs
//
// 退出码非 0 表示有断言失败。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs');
const sandbox = mkdtempSync(path.join(tmpdir(), 'worktree-ops-smoke-'));
const cfgHome = path.join(sandbox, 'cfg');
const repo = path.join(sandbox, 'myrepo');
const root = path.join(sandbox, 'custom-root');
const envRoot = path.join(sandbox, 'env-root');
const overrideRoot = path.join(sandbox, 'override-root');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n${title}`);

/** 起一个 server 子进程，用 JSON-RPC 驱动它。 */
function openSession(env) {
  const child = spawn('node', [SERVER], {
    cwd: repo,
    env: {
      ...process.env,
      WORKTREE_CONFIG_HOME: cfgHome,
      WORKTREE_ROOT: '',
      WORKTREE_BASE_REF: '',
      WORKTREE_BRANCH_PREFIX: '',
      WORKTREE_STALE_DAYS: '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let seq = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    });

  const tool = async (name, args = {}) => {
 try {
 const res = await rpc('tools/call', { name, arguments: args });
 return {
 isError: Boolean(res.result?.isError),
 text: (res.result?.content || []).map((c) => c.text).join('\n'),
 };
 } catch (err) {
 return { isError: true, text: `rpc failed: ${err.message}` };
 }
  };

  const ready = rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'worktree-ops-smoke', version: '0.1.0' },
  });

  return {
    ready,
    rpc,
    tool,
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

// ── 一次性仓库 ────────────────────────────────────────────────────────────────
mkdirSync(repo);
git(['init', '-b', 'main'], repo);
git(['config', 'user.email', 'smoke@test.invalid'], repo);
git(['config', 'user.name', 'smoke'], repo);
writeFileSync(path.join(repo, 'README.md'), 'hello\n');
git(['add', '.'], repo);
git(['commit', '-m', 'init'], repo);

const session = openSession({});

try {
  const init = await session.ready;
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'worktree-ops', JSON.stringify(init.result));

  const list = await session.rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name).sort();
  check(
    'tools/list 暴露全部 8 个工具',
    JSON.stringify(names) === JSON.stringify([
      'worktree_audit',
      'worktree_create',
      'worktree_handoff',
      'worktree_list',
      'worktree_merge_back',
      'worktree_remove',
      'worktree_set_root',
      'worktree_status',
    ]),
    names.join(','),
  );

  section('未配置拒绝创建');
  const dft = await session.tool('worktree_create', { repoPath: repo, name: 'default-check' });
  check(
    '优先级链①前置：未配置根目录时 create 拒绝并给出指引',
    dft.isError && /no worktree root configured/.test(dft.text) && dft.text.includes('WORKTREE_ROOT'),
    dft.text,
  );

  section('配置');
  const set = await session.tool('worktree_set_root', { action: 'set', scope: 'global', root, branchPrefix: 'wt/', staleDays: 7 });
  check('set_root 写入全局配置', !set.isError && existsSync(path.join(cfgHome, 'config.json')), set.text);
  const get = await session.tool('worktree_set_root', { action: 'get', repoPath: repo });
  check('set_root 读回配置路径', get.text.includes(path.join(cfgHome, 'config.json')), get.text);
  const badScope = await session.tool('worktree_set_root', { action: 'set', scope: 'bogus', root: 'D:/nowhere' });
  check('非法 scope 被拒绝', badScope.isError && /invalid scope/.test(badScope.text), badScope.text);
  const staleStr = await session.tool('worktree_set_root', { action: 'set', scope: 'global', staleDays: '5' });
  check('字符串 staleDays 写入生效', !staleStr.isError && /staleDays=5/.test(staleStr.text), staleStr.text);

  section('创建');
  const created = await session.tool('worktree_create', { repoPath: repo, name: 'feat/login' });
  const wtPath = path.join(root, 'feat-login');
  check('create 成功', !created.isError, created.text);
  check('create 落在配置根目录', created.text.includes(wtPath), created.text);
  check('create 给出新会话指引', /working directory/i.test(created.text), created.text);
  const dup = await session.tool('worktree_create', { repoPath: repo, name: 'feat/login' });
  check('重复创建被拦截', dup.isError, dup.text);

  const listed = await session.tool('worktree_list', { repoPath: repo });
  check('list 同时列出主工作树与新 worktree', listed.text.includes('feat/login') && listed.text.includes('myrepo'), listed.text);

  section('状态与交接');
  git(['config', 'user.email', 'smoke@test.invalid'], wtPath);
  git(['config', 'user.name', 'smoke'], wtPath);
  writeFileSync(path.join(wtPath, 'feature.txt'), 'x\n');
  git(['add', '.'], wtPath);
  git(['commit', '-m', 'feat: login'], wtPath);

  const status = await session.tool('worktree_status', { repoPath: repo, name: 'feat/login' });
  check('status 报告领先 1 个提交', /ahead 1/.test(status.text), status.text);
  check('status 给出 hold 分桶', /bucket: hold/.test(status.text), status.text);

  const handoff = await session.tool('worktree_handoff', { repoPath: repo, name: 'feat/login', task: '实现登录表单' });
  check('handoff 包含路径与任务', handoff.text.includes(wtPath) && handoff.text.includes('实现登录表单'), handoff.text);

  section('合并回主干');
  const plan = await session.tool('worktree_merge_back', { repoPath: repo, name: 'feat/login' });
  check('默认只出计划不动手', !plan.isError && /Report-only/.test(plan.text), plan.text);

  git(['checkout', '-b', 'scratch'], repo);
  const wrongTarget = await session.tool('worktree_merge_back', { repoPath: repo, name: 'feat/login', target: 'main', merge: true });
  check('目标分支未检出时拒绝合并', wrongTarget.isError && /REFUSED/.test(wrongTarget.text), wrongTarget.text);
  git(['checkout', 'main'], repo);

  const merged = await session.tool('worktree_merge_back', { repoPath: repo, name: 'feat/login', merge: true, remove: true, deleteBranch: true });
  check('合并并清理成功', !merged.isError && /merge feat\/login into main: ok/.test(merged.text), merged.text);
  check('已合并时不强制删除', !/forced/.test(merged.text), merged.text);

  section('清理保护');
  const audit = await session.tool('worktree_audit', { repoPath: repo, includeSize: true });
  check('审计只报主工作树且标 hold', /hold\s+main/.test(audit.text), audit.text);

  const staleAudit = await session.tool('worktree_audit', { repoPath: repo, staleDays: '3' });
  check('audit 字符串 staleDays 生效', /idle threshold: 3d/.test(staleAudit.text), staleAudit.text);

  section('脏文件归属');
  await session.tool('worktree_create', { repoPath: repo, name: 'pair-a' });
  await session.tool('worktree_create', { repoPath: repo, name: 'pair-b' });
  writeFileSync(path.join(root, 'wt-pair-a', 'a-only.txt'), 'a\n');
  writeFileSync(path.join(root, 'wt-pair-b', 'b-only.txt'), 'b\n');
  const dirtyList = await session.tool('worktree_list', { repoPath: repo });
  const dirtyLines = dirtyList.text.split('\n');
  const labelA = dirtyLines.findIndex((l) => l.startsWith('dirty in') && l.includes('wt-pair-a'));
  const labelB = dirtyLines.findIndex((l) => l.startsWith('dirty in') && l.includes('wt-pair-b'));
  const fileA = dirtyLines.findIndex((l) => l.trim() === '?? a-only.txt');
  const fileB = dirtyLines.findIndex((l) => l.trim() === '?? b-only.txt');
  check(
    '脏文件紧跟所属 worktree 标签',
    [labelA, fileA, labelB, fileB].every((v) => v >= 0) && labelA < fileA && fileA < labelB && labelB < fileB,
    dirtyList.text,
  );
  await session.tool('worktree_remove', { repoPath: repo, name: 'pair-a', force: true, deleteBranch: true });
  await session.tool('worktree_remove', { repoPath: repo, name: 'pair-b', force: true, deleteBranch: true });

 section('受管目录与锁定保护');
 await session.tool('worktree_create', { repoPath: repo, name: 'locked-one' });
 const lockedDir = path.join(root, 'wt-locked-one');
 git(['worktree', 'lock', lockedDir], repo);
 const lockedRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'locked-one', force: true, deleteBranch: true });
 check('force 不能删除锁定 worktree', lockedRemove.isError && /locked worktree/.test(lockedRemove.text), lockedRemove.text);
 const stillThere = await session.tool('worktree_status', { repoPath: repo, name: 'locked-one' });
 check('被拒绝的锁定 worktree 仍在登记中', /primary worktree: no/.test(stillThere.text) && existsSync(lockedDir), stillThere.text);
 const lockedMerge = await session.tool('worktree_merge_back', { repoPath: repo, name: 'locked-one', merge: true, remove: true });
 check('锁定 worktree 在合并前被拦下', lockedMerge.isError && /locked/.test(lockedMerge.text), lockedMerge.text);
 check('被拦下的合并没有产生 merge 提交', !git(['log', '--format=%s', '-1'], repo).includes('Merge wt/locked-one'), lockedMerge.text);
 git(['worktree', 'unlock', lockedDir], repo);
 const unlockedRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'locked-one', deleteBranch: true });
 check('解锁后可正常删除', !unlockedRemove.isError && /Removed worktree/.test(unlockedRemove.text), unlockedRemove.text);

 await session.tool('worktree_create', { repoPath: repo, name: 'outside-one' });
 await session.tool('worktree_create', { repoPath: repo, name: 'root-prefix' });
 git(['worktree', 'move', path.join(root, 'wt-outside-one'), path.join(sandbox, 'outside-one')], repo);
 const outside = await session.tool('worktree_remove', { repoPath: repo, name: 'outside-one', force: true, deleteBranch: true });
 check('force 不能删除受管根目录外的 worktree', outside.isError && /outside the managed root/.test(outside.text), outside.text);
 check('根目录外被拒绝的 worktree 原样保留', existsSync(path.join(sandbox, 'outside-one', 'README.md')), outside.text);
 await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, root: `${root}-x` });
 const prefix = await session.tool('worktree_remove', { repoPath: repo, name: 'root-prefix' });
 check('同名前缀目录不算受管目录内', prefix.isError && /outside the managed root/.test(prefix.text), prefix.text);
 await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, root });
 const insideRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'root-prefix', deleteBranch: true });
 check('受管根目录内的 worktree 可正常删除', !insideRemove.isError, insideRemove.text);

  const created2 = await session.tool('worktree_create', { repoPath: repo, name: 'dirty-one' });
  check('短任务名加前缀并 slug 化', created2.text.includes(path.join(root, 'wt-dirty-one')), created2.text);
  writeFileSync(path.join(root, 'wt-dirty-one', 'junk.txt'), 'oops\n');

  const dirty = await session.tool('worktree_remove', { repoPath: repo, name: 'dirty-one' });
  check('脏 worktree 拒绝删除', dirty.isError && /uncommitted/.test(dirty.text), dirty.text);
  const forced = await session.tool('worktree_remove', { repoPath: repo, name: 'dirty-one', force: true, deleteBranch: true });
  check('显式 force 可删除', !forced.isError && /Removed worktree/.test(forced.text), forced.text);

  const primary = await session.tool('worktree_remove', { repoPath: repo, name: 'main' });
  check('主工作树永远拒绝删除', primary.isError && /primary worktree/.test(primary.text), primary.text);

  const notRepo = await session.tool('worktree_list', { repoPath: sandbox });
  check('非 git 目录报错清晰', notRepo.isError && /not inside a git work tree/.test(notRepo.text), notRepo.text);

  const gone = await session.tool('worktree_status', { repoPath: repo, name: 'feat/login' });
  check('已删除的 worktree 报 not found', gone.isError && /worktree not found/.test(gone.text), gone.text);

  section('配置优先级');
  // 链①前置（未配置拒绝）已在「未配置拒绝创建」小节验证，链②由「create 落在配置根目录」覆盖；此处补链③与链④。
  const ovSet = await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, root: overrideRoot });
  check('优先级链③：单仓库覆盖写入成功', !ovSet.isError, ovSet.text);
  const ovCreated = await session.tool('worktree_create', { repoPath: repo, name: 'ovr-check' });
  check(
    '优先级链③：单仓库覆盖压过全局配置',
    !ovCreated.isError && ovCreated.text.includes(path.join(overrideRoot, 'wt-ovr-check')),
    ovCreated.text,
  );
  await session.tool('worktree_remove', { repoPath: repo, name: 'ovr-check', force: true, deleteBranch: true });

  // 单仓库覆盖 overrideRoot 仍留在配置文件里；WORKTREE_ROOT 必须压过它与全局 custom-root
  const envSession = openSession({ WORKTREE_ROOT: envRoot });
  try {
    await envSession.ready;
    const envCreated = await envSession.tool('worktree_create', { repoPath: repo, name: 'env-check' });
    check('优先级链④：环境变量压过单仓库覆盖与全局配置', !envCreated.isError && envCreated.text.includes(envRoot), envCreated.text);
    const envRemoved = await envSession.tool('worktree_remove', { repoPath: repo, name: 'env-check', force: true, deleteBranch: true });
    check('按环境变量位置清理干净', !envRemoved.isError, envRemoved.text);
  } finally {
    envSession.close();
  }
} catch (err) {
  failures += 1;
  console.error(`\n未捕获异常: ${err.message}`);
} finally {
  session.close();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
