# 特性：列表筛选区布局（SearchPanel 标准）

> 特性地图。事实锚点为建档时点代码（plan `workflow/plans/2026-10-26-filter-searchpanel-standard.md`，前作尺寸令牌 plan `workflow/plans/2026-10-26-filter-control-width-unify.md`），漂移时先修地图再出结论。

## 标准口径（2026-10-26 用户裁定：采购订单筛选条件 = 标准）

列表页筛选区标准 = 共享组件 `frontend/src/components/SearchPanel.vue` 的网格模型：

- 页面给 `style="--search-cols: 5"`（首行 5 主条件 + auto 列放按钮）、`form-name`、`:form-model`；默认 slot 放主条件、`#actions` 放查询/重置（组件 `grid-column: -2/-1` 钉首行行末）、`#more` 放附加条件（默认折叠，折叠条带「N 项条件已折叠」徽标，隐藏条件照常参与查询）。
- 页面侧配方（锚页面自有 `.search-panel-item`，勿锚子组件渲染的 `.search-panel-form`——scoped 属性不匹配会整段失效）：label 定宽 `var(--filter-label-w)`（80）+ `.ant-form-item-control { flex:1 1 0; width:0; min-width:0 }` + `.search-input { width:100%; min-width:0 }`（控件吃满列宽 = 列宽 − 80）。
- 尺寸令牌单源 = `frontend/src/style.css` `:root`：`--filter-control-w: 160px`（仅 inline 存量页用）、`--filter-range-w: 240px`、`--filter-label-w: 80px`。6 字 label 需 96，先改令牌再上字段。
- 新建/改造列表页一律按此标准；改 `SearchPanel` 组件契约属跨页共享面，动前须评估 4 个消费页。

## 到达路径

hash 路由，筛选区在列表页顶部卡片内：

| 页面 | 路由 | 模型 |
|---|---|---|
| 采购订单 | `#/purchase-orders` | `SearchPanel` 网格 5 列（首行 5 + `#more` 折叠 3） |
| 采购申请 | `#/purchase-requests`（先切「明细视图」） | `SearchPanel` 网格 5 列 |
| 到货管理 | `#/arrival-orders` | `SearchPanel` 网格 5 列（5 条件恰满首行，无折叠条） |
| 入库管理 | `#/inbound-orders` | `SearchPanel` 网格 5 列（首行 5 + `#more` 折叠来源类型） |
| 汇率设置 | `#/exchange-center` | inline flex（存量例外，未迁移） |
| 供应商管理 | `#/suppliers` | inline flex（存量例外，未迁移） |

## 可观察终态

- 4 张 SearchPanel 页：控件宽 = 列宽 − 80（1920 视口 237.2、1440 157.2、1366 126.4），label 恒 80，同页各控件左缘 x 一致，按钮组右缘贴卡片内容右缘（差 ≤1px）。
- 2 张 inline 存量页（汇率/供应商）：控件宽恒 160（日期区间 240），label 恒 80——仍引用 `--filter-control-w`/`--filter-range-w`，迁移前不得删令牌。
- 断点：1366 视口 placeholder 全不截断；1280 视口 SearchPanel 页控件 109.2px（低于 113 的 placeholder 下限，约 4px 截断）——已知边界，需更窄可用须先降列数。

## 驱动

探针（一次性，模板见 `scripts/verify/e2e/harness.mjs`）：登录注入 token → 逐页 `hardGoto` → 量 `.ant-form-item-label` 容器宽、控件宽、按钮右缘 vs 卡片内容右缘（扣 padding）、折叠条存在性与徽标、placeholder `scrollWidth > clientWidth`。1920 与 1366 双视口各跑一遍，采购申请需先点「明细视图」。前作探针：`tmp/e2e/verify-filter-unify.mjs`（尺寸令牌版）。

## Gotchas

- `.search-panel-form` 是子组件渲染、不带页面 scoped 的 data-v 属性——页面样式锚它会整段失效（label 定宽不生效 → 控件左缘参差），必须锚页面自有的 `.search-panel-item`。
- antd inline 表单项自带 `margin-inline-end: 16px`（仅 inline 存量页相关）；SearchPanel 页按钮贴右缘由组件 `margin-inline-end: 0 !important` 承担，页面不用再写。
- label 定宽在 inline 页须同时压 `width` + `flex` + `padding-right` 并带 `!important`（antd <576px 竖排）；SearchPanel 页由组件级 `flex-wrap: nowrap` + 页面配方承担。
- 采购两页的 `.search-input--mid` / `.search-input--range` 是**未定义的空类**（全仓无对应 CSS），附加行控件宽度实际由网格列决定，别以为它们有独立宽度。
- 入库「来源类型」绑独立 `sourceType` ref（不进 `query`，查询时分支改写 API 参数）——折叠进 `#more` 时 `activeFilterCount` 读该 ref，别按「query 键有值」口径统计。
- 令牌改动会同时影响多页，改完必须重跑双视口探针：只测 1920 会漏掉窄视口 placeholder 截断。
