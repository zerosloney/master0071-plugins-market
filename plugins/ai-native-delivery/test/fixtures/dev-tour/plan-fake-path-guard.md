---
标题: 伪路径防护样例
状态: 起草中
级别: L1
模块: 订单
日期: 2099-12-31
---
# PLAN — 伪路径防护样例：消解不伪造

## 任务拆解
1. **T1 生成器联动**：改造 `scripts/gen-dev-tour.mjs`，`scripts/install` 仅作目录锚提示
   - 判据：构建通过
2. **T2 未落库路径核对**：`Dtos/Inventory/SampleCheckRuleDtos.cs` 与 `tmp/perf/save-baseline.mjs` 均未落库
   - 判据：原样保留可见

## 改动方案
- **T1**：生成器
  - `scripts/gen-dev-tour.mjs`：联动
- **T2**：核对
  - `Dtos/Inventory/SampleCheckRuleDtos.cs`：未落库
  - `tmp/perf/save-baseline.mjs`：未落库
