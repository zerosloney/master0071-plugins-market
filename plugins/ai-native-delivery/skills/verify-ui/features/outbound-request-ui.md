# 特性：出库申请列表与详情（AG Grid + 覆盖层三态）

> 特性地图种子（2026-10-25 整模块重构后形态）。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
`#/outbound-requests` → 列表（AG Grid）→ 单号链接 / 行 hover 浮层「查看详情」→ 页内覆盖层查看态；工具栏「新增出库申请」→ 覆盖层新增态；行浮层「编辑」/ 工具栏「编辑」→ 覆盖层编辑态。

## 驱动
- 列表：`SearchPanel`（申请单号 / 项目号 / 状态 / 审批状态 / 领料类型；日期范围折叠）+ AG Grid（单选 radio、行操作 hover 浮层、分页页脚钉底）。
- 详情：`frontend/src/views/inventory/outboundRequest/detail.vue` 三态（`create | edit | view`）——上半区基础信息 `info-grid`，下半区页签 `出库明细 / 物料汇总 / 出库单 / 审批与关闭` + 最大化；编辑态明细工具栏并入页签行（引用托盘 / 导入 / 添加明细）。
- 保存：`createOutboundRequest` / `updateOutboundRequest`，载荷与原 Drawer 逐字段一致（含 `rowVersion` 乐观锁）；成功后 `emit('close', true)` → 列表刷新。

## 可观察终态
- 列表列序 = 定义顺序（复选框 → 序号 → 申请单号 → … → 创建时间），列头无 `...` 截断；行滚动收在 grid 内部，页面无外层滚动条。
- 查看态：`top + bottom == --layer-h`，`.detail-layer` 无外层滚动条；最大化时上半 `display:none`、下半铺满。
- 编辑/新增态：无 `.ant-drawer-open`；保存成功后覆盖层关闭且列表刷新。

## Gotchas
- 覆盖层是页面内视图切换（无路由），刷新即回列表；列表实例保持存活（筛选/滚动不丢）。
- 行 hover 浮层用 DOM 事件委托（AG Grid `rowMouseEnter` 不触发）；详情层打开期间浮层熔断（防 Chrome 补发 mouseover 重建）。
- 编辑态明细「库存满足」由草稿预检（`check-inventory-draft`）回填，防抖 400ms + 序号守卫；失败降级为 `-`，不阻断保存。
- 审批/撤回/关闭在列表工具栏与详情头部各有一套入口，资格判据同源（`shared.ts` 的 `isSelfCreated` / `approveTitleFor`）。
- 实测探针：`tmp/e2e/outbound-request-ui-refactor-check.mjs`（52 PASS / 0 FAIL）；AG Grid license banner 属已知噪声。
