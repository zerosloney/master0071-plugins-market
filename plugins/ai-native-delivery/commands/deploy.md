---
description: Deploy 阶段:prod 上线清单(静态门 + 配对检查 + 回归 + DB + 授权 + 24h 观察；文档关单在 test)
stage: Deploy
triggers:
  - "跑下 release"
  - "可以上了"
  - "过一遍 release 清单"
  - "准备上线"
approval_required: true
next: commands/maintain.md(仅事故时)
---

# Deploy · 上线清单

L1 已在 `commands/new-task.md` §L1 快速道关单，不打开本文件。本文件从 L2/L3 上线起。

## 1. 静态门 (Static Gates)
**Process**:
1. **执行门禁**: `node <插件根>/scripts/verify.mjs`（全量，不上 `--scope`）
2. **要求**: 必须全绿 $\rightarrow$ 记录证据 $\rightarrow$ 继续。任一失败 $\rightarrow$ **HALT** $\rightarrow$ 回 `build.md`。
**Note**: 环境细节见 `.agents/notes/runtime-env.md` §1, §2

## 2. 文档闭环 (Documentation Audit)
**Process**:
1. **配对检查 (L2/L3)**: 验证 `intents/` (或 `incidents/`) $\leftrightarrow$ `specs/` $\leftrightarrow$ `plans/` 三件同名文档齐全
2. **状态核对**: 所有相关文档状态必须为 `done` (由 `test.md` 关单)
3. **修复类专项**: 验证 incident 满足 [结构性修复 / 防复发验证 / 规范条目] 三件套完整 $\text{AND}$ 状态为 `closed`
4. **系统性追踪**: 根因属门禁/规范缺位 $\rightarrow$ 确认已立新 intent 追踪
5. **裁定回填核对**: 上线前若有裁定回填改动过 done 文档 $\rightarrow$ 确认已同批补录重确认补偿行 (做法见 `maintain.md` §4.4) $\rightarrow$ 否则 pre-push 指纹硬门拦截
6. **发版收口自查**（收编原 check-loop §17 职责，2026-10-21 第 2 批下沉）: tag 前全量核对 `workflow/` 四目录无本批应关未关的在途件——凡发版提交树上已是 `draft`/`approved` 的 intent/spec/plan，tag 时仍停留 `draft`/`approved` 即收口未完成，先关单再上线
**Output**: 闭环审计通过证据

## 3. 回归与数据库 (Regression & DB)
**Process**:
1. **路径验证**: `workflow/regression-checklist.md` 涉及模块关键路径全过
2. **自动化验证**: 项目测试用例全过 (禁跳过失败用例)
3. **历史验证**: 历史同类 incident 的防复发验证条目逐条过
4. **DB 变更 (L3 专项)**:
   - 验证迁移 SQL $\leftrightarrow$ 实体映射一致
   - 记录 [备份点] + [回滚 SQL 路径]
   - **强制要求**: 回滚 SQL 必须在 dev 演练执行过 (未演练 $\rightarrow$ 视为无预案 $\rightarrow$ **HALT**)

## 4. 上线授权 (Authorization)
**Input**: 确认所有前置步骤 (1-3) 已完成
**Process**:
1. **用户授权**: 仅接受用户本人在对话内一句 "上" 或同义确认
2. **授权记录**: 打 `release/<日期>` tag + 记录 commit SHA
3. **发布执行**: 执行项目发布流水线 (若有，人工审批由本人在平台完成)
**Output**: `release/<日期>` tag 留痕

## 5. 上线后观察 (Observation)
**Process**:
1. **观察期**: 上线后 24h $\rightarrow$ 用户观察错误率 / 延迟 / 关键业务流
2. **闭环宣告**: 用户确认无异常 $\rightarrow$ 宣告 prod 闭环
3. **异常回落**: 超阈值 $\rightarrow$ 生成 `workflow/incidents/` $\rightarrow$ 进 `maintain.md` (止血方案用户拍板)
4. **观察落账 (2026-10-25 优化5)**: 步骤 2/3 出结论时追加一行进当月分片（一行 = 一次 release；结果枚举 `通过`/`异常`，异常行必须关联 incident，记法见 `workflow/deploy-observations.md` 头部）:
   `node <插件根>/scripts/ledger-shards.mjs --append deploy-observations --row "| <YYYY-MM-DD> | release/<日期> | 通过|异常 | <incident 文件名或 -> | <确认方式摘要> |"`
   月度聚合进 `metrics.md`「发布观察」表（`gen-workflow-metrics.mjs`）——闭环漏斗延伸到部署后，上线了却长期无行即挂债
**Note**: 事故响应禁跨智能体协作推送修复 (参考 Anthropic 教训)

## 🚫 禁止项
| 操作 | 后果 / 机器行为 | 例外 |
|---|---|---|
| 无演练回滚 | → 视为无预案 | 必须在 dev 验证回滚 SQL |
| 绕过 test 关单 | → 拦截上线 | 文档必须先在 test 阶段置 done |
| 委派回滚决策 | → 违反安全策略 | 数据回滚决策必须由主 Agent + 用户完成 |

## 🛠️ 辅助工具
- **版本回退**: 回退至上一 `release/<日期>` tag
- **数据回滚**: 执行记录的备份点 + 回滚 SQL
