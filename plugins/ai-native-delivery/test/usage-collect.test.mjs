#!/usr/bin/env node
// usage-collect.test.mjs — PostToolUse(Agent) usage 观测腿三态测试（spawn hook 进程喂 stdin JSON，
// 风格随 hook.test.mjs）。断言：①有 usage 载荷 → usage.jsonl 追加一行且字段齐（ts/role/model/run/
//       inputTokens/outputTokens/latencyMs 逐字段对齐蓝本映射）；②缺 usage / 坏 JSON / 空 stdin /
//       非对象 JSON / usage 数值非法 → 零写入 exit 0（诚实边界：不推测 token）；③非插件仓（向上找不到
//       .agents/install-manifest.json）→ exit 0 零写入；④追加语义（append 不覆盖，二跑两行）；
//       ⑤stdout 恒干净（观测腿无决策体）；⑥usage.jsonl 进 GITIGNORE_ENTRIES（运行态不入库，plan.mjs 单源）。
// 用法：node test/usage-collect.test.mjs（零依赖，Node ≥ 18）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(TEST_DIR, '..', 'hooks', 'usage-collect.cjs');
const USAGE = '用法：node test/usage-collect.test.mjs';

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.log(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
};

// 伪造插件仓：临时根 + .agents/install-manifest.json（root 解析锚）
const mkPluginRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-collect-test-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'install-manifest.json'), JSON.stringify({ schemaVersion: 1, plugin: { name: 'fixture' } }), 'utf8');
  return root;
};
const ledgerOf = (root) => path.join(root, '.agents', 'usage.jsonl');
const rowsOf = (root) => fs.readFileSync(ledgerOf(root), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// run：payload 喂 stdin；cwd 给进程内回退锚（root 解析主锚是 payload.cwd）
const run = (payload, cwd) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  cwd,
  env: { ...process.env },
});

// PostToolUse(Agent) 载荷形态（官方 hooks 文档：tool_response 携 usage/resolvedModel/agentId/totalDurationMs）
const payloadOf = (repo, toolResponse) => ({ tool_name: 'Agent', tool_input: { prompt: 'fixture' }, tool_response: toolResponse, cwd: repo });

// ---- ① 有 usage 载荷 → 追加一行字段齐 ----
{
  const repo = mkPluginRepo();
  const r = run(payloadOf(repo, {
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 },
    totalTokens: 1550, resolvedModel: 'claude-sonnet-4-5', agentId: 'agent-abc123', totalDurationMs: 5234,
  }), repo);
  check('① 有 usage 载荷 → exit 0（观测腿恒 0）', r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  check('① stdout 干净（无决策体）', r.stdout.trim() === '', `stdout=${r.stdout}`);
  check('① usage.jsonl 追加一行', fs.existsSync(ledgerOf(repo)) && rowsOf(repo).length === 1, rowsOf(repo).length + ' 行');
  const row = rowsOf(repo)[0];
  check('① ts 为 ISO 时间串', typeof row.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.ts), row.ts);
  check('① role=agent', row.role === 'agent', JSON.stringify(row));
  check('① model=resolvedModel', row.model === 'claude-sonnet-4-5', JSON.stringify(row));
  check('① run=agentId', row.run === 'agent-abc123', JSON.stringify(row));
  check('① inputTokens=usage.input_tokens', row.inputTokens === 1200, JSON.stringify(row));
  check('① outputTokens=usage.output_tokens', row.outputTokens === 300, JSON.stringify(row));
  check('① latencyMs=totalDurationMs', row.latencyMs === 5234, JSON.stringify(row));
  check('① cache_* 与 totalTokens 不落账（行 schema 无此字段）', !('cacheTokens' in row) && !('totalTokens' in row), JSON.stringify(row));
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ② 追加语义：二跑叠行不覆盖 ----
{
  const repo = mkPluginRepo();
  run(payloadOf(repo, { usage: { input_tokens: 10, output_tokens: 5 }, resolvedModel: 'm1', agentId: 'a1' }), repo);
  const r2 = run(payloadOf(repo, { usage: { input_tokens: 20, output_tokens: 8 }, resolvedModel: 'm2', agentId: 'a2' }), repo);
  const rows = rowsOf(repo);
  check('② 二跑 → 两行（append 不覆盖）', r2.status === 0 && rows.length === 2, JSON.stringify(rows));
  check('② 先后顺序保持（首行是 m1/a1）', rows[0].model === 'm1' && rows[1].model === 'm2', JSON.stringify(rows));
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ③ 零写入态：缺 usage / 坏 JSON / 空 stdin / 非对象 JSON / usage 数值非法 ----
{
  const repo = mkPluginRepo();
  const cases = [
    ['缺 usage（tool_response 无 usage）', payloadOf(repo, { totalTokens: 100, resolvedModel: 'm', agentId: 'a' })],
    ['usage 缺 token 数值（空对象）', payloadOf(repo, { usage: {}, resolvedModel: 'm', agentId: 'a' })],
    ['usage 数值非法（负值 + 非数）', payloadOf(repo, { usage: { input_tokens: -5, output_tokens: 'abc' }, resolvedModel: 'm', agentId: 'a' })],
    ['坏 JSON', '{not valid json'],
    ['空 stdin', ''],
    ['非对象 JSON（null）', 'null'],
    ['非对象 JSON（数字标量）', '123'],
  ];
  for (const [label, payload] of cases) {
    const r = run(payload, repo);
    check(`③ ${label} → exit 0 且 stdout 干净`, r.status === 0 && r.stdout.trim() === '', `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    check(`③ ${label} → 零写入（无 usage.jsonl）`, !fs.existsSync(ledgerOf(repo)), '文件不应存在');
  }
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ③' 部分可采：input 合法 output 非法 → 只落 inputTokens（字段条件式在场，对齐蓝本）----
{
  const repo = mkPluginRepo();
  const r = run(payloadOf(repo, { usage: { input_tokens: 42, output_tokens: 'oops' }, resolvedModel: '' }), repo);
  const rows = rowsOf(repo);
  check(`③' input 合法 output 非法 → 只落 inputTokens`, r.status === 0 && rows.length === 1 && rows[0].inputTokens === 42 && !('outputTokens' in rows[0]), JSON.stringify(rows));
  check(`③' resolvedModel 空 → model 兜底 unknown`, rows[0].model === 'unknown', JSON.stringify(rows));
  check(`③' agentId 缺 → 无 run 键`, !('run' in rows[0]), JSON.stringify(rows));
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ④ 非插件仓：向上找不到 install-manifest → exit 0 零写入 ----
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-collect-norepo-'));
  const nested = path.join(bare, 'deep', 'inner');
  fs.mkdirSync(nested, { recursive: true });
  const r = run(payloadOf(nested, { usage: { input_tokens: 9, output_tokens: 9 }, resolvedModel: 'm', agentId: 'a' }), nested);
  check('④ 非插件仓 → exit 0 且 stdout 干净', r.status === 0 && r.stdout.trim() === '', `exit=${r.status} stdout=${r.stdout}`);
  check('④ 非插件仓 → 仓内零写入', !fs.existsSync(path.join(bare, '.agents', 'usage.jsonl')), '不应有 .agents/usage.jsonl');
  check('④ 非插件仓 → 不向上误写（嵌套层也无落盘）', !fs.existsSync(path.join(bare, 'deep', '.agents')), '不应创建 .agents/');
  fs.rmSync(bare, { recursive: true, force: true });
}

// ---- ⑤ payload.cwd 缺席 → 回退进程 cwd（cwd=插件仓夹具时仍可采） ----
{
  const repo = mkPluginRepo();
  const r = run({ tool_name: 'Agent', tool_input: {}, tool_response: { usage: { input_tokens: 7, output_tokens: 3 }, resolvedModel: 'm', agentId: 'a' } }, repo);
  check('⑤ payload.cwd 缺席 → 回退进程 cwd 采集一行', r.status === 0 && rowsOf(repo).length === 1, `exit=${r.status}`);
  fs.rmSync(repo, { recursive: true, force: true });
}

// ---- ⑥ 台账不入库：.agents/usage.jsonl 在 GITIGNORE_ENTRIES（plan.mjs 单源，幂等再装不漂） ----
{
  const { GITIGNORE_ENTRIES } = await import(pathToFileURL(path.join(TEST_DIR, '..', 'scripts', 'install', 'plan.mjs')).href);
  check('⑥ GITIGNORE_ENTRIES 含 .agents/usage.jsonl', Array.isArray(GITIGNORE_ENTRIES) && GITIGNORE_ENTRIES.includes('.agents/usage.jsonl'), JSON.stringify(GITIGNORE_ENTRIES));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log(`\n${USAGE}`);
  process.exit(1);
}
process.exit(0);
