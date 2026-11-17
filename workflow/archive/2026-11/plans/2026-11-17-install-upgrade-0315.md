---
状态: done
级别: L2
日期: 2026-11-17
模块: infra
确认指纹: 648917b1d26ff442
---
# PLAN — 装户升级面：基线三方合并 + manifest 迁移框架 + 漂移视图 + prune（0.3.15）

<!-- L2/L3 与 intents/ 或 incidents/ 下同名入口配对，且须先有 ../specs/ 同名 spec；L1 本文件即入口 -->
<!-- frontmatter 受限子集：状态∈draft/approved/done/superseded/cancelled；级别∈L1/L2/L3；正文不再写状态/级别行 -->
<!-- L1：一份 plan 收口来源/目标/红线/改动/验证/验收。L2/L3 仍走 intent + spec + 下面 4 节 -->

对应入口：../intents/2026-11-17-install-upgrade-0315.md（approved，A1..A7）
对应 spec：../specs/2026-11-17-install-upgrade-0315.md（approved，判据表 9 行 ↔ A1..A7）

## 改动方案

- `plugins/ai-native-delivery/scripts/install/baseline.mjs`（新）：基线读写/清无主/向上清空目录/mergeThreeWay（退出码三分 clean/conflict/unavailable；基线面不含钩子；BINARY_EXT 防御）
- `plugins/ai-native-delivery/scripts/install/migrations.mjs`（新）：单向迁移链框架（全链成功才写/失败零落盘/超前拒绝/只转 manifest）
- `plugins/ai-native-delivery/scripts/install/migrations/0-1.mjs`（新）：补 schemaVersion:1 的 normalize 迁移
- `plugins/ai-native-delivery/scripts/install/manifest.mjs`（改）：CURRENT_SCHEMA_VERSION=1；readManifest 容忍缺 schemaVersion；新建/领养构造即带 schemaVersion
- `plugins/ai-native-delivery/scripts/install/apply.mjs`（改）：conflict 分支插 merged 出口（非 mutable + 非钩子 + 基线在场；clean 基线写新种子正文）；create/update/merged-clean 后写基线；init 接迁移链
- `plugins/ai-native-delivery/scripts/init-engine.mjs`（改）：--prune/--dry-run 接线（钩子识别口径：basename ∈ 四钩子名单 ∪ hooksDir 前缀，宁保留不删）；报告加合并/prune 清单；gitignore 标记块加 `.agents/.install-baseline/` 条目
- `plugins/ai-native-delivery/scripts/install-drift.mjs`（新）：六类只读漂移分类（mutable 恒 unchanged；无台账单行提示恒 exit 0）
- `plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt`（改）：4 新脚本 indirect 登记 → test/install-upgrade.test.mjs（同 install/ 三件先例）
- `plugins/ai-native-delivery/test/install-upgrade.test.mjs`（新）：merge 三路径/mutable+钩子旁路/迁移三态+首装幂等/幂等字节/drift 六类+边界/prune 四态
- `plugins/ai-native-delivery/README.md`（改）：装户节补升级/合并/漂移/prune 口径
- 版本位八处（release.mjs 统一发）：0.3.15——明细见 spec 系统改动表末行（markets×2 + 插件清单×4 + 协议 SERVER_INFO + 根市场表）

> L2/L3：本节作总清单；任务拆解每步再写「- 文件：…」与判据，否则全景图只能把文件归到附录。
> build.md §2 确认的改动清单确认后回填本节落盘（对话留痕仅供当次）——改动面 + 任务勾选态 + git status = 会话重入三锚（session-context）。

## 任务拆解（L2/L3 必填；L1 仅多文件多步骤时用，单任务微改动删本节）

- [x] 1. 基线模块：baseline.mjs（读写/清无主/向上清空/mergeThreeWay 三分退出码）
   - 文件：plugins/ai-native-delivery/scripts/install/baseline.mjs
   - 判据：mergeThreeWay 对 clean/conflict/unavailable 三态各返回正确 status 与 text；BINARY_EXT 跳过；pruneBaselines 只删 keep 集外
   - 风险：低（纯新增模块，判据级移植 kit baseline.mjs）
   - 留痕：冒烟 17 断言 PASS（0→1 changed=true / 已 1 不重跑 / schemaVersion:2 拒 MANIFEST_SCHEMA / newManifest 首键 schemaVersion）；零写盘=模块无 fs 写调用
- [x] 2. 迁移框架：migrations.mjs + 0-1.mjs + manifest.mjs schemaVersion 面
   - 文件：plugins/ai-native-delivery/scripts/install/migrations.mjs、plugins/ai-native-delivery/scripts/install/migrations/0-1.mjs、plugins/ai-native-delivery/scripts/install/manifest.mjs
   - 判据：缺 schemaVersion 读作 0；0→1 迁移补字段；注入失败用例零写盘；超前版本拒绝；新建台账构造即带 schemaVersion:1
   - 风险：低（A4/A5 判据）
   - 留痕：install.test 56/0 + init.test 51/0 既有零改动全绿；冒烟 24 断言 PASS（merged 落盘/二跑不丢/二轮演进重合/conflict 降级/mutable+钩子旁路/首装带 schemaVersion 二跑字节不动）；主 Agent 裁决两判据：台账 merged 记种子侧哈希（防下轮 update 覆盖丢内容，kit 同款）、--force 后随写基线
- [x] 3. 裁决出口：apply.mjs merged 通道 + 基线落盘 + 迁移链接入
   - 文件：plugins/ai-native-delivery/scripts/install/apply.mjs
   - 判据：双改冲突且非 mutable/非钩子且基线在场 → merge：clean 落盘+台账 update+基线写新种子正文（A1）；conflict/unavailable → conflict-skip 语义与输出不变（A2）；mutable/钩子旁路逐字节不变（A3）；create/update/merged-clean 后基线落盘；--force 优先于合并
   - 风险：中（改动现有裁决主路径——既有 install.test.mjs 全绿为底线）
   - 留痕：冒烟 34 断言 PASS（prune 四态+钩子双口径+无主基线+dry-run 零删+不带 --prune 输出逐字节不变+gitignore 幂等）；init/install 既有 56+51 全绿；主 Agent 采纳：pruneBaselines 每次 --prune 真跑均清点本机无主基线
- [x] 4. CLI 面：init-engine --prune/--dry-run + gitignore 条目
   - 文件：plugins/ai-native-delivery/scripts/init-engine.mjs
   - 判据：--prune 哈希一致才删、mutable/改过/钩子保留并报告、--dry-run 只报告、不带 --prune 零删除（A6 prune 半）；gitignore 标记块含 .agents/.install-baseline/；报告新增「合并 N 项」与 prune 清单行
   - 风险：低（挂接既有 CLI 骨架）
   - 留痕：冒烟 24 断言 PASS（六类各≥1+mutable 恒 unchanged+钩子正常比+无台账单行 exit 0+全树快照零写盘）；主 Agent 采纳边界：种子有台账未记账键归 seed-updated 标注重跑落位
- [x] 5. 漂移视图：install-drift.mjs
   - 文件：plugins/ai-native-delivery/scripts/install-drift.mjs
   - 判据：六类分类正确；mutable 恒 unchanged；无台账单行提示恒 exit 0；零写盘（A6 drift 半）
   - 风险：低（只读新脚本）
   - 留痕：install-upgrade.test 79/0 首跑全绿（A1 14/A2 9/A3 8/A4 13/A5 6/A6a 15/A6b 14）；init 56 + install 56 既有零改动全绿；check-script-coverage 115 脚本直接 71/间接 41/缺失 0；exempt +4 indirect 行
- [x] 6. 测试与豁免登记：install-upgrade.test.mjs + exempt 四行
   - 文件：plugins/ai-native-delivery/test/install-upgrade.test.mjs、plugins/ai-native-delivery/config-templates/scripts-test-exempt.txt
   - 判据：spec 验收判据表 1–7 行对应用例全绿（A1..A6）；check-script-coverage 对账过（A7 半）
   - 风险：低
   - 留痕：node --test 三套 pass 3/0（init 56+install 56+upgrade 79）；verify --scope 13 门全绿（墙钟 7s/预算 15s）；自举真跑：update 通道传 exempt+4 行、双改无基线 2 项 conflict-skip 保留、台账 0.3.2 无版本→schemaVersion:1；三次跑台账字节逐字节一致（sha256 9ee6ab54…）
- [x] 7. 验证步骤：全量回归 + verify + 本仓自举走查
   - 文件：验证步骤：无代码文件
   - 判据：test/init.test.mjs + test/install.test.mjs + test/install-upgrade.test.mjs 全绿（A5）；verify.mjs --scope 全绿（A7）；本仓 init-engine --dry-run 报告合理后真跑，.agents/install-manifest.json 得 schemaVersion:1（spec 判据 9，人工）
   - 风险：中（自举真跑动本仓台账——先 dry-run、git 可回滚）
   - 留痕：README 装户节补六态/merged/迁移链/drift/prune 口径；release.mjs 发版 0.3.15 八处、--check 全市场一致（ai-native-delivery 8 处 0.3.15）；发版后 init 零变化（种子不含版本位）；verify --scope 复跑 13 门全绿
- [x] 8. 文档与发版：装户文档更新 + 版本位 0.3.15
   - 文件：plugins/ai-native-delivery/README.md
   - 判据：plugins/ai-native-delivery/README.md 装户节含合并/漂移/prune 口径；plugins/ai-native-delivery/plugin.json 等八处版本位 0.3.15（release.mjs 统一发）且 --check 一致
   - 风险：低
   - 留痕：

> 每步「文件」是开发全景图 步骤×文件 对齐的单源；实现步骤缺文件条目会被 `gen-dev-tour --strict` 拒绝，纯验证步骤请在标题写明「验证步骤」。
> 任务即勾选态（session-context）：完成一项立刻勾选并回填留痕；压缩 / 新会话续作先读本表勾选态 + git status 重建进度，禁凭记忆补勾。

## 执行顺序（L2/L3 必填；L1 单文件微改动删本节）

1 ∥ 2（相互独立的新模块）→ 3（依赖 1、2）→ 4 ∥ 5（依赖 3 的 apply 接口）→ 6（依赖 1–5 全部）→ 7（依赖 6）→ 8（收尾，依赖 7 全绿）

## 验证计划

- 静态门：`node --test plugins/ai-native-delivery/test/init.test.mjs plugins/ai-native-delivery/test/install.test.mjs plugins/ai-native-delivery/test/install-upgrade.test.mjs`；`node plugins/ai-native-delivery/scripts/check-scripts-syntax.mjs`（若入 verify 门则随 verify）
- 全量门：`node plugins/ai-native-delivery/scripts/verify.mjs --scope`（含 check-script-coverage exempt 四行生效）
- L2 追加：契约对账——幂等 mtime 快照用例（重复跑台账字节不动）；mutable/钩子旁路逐字节断言；本仓自举 --dry-run → 真跑走查（spec 判据 9，人工项）
- 无前端/UI 改动（前端与 UI 两行不适用）

## 确认与复核

> 确认 = 用户在对话内一句话通过；确认后本 plan 状态 draft → approved 并回填本节（确认环节的机器可见态），done 只在关单出现——禁从 draft 直跳 done（papercut）。
- 确认结果：（待用户确认 approved）；done（关单时随入口文档置终态）
- 确认门记录：plan 草稿全文过目 + 改动清单确认（build.md 两道门，本单改动方案节即 §2 改动清单，一次过目两门同判）
- 复核：spec 已过独立复核（两轮，落盘行见 spec）；plan 为 spec 的实现映射，L2 不再重复复核

> 开发全景：`node <插件根>/scripts/gen-dev-tour.mjs <本文件>`。步骤取「任务拆解/步骤」，文件取任务每步「- 文件：…」或「改动方案」，git 工作树补实际改动（口径 <插件根>/skills/dev-tour/SKILL.md；实时看板暂未随插件分发）。
