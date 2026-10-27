# 特性：采购订单汇率本币预览重算

> 特性地图种子。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
`#/purchase-orders` → 新建/编辑抽屉 → 表头币种下拉 + 汇率输入框；明细行含本币金额预览列。

## 驱动
选外币币种 → 填表头汇率 → 改动币种或汇率（`@change`）→ `editForm.details.forEach(calcAmount)` 全行联动重算；填完明细数量/单价后看本币预览列随税率与汇率变化。

## 可观察终态
- 前端预览（`calcAmount`）：`localAmountWithTax = amountWithTax × rate`；CNY/空币种 rate 恒 1。
- 后端落库权威（`ExchangeRateResolver.ResolveAsync` + `CalculateDetailAmounts`，`MidpointRounding.AwayFromZero`）：本币 = 原币 × **保存时点**表头汇率（锁定——保存后改表头汇率不回刷已存明细）。

## Gotchas
- 外币无汇率或汇率 ≤0 → 后端保存抛异常（前端预览不拦）——负路径实测必选。
- 前端预览与后端落库间存在舍入路径差，断言以**保存后回读值**为准，预览值只作交互层信号。
- 行税率随表头：服务端覆写，客户端行值被忽略（2026-10-18 用户裁定）——勿把「行税率与表头不一致」当缺陷。
