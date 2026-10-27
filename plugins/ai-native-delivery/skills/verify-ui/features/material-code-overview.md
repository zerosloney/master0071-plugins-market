# 特性：/material-code-overview

> gen-verify-feature.mjs 骨架 + 2026-10-27 实测回填（plan 2026-10-27-material-code-overview-page：物资编码统计看板独立成概览页）。

## 到达路径

hash 路由 `#/material-code-overview`。入口：物资编码列表页（`#/material-codes`）表格工具栏「数据概览」按钮（`router.push({ name: 'MaterialCodeOverview' })`，index.vue `goOverview`）。侧栏菜单无直接入口（按 plan 口径入口收在列表页工具栏）。

## 驱动

只读页（无写操作）：到达后页面自动取数渲染；「返回列表」按钮回 `#/material-codes`；浏览器窗口缩放触发 echarts resize。

## 可观察终态

- 页头标题「物资编码概览」+「返回列表」按钮（overview.vue `.overview-header`）；
- 6 张指标卡（编码总数/有效编码/待审编码/失效编码/本月新增/有效率），数据源 `GET /api/v1/statistics/summary`（api/statistics.ts `getStatisticsSummary`）；
- 3 个 echarts 图表：状态分布（饼）+ 月度趋势（线，span 16）一行、分类分布（柱，整行）第二行，图高 300px；
- keep-alive 回页重取（onActivated → loadStats），指标不陈旧。

## Gotchas

- 页面被 keep-alive 缓存（component name `MaterialCodeOverview`），onMounted 只走一次；验证陈旧性问题要看 onActivated 分支。
- 列表页 `/material-codes` 为「进入不取数」页：直接深链接到达时表格为空态属预期，点「查询」后才出数（useListQueryGate）。
- echarts 打包进 overview chunk（~1.1MB minified），首次进入该页有一次 chunk 加载延迟，断言 canvas 前等待 ≥2.5s。
