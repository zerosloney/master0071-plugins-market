---
标题: 层词臂样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 层词臂样例：录入单列微调

## 背景
两个孤儿文件验证层词臂绑定行为（不在改动方案登记）：
- `frontend/src/views/catalog/orphan-page.vue`：孤儿前端页面
- `backend/Catalog/OrphanAlign.sql`：孤儿对齐脚本

## 任务拆解
- [ ] 1. T1 列表新列：前端列表加来源列
  - 判据：前端构建通过
- [ ] 2. T2 抽屉对齐：前端抽屉字段顺序调整
  - 判据：前端构建通过
- [ ] 3. T3 备注列落地：数据库补备注列
  - 判据：数据库脚本幂等

## 改动方案
- **T1**：列表
  - `frontend/src/views/catalog/entry-list.vue`：新列
- **T2**：抽屉
  - `frontend/src/views/catalog/entry-drawer.vue`：字段顺序
- **T3**：备注列
  - `backend/Catalog/EntryAlign.sql`：对齐脚本
