---
标题: 表格行路径样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 表格行路径样例：汇率双币落地

## 任务拆解
- [ ] 1. 批次 1 后端：实体与查询
  - 判据：构建通过
- [ ] 2. 批次 2 前端：页面列
  - 判据：构建通过

## 改动方案

### 批次 1：后端

| 文件 | 改动 |
|---|---|
| `backend/Catalog/TableProbe.cs` | 新实体 |
| `backend/Catalog/TableProbeDtos.cs` | 查询 DTO |

### 批次 2：前端

| 文件 | 改动 |
|---|---|
| `frontend/src/views/catalog/table-probe.vue` | 列表页 |
