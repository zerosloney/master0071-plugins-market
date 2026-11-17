// install/migrations.mjs — manifest 单向迁移链（schemaVersion 驱动；2026-11 装户升级面新增）。
// 与蓝本（agentic-flow-kit src/install/migrations.mjs）的有意差异：
//   ① 静态注册表：插件链路全同步，直接 import 各级迁移模块（MIGRATIONS 数组），不用动态
//      import 目录发现；新增迁移在此追加并保持链连续（from+1===to 校验兜底）。
//   ② migrate 签名同步化：migrate({ manifest }) → { manifest, notes? }，无 target/dryRun。
//   ③ 本模块零写盘：迁移只转换 manifest，写盘归 apply 台账写入口（writeManifestAtomic 单源，
//      避免双写入口）——apply 在本来要写台账的时机带上返回的 manifest 即可（接线属 apply 段）。
// 任一步失败抛错且不落盘（半迁移状态不会发生）；台账版本高于 CURRENT_SCHEMA_VERSION 报
// code='MANIFEST_SCHEMA'（拒绝降级读，防止新版台账被旧引擎静默改写）。
import { CURRENT_SCHEMA_VERSION } from './manifest.mjs';
import * as m01 from './migrations/0-1.mjs';

const MIGRATIONS = [m01];

function migrationError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

// migrateManifest({ manifest, log })：从 manifest.schemaVersion（缺字段视作 0）逐级迁移到
// CURRENT_SCHEMA_VERSION。返回 { from, to, changed, applied, notes, manifest }：
//   changed=false 表示台账已是当前版本、无需迁移；applied 为实际执行的 "<from>-<to>" 段列表。
// 迁移结果只在内存中，调用方决定是否落盘；本模块无任何 fs 写调用——失败抛错时现场原样保留。
export function migrateManifest({ manifest, log = () => {} } = {}) {
  const from = Number.isInteger(manifest?.schemaVersion) ? manifest.schemaVersion : 0;
  if (from > CURRENT_SCHEMA_VERSION) {
    throw migrationError(
      `manifest schemaVersion ${from} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`,
      { code: 'MANIFEST_SCHEMA', version: from, current: CURRENT_SCHEMA_VERSION },
    );
  }
  for (const migration of MIGRATIONS) {
    if (!Number.isInteger(migration.from) || migration.to !== migration.from + 1
      || typeof migration.migrate !== 'function') {
      throw migrationError(
        `迁移注册无效: ${migration.from} → ${migration.to}`,
        { code: 'MIGRATION_FAILED' },
      );
    }
  }
  let current = { ...manifest, schemaVersion: from };
  let version = from;
  const applied = [];
  const notes = [];
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version && m.to === version + 1);
    if (!migration) {
      throw migrationError(
        `缺少 manifest 迁移: ${version}-${version + 1}`,
        { code: 'MIGRATION_FAILED' },
      );
    }
    let result;
    try {
      result = migration.migrate({ manifest: current });
    } catch (error) {
      throw migrationError(
        `manifest 迁移 ${migration.from}-${migration.to} 执行失败: ${error.message}`,
        { code: 'MIGRATION_FAILED', cause: error },
      );
    }
    const next = result && typeof result === 'object' && result.manifest ? result.manifest : result;
    if (!next || typeof next !== 'object' || next.schemaVersion !== version + 1) {
      throw migrationError(
        `manifest 迁移 ${migration.from}-${migration.to} 未返回 schemaVersion=${version + 1} 的对象`,
        { code: 'MIGRATION_FAILED' },
      );
    }
    current = next;
    version = next.schemaVersion;
    applied.push(`${migration.from}-${migration.to}`);
    for (const note of result?.notes || []) notes.push(String(note));
    log(`migrate ${migration.from}-${migration.to}`);
  }
  return { from, to: version, changed: applied.length > 0, applied, notes, manifest: current };
}
