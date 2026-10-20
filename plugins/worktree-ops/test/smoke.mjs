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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

  // 回归：action:'get' 曾与「带值即 set」的启发叠加成或运算——只要同传任何值就落盘，
  // 而 schema 写的是「缺省时才推断」，显式 action 理应一律优先。
  const cfgBefore = readFileSync(path.join(cfgHome, 'config.json'), 'utf8');
  const sneakyRoot = path.join(sandbox, 'sneaky-root');
  const getWithValue = await session.tool('worktree_set_root', { action: 'get', scope: 'global', root: sneakyRoot });
  check(
    'action:"get" 带值也不写配置文件',
    !getWithValue.isError && readFileSync(path.join(cfgHome, 'config.json'), 'utf8') === cfgBefore,
    getWithValue.text,
  );
  check('action:"get" 回执不泄露同传的 root 值', !getWithValue.text.includes(sneakyRoot), getWithValue.text);
  const badAction = await session.tool('worktree_set_root', { action: 'bogus', root });
  check('非法 action 被拒绝', badAction.isError && /invalid action/.test(badAction.text), badAction.text);

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

  // 回归：detached 工作树的删除护栏曾整体失效。porcelain 对 detached 不输出 branch 行，
  // entry.branch 于是为 null——护栏一 `entry.branch && info.ahead === null` 永假，
  // 护栏二 `info.ahead > 0` 又因 ahead 是 null 而永假，未合并提交被静默删掉。
  // 修复后 describe() 改用 entry.head 做比较 rev，ahead 对 detached 也是真实值。
  const dgDir = path.join(root, 'wt-det-guard');
  git(['worktree', 'add', '--detach', dgDir, 'main'], repo);
  git(['config', 'user.email', 'smoke@test.invalid'], dgDir);
  git(['config', 'user.name', 'smoke'], dgDir);
  writeFileSync(path.join(dgDir, 'lost.txt'), 'unmerged work\n');
  git(['add', '.'], dgDir);
  git(['commit', '-m', 'wip: detached-unmerged'], dgDir);

  const dgStatus = await session.tool('worktree_status', { repoPath: repo, name: dgDir });
  check('detached 工作树能算出 ahead（不再全是 ?）', /ahead 1,/.test(dgStatus.text), dgStatus.text);
  const dgRemove = await session.tool('worktree_remove', { repoPath: repo, name: dgDir });
  check(
    '未合并的 detached 工作树拒绝删除',
    dgRemove.isError && /not merged into/.test(dgRemove.text),
    dgRemove.text,
  );
  check('被拒后未合并的文件原样保留', existsSync(path.join(dgDir, 'lost.txt')), dgRemove.text);
  const dgForced = await session.tool('worktree_remove', { repoPath: repo, name: dgDir, force: true });
  check('显式 force 仍可删除 detached 工作树', !dgForced.isError && /Removed worktree/.test(dgForced.text), dgForced.text);

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

  section('简报基线穿透调用方 target');
  // 回归：handoffText() 曾在内部重新调 resolveTarget(repo) 取默认值，于是简报里的
  // `Base target` 与 create 的 `- base:` 各用一套基线。简报是下一个 agent 的执行指令，
  // 基线错会把它导到错误的分支上 rebase。
  git(['branch', 'handoff-base-ref', 'main'], repo);
  const hgCreated = await session.tool('worktree_create', { repoPath: repo, name: 'handoff-probe' });
  check('创建 handoff-probe 成功', !hgCreated.isError, hgCreated.text);
  // 会话当前分支是 main（默认 target 也会是 main）；显式传另一个已存在分支才能区分穿透与否
  const hg = await session.tool('worktree_handoff', {
    repoPath: repo,
    name: 'handoff-probe',
    target: 'handoff-base-ref',
    task: '验证简报基线',
  });
  check('handoff 的 Base target 用调用方传的 target', /Base target: handoff-base-ref/.test(hg.text), hg.text);
  check('handoff 的 rebase 建议同样用该 target', /rebased on handoff-base-ref/.test(hg.text), hg.text);
  const cb = await session.tool('worktree_create', { repoPath: repo, name: 'create-base-probe', baseRef: 'handoff-base-ref' });
  check('create 的 - base 用显式 baseRef', /- base: handoff-base-ref @ [0-9a-f]{7,}/.test(cb.text), cb.text);
  check('create 简报的 Base target 与 - base 同一基线', /Base target: handoff-base-ref/.test(cb.text), cb.text);
  await session.tool('worktree_remove', { repoPath: repo, name: 'handoff-probe', force: true, deleteBranch: true });
  await session.tool('worktree_remove', { repoPath: repo, name: 'create-base-probe', force: true, deleteBranch: true });

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

  section('submodule 下的主工作树保护');
  // 回归：mainWorktreePath() 曾用 dirname(--git-common-dir)。submodule 的 common-dir 指向
  // <super>/.git/modules/<name>，dirname 得到 <super>/.git/modules，与 porcelain 里任何
  // entry.path 都不相等 → isMain 恒假，删/锁/合并三道主工作树保护同时失效，
  // audit 还会主动把主检出列进 safe to remove。修复后取 porcelain 首条。
  const subSrc = path.join(sandbox, 'subsrc');
  const superRepo = path.join(sandbox, 'superrepo');
  const subRoot = path.join(sandbox, 'subroot');
  mkdirSync(subSrc);
  git(['init', '-b', 'main'], subSrc);
  git(['config', 'user.email', 'smoke@test.invalid'], subSrc);
  git(['config', 'user.name', 'smoke'], subSrc);
  writeFileSync(path.join(subSrc, 'lib.txt'), 'sub lib\n');
  git(['add', '.'], subSrc);
  git(['commit', '-m', 'sub init'], subSrc);

  mkdirSync(superRepo);
  git(['init', '-b', 'main'], superRepo);
  git(['config', 'user.email', 'smoke@test.invalid'], superRepo);
  git(['config', 'user.name', 'smoke'], superRepo);
  writeFileSync(path.join(superRepo, 'README.md'), 'super\n');
  git(['add', '.'], superRepo);
  git(['commit', '-m', 'super init'], superRepo);
  // 本地路径作 submodule 源：git ≥ 2.38.1 默认禁 file 传输，需显式放行
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'mysub'], superRepo);
  const subPath = path.join(superRepo, 'mysub');

  const subCfgHome = path.join(sandbox, 'sub-cfg');
  mkdirSync(subCfgHome);
  const subSession = openSession({ WORKTREE_CONFIG_HOME: subCfgHome });
  try {
    await subSession.ready;
    await subSession.tool('worktree_set_root', { action: 'set', scope: 'global', root: subRoot, branchPrefix: 'wt/', staleDays: 7 });

    const subStatus = await subSession.tool('worktree_status', { repoPath: subPath, name: 'main' });
    check('submodule 主检出被标为 primary worktree', /primary worktree: yes/.test(subStatus.text), subStatus.text);

    const subAudit = await subSession.tool('worktree_audit', { repoPath: subPath });
    const subRow = subAudit.text.split('\n').find((l) => l.includes('mysub')) || '';
    check('audit 把 submodule 主检出归入 hold', /^hold\s+main\b/.test(subRow) && /primary worktree/.test(subRow), subRow);
    check('audit 不再把 submodule 主检出列为 safe to remove', /safe to remove: 0/.test(subAudit.text), subAudit.text);

    const subRemove = await subSession.tool('worktree_remove', { repoPath: subPath, name: 'main', force: true });
    check('submodule 主检出拒绝删除', subRemove.isError && /primary worktree/.test(subRemove.text), subRemove.text);
    const subLock = await subSession.tool('worktree_lock', { repoPath: subPath, name: 'main' });
    check('submodule 主检出拒绝加锁', subLock.isError && /primary worktree/.test(subLock.text), subLock.text);
    check('被拒后 submodule 工作目录原样保留', existsSync(path.join(subPath, 'lib.txt')), subRemove.text);

    // 反向回归：修好主检出判定，不能把 submodule 里的普通 worktree 一并误判成主检出
    const subWtCreated = await subSession.tool('worktree_create', { repoPath: subPath, name: 'sub-work' });
    check('submodule 内可正常创建 worktree', !subWtCreated.isError, subWtCreated.text);
    const subWtStatus = await subSession.tool('worktree_status', { repoPath: subPath, name: 'wt/sub-work' });
    check('submodule 内的普通 worktree 不是 primary', /primary worktree: no/.test(subWtStatus.text), subWtStatus.text);
    const subWtRemoved = await subSession.tool('worktree_remove', { repoPath: subPath, name: 'wt/sub-work', deleteBranch: true });
    check('submodule 内的普通 worktree 可正常删除', !subWtRemoved.isError && /Removed worktree/.test(subWtRemoved.text), subWtRemoved.text);
  } finally {
    subSession.close();
  }

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

  section('环境变量覆盖其余三项');
  // 链④此前只覆盖了 WORKTREE_ROOT；base_ref / branch_prefix / stale_days 同样走
  // env > 单仓库覆盖 > 全局配置，却没有用例守着。让全局配置说一套、环境变量说另一套，
  // 用结果证明环境变量真的压过了配置文件（而不是恰好与默认值相同）。
  await session.tool('worktree_set_root', { action: 'set', scope: 'global', baseRef: 'scratch' });
  const envFull = openSession({
    WORKTREE_BASE_REF: 'feature/session-branch',
    WORKTREE_BRANCH_PREFIX: 'env/',
    WORKTREE_STALE_DAYS: '3',
  });
  try {
    await envFull.ready;
    const envFullCreated = await envFull.tool('worktree_create', { repoPath: repo, name: 'prefix-probe' });
    check(
      '链④：WORKTREE_BRANCH_PREFIX 压过全局配置的 wt/',
      !envFullCreated.isError && envFullCreated.text.includes(path.join(root, 'env-prefix-probe')),
      envFullCreated.text,
    );
    check(
      '链④：WORKTREE_BASE_REF 压过全局配置的 scratch',
      /- base: feature\/session-branch @/.test(envFullCreated.text),
      envFullCreated.text,
    );
    const envFullAudit = await envFull.tool('worktree_audit', { repoPath: repo });
    check('链④：WORKTREE_STALE_DAYS 压过全局配置的 5', /idle threshold: 3d/.test(envFullAudit.text), envFullAudit.text);
    const envFullRemoved = await envFull.tool('worktree_remove', { repoPath: repo, name: 'prefix-probe', force: true, deleteBranch: true });
    check('按环境变量前缀清理干净', !envFullRemoved.isError, envFullRemoved.text);
} finally {
 envFull.close();
 }

section('P0：auto 基线落后默认分支时点名提示');
// 回归：defaultBranch() 曾回退「当前检出分支」，于是 auto 的落后判定恒为 0；
// 会话在 feature/x、main 已前进时，新 worktree 缺 main 上的文件却毫无提示。
// 前面的用例把全局 baseRef 改成了 scratch，这里先恢复 auto 才测得到「跟随会话分支」。
await session.tool('worktree_set_root', { action: 'set', scope: 'global', baseRef: 'auto' });
git(['checkout', '-q', 'main'], repo);
git(['checkout', '-qb', 'lag/feature'], repo);
const lagSha = git(['rev-parse', 'HEAD'], repo).trim();
git(['checkout', '-q', 'main'], repo);
writeFileSync(path.join(repo, 'lag-main.txt'), 'main moved\n');
git(['add', '.'], repo);
git(['commit', '-qm', 'chore: main moved'], repo);
git(['checkout', '-q', 'lag/feature'], repo);
const lagCreated = await session.tool('worktree_create', { repoPath: repo, name: 'lag-probe' });
check(
 'auto 跟随的分支落后默认分支时给出 base lag 提示',
 !lagCreated.isError && /base lag: `lag\/feature` is 1 commit\(s\) behind `main`/.test(lagCreated.text),
 lagCreated.text,
);
check('落后提示给出可执行的 baseRef 建议', /baseRef: "main"/.test(lagCreated.text), lagCreated.text);
const lagWt = path.join(root, 'wt-lag-probe');
check('worktree 确实缺少默认分支上的文件（提示不是误报）', !existsSync(path.join(lagWt, 'lag-main.txt')), lagWt);
await session.tool('worktree_remove', { repoPath: repo, name: 'lag-probe', force: true, deleteBranch: true });
const lagExplicit = await session.tool('worktree_create', { repoPath: repo, name: 'lag-explicit', baseRef: 'lag/feature' });
check('显式 baseRef 时不打扰（用户已明确选择基线）', !lagExplicit.isError && !/base lag/.test(lagExplicit.text), lagExplicit.text);
await session.tool('worktree_remove', { repoPath: repo, name: 'lag-explicit', force: true, deleteBranch: true });
git(['checkout', '-q', 'main'], repo);
check('lag 场景的 HEAD 与初始一致（测试自身未污染分支）', Boolean(lagSha), lagSha);

section('P0：配置来源可见 + 显式空串被拒绝');
// 回归：configSummary 只打印最终值，用户无法判断 root 来自环境变量、单仓库覆盖还是全局配置。
const srcGet = await session.tool('worktree_set_root', { action: 'get', repoPath: repo });
check('configSummary 标出每项的来源', /root: .*\((global|repo|env)\)/.test(srcGet.text) && /baseRef: .*\((global|repo|env|default)\)/.test(srcGet.text), srcGet.text);
const envSrc = openSession({ WORKTREE_STALE_DAYS: '4' });
try {
 await envSrc.ready;
 const envSrcGet = await envSrc.tool('worktree_set_root', { action: 'get', repoPath: repo });
 check('环境变量生效时来源标为 env', /staleDays: 4 \(env\)/.test(envSrcGet.text), envSrcGet.text);
} finally {
 envSrc.close();
}
const emptyRoot = await session.tool('worktree_set_root', { action: 'set', scope: 'global', root: '' });
check('root 空串被拒绝而不是静默清空', emptyRoot.isError && /invalid root/.test(emptyRoot.text), emptyRoot.text);
const emptyPrefix = await session.tool('worktree_set_root', { action: 'set', scope: 'global', branchPrefix: '' });
check('branchPrefix 空串被拒绝（空串无法区分「不改」与「去掉前缀」）', emptyPrefix.isError && /invalid branchPrefix/.test(emptyPrefix.text), emptyPrefix.text);
const resetPrefix = await session.tool('worktree_set_root', { action: 'set', scope: 'global', branchPrefix: null });
check('branchPrefix 传 null 才是「回退默认」', !resetPrefix.isError && /branchPrefix=wt\//.test(resetPrefix.text), resetPrefix.text);
const emptyBase = await session.tool('worktree_create', { repoPath: repo, name: 'empty-base-probe', baseRef: '' });
check('create 的 baseRef 空串被拒绝而不是悄悄走 auto', emptyBase.isError && /invalid baseRef/.test(emptyBase.text), emptyBase.text);

section('P1：merge_back 在 rebase 之后基于新快照决策');
// 回归：rebase 改写了提交，但 merge/remove 仍按 rebase 前的 ahead/merged 判断，
// 可能出现「报告已合并、实际没合」或「已合并却拒绝删除」。
const rbCreated = await session.tool('worktree_create', { repoPath: repo, name: 'rb-probe' });
check('创建 rb-probe 成功', !rbCreated.isError, rbCreated.text);
const rbDir = path.join(root, 'wt-rb-probe');
writeFileSync(path.join(rbDir, 'rb.txt'), 'rb\n');
git(['add', '.'], rbDir);
git(['commit', '-qm', 'feat: rb-probe'], rbDir);
writeFileSync(path.join(repo, 'rb-main.txt'), 'm\n');
git(['add', '.'], repo);
git(['commit', '-qm', 'chore: rb main moves'], repo);
const rbResult = await session.tool('worktree_merge_back', { repoPath: repo, name: 'rb-probe', rebase: true, merge: true, remove: true });
check(
 'rebase + merge + remove 一条链走通',
 !rbResult.isError && /rebase onto main: ok/.test(rbResult.text) && /merge wt\/rb-probe into main: ok/.test(rbResult.text) && /removed worktree/.test(rbResult.text),
 rbResult.text,
);
check('rebase 后的 merge 真的把文件合进 target', existsSync(path.join(repo, 'rb.txt')), rbResult.text);
check('rebase 改写后的分支没有残留未合并提交', !existsSync(rbDir), rbResult.text);

section('P1：模糊匹配歧义必须报错而不是任选其一');
// 回归：pickWorktree 每级 find 只取第一个命中，remove/lock 可能作用在错误的 worktree 上。
// 前面的用例可能留有单仓库覆盖（如 <repo>/.wts），先清掉，让落点可预期
await session.tool('worktree_set_root', { action: 'set', scope: 'repo', repoPath: repo, clearRepoOverride: true });
// 名字不带 "/" 才走 slug + 前缀，落点才可预测（带 "/" 的名字按完整分支名原样使用）
const ambACreate = await session.tool('worktree_create', { repoPath: repo, name: 'one' });
const ambSiblingCreate = await session.tool('worktree_create', { repoPath: repo, name: 'x-one' });
check('歧义夹具创建成功', !ambACreate.isError && !ambSiblingCreate.isError, `${ambACreate.text}\n${ambSiblingCreate.text}`);
// 把 wt/one 的分支改名为 amb/one：此时 wt/one 与 wt/x-one 的目录名后缀都是 "one"，
// 传 "one" 会在 slug-suffix 级同时命中两条，正是旧实现「任选其一」的场景。
const ambA = path.join(root, 'wt-one');
const ambSibling = path.join(root, 'wt-x-one');
git(['branch', '-m', 'wt/one', 'amb/one'], repo);
const ambRemove = await session.tool('worktree_remove', { repoPath: repo, name: 'one' });
check(
 '多个 worktree 同级命中时 remove 报 ambiguity 并列出候选',
 ambRemove.isError && /ambiguous worktree name/.test(ambRemove.text) && ambRemove.text.includes(ambA) && ambRemove.text.includes(ambSibling),
 ambRemove.text,
);
check('歧义时两个 worktree 都原样保留', existsSync(ambA) && existsSync(ambSibling), `${ambA} / ${ambSibling}`);
const ambByPath = await session.tool('worktree_remove', { repoPath: repo, name: ambA, deleteBranch: true });
check('给出绝对路径后可以精确删除', !ambByPath.isError && /Removed worktree/.test(ambByPath.text), ambByPath.text);
await session.tool('worktree_remove', { repoPath: repo, name: ambSibling, force: true, deleteBranch: true });

section('P1：并发写配置不互相截断');
// 回归：固定的 config.json.tmp 让并发写者争抢同一临时文件，可能出现截断或 EPERM。
const concCfgHome = path.join(sandbox, 'conc-cfg');
mkdirSync(concCfgHome);
const concSessions = Array.from({ length: 6 }, () => openSession({ WORKTREE_CONFIG_HOME: concCfgHome }));
try {
 await Promise.all(concSessions.map((s) => s.ready));
 const results = await Promise.all(
 concSessions.map((s, i) => s.tool('worktree_set_root', { action: 'set', scope: 'global', staleDays: i + 2 })),
 );
 check('并发 set_root 全部成功', results.every((r) => !r.isError), results.map((r) => r.text.split('\n')[0]).join(' | '));
 const finalBody = readFileSync(path.join(concCfgHome, 'config.json'), 'utf8');
 let parsed = null;
 try {
 parsed = JSON.parse(finalBody);
 } catch {
 parsed = null;
 }
 check('并发写后 config.json 仍是合法 JSON（未被截断）', Boolean(parsed), finalBody);
 check('并发写后没有残留临时文件', readdirSync(concCfgHome).every((f) => f === 'config.json'), readdirSync(concCfgHome).join(','));
} finally {
 for (const s of concSessions) s.close();
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
