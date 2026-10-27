# 特性：MTO 需求单新增/编辑/查看（覆盖层详情：明细信息 + 明细编辑 + 利库代用 + 查看态行操作）

> 特性地图。事实锚点为建档时点代码（commit `391f26a2`，2026-10-23），漂移时先修地图再出结论。

## 到达路径
hash 路由 `#/mto-orders` → 列表行操作「编辑」（或工具条「新增需求」）→ 打开**覆盖层详情**（detail.vue，mode=edit/create）。
形态锚点：2026-10-24（d3692b6e）抽屉形态整体下线迁入覆盖层详情（禁双编辑入口），原独立编辑页与三条 mto-orders 子路由同批删除——不要按独立路由去找这个特性。
**查看态**另有一条路径（2026-10-26 起承载审批后的行级维护）：列表行内点 **MTO 单号链接**（ag-grid 行的 `.code-link`）→ `openDetail('view', id)`，任何状态都可进。

## 驱动
1. 抽屉内「明细信息」卡：工具条 `新增 / 批量导入 / 导出Excel / 利库匹配 / 取消利库 / 删除`；每行操作列 `编辑 / 利库匹配 / 利库代用 / 取消利库 / 行关闭(或行启用) / 删除`。
2. 行操作「编辑」或工具条「新增」→ 打开**明细编辑抽屉**（标题「编辑明细」/「新增明细」）。
3. 行操作「行关闭」/「行启用」→ 弹原因弹窗（原因必填）。
4. 行操作「利库代用」→ 打开**利库代用弹窗**（上半=该明细行只读信息，下半=同大类库存候选）。
5. 行操作「取消利库」→ Popconfirm 确认 → 该行「利库数量(辅)」归 0；工具条「取消利库」同文案但为**批量**，作用于勾选明细（位置固定在「利库匹配」之后）。
6. 「保存」提交整单（明细「删旧建新」）。
7. **查看态**（点 MTO 单号进）：明细表末列「行操作」→ `行关闭 / 行启用` 单按钮二态切换 → 原因弹窗 → 确认**即刻落库**（不随整单保存）。


## 可观察终态
- **查看态行关闭 / 行启用（审批后唯一入口）**（2026-10-26；plan `2026-10-26-mto-row-close-enable-after-approval`）：点 MTO 单号进查看层，明细表**末列多一列「行操作」**（`fixed: right`、宽 110），列内单按钮二态 = 可用行 `行关闭`（锁）/ 停用行 `行启用`（开锁），`title` 形如 `行关闭（第 1 行）`。列的在场条件 = **单据 `status !== 3`（未关闭）且当前登录工号 = 单据创建人工号**；整单已关闭或非创建人 → 列整体不渲染（表回到 22 列）。点按钮 → 原因弹窗（标题 `关闭MTO需求明细行` / `启用MTO需求明细行`，确认按钮 `确认关闭` / `确认启用`）；**空原因被阻断**（弹窗不关 + 零写请求 + toast「关闭原因不能为空」）；填原因确认后**即刻落库**（`POST /api/v1/mto-orders/{id}/details/{detailId}/close|enable`，非整单 PUT）——`可用性` 列翻转、按钮换向、`关闭原因`/`启用原因` 列出现本次原因，且**覆盖层不关闭**（只刷新详情 + 通知列表）。实测 `scripts/verify/business/verify-mto-row-close-enable-after-approval-ui.mjs`（37/37），证据 `tmp/e2e-evidence/mto-row-close-enable-after-approval/`。
- **停用行操作闸**（2026-10-23；2026-10-23 增量把「取消利库」并入）：`isAvailable === false` 的行，操作列只留「行启用」「删除」；「编辑」「利库匹配」「利库代用」「取消利库」四处带 `action-disabled`（灰字 + `pointer-events:none`）且点击零副作用。可用行六动作行为不变。实测 `scripts/verify/business/verify-mto-disabled-row-actions-ui.mjs`，证据 `tmp/e2e-evidence/mto-disabled-row-actions/`。
- **取消利库**（2026-10-23 用户需求③④；plan `2026-10-23-mto-order-cancel-stock-batch-count-and-org-placeholder`）：行内单行与工具条批量两处入口，文本同为 `取消利库`，均带 Popconfirm。确认后目标行 `利库数量(辅)` 归 0、`需采购数量(辅)` = `需求数量(辅)`（算式与「利库代用」的确认回写逐字同式）；只改内存、随「保存」落库（`purchaseQty` 不随载荷提交，由后端 `DemandQty − StockQty` 重算）。批量入口**跳过停用行**并如实报数（提示含「跳过 N 行已停用明细」）；无实际改动（选中行利库数量全为 0）时不报成功、给 info 提示。实测 `scripts/verify/business/verify-mto-order-cancel-stock-and-drawer-hints-ui.mjs`，证据 `tmp/e2e-evidence/mto-order-cancel-stock-and-drawer-hints/`。
- **批量删除按钮带条数**（2026-10-23 用户需求①）：工具条「删除」在勾选后文本变 `删除(N)`（N = 已勾选条数），未勾选时保持 `删除` 且置灰。同一探针覆盖。
- **利库匹配直匹配**（2026-10-24；plan `2026-10-24-mto-stock-match-logic`）：行内与工具条两处「利库匹配」均**免弹窗**——直接取新端点 `GET /api/v1/inventory/same-material-candidates`（同物资编码自身、可用量(辅) > 0、入库时间升序空值靠后 → ID 兜底）按 FIFO 把 `min(需求数量−已利库, 可用量合计)` **累加**回该行「利库数量(辅)」并同步「需采购数量(辅)」；重复点击按剩余缺口收敛至需求上限。工具条批量按 `form.details` 行序先到先配（同物资编码共享候选池），结束 toast 含「成功 N 行 / 无可用库存 M 行 / 跳过 K 行」分类计数；无库存行提示「库存中无该物资编码的可用库存，未写入利库数量」且数据不动。实测 `scripts/verify/business/verify-mto-order-stock-match-logic-ui.mjs`（27/27），证据 `tmp/e2e-evidence/mto-order-stock-match-logic/`；按钮面回归 `verify-mto-order-stock-match-buttons-ui.mjs`（不弹窗不占位口径）。
- **采购组织占位提示**（2026-10-23 用户需求②）：编辑抽屉打开 `PurchaseOrgID` 为 `null` 的单据时，采购组织输入框显示占位文本 `请选择采购组织`。同一探针覆盖（探针单以 `purchaseOrgID: null` 创建）。
- **明细编辑抽屉字段集**（2026-10-23）：13 项 = `物资编码 / 物资名称 / 规格型号 / 需求数量 / 使用单位 / 计价数量 / 计价单位 / 需求部门 / 需求日期 / 分段\/区域 / TAG号 / 备注1 / 备注2`——**无「可用性」**（该字段已下线，停用/启用唯一入口 = 行关闭/行启用）；新增明细默认可用。实测同上探针（按字段集**全量**比对，不只查缺项）。
- **利库代用弹窗**（2026-10-23 首版；同日形态收敛见 spec `2026-10-23-mto-stock-substitute-modal-refine`；同日二轮调整见 spec `2026-10-23-mto-stock-substitute-modal-self-exclude-and-columns`）：宽度 **1560**（二轮由 1400 加宽）；上下两半均为「**左对齐分节标题 + 表格**」——上半标题 `明细信息`（1 行表头 + 1 行明细），下半标题 `可利库代用的明细`（二轮由「可库存明细」改名）。上半八列 `物资编码 / 物资名称 / 规格描述 / 需求数量(辅) / 已利库数量(辅) / 需利库数量(辅) / 本次利库数量(辅) / 使用单位(辅)`（二轮：`已利库数量` 补 `(辅)`；`使用单位(辅)` 置**末列**），其中需利库数量 = 需求数量 − 已利库数量、本次利库数量 = 下半各行输入之和（只读派生）。下半**七列** `物资编码 / 物资名称 / 规格描述 / 批次号 / 可用数量(辅) / 本次利库数量(辅) / 使用单位(辅)`（二轮下线 `库存数量(辅)`；可填列在倒数第二、`使用单位(辅)` 末列；默认 0）；表体可视区须容纳 **10 行**（`:scroll` = `{ x: 1070, y: 500 }`）。确认后该行「利库数量(辅)」累加合计、「需采购数量(辅)」= 需求数量 − 利库数量 随之变化；保存后落 `MM_PUR_MTOOrderDetail.StockQty`。实测 `scripts/verify/business/verify-mto-stock-substitute-modal-ui.mjs`，证据 `tmp/e2e-evidence/mto-stock-substitute-modal/`。
- 明细行单行显示（长文本 ellipsis 不换行）、工具条与操作列顺序：见 `verify-mto-order-stock-match-buttons-ui.mjs`。

## Gotchas
- **行关闭/启用的权威闸分两处，别找错**（2026-10-26）：**编辑/新增态**走整单 `PUT /api/v1/mto-orders/{id}`，权威闸是 `MTOService.UpdateAsync` 的「仅未提交可编辑 + 停用行字段不可变」；**查看态**走行级端点 `POST …/details/{detailId}/close|enable`，权威闸是 `EnsureLineOperable`（仅拒 `status == Closed`）+ `MtoOwnerGuard`（仅创建人）。行级端点**不经过** `UpdateAsync`，所以「审批后不能保存」与「审批后不能行关闭」是两回事——前者是设计，后者是缺陷（本批修复）。绕过前端直调行级端点同样受上述两闸约束。
- **查看态原因由服务端追加，编辑态由前端追加**：查看态前端**不追加**（`handleReasonSubmit` 的 `viewMode` 分支只调接口），服务端 `MTOService.AppendReason` 逐字镜像 `frontend/src/utils/mtoReason.ts`（连续换行折叠为**单个空格**、既有值 CRLF→LF + 去尾空行）。两侧漂移会让 `latestReason` 取到空条目 → 展示偏。判别性用例见 `MTOOrderDetailAvailabilityApiTests.Close_AppendsReason_WithFrontendSeparatorSemantics`。
- **原因弹窗在根层**（2026-10-26 提到根层）：此前嵌在 `v-else`（编辑态）分支内，查看态取不到。移动时**不得插在 `v-if="viewMode"` 与 `v-else` 之间**——中间夹兄弟节点会破坏 v-if/v-else 邻接，Vue 编译直接抛 `TypeError: Cannot read properties of undefined (reading 'type')`（症状离真因很远）。
- **停用行的权威闸在后端**：前端置灰只是表现层。`MTOService.UpdateAsync` 对「库内已停用 && 本次仍未启用」的行做字段不可变校验，命中即 400（文案带行号 + 物资编码）。绕过前端直调 `PUT /api/v1/mto-orders/{id}` 同样被拒。
- **守卫比对的是「有效值」不是原始载荷**，两处非显然：① `DemandDept` 字符串仅在旧行 `DemandDeptID` 为 null 时参与比对（前端对带 ID 的行恒发 `demandDept: undefined`，裸比会把每个带 ID 的停用行误判为改动）；② `stockQty` 载荷缺省时按明细 `id` 取旧行值兜底，缺省不算改动。文本字段一律 null ≡ 空串（`TextDiffers`）。
- **利库数量写入面**：`MTOOrderDetailDto.StockQty` 是**可空**的（区分「未提供」与「显式 0」）；Update 为「删旧建新」，不传该列时后端按 ID 兜底回填，否则整单保存会把已利库数量抹 0。需采购数量口径 `DemandQty − StockQty` 与 `MTOChangeService` 既有同式。
- **同大类候选端点**：`GET /api/v1/inventory/same-category-candidates?MaterialCodeID=<guid>`（落 `InventoryController`，非 MTO 控制器）。筛选 = `MaterialCode.L1Code` 相等 **但排除目标物资自身**（2026-10-23 二轮起；此前「含自身」的口径已翻转）**且可用量 > 0**（同日首轮起过滤掉可用量为 0 的行）；排序 = `lastInboundTime` 升序、空值靠后、`ID` 兜底（同日改键，不再按物资编码分组；前端不排序，直接用接口顺序）。`availableUsageQty` 是**服务端派生**（`UsageQty − LockedUsageQty`，辅单位口径），契约有意不回传 `lockedUsageQty` 以免前端重算；目标物资无 `L1Code`、或同 `L1Code` 下只剩目标物资自身 → 空列表（200）。出库侧 `OutboundInventoryLockHelper.AvailableQtyOf` 是**主单位**口径，勿混用。
- **「本次利库数量」上限**：`:max="可用数量(辅)"` 是声明式绑定，但 antd InputNumber 在键入期间不提交越界值，故「不得超过可用数量」实际由确认校验（每行 ≤ 可用、合计 > 0、合计 ≤ 需利库数量）兜住——探针据此按**结果**断言（超量不写回），不要按 input 的 HTML `max` 属性断言（antd 不落该属性）。
- **弹窗上下两半的取值方式**：两半都是 `a-table`，上半是**第一个** `.ant-table`（1 行表头 + 1 行明细），下半是**最后一个**。取值按 `thead th` / `tbody td` 同序下标配对，且**先剔空 th**（`scroll.x` / 固定列下 antd 会注入空占位格）；上一版曾用 `.ant-descriptions-item-*` 取上半（bordered 模式下 label/content 是**两个**单元格，按包装元素找会全空），改表格后该取法已作废。分节标题是 `.stock-substitute-section-title`（两处共用，`text-align: left`）。
- **本页明细表列集有两套**：`isDemandChange` 为真时走 `demandChangeColumns`（无操作列），故停用行操作闸在需求变更模式下不适用。
- **`a-select` 的空串值会吞掉占位提示**（2026-10-23 用户需求② 的根因）：抽屉回填若把空值写成 `''`，antd 把它当「已选中值」渲染一个空的 `.ant-select-selection-item`，`.ant-select-selection-placeholder` **根本不渲染**（`placeholderVisible=false`）——故 `goEdit` 回填统一用 `|| undefined`（`applyDeptID` / `demandDeptID` 同口径）。探针要断言占位提示，须取 `.ant-select-selection-placeholder` 的可见性，不能只看输入框是否为空。
- **操作列宽度 450**：6 个动作（编辑/利库匹配/利库代用/取消利库/行关闭/删除）在 `.action-buttons`（`flex-wrap:nowrap`）下需 450px——宽度不足会把末位按钮**裁掉而不是换行**，故探针同时断言「6 个动作文本齐全 + 首尾动作落在操作列内 + 行高 ≤ 45px」。

## Gotchas
- **固定列左边框断裂先查 `.result-area .ant-table-body` 的滚动条声明**：明细表（查看态/编辑态）共用的 `.result-area :deep(.ant-table-body)` 曾带 `scrollbar-width: thin`，致表体滚动条 10px ≠ antd 表头补偿 6px，固定操作列边界错位 4px（2026-10-24 已摘除，plan 2026-10-24-mto-action-column-border-align）；诊断口径 = 探针比对表头/表体 `fix-right-first` 单元格 getBoundingClientRect().x。
