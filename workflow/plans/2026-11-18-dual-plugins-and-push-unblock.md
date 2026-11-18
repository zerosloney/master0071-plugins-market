---
状态: approved
级别: L1
日期: 2026-11-18
模块: market
---
# PLAN — 双插件会话补档与推送解锁（deep-research-evolve 入库 + tech-code-refactoring 全原创重建 + check-scope-range 归档撞名修复）

<!-- 补档性质说明：本单为已完成工作的范围补档（工作先落、plan 后补解锁推送）——本仓推送门
     check-scope-range 只判越界方向（改了未声明=hard），声明先行/后补均可对账。会话内工作
     均经用户逐项决策（见「确认与复核」），本单如实收录声明面，不追改任何已归档 plan。 -->

## 改动方案

三段工作（均已提交为 aa9e3d2 / f4b4330 / 7824a1f 三笔）+ 一段待提交修复 + 三件追认：

1. **deep-research-evolve 0.1.0 入库**（11 件）：深度研究全流程纯 skills 插件——四技能（deep-research/evolve/visual-report/benchmark）+ research/ 档案约定闭环；会话内修正：版本 1.0.0→0.1.0 对齐仓库惯例、browser-use 工具名宿主中立化、evolve 定时 payload 双宿主写法。
2. **tech-code-refactoring 0.2.0 全原创重建**（30 件）：初版因 5/6 移植 skill 上游未声明许可整体移除（用户决策），按原思路全原创重写七技能六步重构工作流；code-analyzer 多语言 AST 分析（vendored tree-sitter 0.27.2 + 9 grammar wasm 共 13 文件随插件分发，NOTICE 三层许可：web-tree-sitter MIT / 聚合包 Unlicense / 8 grammar 上游 MIT 经 GitHub API 逐一实证）；分层降级（启发式兜底，--heuristic 可强制）；27 测试（启发式回归 15 + AST 12）。
3. **市场注册与门禁**（8 件）：三市场清单条目、release.mjs PLUGINS 扩至 7 插件、根 README 表行/目录树/四安装列表、ci.yml 双测试步骤；门禁修复：ai-native-delivery README 补 0.3.18 版本变更段（manifest-lint 既有红根除）、.gitignore 补 __pycache__/*.pyc。
4. **推送解锁修复（待提交，本单解锁）**：check-scope-range.mjs 归档回退 basename 匹配撞同名 intent 副本——ls-tree 字母序 intents/ 先于 plans/，撞取 intent 副本致声明归零、推送被误硬拦（本仓 HEAD 实证：4 份范围 plan 声明应 96 实收 41）；修复限定 plans/ 子树匹配 + 回归用例 ⑩（红灯先行验证）。
5. **追认（3 件，经用户确认纳入本单）**：0.3.15–0.3.18 发版提交的版本位文件——plugins/ai-native-delivery/.omp-plugin/plugin.json、plugins/ai-native-delivery/.zcode-plugin/plugin.json、plugins/ai-native-delivery/mcp/protocol.mjs（发版八处版本位同步的组成部分，当时各 plan 声明面未列）。

## 任务拆解

声明面（逐件，54 件 = 已提交 49 + 待提交修复 2 + 追认 3）：

- 市场与门禁（9）：.agents/plugins/marketplace.json、.github/workflows/ci.yml、.gitignore、.omp-plugin/marketplace.json、README.md、marketplace.json、scripts/release.mjs、plugins/ai-native-delivery/README.md、plugins/ai-native-delivery/scripts/check-scope-range.mjs
- 引擎修复测试（1）：plugins/ai-native-delivery/test/check-scope-range.test.mjs
- 追认版本位（3）：plugins/ai-native-delivery/.omp-plugin/plugin.json、plugins/ai-native-delivery/.zcode-plugin/plugin.json、plugins/ai-native-delivery/mcp/protocol.mjs
- deep-research-evolve（12）：plugins/deep-research-evolve/plugin.json、plugins/deep-research-evolve/.zcode-plugin/plugin.json、plugins/deep-research-evolve/.codex-plugin/plugin.json、plugins/deep-research-evolve/.omp-plugin/plugin.json、plugins/deep-research-evolve/README.md、plugins/deep-research-evolve/CONNECTORS.md、plugins/deep-research-evolve/skills/deep-research/SKILL.md、plugins/deep-research-evolve/skills/evolve/SKILL.md、plugins/deep-research-evolve/skills/visual-report/SKILL.md、plugins/deep-research-evolve/skills/visual-report/assets/report-skeleton.html、plugins/deep-research-evolve/skills/benchmark/SKILL.md
- tech-code-refactoring 清单与文档（6）：plugins/tech-code-refactoring/plugin.json、plugins/tech-code-refactoring/.zcode-plugin/plugin.json、plugins/tech-code-refactoring/.codex-plugin/plugin.json、plugins/tech-code-refactoring/.omp-plugin/plugin.json、plugins/tech-code-refactoring/README.md、plugins/tech-code-refactoring/NOTICE.md
- tech-code-refactoring 技能（7）：plugins/tech-code-refactoring/skills/code-analyzer/SKILL.md、plugins/tech-code-refactoring/skills/agent-git-oracle/SKILL.md、plugins/tech-code-refactoring/skills/uncle-bob/SKILL.md、plugins/tech-code-refactoring/skills/code-refactoring/SKILL.md、plugins/tech-code-refactoring/skills/system-architect/SKILL.md、plugins/tech-code-refactoring/skills/simplify/SKILL.md、plugins/tech-code-refactoring/skills/refactoring-workflow/SKILL.md
- tech-code-refactoring 脚本（3）：plugins/tech-code-refactoring/skills/code-analyzer/scripts/analyze.mjs、plugins/tech-code-refactoring/skills/code-analyzer/scripts/ast.mjs、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/web-tree-sitter.js
- tech-code-refactoring 测试（2）：plugins/tech-code-refactoring/test/analyze.test.mjs、plugins/tech-code-refactoring/test/ast.test.mjs
- vendored 资产（13）：plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/web-tree-sitter.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-javascript.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-typescript.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-tsx.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-python.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-java.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-go.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-rust.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-c.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/tree-sitter-cpp.wasm、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/LICENSE-web-tree-sitter、plugins/tech-code-refactoring/skills/code-analyzer/scripts/vendor/LICENSE-tree-sitter-wasms

## 验证计划

- 三门禁全绿：release.mjs --check（7 插件版本位）、manifest-lint（7 插件 × 4 清单、89 skill 名唯一）、manifest-lint.selftest（26/0）
- tech-code-refactoring 27 用例（analyze.test.mjs 15 回归 + ast.test.mjs 12 AST）
- check-scope-range.test.mjs 11 用例（含新增 ⑩ archived-plan-not-intent，红灯先行）+ check-scope.test.mjs 23 用例回归
- 推送前实跑 check-scope-range 58320b78..HEAD：越界方向应为 0（advisory 未落件不拦截）

## 确认与复核

- 2026-11-18 会话内用户逐项决策（交互留痕）：tech-code-refactoring 初版整体移除（许可不干净）→「整个插件移除」；重建路线→「分层/tree-sitter 全家桶/不用 python」；多语言 AST 路线→「tree-sitter 全家桶 不用 python」；遗留边角件追认→「新 plan 一并追认」。
- 许可面：本单新增第三方内容仅 vendored tree-sitter 运行时（NOTICE.md 三层声明，上游许可全部实证核对）；其余全原创。
