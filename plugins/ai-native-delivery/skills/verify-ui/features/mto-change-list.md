# 特性：需求变更 列表（/mto-changes）

> 特性地图。事实锚点为建档时点代码，漂移时先修地图再出结论。
> 建档 2026-10-26（L1 plan `workflow/plans/2026-10-26-mtochange-list-batch-search-and-columns.md`，实现提交 `a7c61d69`）。

## 到达路径

hash 路由 `#/mto-changes`（采购 › 需求变更）。**进入不取数**：不在 URL 带参进入时列表为空态，必须点「查询」才取数（`useListQueryGate` 既有口径）。

- 查询栏为共享 `SearchPanel` 网格（`style="--search-cols: 5"`）：变更单号 | 项目号 | 专业 | 申请部门/科室 | 审批状态 五字段，与动作项（查询 / 重置）同首行；label 定宽 104px（本页最长「申请部门/科室」）。
- 本页**无「新增变更单」入口**——变更单由 MTO 需求页（`/mto-orders`）的「需求变更」抽屉创建。

## 驱动

进入 `#/mto-changes` → 点「查询」取数，然后：

- **行操作**：鼠标移到目标行（`mouseover` 冒泡到 `.ag-row`）→ 行右缘浮出 `.row-hover-panel` → 点其中 `<a class="action-edit|action-submit|action-recall|action-approve|action-delete">`。
  **不满足资格的动作不渲染**（2026-10-26 起；旧口径「五按钮常驻 + `.action-disabled` 置灰」已删除）；行无任何可用动作时**不浮出浮层**。
- **批量操作**：勾行首复选框（AG Grid `rowSelection` = multiRow + 表头全选 + `enableClickSelection: false`）→ 列表**上方靠右**的批量按钮组（`.toolbar-right`：提交审批 / 审批 / 撤回 / 删除）按资格集合启用并显示 `（N）`。
- **查询栏**：「查询」取数并回第 1 页；「重置」清空条件 + 回未查询空态（**不取数**）。

## 可观察终态

- 工具栏**只有靠右的批量按钮组**（无左组：本页无单据级新增按钮），**无「N 条待审批 / M 条已审批」计数文本**（2026-10-26 下线；网络亦无 `approval-counts` 请求——接口与后端端点保留，只是本页不再消费）。
- 批量按钮 `:disabled` 由「当前页选中行 ∩ 该动作资格」集合长度驱动；计数后缀 `（N）` 仅 N>0 时出现（未勾选时四个按钮全 disabled）。
- 行内「撤回」弹**单层居中 `Modal.confirm`**（`.ant-modal-confirm`），标题「确认撤回」、正文「确认撤回该变更单的审批？」、确认钮 danger；**不再用 `Popconfirm` 气泡**（2026-10-26 改）。同页「删除」仍是 `Popconfirm`（本次口径未含，属已知不一致）。
- 翻页 / 查询 / 重置 / 任一写操作后刷新：**勾选一律清零**、批量按钮回 disabled。
- 列宽按内容 p90 定宽（2026-10-26 重调）：`width = ceil10(max(列头需求, 内容 p90 需求) + 40)`，其中 **+40 = 单元格开销 32（padding 15×2 + 边框 2）+ 8 呼吸位**。实测逐列数据集级截断率 ≤ 7.4%（仅 p90 之外的离群值截断，由 hover tooltip `tooltipShowMode:'whenTruncated'` 承载）。
- **横向滚动是固有代价**：16 列合计 2090px > 1600px 窗口下的可用宽 1478px。这不是缺陷，别当回归修。

## Gotchas

- **必须真身播种**：行操作资格含「本人创建」门（`canEdit = status === 1 && isCreator`，比 `authStore.user.jobNo` 与行 `createdByJobNo`）。`harness.seedSession(ctx, token)` 写死 Admin 身份 → 本人门恒不通过，会把「没有可操作行」误判成缺陷。须自行把 `POST /api/v1/auth/login` 响应的 `jobNo/displayName/dept` 写进 `localStorage.auth_user`，再经 `about:blank` 中转后硬导航。
- **勾选态必须显式清**：AG Grid 未设 `getRowId`，行选中按**行索引**落地——服务端分页翻页后同索引行会「看起来被勾上」，而 `selectedRowKeys` 仍是旧页 id（按钮计数与视觉不一致）。本页把 `clearSelection()` 收进 `loadData()` 单一咽喉；`/mto-orders` 只在查询/重置/批量后清，别照抄那一版。
- **单元格内层就是 `.ag-cell` 本体**（`ag-cell-value` 与 `ag-cell` 是同一元素同类名）：判截断直接比 `scrollWidth > clientWidth`，**内容盒 = 声明宽 − 32**，不是 −16 也不是 −24。
- **量文本宽用隐藏 DOM span（复制 `font` / `letter-spacing`），别用 canvas 也别忘了开销常量**：本页 canvas 与 DOM span 量出同值（尺子本身没问题），真正的坑是**开销常量**——按旧口径 24 算会窄 8px，后果是正常长度也截断（实测：项目号 80px 时内容盒仅 48 < 所需 54 → 10/10 行截断）。
- 「操作时间 / 创建时间」渲染的是 `formatTime` 的 `YYYY-MM-DD HH:mm`（**不是**接口返回的 ISO 原文）——量宽必须用渲染文本。
- **AG Grid 试用 license 过期 banner 是本机既有噪声**：断言「控制台零错误」前先按 `AG Grid|Enterprise License|ag-grid.com` 过滤。
- 时间列 / 申请部门-科室等「未渲染即不在 DOM」：列横向虚拟化下，视口外的列（如创建人 / 创建时间）不在 DOM 里，别用 `.ag-header-cell` 计数当列总数。
