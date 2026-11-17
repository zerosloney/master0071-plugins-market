// manifest 0 → 1：补 schemaVersion（v0 台账只有 { plugin, version, files }）。
// 只补元数据、不触碰 files：浅拷贝构造新对象，schemaVersion 置 1，其余字段原样。幂等：
// 已是 1 的对象再迁仍返回等值新对象（框架按 schemaVersion 跳过，正常不会重跑，此处自守）。
export const from = 0;
export const to = 1;

export function migrate({ manifest }) {
  return {
    manifest: { ...manifest, schemaVersion: 1 },
    notes: ['补 schemaVersion:1'],
  };
}
