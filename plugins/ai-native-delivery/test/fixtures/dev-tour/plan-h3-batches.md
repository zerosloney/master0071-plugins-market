---
标题: 批次小标题样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 批次小标题样例：部件库整理

## 背景
部件实体与查询服务分两批落地，每批一个 h3 小标题。

## 改动方案
### 批次 1：领域模型整理
- `backend/Catalog/Part.cs`：部件实体
- `backend/Catalog/PartItem.cs`：部件明细实体

### 批次 2：查询服务
- `backend/Catalog/PartQueryService.cs`：查询编排
- `frontend/src/api/catalog/part.ts`：前端接口封装
