# 特性：采购申请 → 采购订单 → 出库 主链

> 特性地图种子。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
hash 路由。`#/purchase-requests`（采购申请，详情为页内抽屉，无 `:id` 路由）→ `#/purchase-orders`（采购订单，列表为 AG Grid；新增/查看/编辑为页内覆盖层三态，无 `:id` 路由）→ `#/outbound-requests`（出库申请）→ `#/outbound-orders`（出库管理）。入口经可折叠侧栏「模块列表」抽屉（采购管理 / 仓储管理分类，`frontend/src/layouts/MainLayout.vue` moduleCategories）。上游供数面：MTO 需求 `#/mto-orders`、到货 `#/arrival-orders`、入库 `#/inbound-orders`。

## 驱动
采购申请建单（草稿→确认）→ 采购订单从申请行取行下单（可下单量过滤）→ 到货入库形成库存 → 出库申请领料（占用库存）→ 出库单执行扣减。逐段验证时从对应列表页进入；采购订单的查看/编辑/新增走页内覆盖层（列表单号链接或行 hover 浮层「查看详情 / 编辑」，工具栏「新增采购订单」）。

## 可观察终态
- PR 行可下单量 = `max(RequestQty − ΣOrderedContribution, 0)`，单点判据 `PurchaseOrderStatusExtensions.OrderedContribution`（未关闭行=OrderQty、已关闭行=DeliveredQty；草稿/已取消 PO 不占量）。
- PR 全部行下满 → PR 状态重算升级；PO 驳回（回草稿）→ 被占用的 PR 由「已完成」回退「已审核」，剩余量恢复可再下单（`PurchaseOrderService.RejectAsync` → `UpdatePRStatusAsync`）。

## Gotchas
- PR 详情是页内抽屉、PO 详情/编辑/新增是页内覆盖层，均无独立深链路由——深链验证须走「列表 → 单号链接 / 行 hover 浮层 / 工具栏新增」路径，勿试图直连详情 URL。
- 采购订单列表为 AG Grid（2026-10-24 plans po-module-ui-refactor-ag-grid）：列序 = 定义顺序（复选框 → 序号 → 订单号 → …），列全部不 pin（pin 会打乱视觉顺序）；行操作不在固定操作列，走行 hover 浮层（DOM 事件委托，AG Grid `rowMouseEnter` 实测不触发）；浮层显隐/熔断/滚轮转发三处机制见 `frontend/src/views/purchase/purchaseOrder/index.vue` 注释，改表格时勿回退成 a-table 或恢复操作列。
- 采购订单详情覆盖层高度模型：上半区纯内容高、下半区 `min-height: calc(var(--layer-h)/2)` grow 撑满、表内滚动、下半区可最大化；`--layer-h` 由 ResizeObserver 注入（CSS 百分比在可撑开容器下失效）。查看态字段多，长文本与审批留痕收在「审批与备注」页签以保上半区 ≤ 半屏（否则常规视口出外层滚动条）。
- 采购订单列表搜索区走共享 `components/SearchPanel.vue`（2026-10-24 plans po-search-panel-collapse）：条件与「查询/重置」同行、按钮贴首行行末；条件超出一行时底部折叠条（延长线 + 居中箭头），**默认只显首行**，点箭头展开全部。机制要点：行归属靠 `measure()` 运行时测量（先恢复可见→按 `top` 分行→折叠态隐藏非首行→逐次隐藏首行末位项直到按钮回到首行）；`ResizeObserver` **只认宽度变化**（认高度会因折叠改高自唤醒成回环）；折叠只裁视觉，隐藏条件 `v-model` 值保留、照常参与查询——页面给有值项加 `is-active-filter` 类并透传 `activeCount`，组件据此在折叠条显示「N 项条件已折叠」徽标（防条件藏起来却生效）。改搜索区时勿退回 4 列栅格或自写折叠。
- 新增采购订单默认值（2026-10-24 plans po-feedback-round2）：采购员 = 登录人（按 `buyerJobNo/jobNo/userName/displayName` 四键匹配启用采购员记录）；采购组织 = 该采购员所属采购组的组织（采购员 → 采购组 `companyCode` → `Systembase_Company` 同名编码）。派生链任一环缺失则留空（不猜）。默认组织写入时同步 `lastOrgID` 基线——它是「初值」不是「切换」，勿在 `initForCreate` 里漏掉这步（漏了首次改组织会被误判为补选）。
- 明细导入模板（后端单源 `PurchaseOrderImportService`）为 12 列、**双单价列**：第 4 列锚点列随订单口径切「含税单价*」/「无税单价*」（必填），第 5 列另一列不带 `*`、可留空，填了则按生效税率（行税率 → 物资默认税率）折算一致性校验（容差 0.01）；通用「单价」列头按口径归入锚点列（旧单列模板两种口径均可解析）。同一单价逻辑列被两个列头命中（如「单价」+「含税单价」）才整文件报错。改模板列时同查 `HeaderAliases` / `DefaultColumnIndexes` / `RequiredColumns` / `ColumnTitle` 四处的按口径求值，以及 `DlgDetailImport.vue` 预览列。
- 查看态明细表「备注」与「备注2」是**两个字段**：`remark`（行级备注，来源引入采购申请/打印模板）与 `remark2`（手工备注2）；两者都要在查看态列里（2026-10-24 用户反馈只显示了备注2）。2026-10-26 起编辑态明细表也在「管理单位」与「备注2」之间补了可编辑「备注」列（plans/2026-10-26-pr-po-unit-qty-rename）。
- 已下单量口径禁手写：五处消费点（可下单量展示/PR 状态重算/超量硬拦/草稿预警/提交闸口）统一走 `OrderedContribution`（2026-10-18 incident po-line-close-caliber-asymmetry）。
- PO Status=6 已取消不占量；值 5 已退役不复用（2026-10-18 incident pr-status5-cancelled-legacy-rows，枚举退役三步巡检判据见 regression-checklist）。
- 「引入采购申请明细」弹窗只列可用行（`isAvailable !== false`，停用行不进弹窗）；列序：前 4 列左侧固定（申请单号 / 物资编码 / 物资名称 / 规格型号）→ 需采购数量（= 可下单量 `remainingQty`）→ 管理单位（2026-10-26 起绑 `usageUnitName`，原「单位」绑主单位名，plans/2026-10-26-pr-po-unit-qty-rename）→ 代管 → 采购组织 → MTO单号 → 项目号 → 需求日期 → 需求部门 → 分段 → TAG号（14 列）。已下单/可下单/需求明细不再单列（2026-10-23 plans po-pr-import-column-order / columns-refine / available-only）；改列时同查 `prSelectColumns` 与 `:scroll.x`（当前 1670）。
- PO 详情明细行操作列显示矩阵与后端行重开白名单（`ReopenDetailAsync`：草稿/已提交/已审核 ∪ 已关闭）一致：已完成(4)/已取消(6)整单各行与未关闭行显 `-`，已关闭行的「重开」仅上述状态可见——改行操作列时先查 `RowOperationAllowedStatuses` 单源，禁手写第三套状态表（2026-10-24 incident po-completed-row-reopen-button）。
- PO 单据状态无「部分到货」（7 已于 2026-10-24 退役，部分到货期间保持已审核 3）；到货进度看独立派生轴——列表「到货状态」列/筛选、详情头「到货状态」，判据单源 `PurchaseArrivalEvaluator`（未到货/部分到货/全部到货，不落库实时派生）。改状态相关 UI/测试时先查该单源与 `OrderedStatuses`，禁手写状态表或假设「部分到货」是单据状态（2026-10-24 spec po-arrival-status-axis-split）。
