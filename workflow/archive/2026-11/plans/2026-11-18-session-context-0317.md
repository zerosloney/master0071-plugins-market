---
状态: done
级别: L1
日期: 2026-11-18
模块: pipeline
确认指纹: d3efc05172013c4c
---
# PLAN — SessionStart 会话入口路由令（0.3.17）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：本 plan（L1 不再另立 intent）。修复类另保留 ../incidents/YYYY-MM-DD-<主题>.md
对应 spec：省略

## 入口

- 来源：用户对话指令「P0 剩余两项搞完」——底座移植 P0 批次第三项（收尾项）：SessionStart 会话入口路由令
- 目标：会话启动时注入 4 行指针（续作先读 session-resume / 新任务走 new-task 定级 / 规则正文单源声明 / 关闭方式），零写零 spawn 不读 transcript；`.agents/config/session-context.local.json` 只认显式 false 关闭；正中第二闭环「断崖恢复」入口痛点——read_context MCP 已在但要 agent 主动调，路由令让每次会话自动装载
- 检索：kb-search incidents「hook 注入」无命中；蓝本 agentic-flow-kit session-context.cjs（SessionStart 属 Context-only 事件、无决策面；plain stdout 注入为 system reminder）
- [ ] 规则 / 契约变更 → 级别至少 L2：**不勾**——纯新增注入腿（hooks.json 追加段 + 新脚本），既有面零变化
- [ ] schema / 迁移 SQL / DI 链 / 认证管线 → L3：**不勾**——无结构面

## 改动方案

- `plugins/ai-native-delivery/hooks/session-context.cjs`（新）：判据级移植蓝本 session-context.cjs——4 行中文指针单源指向**插件路径**（`<插件根>/skills/session-resume/SKILL.md`、`<插件根>/commands/new-task.md`，插件形态无 `.agents/commands/` 指针壳——指针文案按插件实际路径改写，禁照抄 kit 的 .agents/ 路径）；关闭开关 `.agents/config/session-context.local.json` 只认显式 false（缺文件/坏 JSON/其它值=开，坏配置不静默改变行为）；root 解析 payload.cwd || process.cwd() 向上找 `.agents/install-manifest.json`；恒 exit 0、零写零 spawn；zh 单语（插件 manifest 无 language 字段，kit 双语分支以头注说明差异后省略）
- `plugins/ai-native-delivery/hooks/hooks.json`（改）：追加 `SessionStart` 段——matcher 空串（全部启动来源 startup/resume/clear/compact/fork）→ `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-context.cjs"`，timeout 10
- `plugins/ai-native-delivery/.codex-plugin/plugin.json`（改）：gen-host-manifests 重渲染（机制同 0316 单）
- `plugins/ai-native-delivery/test/session-context.test.mjs`（新）：stdout 4 行指针内容断言（含插件路径锚）；关闭开关三态（显式 false 零输出/缺文件=开/坏 JSON=开）；非插件仓零输出 exit 0
- `plugins/ai-native-delivery/README.md`（改）：「宿主与 hook 降级」节补 SessionStart 口径（claude 式宿主注入、其余宿主降级零注入；关闭方式一句）
- 版本位八处 → 0.3.17（release.mjs；plugins/ai-native-delivery/plugin.json 等）

## 约束与风险

- 约束：只指路不复制规则（单源纪律 + 每会话 token 成本，禁把红线/分级表抄进注入面）；Context-only 无决策面，任何异常 exit 0 不阻塞会话启动；关闭文件用户所有——init 不播种、不进安装台账、升级不覆盖（省 plan.mjs 改动）；零运行时依赖 kit
- 风险：SessionStart matcher 空串语义按宿主文档（匹配全部来源）；codex/其余宿主对 SessionStart 支持未核实——不支持则宿主侧忽略条目，README 降级口径明文；注入文本含插件根路径（${CLAUDE_PLUGIN_ROOT} 运行时展开，文案用相对指法防绝对路径入注）

## 验证计划

- `node --test plugins/ai-native-delivery/test/session-context.test.mjs plugins/ai-native-delivery/test/hook.test.mjs plugins/ai-native-delivery/test/check-hook-wiring.test.mjs`
- `node plugins/ai-native-delivery/scripts/gen-host-manifests.mjs --check` + `check-script-coverage.mjs`
- `node plugins/ai-native-delivery/scripts/verify.mjs --scope` 全绿
- 真机走查（人工）：zcode 新会话启动注入 4 行指针可见、写入 session-context.local.json {"enabled":false} 后新会话零注入
- `node scripts/release.mjs ai-native-delivery 0.3.17 && node scripts/release.mjs --check`

## 验收标准（可测试）

- [x] B1 注入内容：4 行指针、指向插件实际路径（session-resume / new-task）、含关闭方式行（证据：test/session-context.test.mjs 全绿——4 行内容/插件路径锚/无绝对路径/零写/不读 transcript）
- [x] B2 关闭开关三态：显式 false → 零输出；缺文件 → 开；坏 JSON / 非 false 值 → 开（证据：同上用例三态全绿 + 本仓真机走查 false 零字节、删开关恢复 4 行）
- [x] B3 接线一致：hooks.json SessionStart 段 + codex 垫片重渲染后 gen-host-manifests --check 过、check-hook-wiring 过（证据：gen-host-manifests --check 三垫片一致 + check-hook-wiring 过）
- [x] B4 全量门：verify --scope 全绿 + coverage 过 + 0.3.17 八处版本位 --check 一致（证据：verify 13 门全绿；coverage 缺失 0；release --check 0.3.17 一致）
- [x] B5 真机走查：注入可见 + 关闭生效（证据：本仓实跑 startup 注入 4 行 exit 0；local.json false → 0 字节；删除后 resume 恢复 4 行——人工项已走查）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：（待用户确认 approved）；done（关单时回填）
- 确认门记录：L1 快速道单，plan 即入口；与 usage-collect-0316 两单一次过目、逐件确认
- 复核：L1 不要求独立复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。
