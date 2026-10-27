# 特性：物资编码申请列表与详情（AG Grid + 覆盖层）

> 特性地图种子（2026-10-25 整模块重构后形态）。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
`#/base-code-applies` → 列表（AG Grid）→ 物资编码链接 / 行 hover 浮层「查看详情」→ 页内覆盖层详情；工具栏「新增申请」→ 覆盖层新增；行浮层「编辑」→ 覆盖层编辑；行浮层「审批」→ 审批弹窗。

## 驱动
- 列表：`SearchPanel`（关键词 / 审批状态 / 申请人）+ AG Grid（27 列保持原列序、多选、行操作 hover 浮层、分页页脚钉底）；工具栏左组「新增申请」+ 审批状态计数，右组批量动作（提交/审批/取消/驳回/删除）。
- 详情：`baseCodeApply/detail.vue` 覆盖层，正文复用 `MaterialCodeDetailContent` 的 `layout="grid"`（PO 四列 info-grid + 分组标题）；共享抽屉仍用默认 descriptions。
- 新增/编辑：`baseCodeApply/form.vue` 覆盖层，复用 `MaterialCodeForm` + 编辑态「申请信息」；保存载荷与原 Drawer 逐字段一致（含 `rowVersion` 乐观锁）。
- 审批：弹窗（意见 + 通过/驳回），逻辑与原 Drawer 一致。
- 共享抽屉：`MaterialCodeDetailDrawer` 拆为 `MaterialCodeDetailContent` + 抽屉壳，7 个消费页 API 不变。

## 可观察终态
- 列表列序 = 定义顺序（物资编码 → 审批状态 → … → 申请时间），列头无 `...` 截断；行滚动收在 grid 内部，页面无外层滚动条。
- 详情/新增/编辑：无 `.ant-drawer-open`；详情 info-grid 20 字段齐全；编辑保存 PUT 200 且覆盖层关闭。
- 审批：弹窗标题「审批申请」+ 通过/驳回按钮。
- 物资编码管理页详情抽屉仍可打开（共享组件回归）。

## Gotchas
- `MaterialCodeForm` 的 `props.value` 只在挂载/引用变化时同步：编辑态必须**先回填 formData 再挂载表单**（`v-if="ready"`），否则表单空白、保存报必填。
- 行操作资格与后端同源：编辑/提交=草稿(1)/已驳回(4)且本人；审批=已提交(2)；取消=已提交且本人；删除=草稿/已驳回/已取消且本人。
- 批量按钮计数 = 选中行中符合状态条件的行数（非选中总数）；通过(3)复选框置灰，已取消(5)可勾选（批量删除可达）。
- 27 列宽表：行元素宽度 3800px，探针 hover 坐标须钳制在视口内（`Math.min(row.cx, 800)`），否则 `elementFromPoint` 落空。
- 实测探针：`tmp/e2e/base-code-apply-ui-refactor-check.mjs`（33 PASS / 0 FAIL）；AG Grid license banner 属已知噪声。
