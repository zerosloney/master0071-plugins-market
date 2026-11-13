---
标题: 裸中段路径样例
状态: 起草中
级别: L1
模块: 订单
日期: 2099-12-31
---
# PLAN — 裸中段路径样例：安装流程联动

## 任务拆解
1. **T1 安装流程联动**：改造 install/plan.mjs 计划栏，收敛 if/else 分支，Success/Error 提示对齐 install/apply.mjs
   - 判据：构建通过
2. **T2 清单常量调整**：抽共享常量到 install/manifest.mjs
   - 判据：单测通过
