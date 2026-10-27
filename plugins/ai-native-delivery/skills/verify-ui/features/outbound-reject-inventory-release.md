# 特性：出库申请驳回后库存占用归还

> 特性地图种子（内涵按代码实证收窄——PR/PO 驳回不涉库存，勿当等价路径）。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
`#/outbound-requests` → 已提交（Submitted）出库申请 → 审批弹窗选「驳回」radio（`frontend/src/views/inventory/outboundRequest/index.vue`）。

## 驱动
对 Submitted 单填驳回意见提交 → 观察单据状态与库存可用量。核心实现：`OutboundRequestService.RejectAsync`，与状态变更**同事务**调 `ReleaseByRequestAsync`（逐条 `UPDATE MM_INV_InventoryRecord SET LockedQty -= delta`，下限 0，并删 `InventoryLock` 占用行）+ `ReleasePmlQuotaAsync`（释放 PML 定额）。

## 可观察终态
- 单据状态 →「已驳回」红色 tag（Status=4，色板 error）；审批状态同步 Rejected。
- 库存可用量（`Qty − LockedQty`）回升，该物资可立即被其他出库申请再次占用；PML 定额余量恢复。

## Gotchas
- 仅 Submitted 可驳，其他状态驳回应被守卫拦下。
- 同一释放逻辑复用于删除/取消/关闭路径——验证时任一路径泄漏（驳回后 LockedQty 未归零）都是共享函数缺陷，根因修在释放函数而非调用点。
- PR 驳回 = 退回草稿且**不释放** MTO 明细占用（防「待分配」死角）；PO 驳回 = 采购量占用回退（OrderedContribution 口径）——两者均无库存字段参与，不能作为本特性的等价验证路径。
