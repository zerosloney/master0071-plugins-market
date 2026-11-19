---
状态: done
级别: L1
日期: 2026-11-18
模块: market
确认指纹: 139a4ef990d1fb59
---
# PLAN — deep-research-evolve 定时任务兼容性与档案库根冲突修复（0.1.0 → 0.1.1）

<!-- 本单为已完成工作的补单（工作先落、plan 随提交补记）。本仓推送门 check-scope-range
     只判越界方向（改了未声明=hard），声明先行/后补均可对账。 -->

## 改动方案

两处缺陷 + 一处测试接线，均在 deep-research-evolve 插件内：

1. **evolve schedule 定时任务 payload 兼容性修复**（evolve 技能）：原技能用二值分支硬编码 `/evolve revisit <slug>` 与 `/deep-research-evolve:evolve revisit <slug>` 两种斜杠命令形态，宿主实际形态不止这两种（也有仅 `/<技能名>`、或只认自然语言描述的），猜错前缀会让定时任务静默空跑。改为三步：先观察宿主实际暴露的调用形态（技能清单 / 已注册命令 / 用户此前调用示例）而非猜；payload 优先写自然语言描述任务，跨宿主不需改前缀，确认走斜杠命令形态时再按观察结果补前缀；创建后回读任务校验周期与 payload，不一致就改写而非留着跑歪。
2. **档案库根与用户项目同名目录冲突修复**（四个技能同步）：原技能把 `research/` 写死为写入目标，用户项目里原有的同名目录（学术 `research/`、文档目录等）会被直接混入并覆盖，不可逆。新增「档案库根解析」——写入前做占用检查：目录不存在则用；存在且含本插件标记文件 `research-log.jsonl` 则为本插件档案库，正常使用；存在但不含标记文件则判定为用户项目原有目录，不得写入，改用 `research-evolve/`（同样做占用检查）；两条路径都不可用则停止并向用户确认。判定规则唯一定义在 evolve 技能，deep-research / benchmark / visual-report 三个写入方只引用不复制——规则复制即漂移。
3. **契约测试与 CI 接线**：本插件是纯提示词包，无运行时行为可断言，故按仓库既有惯例（同 agent-pipelines 插件的契约测试一路）做静态契约测试，守三条跨文件不漂移约束——解析规则唯一定义在 evolve、三个写入方技能只引用不复制、evolve schedule 不再硬编码斜杠命令；另加一条兜底断言，防未来新增技能提及 `research/` 路径却漏写档案库根门。
4. **版本位与文档同步**（7 处版本位 0.1.0 → 0.1.1 + 插件 README 版本变更段）：经版本位同步脚本执行（`node scripts/release.mjs deep-research-evolve 0.1.1`）；插件 README 补「## 版本变更 / ### 0.1.1」段（清单一致性检查强制版本变更段覆盖当前版本号）。

## 任务拆解

声明面（逐件，14 件 = 插件技能与文档 6 + 插件清单 4 + 市场与根文档 3 + CI 与测试 2，其中本 plan 自身在台账白名单内不计入）：

- deep-research-evolve 技能（4）：`plugins/deep-research-evolve/skills/evolve/SKILL.md`、`plugins/deep-research-evolve/skills/deep-research/SKILL.md`、`plugins/deep-research-evolve/skills/benchmark/SKILL.md`、`plugins/deep-research-evolve/skills/visual-report/SKILL.md`
- deep-research-evolve 文档（1）：`plugins/deep-research-evolve/README.md`
- deep-research-evolve 清单（4）：`plugins/deep-research-evolve/plugin.json`、`plugins/deep-research-evolve/.zcode-plugin/plugin.json`、`plugins/deep-research-evolve/.codex-plugin/plugin.json`、`plugins/deep-research-evolve/.omp-plugin/plugin.json`
- 市场与根文档（3）：`marketplace.json`、`.omp-plugin/marketplace.json`、`README.md`
- CI 与测试（2）：`.github/workflows/ci.yml`、`plugins/deep-research-evolve/test/contract.test.mjs`

## 验证计划

- 新增契约测试（见任务拆解「CI 与测试」项）：10 用例全绿（改前红灯 10/0 实证——能抓住旧写法）。
- 三门禁全绿：版本位一致性检查（7 插件，deep-research-evolve 七处一致于 0.1.1）、垫片与清单一致性检查（7 插件 × 4 清单、89 skill 名唯一）、门禁自身反证自测（26/0）。
- CI 引用对账：新测试文件已 `git add` 入库，按 git 索引判据核对工作流文件引用的每个 node 目标均存在且已入库（manifest-lint「CI 引用文件必须已入库」口径）。
- 回归：tech-code-refactoring 测试套件不受影响（analyze 15/0 + ast 12/0）。

## 验收标准（可测试）

- [x] 契约测试 10/10 全绿（证据：2026-11-20 复跑 `node test/contract.test.mjs` 于插件根 → tests 10 / pass 10 / fail 0；守「解析规则唯一定义在 evolve、三写入方只引用、schedule 不硬编码斜杠命令」三漂移约束 + 新增技能提及 research/ 漏档案库根门的兜底断言）
- [x] 版本位一致性：deep-research-evolve 7 处一致于 0.1.1（证据：2026-11-20 复跑 `node scripts/release.mjs --check` →「[deep-research-evolve] 7 处版本一致：0.1.1」，7 插件全绿）
- [x] 垫片与清单一致性（证据：2026-11-20 复跑 `node scripts/manifest-lint.mjs` → 7 插件 × 4 清单、89 skill 名唯一 ✓；含「CI 引用文件必须已入库」口径下 contract.test.mjs 已入库）
- [x] 邻插插件回归不受影响（证据：2026-11-20 复跑 tech-code-refactoring `node test/analyze.test.mjs` → 15/15、`node test/ast.test.mjs` → 12/12，零失败）

## 确认与复核

- 2026-11-18 会话内用户逐项决策：修复范围限定为「deep-research-evolve 的 schedule 命令兼容性和 research/ 目录冲突，并补相应测试」；提交动作明确要求「提交 补plan」。
- 修复落在提示词契约层、不新增脚本：插件对外定位为「纯 skills 无脚本无 MCP」，加 Node 脚本会推翻卖点且需连带改 4 份清单与 3 份市场描述；市场描述与 frontmatter 中保留的 `research/` 表述是默认路径的描述性说法（默认路径未变），故未改动。
- 已知边界：契约测试只能守住提示词文本契约，无法证明模型在实际会话中 100% 遵守；真正的兜底是规则本身的 fail-loud 设计（路径冲突时停下向用户确认而非静默写入）。
