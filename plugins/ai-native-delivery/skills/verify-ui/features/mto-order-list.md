# 特性：MTO 需求单列表

> 特性地图。事实锚点为建档时点代码，漂移时先修地图再出结论。
> 2026-10-26 大幅修订：本页 2026-10-24 已迁 AG Grid（commit `b102e094`），旧版此地图里 `a-table` 时代的
> 表头居中 / 固定操作列 / 两行 `.search-row` 条目已失效，按现实现重写（同批随
> plan `2026-10-26-mto-pml-list-batch-ops-and-close-guard`）。

## 到达路径
hash 路由 `#/mto-orders`（采购 › MTO需求）。主列表进入不取数，点「查询」或带参进入才取数（`useListQueryGate`）。

## 驱动
进入 `#/mto-orders` → 观察未查询空态；填任意不存在的 MTO单号 → 点「查询」→ 观察已查询无结果空态；点「重置」回默认查询态。
行操作在 **hover 浮层**里：鼠标移到某行 → 表格右缘浮出该行按钮（无固定操作列）。

## 可观察终态
- 查询栏为 `SearchPanel` 网格（`:expandable="false"`、`--search-cols: 5`）：10 个条目 DOM 序
  `MTO单号｜MTO名称｜项目号｜专业｜采购组织｜查询重置｜单据状态｜审批状态｜创建人｜创建时间`；
  第一行 = 前 5 项 + 行末「查询/重置」，第二行 = 自「单据状态」起的 4 项；两行同列左缘一致、行距 40px（32px 控件 + 8px 网格 gap）
  （2026-10-26 用户口径「参照采购订单」，替换原 `.search-row` flex 两行 + 44px 行距；实测 `scripts/verify/business/verify-mto-order-search-field-order-ui.mjs`，
  证据 `tmp/e2e-evidence/mto-order-search-field-order/`；字段序与两行分组仍是 2026-10-23 用户裁定）。
- 工具栏：左组「新增需求」，右组 5 个批量按钮（提交审批 / 审批 / 撤回 / 关闭 / 删除）靠右、竖线分隔；
  无选中全禁用，勾选后带「（N）」计数（2026-10-26 用户口径；行复选框资格 = 该行至少有一个可用动作）。
- 行 hover 浮层**只渲染可用动作**（不可用即不渲染节点）；一个动作都没有的行（如已关闭行、非本人创建的已提交行）
  **不浮出浮层**（2026-10-26 用户口径，反转 2026-10-09 的「置灰不隐藏」）。查看入口仍在「MTO单号」链接（打开详情覆盖层）。
- 所有确认类入口（提交审批 / 撤回 / 关闭 / 删除 / 批量各项）弹出**单层居中 `Modal.confirm`**（无 `Popconfirm` 气泡；
  原「提交审批」的 Popconfirm + Modal 双弹已消除）（2026-10-26 用户口径，参照「关闭」对话框）。
- 单据关闭：仅**创建人本人**可关（前端 `canCloseMTO` 叠加本人判据 + 后端 `MTOService.CloseAsync` 权威守卫）；
  单据已走下游（列表 DTO `downstreamSummary` 非空：已匹配定额 / 已生成采购订单）时，关闭确认框追加提示（提示不阻断）。
- 空态与 `/pml` 托盘列表同形态，文案由 `useListQueryGate()` 单源生成（对照见 `pml-pallet-list.md`）。
- 列表为 AG Grid：行高 40、表头高 40、无固定列（列序即视觉序：复选框 → 序号 → MTO单号 → …），
  文本列内容截断时 hover 出全文 tooltip（`tooltipShowMode:'whenTruncated'`）。

## Gotchas
- 查询栏改字段/顺序：字段序是 2026-10-23 用户裁定，动它要连带改随动门脚本
  `scripts/verify/business/verify-mto-order-search-field-order-ui.mjs` 的 `EXPECT_ORDER`。改 `--search-cols` 会改变
  「动作项落在第几格」（SearchPanel 把 `#actions` 渲染在 `#more` **之前**）。
- 「禁用即不渲染」的资格判据单源在页面 `canEdit` / `canSubmitApproval` / `canApprove` / `canRecall` /
  `canCloseMTO` / `canDelete` / `canDemandChange`；批量按钮的资格集合（`submittableIds` 一族）与行复选框
  `isRowSelectable` 都从这里派生——加动作时改这一处，别另写清单。
- 批量是**前端循环调单条端点**（`Promise.allSettled` 聚合 + `batchSubmitting` 重入守卫），没有后端批量端点；
  服务端权威门仍是各单条端点自身的守卫。
- 行 hover 浮层的显隐走 DOM 事件委托（`mouseover`/`mouseout` 冒泡 + 150ms 延时），**不是** ag-grid 的
  `rowMouseEnter`（实测不触发）；`pointer-events:none` 不再是置灰手段（禁用动作已不渲染）。
- 表体列序与查询栏字段序是两处独立口径，改一处不代表另一处同步。
