// check-query-contract.test.mjs — 查询契约对账解析器与比对函数（夹具目录注入）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontendQueryInterfaces, parseBackendQueryDtos, compareContracts } from '../scripts/check-query-contract.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'query-contract-test-'));
const feDir = path.join(tmp, 'frontend', 'api');
const beDir = path.join(tmp, 'backend');
fs.mkdirSync(feDir, { recursive: true });
fs.mkdirSync(beDir, { recursive: true });

try {
  fs.writeFileSync(path.join(feDir, 'material.ts'), [
    'export interface MaterialQuery extends PagedQueryDto {',
    '  keyword?: string;',
    '  projectID?: number; // 注释行不计字段',
    '  page: number;',
    '}',
    '',
    'export interface ExemptQuery {',
    '  foo: string;',
    '}',
    '',
    'export interface PairQuery {',
    '  bar?: string;',
    '}',
    '',
    'export interface OrphanQuery {',
    '  baz: string;',
    '}',
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(beDir, 'Dtos.cs'), [
    'public class MaterialQueryDto : PagedQueryDto',
    '{',
    '    public string? Keyword { get; set; }',
    '    public Guid? ProjectID { get; set; }',
    '}',
    '',
    'public class PairItemQueryDto',
    '{',
    '    public string? Bar { get; set; }',
    '}',
    '',
  ].join('\n'), 'utf8');

  const frontend = parseFrontendQueryInterfaces(feDir);
  check('S1 前端解析出 4 个 Query 接口', frontend.length === 4, JSON.stringify(frontend.map((f) => f.name)));
  const mq = frontend.find((f) => f.name === 'MaterialQuery');
  check('S2 直接字段声明解析（注释行剔除）',
    mq && JSON.stringify(mq.fields) === JSON.stringify(['keyword', 'projectID', 'page']), JSON.stringify(mq));

  const backend = parseBackendQueryDtos(beDir);
  check('S3 后端解析出 2 个 QueryDto', backend.length === 2, JSON.stringify(backend.map((d) => d.name)));
  const dto = backend.find((d) => d.name === 'MaterialQueryDto');
  check('S4 后端属性名归一为小写', dto && dto.props.has('keyword') && dto.props.has('projectid'), JSON.stringify([...dto.props]));

  const opts = { explicitPairs: { PairQuery: 'PairItemQueryDto' }, exemptInterfaces: { ExemptQuery: 'fixture exempt' }, exemptFields: {} };
  const base = compareContracts(frontend.filter((f) => f.name !== 'OrphanQuery'), backend, opts);
  check('S5 大小写不敏感配对成功（projectID↔ProjectID）', base.paired.length === 2 && base.violations.length === 0,
    JSON.stringify(base));
  check('S6 分页字段 page 不计违例', !base.violations.some((v) => v.includes('.page ')), JSON.stringify(base.violations));

  const withExtra = frontend.map((f) => f.name === 'MaterialQuery' ? { ...f, fields: [...f.fields, 'bogus'] } : f);
  const extra = compareContracts(withExtra.filter((f) => f.name !== 'OrphanQuery'), backend, opts);
  check('S7 前端多声明字段 → 违例且指名', extra.violations.length === 1 && extra.violations[0].includes('MaterialQuery.bogus'),
    JSON.stringify(extra.violations));

  const exemptField = compareContracts(withExtra.filter((f) => f.name !== 'OrphanQuery'), backend,
    { ...opts, exemptFields: { 'MaterialQuery.bogus': '存量漂移，已登记处置' } });
  check('S8 字段级豁免打印且不计违例', exemptField.violations.length === 0
    && exemptField.exempted.some((e) => e.includes('MaterialQuery.bogus')), JSON.stringify(exemptField));

  const exemptItf = compareContracts(frontend, backend,
    { ...opts, exemptInterfaces: { ExemptQuery: '后端为内联 [FromQuery]' } });
  check('S9 接口级豁免打印且不因缺 DTO 报违例',
    !exemptItf.violations.some((v) => v.includes('ExemptQuery')) && exemptItf.exempted.some((e) => e.includes('ExemptQuery')),
    JSON.stringify(exemptItf));

  check('S10 无对应 DTO → 违例并给出期望名',
    exemptItf.violations.length === 1 && exemptItf.violations[0].includes('OrphanQueryDto'), JSON.stringify(exemptItf.violations));

  const unpaired = compareContracts([{ name: 'SoloQuery', file: 'x.ts', line: 3, fields: [] }], [],
    { explicitPairs: {}, exemptInterfaces: {}, exemptFields: {} });
  check('S11 空后端也按违例处理（不静默）', unpaired.violations.length === 1 && unpaired.violations[0].includes('SoloQueryDto'));

  const explicit = compareContracts([{ name: 'PairQuery', file: 'x.ts', line: 1, fields: ['bar'] }], backend, opts);
  check('S12 显式映射名对账成功', explicit.violations.length === 0 && explicit.paired[0].includes('PairItemQueryDto'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- S13 非 git 目录下加载脚本不得崩溃（2026-10-28）----
// ROOT 解析的回退分支曾引用一个**从未定义**的 `SCRIPT_DIR`：git 目录里 findProjectRoot() 短路成功，
// 回退分支永远不执行，所以这个问题一直没暴露；在非 git 目录（合法形态：就地操作）跑时脚本直接
// `ReferenceError: SCRIPT_DIR is not defined` 崩溃。这里在临时非 git 目录加载模块，锁住「能加载」。
{
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { fileURLToPath } = await import('node:url');
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-nongit-'));
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-query-contract.mjs');
    const r = spawnSync(process.execPath, ['-e',
      `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => console.log('loaded')).catch((e) => { console.error(e.message); process.exit(1); })`,
    ], {
      cwd: nonGit,
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(nonGit) },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check('S13 非 git 目录下加载不抛 ReferenceError',
      r.status === 0 && /loaded/.test(out) && !/ReferenceError/.test(out), out.slice(0, 300));
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
}

// ---- S14 契约面守卫（2026-11 Minor）：前后端目录缺失 →「无契约可查」advisory exit 0，不崩 ----
// 本门是 advisory 对账（脚本头定位）：消费项目可以没有 frontend/backend 布局——此前 readdirSync
// ENOENT 直接崩栈。黑盒 spawn 断言退出契约。
{
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-query-contract.mjs');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bare-'));
  try {
    const r = spawnSync(process.execPath, [script], { cwd: bare, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check('S14 前后端目录缺失 → exit 0 + 无契约可查 advisory（不崩栈）',
      r.status === 0 && /无契约可查/.test(out) && !/ENOENT.*at\s/.test(out), `exit=${r.status}\n${out.slice(0, 400)}`);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
}

// ---- S15 契约文件读失败（目录位被同名文件占用 → readdirSync ENOTDIR）→ advisory 放行 exit 0 ----
{
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-query-contract.mjs');
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-broken-'));
  try {
    fs.mkdirSync(path.join(broken, 'backend'), { recursive: true });
    fs.mkdirSync(path.join(broken, 'frontend', 'src'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'frontend', 'src', 'api'), 'not a dir', 'utf8'); // api 是文件 → ENOTDIR
    const r = spawnSync(process.execPath, [script], { cwd: broken, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    check('S15 契约面不可读 → exit 0 + advisory 点名原因（不崩栈）',
      r.status === 0 && /契约面不可读/.test(out) && !/ENOTDIR.*at\s/.test(out), `exit=${r.status}\n${out.slice(0, 400)}`);
  } finally {
    fs.rmSync(broken, { recursive: true, force: true });
  }
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);