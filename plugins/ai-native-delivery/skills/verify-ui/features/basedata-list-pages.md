# 特性：基础数据列表页（仓库 / 计量单位 / 采购员 / 基本编码定义）

> 特性地图种子。事实锚点为建档时点代码（commit `5e4c41bc`），漂移时先修地图再出结论。

## 到达路径

hash 路由四条：`#/warehouses`（左树 + 右详情卡 + 子节点表）、`#/measurement-units`（左分组列表 + 右表格）、`#/buyers`（同前）、`#/basic-code-defs`（`a-segmented` 切管理类别 / 技术组别 + 单表）。
四页进入即取数（分组列表 `onMounted` 拉取），无需点「查询」。

## 驱动

- `#/warehouses`：点左侧树任一节点 → 右侧详情卡出现（右上操作区：返回 / 新增子节点 / 编辑 / 禁用 / 删除）。
- `#/measurement-units`、`#/buyers`：点左侧分组项 → 右栏标题与表格出现。空态取样：逐个点分组，取第一个 0 行的分组（实测计量单位 #1、采购员 #2）。
- `#/basic-code-defs`：点 `a-segmented` 切「技术组别」→ 表格列集变化（管理类别多一列「描述」）。

## 可观察终态

- 左栏分组项两行：第一行 code + name，第二行 `.group-meta` —— 计量单位「基本单位：X」、采购员「组长：X」「分类：A、B」（2026-10-23 用户口径，commit `5e4c41bc`）；同一份数据仍挂在 `title` 提示上。
- 右栏 `.table-title` 只显示分组名，不带「 - 计量单位」/「 - 采购员」后缀。
- 空态：占位单元格无底边（`border-bottom-width: 0`，即无「悬在中间的横线」），空态插画与文案保留且在表体内容区内垂直居中；`.ant-table-body` 底边贴卡片内容底边（表格底边 = 页面底边）。
- `#/warehouses` 详情卡右上「编辑」「禁用」为浅边框白底按钮（`border: 1px solid var(--border-color)`），与同栏「新增子节点」（浅蓝渐变底）、「删除」（danger 边框）一样有可见边界。
- `#/basic-code-defs` `a-segmented` 左边缘与下方表格左边缘同 x（实测 93px）。
- 左栏搜索框统一为灰底胶囊（`#f3f4f6`、圆角 3px、高 32px、宽 220px）+ 左侧前缀放大镜图标，外盒右缘不超出卡片、左缘与面板标题文字对齐（2026-10-24 用户口径，commit `803029f3`）。
- 断言脚本：`scripts/verify/business/verify-basedata-four-modules-ui-tweaks-ui.mjs`（33 断言 = 既有 21 + 搜索框 12；四路由）。

## Gotchas

- 主面板搜索框统一用 `a-input` + `#prefix` 图标形态，**别用 `a-input-search`**：它的放大镜是右侧独立按钮，在 278px 面板里放不下（外盒必然溢出卡片 3px），且会把 `master-panel-search` 类挂到外层 group-wrapper 上（2026-10-24 用户口径，commit `803029f3`）。
- `master-panel-search` 类无论挂在外层容器还是直接挂在 `.ant-input-affix-wrapper` 自身，全局 `.master-panel-search` 规则都已按两种形态补齐（`frontend/src/style.css`，含 `width: auto` 与「32px 高只定在 wrapper」）——新增页面改这块前先跑 UI 门的搜索框判据。

- 全局 `.ant-card .ant-card-body { padding: 12px 12px 4px !important }`（`frontend/src/style.css:460`）会压过页面的 `:body-style`；两页列表要把表格底边贴到页面底，须同时去掉 `.table-wrapper` 的 16px 底距与卡片体的 4px 底距（写页面 scoped 覆盖，别改全局）。
- 空表消线**不要**走「撑高内层 table 让占位行分摊余量」：带 `scroll.x` 的表格 Chrome 不分摊（实测表 664 / 占位行 623），行底边仍悬空 41px。用绝对定位铺满（见两页 scoped 样式注释）。
- 左栏第二行靠 `.group-item { flex-wrap: wrap }` + `.group-meta { flex: 0 0 100% }` 换行；`.master-item` 的 `height: 32px` 须覆盖为 `auto`，否则第二行被压掉。
- `.card-toolbar` 的 16px 左内边距只对「表格容器同为 16px 内边距」的页面成立；表格直接落卡片体的页面（`#/basic-code-defs`）要归零，否则错位 16px。

## 形态跃迁（2026-10-24，plan `workflow/plans/2026-10-24-basedata-four-modules-overlay-detail`）

四模块新建/编辑/查看统一改**页面内覆盖层详情**（DetailPageHeader 面包屑 + 返回，不走路由，列表实例保持存活），原 a-drawer / a-modal 编辑容器下线：

- `#/basic-code-defs`：行内「详情/编辑」与工具栏「新增」开 `.basic-code-def-layer`；手写校验改 a-form rules（空保存出「请填写编码/请填写名称」）。
- `#/buyers`：组「新增采购组」/组项眼睛图标（详情）/铅笔图标（编辑）开 `.buyer-detail-layer`（kind=group）；采购员行新增「详情」链接 + 编辑（仅可用性可改）开同层（kind=buyer）；**组选中态已进 URL**（`?buyerGroupID=`，刷新/深链接恢复左侧选中 + 右栏标题）。
- `#/measurement-units`：分组/单位各三态开 `.measurement-unit-detail-layer`（kind=group|unit）；单位编辑清空取整方式 → PUT 带 `clearRoundingType:true`（三态清空语义不变）。
- `#/warehouses`：「新增仓库/新增子节点/编辑」开 `.warehouse-detail-layer`（create/edit）；库管员多选弹窗迁入 detail.vue；右栏详情卡 a-descriptions 改 `.info-grid` 只读栅格（label 106px 横排）；树导航/URL 回放不变。

实测锚：`tmp/e2e/run7.log`（38 PASS / 0 FAIL，提交载荷逐字段对账含 rowVersion/clearRoundingType/parentID；测试数据按响应 ID 精确清理），证据 `tmp/e2e-evidence/basedata-1~4-*.png`。
