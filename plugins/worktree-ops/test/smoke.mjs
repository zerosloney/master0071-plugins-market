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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** 起一个 server 子进程，用 JSON-RPC 驱动它。cwd 缺省为主仓库，可传入 worktree 目录模拟会话落在其中。 */
function openSession(env, cwd = repo) {
  const child = spawn('node', [SERVER], {
    cwd,
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
    'tools/list 暴露全部 10 个工具',
    JSON.stringify(names) === JSON.stringify([
      'worktree_audit',
      'worktree_create',
      'worktree_handoff',
      'worktree_list',
      'worktree_lock',
      'worktree_merge_back',
      'worktree_remove',
      'worktree_set_root',
      'worktree_status',
      'worktree_unlock',
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

  section('未合并不强删（merge_back remove 护栏）');
  await session.tool('worktree_create', { repoPath: repo, name: 'keepme' });
  const keepDir = path.join(root, 'wt-keepme');
  git(['config', 'user.email', 'smoke@test.invalid'], keepDir);
  git(['config', 'user.name', 'smoke'], keepDir);
  writeFileSync(path.join(keepDir, 'keep.txt'), 'wip\n');
  git(['add', '.'], keepDir);
  git(['commit', '-m', 'wip: keepme'], keepDir);
  const keepBack = await session.tool('worktree_merge_back', { repoPath: repo, name: 'keepme', remove: true });
  check('未合并时 remove=true 不再强删', !keepBack.isError && /kept worktree/.test(keepBack.text), keepBack.text);
  check('跳过删除后目录与提交原样保留', existsSync(path.join(keepDir, 'keep.txt')), keepBack.text);
  const keepGone = await session.tool('worktree_remove', { repoPath: repo, name: 'keepme', force: true, deleteBranch: true });
  check('确认意图后仍可用 worktree_remove 删除', !keepGone.isError && /Removed worktree/.test(keepGone.text), keepGone.text);

  section('merge_back 受管根外拒绝删除');
  await session.tool('worktree_create', { repoPath: repo, name: 'outside-mb' });
  git(['worktree', 'move', path.join(root, 'wt-outside-mb'), path.join(sandbox, 'outside-mb')], repo);
  const outsideBack = await session.tool('worktree_merge_back', { repoPath: repo, name: 'outside-mb', remove: true });
  check(
    'merge_back 对受管根外 worktree 拒绝删除并报告',
    !outsideBack.isError && /outside the managed root/.test(outsideBack.text) && /kept worktree/.test(outsideBack.text),
    outsideBack.text,
  );
  check('受管根外被拒绝删除的 worktree 原样保留', existsSync(path.join(sandbox, 'outside-mb', 'README.md')), outsideBack.text);

  section('ref 类参数边界校验');
  const dashTarget = await session.tool('worktree_list', { repoPath: repo, target: '--exec=evil' });
  check('target 前导 - 被拒', dashTarget.isError && /invalid target/.test(dashTarget.text), dashTarget.text);
  const dashBase = await session.tool('worktree_create', { repoPath: repo, name: 'dash-base', baseRef: '--upload-pack=evil' });
  check('baseRef 前导 - 被拒', dashBase.isError && /invalid baseRef/.test(dashBase.text), dashBase.text);

  section('target 不可解析时护栏不失效');
  // 回归：target 解析失败曾让 counts() 返回 ahead=null，而删除护栏写成
  // `if (info.ahead && info.ahead > 0)` 会因 null 短路放行，未 force 就删掉有未合并提交的工作树。
  const guardDir = path.join(root, 'wt-target-guard');
  await session.tool('worktree_create', { repoPath: repo, name: 'target-guard' });
  git(['config', 'user.email', 'smoke@test.invalid'], guardDir);
  git(['config', 'user.name', 'smoke'], guardDir);
  writeFileSync(path.join(guardDir, 'wip.txt'), 'unmerged work\n');
  git(['add', '.'], guardDir);
  git(['commit', '-m', 'wip: target-guard'], guardDir);

  const bogusStatus = await session.tool('worktree_status', { repoPath: repo, name: 'target-guard', target: 'no-such-ref' });
  check(
    'target 解析不到提交时 status 直接报错，不静默降级为 ahead ?',
    bogusStatus.isError && /does not resolve to a commit/.test(bogusStatus.text),
    bogusStatus.text,
  );
  const bogusRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'target-guard', target: 'no-such-ref' });
  check(
    'target 解析不到提交时 remove 被拒',
    bogusRemove.isError && /does not resolve to a commit/.test(bogusRemove.text),
    bogusRemove.text,
  );
  check('被拒后未合并的提交与文件原样保留', existsSync(path.join(guardDir, 'wip.txt')), bogusRemove.text);
  const unmergedRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'target-guard' });
  check(
    'target 有效时未合并提交仍被拒绝（护栏本身生效）',
    unmergedRemove.isError && /not merged into/.test(unmergedRemove.text),
    unmergedRemove.text,
  );
  const guardForced = await session.tool('worktree_remove', { repoPath: repo, name: 'target-guard', force: true, deleteBranch: true });
  check('用户显式 force 仍可清理', !guardForced.isError && /Removed worktree/.test(guardForced.text), guardForced.text);

  // detached 工作树没有分支可与 target 比，不该被上面那条「无法判断是否合并」误拦
  const detDir = path.join(root, 'wt-detached');
  git(['worktree', 'add', '--detach', detDir, 'main'], repo);
  const detRemove = await session.tool('worktree_remove', { repoPath: repo, name: detDir });
  check('干净的 detached 工作树仍可不带 force 删除', !detRemove.isError && /Removed worktree/.test(detRemove.text), detRemove.text);

  section('清理保护');
  const audit = await session.tool('worktree_audit', { repoPath: repo, includeSize: true });
  check('审计只报主工作树且标 hold', /hold\s+main/.test(audit.text), audit.text);

  const staleAudit = await session.tool('worktree_audit', { repoPath: repo, staleDays: '3' });
  check('audit 字符串 staleDays 生效', /idle threshold: 3d/.test(staleAudit.text), staleAudit.text);

  section('零值列不错位');
  // 刚建的 worktree：ahead=0、behind=0、ageDays=0 全是有效零值，曾被 filter(Boolean) 丢掉导致列错位
  await session.tool('worktree_create', { repoPath: repo, name: 'zero-one' });
  const zeroList = await session.tool('worktree_list', { repoPath: repo });
  const zl = zeroList.text.split('\n');
  const zHdr = zl.findIndex((l) => l.includes('WORKTREE'));
  const zRow = zl.find((l) => l.includes('wt-zero-one'));
  const zHdrCols = zHdr >= 0 ? zl[zHdr].trim().split(/\s{2,}/).length : 0;
  const zRowCols = zRow ? zRow.trim().split(/\s{2,}/).length : -1;
  check('list：ahead=0 / ageDays=0 的行与表头列数一致', zHdrCols > 0 && zRowCols === zHdrCols, zeroList.text);
  check('list：ahead=0 显示为 0 而不是丢列', Boolean(zRow) && zRow.trim().split(/\s{2,}/)[4] === '0', zeroList.text);
  const zeroAudit = await session.tool('worktree_audit', { repoPath: repo });
  const za = zeroAudit.text.split('\n');
  const aHdr = za.findIndex((l) => l.includes('BUCKET'));
  const aRow = za.find((l) => l.includes('wt-zero-one'));
  const aHdrCols = aHdr >= 0 ? za[aHdr].trim().split(/\s{2,}/).length : 0;
  const aRowCols = aRow ? aRow.trim().split(/\s{2,}/).length : -1;
  check('audit：ageDays=0 的行与表头列数一致', aHdrCols > 0 && aRowCols === aHdrCols, zeroAudit.text);
  await session.tool('worktree_remove', { repoPath: repo, name: 'zero-one', deleteBranch: true });

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

  section('配置文件损坏防护');
  const brokenHome = path.join(sandbox, 'broken-cfg');
  mkdirSync(brokenHome);
  const brokenFile = path.join(brokenHome, 'config.json');
  const brokenBody = '{ 这不是合法 JSON !!';
  writeFileSync(brokenFile, brokenBody);
  const brokenSession = openSession({ WORKTREE_CONFIG_HOME: brokenHome });
  try {
    await brokenSession.ready;
    const brokenGet = await brokenSession.tool('worktree_set_root', { action: 'get', repoPath: repo });
    check('读取时如实报告配置损坏', !brokenGet.isError && /corrupted/.test(brokenGet.text), brokenGet.text);
    const brokenSet = await brokenSession.tool('worktree_set_root', { action: 'set', scope: 'global', root: path.join(sandbox, 'never-root') });
    check(
      'config.json 损坏时 set_root 拒绝写入并指明文件与解析错误',
      brokenSet.isError && brokenSet.text.includes(brokenFile) && /failed to parse/i.test(brokenSet.text),
      brokenSet.text,
    );
    check('损坏的 config.json 原样保留未被覆盖', readFileSync(brokenFile, 'utf8') === brokenBody, readFileSync(brokenFile, 'utf8'));
  } finally {
    brokenSession.close();
  }

  section('cwdInside 兄弟前缀不误判');
  const sibACreated = await session.tool('worktree_create', { repoPath: repo, name: 'sib-a' });
  check('创建 sib-a 成功', !sibACreated.isError, sibACreated.text);
  const sibABCreated = await session.tool('worktree_create', { repoPath: repo, name: 'sib-ab' });
  check('创建 sib-ab 成功', !sibABCreated.isError, sibABCreated.text);
  // 「配置优先级」一节留下的单仓库覆盖 overrideRoot 仍生效，此时 create 实际落在 override-root 下
  const sibSession = openSession({}, path.join(overrideRoot, 'wt-sib-ab'));
  try {
    await sibSession.ready;
    const stSelf = await sibSession.tool('worktree_status', { repoPath: repo, name: 'sib-ab' });
    check('cwd 就是该 worktree 时报 yes', /current session cwd inside this worktree: yes/.test(stSelf.text), stSelf.text);
    const stSibling = await sibSession.tool('worktree_status', { repoPath: repo, name: 'sib-a' });
    check('wt-sib-ab 里的会话不算在兄弟 wt-sib-a 内（前缀不误判）', /current session cwd inside this worktree: no/.test(stSibling.text), stSibling.text);
  } finally {
    sibSession.close();
  }

  section('base 与 target 默认跟随会话分支');
  // 回归：base（auto）与 target 的默认值曾固定取仓库默认分支（origin/HEAD 优先），
  // 用户诉求是两者都先跟随会话仓库当前检出的分支。伪造 origin/HEAD→main 再把
  // 主检出切到非默认分支，才能区分「跟随当前分支」与「取默认分支」两种语义。
  const mainSha = git(['rev-parse', 'main'], repo).trim();
  git(['update-ref', 'refs/remotes/origin/main', mainSha], repo);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
  git(['checkout', '-b', 'feature/session-branch'], repo);

  const autoCreated = await session.tool('worktree_create', { repoPath: repo, name: 'auto-base' });
  check(
    'auto 基线取会话当前分支而非仓库默认分支',
    !autoCreated.isError && /base: feature\/session-branch @/.test(autoCreated.text),
    autoCreated.text,
  );

  const explicitBase = await session.tool('worktree_create', { repoPath: repo, name: 'explicit-base', baseRef: 'main' });
  check('显式 baseRef 仍优先于 auto 跟随', !explicitBase.isError && /base: main @/.test(explicitBase.text), explicitBase.text);

  const followList = await session.tool('worktree_list', { repoPath: repo });
  check('list 默认对比基准取会话当前分支', /Target ref: feature\/session-branch/.test(followList.text), followList.text);

  // merge_back 不传 target：默认合回会话当前分支。旧默认在有 origin 的仓库里是
  // origin/<默认分支>，与主检出的本地分支名永不相等，不传 target 必然 REFUSED。
  const mergeDir = path.join(overrideRoot, 'wt-auto-merge');
  await session.tool('worktree_create', { repoPath: repo, name: 'auto-merge' });
  writeFileSync(path.join(mergeDir, 'merge.txt'), 'x\n');
  git(['add', '.'], mergeDir);
  git(['commit', '-m', 'feat: auto-merge'], mergeDir);
  const followMerge = await session.tool('worktree_merge_back', { repoPath: repo, name: 'auto-merge', merge: true, remove: true, deleteBranch: true });
  check(
    'merge_back 默认合回会话当前分支并清理',
    !followMerge.isError && /merge wt\/auto-merge into feature\/session-branch: ok/.test(followMerge.text) && /removed worktree/.test(followMerge.text),
    followMerge.text,
  );

  git(['checkout', '--detach', mainSha], repo);
  const detachedBase = await session.tool('worktree_create', { repoPath: repo, name: 'detached-base' });
  check('detached 时 base 回退仓库默认分支', !detachedBase.isError && /base: main @/.test(detachedBase.text), detachedBase.text);
  const detachedList = await session.tool('worktree_list', { repoPath: repo });
  check('detached 时 target 回退 origin/<默认分支>', /Target ref: origin\/main/.test(detachedList.text), detachedList.text);
  git(['checkout', 'main'], repo);

  section('检出既有分支与 prunable 清理');
  // A1 回归：分支已存在时曾恒用 -b 重建而必然失败；应改为直接检出（如检出 PR 分支做验证）
  git(['branch', 'feat/existing', 'main'], repo);
  const existingCreated = await session.tool('worktree_create', { repoPath: repo, name: 'feat/existing' });
  check(
    '既有分支被检出而非 -b 重建',
    !existingCreated.isError && /existing branch checked out/.test(existingCreated.text) && /base: feat\/existing @/.test(existingCreated.text),
    existingCreated.text,
  );

  const conflictBase = await session.tool('worktree_create', { repoPath: repo, name: 'feat/existing', baseRef: 'main', path: path.join(overrideRoot, 'wt-existing2') });
  check(
    '既有分支 + 显式 baseRef 的矛盾意图被拒绝',
    conflictBase.isError && /would be ignored/.test(conflictBase.text),
    conflictBase.text,
  );

  const occupied = await session.tool('worktree_create', { repoPath: repo, name: 'feat/existing', path: path.join(overrideRoot, 'wt-existing3') });
  check(
    '分支已被其他工作树占用时报清晰错误（不再归咎 baseRef）',
    occupied.isError && /only one worktree/.test(occupied.text) && !/base ref/.test(occupied.text),
    occupied.text,
  );

  const bogusBase = await session.tool('worktree_create', { repoPath: repo, name: 'bogus-ref', baseRef: 'no-such-ref' });
  check(
    'baseRef 不存在时才给 base ref 提示',
    bogusBase.isError && /may not exist/.test(bogusBase.text),
    bogusBase.text,
  );

  const exRemoved = await session.tool('worktree_remove', { repoPath: repo, name: 'feat/existing', deleteBranch: true });
  check('检出型 worktree 可正常删除并清理分支', !exRemoved.isError && /deleted/.test(exRemoved.text), exRemoved.text);

  // A3 回归：目录被移走的 prunable 登记，ahead 应从仓库侧算出——干净分支免 force 可删，未合并的仍被拦
  await session.tool('worktree_create', { repoPath: repo, name: 'prunable-clean' });
  renameSync(path.join(overrideRoot, 'wt-prunable-clean'), path.join(overrideRoot, 'wt-prunable-clean-gone'));
  const prunableRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'prunable-clean', deleteBranch: true });
  check('prunable 干净分支可无 force 删除', !prunableRemove.isError && /Removed worktree/.test(prunableRemove.text), prunableRemove.text);

  await session.tool('worktree_create', { repoPath: repo, name: 'prunable-ahead' });
  const paDir = path.join(overrideRoot, 'wt-prunable-ahead');
  writeFileSync(path.join(paDir, 'wip.txt'), 'unmerged\n');
  git(['add', '.'], paDir);
  git(['commit', '-m', 'wip: prunable-ahead'], paDir);
  renameSync(paDir, `${paDir}-gone`);
  const paRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'prunable-ahead' });
  check(
    'prunable 未合并分支仍被拒绝（ahead 从仓库侧算出）',
    paRemove.isError && /not merged into/.test(paRemove.text),
    paRemove.text,
  );
  const paForced = await session.tool('worktree_remove', { repoPath: repo, name: 'prunable-ahead', force: true, deleteBranch: true });
  check('确认意图后 force 可清理', !paForced.isError && /Removed worktree/.test(paForced.text), paForced.text);

  section('仓库内 root 自动写入本地忽略');
  // A4 回归：受管根允许设在仓库工作树内，但 create 必须先把该目录幂等写进
  // .git/info/exclude（本地忽略，不动被跟踪的 .gitignore），否则新建 worktree
  // 以未跟踪目录污染主检出 git status（实测 ?? .wts/）。
  const inSet = await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, root: path.join(repo, '.wts') });
  check('仓库内 root 可设置', !inSet.isError, inSet.text);

  const inCreated = await session.tool('worktree_create', { repoPath: repo, name: 'inside-one' });
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');
  check(
    'create 输出注明已写入本地忽略',
    !inCreated.isError && /info\/exclude/.test(inCreated.text) && inCreated.text.includes('/.wts/'),
    inCreated.text,
  );
  const st1 = git(['status', '--porcelain'], repo).trim();
  check('主检出 git status 保持干净', st1 === '', st1);
  const excludeBody1 = readFileSync(excludeFile, 'utf8');
  check('exclude 含 /.wts/ 条目', excludeBody1.includes('/.wts/'), excludeBody1);

  await session.tool('worktree_create', { repoPath: repo, name: 'inside-two' });
  const excludeBody2 = readFileSync(excludeFile, 'utf8');
  check('同 root 再次创建不重复写条目（幂等）', excludeBody2 === excludeBody1, `${excludeBody1}\n---\n${excludeBody2}`);

  const inRemoved = await session.tool('worktree_remove', { repoPath: repo, name: 'inside-one', deleteBranch: true });
  check('仓库内 worktree 可正常删除', !inRemoved.isError, inRemoved.text);
  const st2 = git(['status', '--porcelain'], repo).trim();
  check('删除后 status 仍干净', st2 === '', st2);

  // .git 内部不是合法落点：git 会照建（实测），但 checkout 混进对象库，必须拒绝
  await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, root: path.join(repo, '.git', 'wts') });
  const gitWt = await session.tool('worktree_create', { repoPath: repo, name: 'meta-one' });
  check('.git 内 root 的创建被拒绝', gitWt.isError && /git directory/.test(gitWt.text), gitWt.text);
  await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, clearRepoOverride: true });

  section('会话在 link worktree 内的主检出判定');
  // A5 回归：会话 repoRoot 解析到 link worktree 时，isMain 曾把会话 worktree 标成
  // main、真主检出标成 wt，且 remove 的主工作树防线对真主检出失效。
  const lwPath = path.join(overrideRoot, 'wt-sib-ab');
  const lwSession = openSession({}, lwPath);
  try {
    await lwSession.ready;
    const lwSet = await lwSession.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: lwPath, root: overrideRoot });
    check('link worktree 会话可设单仓库覆盖', !lwSet.isError && lwSet.text.includes(overrideRoot), lwSet.text);
    const mainGet = await session.tool('worktree_set_root', { action: 'get', repoPath: repo });
    check('覆盖键归一到主仓库（主检出会话读得到）', mainGet.text.includes(overrideRoot), mainGet.text);

    const lwList = await lwSession.tool('worktree_list', { repoPath: lwPath });
    const listLines = lwList.text.split('\n');
    check(
      '真主检出标 main、会话 worktree 标 wt',
      listLines.some((l) => /^main\s/.test(l) && l.includes(repo)) && listLines.some((l) => /^wt\s/.test(l) && l.includes('wt-sib-ab')),
      lwList.text,
    );

    const lwRemove = await lwSession.tool('worktree_remove', { repoPath: lwPath, name: repo });
    check('link worktree 会话不能删除真主检出', lwRemove.isError && /primary worktree/.test(lwRemove.text), lwRemove.text);
  } finally {
    lwSession.close();
  }
  await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, clearRepoOverride: true });

  section('大小写撞名提示');
  // A6 回归：slug() 折叠大小写，两条仅大小写不同的分支共用目录，撞名时报错要点名根因
  await session.tool('worktree_create', { repoPath: repo, name: 'Case/Clash' });
  const clashCreate = await session.tool('worktree_create', { repoPath: repo, name: 'case/clash' });
  check(
    '仅大小写不同的分支撞目录时点名根因',
    clashCreate.isError && /slugifies to the same directory/.test(clashCreate.text) && clashCreate.text.includes('Case/Clash'),
    clashCreate.text,
  );
  await session.tool('worktree_remove', { repoPath: repo, name: 'Case/Clash', deleteBranch: true });

  section('ff 快进合并');
  // A7① 回归：线性历史场景需要 --ff-only；分叉时明确拒绝并建议 rebase，而不是留下 merge commit
  await session.tool('worktree_create', { repoPath: repo, name: 'ff-ok' });
  const ffDir = path.join(root, 'wt-ff-ok');
  writeFileSync(path.join(ffDir, 'ff.txt'), 'x\n');
  git(['add', '.'], ffDir);
  git(['commit', '-m', 'feat: ff-ok'], ffDir);
  const ffMerge = await session.tool('worktree_merge_back', { repoPath: repo, name: 'ff-ok', merge: true, remove: true, deleteBranch: true, ff: true });
  check('ff:true 快进合并成功', !ffMerge.isError && /ok \(fast-forward\)/.test(ffMerge.text), ffMerge.text);
  check('快进不留 merge 提交', !git(['log', '--format=%s', '-3'], repo).includes('Merge wt/ff-ok'), git(['log', '--format=%s', '-3'], repo));

  await session.tool('worktree_create', { repoPath: repo, name: 'ff-div' });
  const divDir = path.join(root, 'wt-ff-div');
  writeFileSync(path.join(divDir, 'div.txt'), 'x\n');
  git(['add', '.'], divDir);
  git(['commit', '-m', 'feat: ff-div'], divDir);
  writeFileSync(path.join(repo, 'main-side.txt'), 'm\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: main moves on'], repo);
  const divMerge = await session.tool('worktree_merge_back', { repoPath: repo, name: 'ff-div', merge: true, ff: true });
  check('分叉时 ff 被拒并建议 rebase', divMerge.isError && /diverged/.test(divMerge.text) && /rebase: true/.test(divMerge.text), divMerge.text);
  const divMerged = await session.tool('worktree_merge_back', { repoPath: repo, name: 'ff-div', merge: true, remove: true, deleteBranch: true });
  check('默认 --no-ff 仍可合并分叉分支', !divMerged.isError && /merge wt\/ff-div into main: ok/.test(divMerged.text), divMerged.text);

  section('--no-checkout 创建');
  // A7② 回归：大仓库场景的 --no-checkout；实测其 status 读作整树删除，remove 需 force
  const ncCreated = await session.tool('worktree_create', { repoPath: repo, name: 'no-checkout-one', noCheckout: true });
  const ncDir = path.join(root, 'wt-no-checkout-one');
  check('noCheckout 创建成功', !ncCreated.isError, ncCreated.text);
  check('工作树未检出文件', !existsSync(path.join(ncDir, 'README.md')), ncCreated.text);
  const ncRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'no-checkout-one', force: true, deleteBranch: true });
  check('no-checkout worktree 以 force 删除', !ncRemove.isError && /Removed worktree/.test(ncRemove.text), ncRemove.text);

  section('lock / unlock 工具');
  // A7③ 回归：SKILL 要求不手搓 git worktree 命令，锁定的生杀大权也应有工具承载
  await session.tool('worktree_create', { repoPath: repo, name: 'lockable' });
  const locked = await session.tool('worktree_lock', { repoPath: repo, name: 'lockable', reason: 'agent session working' });
  check('lock 成功并带 reason', !locked.isError && /agent session working/.test(locked.text), locked.text);
  const lockRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'lockable', force: true, deleteBranch: true });
  check('锁定后 remove 被拒', lockRemove.isError && /locked worktree/.test(lockRemove.text), lockRemove.text);
  const mainLock = await session.tool('worktree_lock', { repoPath: repo, name: repo });
  check('主检出不可加锁', mainLock.isError && /primary worktree/.test(mainLock.text), mainLock.text);
  const unlocked = await session.tool('worktree_unlock', { repoPath: repo, name: 'lockable' });
  check('unlock 成功', !unlocked.isError, unlocked.text);
  const lockGone = await session.tool('worktree_remove', { repoPath: repo, name: 'lockable', deleteBranch: true });
  check('解锁后可正常删除', !lockGone.isError && /Removed worktree/.test(lockGone.text), lockGone.text);
} catch (err) {
  failures += 1;
  console.error(`\n未捕获异常: ${err.message}`);
} finally {
  session.close();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
