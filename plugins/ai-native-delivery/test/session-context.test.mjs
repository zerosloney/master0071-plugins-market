#!/usr/bin/env node
// session-context.test.mjs — SessionStart 会话入口路由令注入腿测试（spawn hook 进程喂 stdin JSON，
// 风格随 usage-collect.test.mjs / hook.test.mjs）。断言：①注入内容：插件仓 → exit 0、stdout 恰 4 行
//       中文指针（逐行锚点：会话入口路由令标 + skills/session-resume/SKILL.md / commands/new-task.md 两问
//       定级 / 单源声明 / 关闭方式行），无绝对路径泄漏（${CLAUDE_PLUGIN_ROOT} 相对指法），仓内零写；
//       ①'全部启动来源（resume/clear/compact）同样注入（本腿不按 source 分流，matcher 空串语义在宿主侧）；
//       ②关闭开关三态：.agents/config/session-context.local.json 显式 {"enabled":false} → 零输出，
//       缺文件 / 坏 JSON / 非 false 值（true、字符串"false"）= 开（坏配置不静默改变注入行为）；
//       ③非插件仓（向上找不到 .agents/install-manifest.json）→ exit 0 零输出；payload.cwd 优先于进程 cwd；
//       ④payload.cwd 缺席 → 回退进程 cwd；⑤坏 JSON / 空 stdin / 非对象 JSON → 恒 exit 0（插件仓 cwd
//       照常注入、裸仓零输出）；⑥接线对账：hooks.json SessionStart 段（matcher 空串 = 全部启动来源、
//       command 指 session-context.cjs、timeout 10、脚本实存）且既有三段零变化（PreToolUse 两段 +
//       PostToolUse 段照旧挂三脚本）。
// 用法：node test/session-context.test.mjs（零依赖，Node ≥ 18）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(TEST_DIR, '..', 'hooks', 'session-context.cjs');
const LOCAL_REL = path.join('.agents', 'config', 'session-context.local.json');

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// 伪造插件仓：临时根 + .agents/install-manifest.json（root 解析锚；夹具在系统临时目录，
// 向上找不到市场仓的 install-manifest，夹具间互不误认）
const mkPluginRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-context-test-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'install-manifest.json'), JSON.stringify({ schemaVersion: 1, plugin: { name: 'fixture' } }), 'utf8');
  return root;
};
const writeLocal = (root, content) => {
  fs.mkdirSync(path.join(root, '.agents', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, LOCAL_REL), content, 'utf8');
};

// run：payload 喂 stdin；cwd 给进程内回退锚（root 解析主锚是 payload.cwd）
const run = (payload, cwd) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  cwd,
  env: { ...process.env },
});
const payloadOf = (repo, source = 'startup') => ({ source, session_id: 'fixture-sess', cwd: repo });
const linesOf = (r) => r.stdout.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');

// 仓内全量文件清单（零写断言的快照面）
const snapshot = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

// ---- ① 注入内容：exit 0 + stdout 恰 4 行 + 逐行锚点 + 无绝对路径泄漏 + 仓内零写 ----
{
  const repo = mkPluginRepo();
  const before = snapshot(repo);
  const r = run(payloadOf(repo), repo);
  const lines = linesOf(r);
  check('① 注入 → exit 0（Context-only 无决策面，恒 0）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('① stdout 恰 4 行（4 行指针，不多不少）', lines.length === 4, `实际 ${lines.length} 行：${JSON.stringify(lines)}`);
  check('① 行1 含路由令标 + session-resume 锚（插件路径指法）',
    lines[0]?.includes('会话入口路由令') && lines[0]?.includes('skills/session-resume/SKILL.md'), lines[0]);
  check('① 行1 装载纪律（机器事实重建 + 禁凭记忆补勾）',
    lines[0]?.includes('机器事实') && lines[0]?.includes('禁凭记忆补勾'), lines[0]);
  check('① 行2 指向 commands/new-task.md 两问定级', lines[1]?.includes('commands/new-task.md') && lines[1]?.includes('两问定级'), lines[1]);
  check('① 行3 规则正文单源声明（只指路不复制红线）',
    lines[2]?.includes('单源') && lines[2]?.includes('不复制红线'), lines[2]);
  check('① 行4 关闭方式（session-context.local.json 写 enabled:false）',
    lines[3]?.includes('session-context.local.json') && /"enabled"\s*:\s*false/.test(lines[3]), lines[3]);
  check('① 无绝对路径入注（CLAUDE_PLUGIN_ROOT 相对指法，stdout 不含夹具仓绝对路径）',
    !r.stdout.includes(repo) && !/[A-Za-z]:\\/.test(r.stdout), JSON.stringify(r.stdout.slice(0, 200)));
  check('① stderr 干净（plain stdout 注入，诊断面零输出）', (r.stderr || '').trim() === '', r.stderr);
  check('① 仓内零写（目录快照前后一致）', JSON.stringify(snapshot(repo)) === JSON.stringify(before),
    JSON.stringify(snapshot(repo)));
  check('① stdin 无残留消费（不读 transcript：重复喂仓内无关文件内容不改变输出）',
    linesOf(run(payloadOf(repo), repo)).length === 4, '');
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ①' 全部启动来源：resume / clear / compact 同样注入（matcher 空串语义 = 宿主侧，本腿不分流） ----
{
  const repo = mkPluginRepo();
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const r = run(payloadOf(repo, source), repo);
    check(`①' 启动来源 ${source} → 注入 4 行`, r.status === 0 && linesOf(r).length === 4, `exit=${r.status} stdout=${r.stdout}`);
  }
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ② 关闭开关三态：显式 false 零输出 / 缺文件 = 开 / 坏 JSON = 开 / 非 false 值 = 开 ----
{
  const off = mkPluginRepo();
  writeLocal(off, JSON.stringify({ enabled: false }));
  const rOff = run(payloadOf(off), off);
  check('② 显式 {"enabled":false} → 零输出 exit 0', rOff.status === 0 && rOff.stdout.trim() === '',
    `exit=${rOff.status} stdout=${rOff.stdout}`);
  fs.rmSync(off, { recursive: true, force: true });

  // 缺文件 = 开：① 已覆盖无 local.json 的注入，此处与坏 JSON / 其它值同夹具对照跑
  const on = mkPluginRepo();
  const rMissing = run(payloadOf(on), on);
  check('② 缺 local.json 文件 → 照常注入 4 行', rMissing.status === 0 && linesOf(rMissing).length === 4,
    `exit=${rMissing.status} stdout=${rMissing.stdout}`);
  fs.rmSync(on, { recursive: true, force: true });

  const broken = mkPluginRepo();
  writeLocal(broken, '{broken json!!');
  const rBroken = run(payloadOf(broken), broken);
  check('② 坏 JSON 配置 → 照常注入 4 行（坏配置不静默改变注入行为）',
    rBroken.status === 0 && linesOf(rBroken).length === 4, `exit=${rBroken.status} stdout=${rBroken.stdout}`);
  fs.rmSync(broken, { recursive: true, force: true });

  for (const [label, body] of [['enabled:true', JSON.stringify({ enabled: true })], ['enabled 写字符串"false"', JSON.stringify({ enabled: 'false' })]]) {
    const other = mkPluginRepo();
    writeLocal(other, body);
    const r = run(payloadOf(other), other);
    check(`② 非 false 值（${label}）→ 照常注入 4 行（只认显式 false）`, r.status === 0 && linesOf(r).length === 4,
      `exit=${r.status} stdout=${r.stdout}`);
    fs.rmSync(other, { recursive: true, force: true });
  }
}

// ---- ③ 非插件仓：向上找不到 install-manifest → exit 0 零输出；payload.cwd 优先于进程 cwd ----
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'session-context-norepo-'));
  const nested = path.join(bare, 'deep', 'inner');
  fs.mkdirSync(nested, { recursive: true });
  const r = run(payloadOf(nested), nested);
  check('③ 非插件仓 → exit 0 且 stdout 零输出', r.status === 0 && r.stdout.trim() === '',
    `exit=${r.status} stdout=${r.stdout}`);
  // payload.cwd 是主锚：进程 cwd 落在插件仓夹具、payload.cwd 指裸目录 → 以裸目录解析（零输出）
  const repo = mkPluginRepo();
  const r2 = run(payloadOf(nested), repo);
  check('③ payload.cwd 优先于进程 cwd（裸 payload + 插件仓 cwd → 零输出）',
    r2.status === 0 && r2.stdout.trim() === '', `exit=${r2.status} stdout=${r2.stdout}`);
  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ④ payload.cwd 缺席 → 回退进程 cwd（cwd=插件仓夹具时仍注入） ----
{
  const repo = mkPluginRepo();
  const r = run({ source: 'startup', session_id: 'fixture-sess' }, repo);
  check('④ payload.cwd 缺席 → 回退进程 cwd 注入 4 行', r.status === 0 && linesOf(r).length === 4,
    `exit=${r.status} stdout=${r.stdout}`);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ⑤ 异常输入姿态：坏 JSON / 空 stdin / 非对象 JSON → 恒 exit 0（本腿不依赖载荷字段） ----
{
  const repo = mkPluginRepo();
  const cases = [['坏 JSON', '{not valid json'], ['空 stdin', ''], ['非对象 JSON（数字标量）', '123'], ['非对象 JSON（null）', 'null']];
  for (const [label, raw] of cases) {
    const r = run(raw, repo);
    check(`⑤ ${label} → exit 0 且照常注入（cwd 解析不受影响）`, r.status === 0 && linesOf(r).length === 4,
      `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'session-context-bare2-'));
  const rBare = run('{not valid json', bare);
  check('⑤ 坏 JSON + 非插件仓 cwd → 零输出 exit 0', rBare.status === 0 && rBare.stdout.trim() === '',
    `exit=${rBare.status} stdout=${rBare.stdout}`);
  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ⑥ 接线对账：hooks.json SessionStart 段 + 既有三段零变化 + 脚本实存 ----
{
  const hooksJson = JSON.parse(fs.readFileSync(path.join(TEST_DIR, '..', 'hooks', 'hooks.json'), 'utf8'));
  const seg = hooksJson.hooks.SessionStart;
  check('⑥ hooks.json 声明 SessionStart 段（单条目）', Array.isArray(seg) && seg.length === 1, JSON.stringify(seg));
  const entry = Array.isArray(seg) ? seg[0] : null;
  check('⑥ matcher 空串（宿主语义 = 全部启动来源 startup/resume/clear/compact/fork）', entry?.matcher === '', JSON.stringify(entry));
  check('⑥ command 指 session-context.cjs（CLAUDE_PLUGIN_ROOT 形态）',
    typeof entry?.hooks?.[0]?.command === 'string' && entry.hooks[0].command.includes('session-context.cjs')
      && entry.hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}'), entry?.hooks?.[0]?.command);
  check('⑥ type=command 且 timeout=10', entry?.hooks?.[0]?.type === 'command' && entry?.hooks?.[0]?.timeout === 10,
    JSON.stringify(entry?.hooks?.[0]));
  check('⑥ hooks/session-context.cjs 脚本实存（接线指向空防呆）', fs.existsSync(HOOK), HOOK);
  // 既有三段零变化：PreToolUse 两段 + PostToolUse 段照旧挂三脚本（字节级一致由 gen-host-manifests --check 对账）
  const pre = hooksJson.hooks.PreToolUse || [];
  const post = hooksJson.hooks.PostToolUse || [];
  const cmds = (entries) => entries.flatMap((e) => (e.hooks || []).map((h) => h.command || '')).join('|');
  check('⑥ 既有 PreToolUse 两段零变化（风险闸 + 写前门仍在）',
    pre.length === 2 && cmds(pre).includes('pretool-risk.mjs') && cmds(pre).includes('pre-write-guard.mjs'), cmds(pre));
  check('⑥ 既有 PostToolUse 段零变化（usage 观测腿仍在）', post.length === 1 && cmds(post).includes('usage-collect.cjs'), cmds(post));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
