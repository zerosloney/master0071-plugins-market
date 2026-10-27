# 特性：单据状态色板（状态/审批双 tag）

> 特性地图种子。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
各单据列表页状态列：`#/purchase-requests`、`#/purchase-orders`、`#/outbound-requests`、`#/outbound-orders`。色板定义分散在各 API 模块的 `Record<number,string>` 常量（`frontend/src/api/purchaseRequest.ts` 的 `PR_STATUS_COLOR`/`PR_APPROVAL_STATUS_COLOR`、`purchaseOrder.ts` 的 `PO_STATUS_COLOR` 等），**非全局 shared util**——页面直接 `:color="XXX_STATUS_COLOR[status]"` 消费。

## 驱动
对单据执行状态流转操作（提交 / 审批通过 / 驳回 / 取消 / 关闭）→ 列表刷新 → 观察单据状态与审批状态两列 tag 的文本与颜色。

## 可观察终态
- 采购申请：单据 1 草稿 default / 3 已确认 success / 4 已完成 processing（值 2、5 已退役）；审批 0 未提交 default / 2 已通过 success / 3 已驳回 error。
- 采购订单：1 草稿 default / 2 已提交 processing / 3 已审核 success / 4 已完成 gold / 6 已取消 error / 7 部分到货 warning；审批驳回 3 error。
- 出库申请：1 草稿 default / 2 已提交 processing / 3 已审批 success / 4 已驳回 error / 5 已取消 default / 6 已关闭 default；出库进度另有 未出库 default / 部分出库 warning / 全部出库 success。

## Gotchas
- 色板按单据族各自维护：新增状态值须同步 `*_STATUS_TEXT` 与 `*_STATUS_COLOR` 两表，漏一张即渲染空白 tag。
- 断言取 tag 的 color 属性而非文本（不同单据存在同名文本如「草稿」，仅色值能区分状态集）。
- 退役值（PR 2/5）已从表内删除——历史数据若仍持退役值会渲染为空，属预期口径而非缺陷。
