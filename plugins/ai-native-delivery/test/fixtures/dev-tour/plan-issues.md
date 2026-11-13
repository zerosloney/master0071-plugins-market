---
标题: 解析失约样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 解析失约样例：部件标签微调

## 任务拆解

- [ ] 1. T1 标签服务调整：文案字段
  - 判据：编译通过
  - 依赖：9（未排批次）
- [ ] 2. T2 标签页面：字段展示

## 改动方案

- **T1**：标签服务
  - `backend/Catalog/LabelService.cs`：字段调整
- **T2**：标签页面
  - `frontend/src/views/catalog/label.vue`：字段展示
- **T9**：幽灵批次
  - `backend/Catalog/GhostBatch.cs`：未对齐锚点
