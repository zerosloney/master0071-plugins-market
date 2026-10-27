# 特性：采购订单数量/单价 6 位精度

> 特性地图种子。事实锚点为建档时点代码，漂移时先修地图再出结论。

## 到达路径
`#/purchase-orders` → 新建/编辑抽屉 → 明细行数量、单价输入框；表头另有汇率输入（同 6 位）。

## 驱动
明细行数量、单价各输入 6 位小数（如 `1.123456`）→ 保存 → 详情/列表回读。后端列精度权威在 `MaterialDbContext`（`PurchaseOrderDetail` 配置）。

## 可观察终态
- 数量 `OrderQty`/`DeliveredQty` 与单价 `UnitPrice` 均为 `DECIMAL(18,6)`；前端 `:precision="6"`（对齐后端，2026-10 由 3 位升 6 位）。
- 精度分层：**价类 6 位**（UnitPrice/LocalUnitPrice/TaxUnitPrice/LocalTaxUnitPrice），**额类 2 位**（Amount/TaxAmount/AmountWithTax/LocalTaxAmount/LocalAmountWithTax），税率 `DECIMAL(5,4)` 显示 `(rate*100).toFixed(2)%`。
- 金额展示走 `formatMoney`（zh-CN 千分位 2 位）；数量/单价列原样显示、不做 toFixed。
- 使用数量按物资离散性 `:precision="record.isDiscrete ? 0 : 4"`。

## Gotchas
- 单价 ≥0 守卫单源 `PurchaseOrderNumericGuards.EnsureUnitPrice`（Create/Update/导入三路同口径）；值类型字段禁依赖 `[Required]`（非空 decimal 恒有值，永不触发——2026-10-18 incident po-numeric-guard-missing）。
- 6 位小数输入后回读若只见 3 位 → 前端 precision 未跟上或 DTO 精度丢失，按缺陷记录，禁改断言迁就。
