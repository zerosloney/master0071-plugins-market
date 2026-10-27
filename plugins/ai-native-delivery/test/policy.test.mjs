// policy.test.mjs — 豁免锚单源：版本表构造 / engine.json 选版 / 绿凭证窗口判定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POLICIES, loadKitPolicy, auditEnabled, hasFreshVerifyLine } from '../scripts/policy.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const versions = Object.keys(POLICIES).map(Number).sort((a, b) => a - b);
check('S1 版本表连续覆盖 1..14', versions.length === 14 && versions.every((v, i) => v === i + 1), versions.join(','));

check('S2 V1 基线五锚', ['moduleSince', 'check14Since', 'confirmDocsEffective', 'confirmIncidentsEffective', 'bindingTs']
  .every((k) => typeof POLICIES[1][k] === 'string'));

check('S3 V2 后移 check14Since 并新增 stageGateSince', POLICIES[2].check14Since === '2026-09-26'
  && POLICIES[2].stageGateSince === '2026-09-29' && POLICIES[1].stageGateSince === undefined);

check('S4 V3 仅后移确认门两锚（不夹带 V2 键）', POLICIES[3].confirmDocsEffective === '2026-10-06'
  && POLICIES[3].confirmIncidentsEffective === '2026-10-06'
  && POLICIES[3].stageGateSince === undefined && POLICIES[3].moduleSince === '2026-09-22');

check('S5 V5 以 V2 为基线（无 delegationSince）', POLICIES[5].verifySince === '2026-10-07'
  && POLICIES[5].delegationSince === undefined && POLICIES[5].confirmDocsEffective === '2026-09-27');

check('S6 V6 = V4 超集 + 三个新锚', ['delegationSince', 'verifySince', 'incidentRegrSince', 'specVerifSince']
  .every((k) => POLICIES[6][k] !== undefined)
  && POLICIES[6].delegationSince === POLICIES[4].delegationSince);

for (const [from, to] of [[6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14]]) {
  const missing = Object.keys(POLICIES[from]).filter((k) => POLICIES[to][k] === undefined);
  check(`S7 v${from}→v${to} 为超集追加（锚不丢失）`, missing.length === 0, missing.join(','));
}

check('S8 V14 具备四枚最新锚', POLICIES[14].reviewerSince === '2026-10-12'
  && POLICIES[14].clarifySince === '2026-10-22'
  && POLICIES[14].coverageSince === '2026-10-22'
  && POLICIES[14].convergenceHardSince === '2026-10-12');

// ---- loadKitPolicy ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
  const cfgDir = path.join(tmp, '.agents', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const write = (obj) => fs.writeFileSync(path.join(cfgDir, 'engine.json'), JSON.stringify(obj), 'utf8');

  write({ policyVersion: 14 });
  const p14 = loadKitPolicy(tmp);
  check('S9 选定版本 14 生效且回显 requested', p14.policyVersion === 14 && p14.requestedVersion === 14
    && p14.coverageSince === '2026-10-22');

  write({ policyVersion: 99 });
  const p99 = loadKitPolicy(tmp);
  check('S10 未知版本回退 v1 且 requested 保留', p99.policyVersion === 1 && p99.requestedVersion === 99
    && p99.verifySince === undefined);

  fs.rmSync(path.join(cfgDir, 'engine.json'));
  const pMissing = loadKitPolicy(tmp);
  check('S11 engine.json 缺失回退 v1', pMissing.policyVersion === 1 && pMissing.requestedVersion === 1);

  write({ policyVersion: 14, audit: false });
  const pNoAudit = loadKitPolicy(tmp);
  check('S12 audit=false 透传且 auditEnabled 为 false', pNoAudit.audit === false && auditEnabled(pNoAudit) === false);

  write({ policyVersion: 14 });
  check('S13 audit 缺省视为启用', auditEnabled(loadKitPolicy(tmp)) === true);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- hasFreshVerifyLine ----
{
  const now = Date.now();
  const iso = (deltaMs) => new Date(now - deltaMs).toISOString();
  const line = (o) => JSON.stringify(o);
  check('S14 24h 内绿行通过', hasFreshVerifyLine([line({ ts: iso(3600 * 1000), exitCode: 0 })], now));
  check('S15 24h 外绿行拒绝', !hasFreshVerifyLine([line({ ts: iso(25 * 3600 * 1000), exitCode: 0 })], now));
  check('S16 红行不构成凭证', !hasFreshVerifyLine([line({ ts: iso(1000), exitCode: 1 })], now));
  check('S17 testCmd 夹具行剔除', !hasFreshVerifyLine([line({ ts: iso(1000), exitCode: 0, testCmd: true })], now));
  check('S18 engineOnly 增量行剔除', !hasFreshVerifyLine([line({ ts: iso(1000), exitCode: 0, engineOnly: true })], now));
  check('S19 坏行跳过、后续绿行仍生效', hasFreshVerifyLine(['not-json', line({ ts: iso(1000), exitCode: 0 })], now));
  check('S20 空输入拒绝', !hasFreshVerifyLine([], now) && !hasFreshVerifyLine(null, now));
}

console.log(`\n合计: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
