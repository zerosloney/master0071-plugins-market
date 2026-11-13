---
标题: 编号步骤样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 编号步骤样例：工单计划跟踪

## 入口
目标：把工单计划页做成可跟踪的最小闭环。
对应入口：workflow/intents/2020-01-01-catalog-demo.md

## 背景
工单计划目前只有线下台账，页面与接口均缺失，需按仓库现有分层补齐。

## 步骤
1. **T1 后端接口**：新增工单计划查询与保存接口
2. **T2 应用服务**：工单计划的保存编排与旧服务下线
3. **T3 前端页面**：工单计划列表与表单
4. **T4 全链路验证**：接口到页面的回归

## 改动方案
- **T1**：后端接口
  - `backend/Catalog/WorkorderController.cs`：工单计划接口
- **T2**：应用服务
  - `backend/Catalog/WorkorderAppService.cs`：保存编排
  - `backend/Catalog/OldWorkorderService.cs`：旧服务删除
- **T3**：前端页面
  - `frontend/src/views/catalog/workorder-plan.vue`：列表页
  - `frontend/src/api/catalog/workorderPlan.ts`：接口封装

## 执行顺序
1 → 2 → 3 → 4
依赖：3 依赖 1~2；4 依赖全部；88 依赖 1

## 验证计划
- `tests/Catalog/WorkorderPlanTests.cs` 全绿
- 手工：页面提交一条工单计划
