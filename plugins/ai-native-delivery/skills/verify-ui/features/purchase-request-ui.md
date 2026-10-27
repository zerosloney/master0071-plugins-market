# 特性：采购申请明细视图（AG Grid + 覆盖层详情）

> 特性地图种子（2026-10-25 明细视图重构后形态）。事实锚点为建档时点代码，漂移时先改地图再出结论。

## 到达路径
`#/purchase-requests` → 默认统计视图 → 切「明细视图」→ 列表（AG Grid）→ 单号链接 / 行 hover 浮层「查看详情」→ 页内覆盖层详情；行浮层「确认」/ 详情头部「确认」→ 确认采购申请。

## 驱动
- 列表：`SearchPanel`（申请单号 / MTO单号 / 采购员 / 状态；创建时间 radio 折叠）+ AG Grid（多选复选框、行操作 hover 浮层、分页页脚钉底）。
- 详情：`frontend/src/views/purchase/purchaseRequest/detail.vue` 只读覆盖层——`DetailPageHeader` + `info-grid` 22 字段；头部「确认」仅待确认（status=1）。
- 确认：`approvePurchaseRequest(id, {})`；成功后详情重载 + 关闭时列表刷新。
- 统计视图、分配采购员 / 重新分配弹窗、批量撤回确认、全部确认弹窗保持原样（用户 2026-10-25 明确「只改明细视图」）。

## 可观察终态
- 列表列序 = 定义顺序（复选框 → 序号 → 申请单号 → … → 状态），列头无 `...` 截断；行滚动收在 grid 内部，页面无外层滚动条。
- 详情：无 `.ant-drawer-open`；22 字段齐全；确认后状态 tag 转「已确认」且确认按钮消失。
- 统计视图：采购员工作量卡片 + 「全部确认」入口仍在。
- 2026-10-26 口径改名（plans/2026-10-26-pr-po-unit-qty-rename）：列表数量列表头「需采购数量(辅)」（宽 150）；详情三项 label「计价单位 / 管理单位 / 需采购数量(辅)」；待分配表「需采购数量(辅) / 计价单位 / 管理单位」；全部确认弹窗「需采购数量(辅)」。列表「管理单位」列数据源仍为 `unitName`（列表 DTO 未下发 `usageUnitName`，改绑留待后端契约裁决）。实测 51/51：`tmp/e2e/pr-po-unit-qty-align-results.json`。

## Gotchas
- 明细视图与统计视图共用 `statsTimeRange`；SearchPanel 折叠区内的创建时间 radio 必须保持同一状态源。
- 「分配采购员」角标向上溢出按钮 6px：明细视图根容器 `.mto-order-list.is-detail-view` **不得设 `overflow:hidden`**（会裁掉角标上半），行滚动由 `.table-card` 承接。
- 工具栏布局同采购订单：左组单据级动作 / 右组批量动作（`margin-left:auto` + 左竖线）；本页无单据级按钮，左组为计数信息。
- 批量动作限当前页内完成（翻页/刷新清空选中）；复选框资格 = status 1/3（`isRowSelectable` 与后端守卫同口径）。
- 详情覆盖层是页面内视图切换（无路由），刷新即回列表；列表实例保持存活。
- 实测探针：`tmp/e2e/purchase-request-ui-refactor-check.mjs`（32 PASS / 0 FAIL）；探针会确认一条草稿单（每次运行消耗一条草稿），AG Grid license banner 属已知噪声。
