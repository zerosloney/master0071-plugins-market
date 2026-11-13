---
标题: 任务拆解样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 任务拆解样例：工单字段微调

## 入口
目标：让工单新增备注字段且不改历史行。

## 背景
另有 `backend/Catalog/UntouchedService.cs` 遗留服务，本次不改动其行为。

## 任务拆解
- [ ] 1. T1 建立工单模型：新增实体与 DTO
  - 判据：字段齐全并通过编译
  - 留痕：实体迁移脚本执行记录
- [ ] 2. T2 工单服务编排：实现保存逻辑
  - 依赖：T1
  - 判据：单测覆盖保存主分支
- [x] 3. T3 页面接入：前端表单与提交
  - 依赖：T1、T2
  - 判据：页面提交工单成功
  - 依赖：4（联调批次）

## 改动方案
- **T1**：实体与 DTO
  - `backend/Catalog/WorkorderItem.cs`：工单明细实体
  - `backend/Catalog/WorkorderItemDto.cs`：传输对象
- **T2**：服务编排
  - `backend/Catalog/WorkorderService.cs`：保存编排
- **T3**：页面接入
  - `frontend/src/views/catalog/workorder-edit.vue`：表单提交
  - `frontend/src/api/catalog/workorder.ts`：接口封装

## 验证计划
- 手工：页面提交一条带备注的工单
