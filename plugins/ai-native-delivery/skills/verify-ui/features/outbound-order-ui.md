# 特性：出库管理列表与详情（AG Grid + 覆盖层三态）

> 特性地图种子（2026-10-25 整模块重构后形态）。事实锚点为建档时点代码，漂移时先改地图再出结论。

## 到达路径
`#/outbound-orders` → 列表（AG Grid）→ 单号链接 / 行 hover 浮层「查看详情」→ 页内覆盖层查看态；工具栏「新增出库单」→ 覆盖层新增态；行浮层「编辑」/ 工具栏「编辑」→ 覆盖层编辑态。

## 驱动
- 列表：`SearchPanel`（出库单号 / 项目号 / 状态；日期范围折叠）+ AG Grid（单选 radio、行操作 hover 浮层、分页页脚钉底）；页面级「从申请下推」弹窗保留在列表页。
- 详情：`frontend/src/views/inventory/outboundOrder/detail.vue` 三态（`create | edit | view`）——上半区基础信息 `info-grid`，下半区 `出库明细` 页签 + 最大化；编辑态明细工具栏并入页签行（匹配模式 / 指定项目 / 库存匹配 / 添加明细）。
- 保存：`createOutboundOrder` / `updateOutboundOrder`，载荷与原 Drawer 逐字段一致（含 `rowVersion` 乐观锁）；成功后 `emit('close', true)` → 列表刷新。

## 可观察终态
- 列表列序 = 定义顺序（复选框 → 序号 → 出库单号 → … → 创建时间），列头无 `...` 截断；行滚动收在 grid 内部，页面无外层滚动条。
- 查看态：`top + bottom == --layer-h`，`.detail-layer` 无外层滚动条；最大化时上半 `display:none`、下半铺满。
- 编辑/新增态：无 `.ant-drawer-open`；保存成功后覆盖层关闭且列表刷新。

## Gotchas
- 覆盖层是页面内视图切换（无路由），刷新即回列表；列表实例保持存活（筛选/滚动不丢）。
- 行 hover 浮层用 DOM 事件委托（AG Grid `rowMouseEnter` 不触发）；详情层打开期间浮层熔断。
- 库存匹配要求单据已落库（新单未保存提示「请先保存出库单」）；匹配只回填库位/批次，仓库在表头。
- 编辑/确认出库/取消/删除同资格：仅草稿（status=1）；已确认/已取消只能查看。
- 实测探针：`tmp/e2e/outbound-order-ui-refactor-check.mjs`（48 PASS / 0 FAIL）；AG Grid license banner 属已知噪声。
