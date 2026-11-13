---
标题: 并集标签样例
状态: 起草中
级别: L2
模块: 订单
日期: 2099-12-31
---
# PLAN — 并集标签样例：代用行重排

## 任务拆解
- [ ] 1. S1+S2：删除冗余分支
  - 判据：编译通过
- [ ] 2. S3：调整列序
  - 判据：构建通过
- [ ] 3. S4+S5 收口：回归清单与文档
  - 判据：收口完成

## 改动方案
- `backend/Catalog/UnionService.cs`
  - **S1**：删旧分支
  - **S2**：补新分支
- `backend/Catalog/UnionColumn.cs`（**S3**）：列序
- `skills/dev-tour/SKILL.md`（**S4**）：注解
- `skills/review-method/golden-set.md`（**S5**）：清单
