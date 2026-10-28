# 纠偏短名索引

> 用途：任务中途用短名纠偏，按指针去读权威原文。**本文件只放短名与指针，不复制规则正文**（正文单源在指针处）。
> 用法：`用「删除优先」再看一遍` / `这步按「证明它能跑」走`。
> 维护：只增删短名与指针；指针必须存在（`principles.test.mjs` 校验），单元格不得塞正文。
>
> **指针口径（2026-10-27 插件化迁移）**：本表的 `.agents/skills/<名>/SKILL.md` 指针指**宿主环境技能**——
>   部分随本插件分发（review-method / session-resume / verify-ui / show-me-your-work 等），
>   部分属**未随插件分发**的宿主技能（可能来自其他插件或用户自建，如 arena / swarm / eval / why /
>   reflect / interrogate / blast-radius / papercut-fix / number-vetting / create-verification-skill /
>   pause-safely）——后者未安装时**按本行短名的原则自行执行**（短名自带语义，指针只是权威正文入口）。
>   与命令面的 skill 引用闭包不同：本表是项目侧资产，指向的是宿主环境而非插件内资产。

| 短名 | 何时报它 | 权威指针（单源） |
|---|---|---|
| 删除优先 | 想加抽象、开关或兼容层时 | `AGENTS.md` §3 最小改动；`.agents/skills/review-method/SKILL.md` 坏味道走查 |
| 单源 | 同一事实要写第二处时 | `AGENTS.md` §3 单源纪律 |
| 守卫上下文 | 准备把长输出贴回主线时 | `AGENTS.md` §3 上下文纪律 |
| 证明它能跑 | 准备说「完成」时 | `<插件根>/commands/test.md` §1 静态门、§3 UI 实测 |
| 解释这个数 | 要引用测量值或性能结论时 | `.agents/skills/number-vetting/SKILL.md` |
| 修根因 | 症状反复或准备加守卫时 | `<插件根>/commands/maintain.md` §2 结构性修复 |
| 攻击前提 | 同一前提下两种修法都过不了同一道验证时 | `<插件根>/commands/maintain.md` §2 攻击前提 |
| 先对齐再动手 | 接手、切 worktree、中断续作时 | `.agents/skills/session-resume/SKILL.md` |
| 可验证单元 | 拆任务、拆提交时 | `<插件根>/commands/build.md` §3 任务清单与自验 |
| 规则要执法 | 新增规则或回归条目时 | `workflow/regression-checklist.md` 规则 7 规则-执法者配对 |
| 先升层再写文 | 想靠「写一句规范」防复发时 | `.agents/skills/papercut-fix/SKILL.md` §0 落点阶梯 |
| 不弱化旅程 | UI 实测前置条件缺失时 | `.agents/skills/verify-ui/SKILL.md` Never weaken the journey |
| 边界收口 | 校验、异常、解析要散落到各处时 | `backend/AGENTS.md` §2 AC-1 / AC-4；`frontend/AGENTS.md` §2 后端契约 |
| 兄弟路径同口径 | 改一处业务动作（单条/批量、正反操作）时 | `backend/AGENTS.md` §1 DI-2 |
| 可实验先跑 | 准备向用户提问前 | `<插件根>/commands/new-task.md` §1 提问分型 |
| 模型按角色 | 委派实现或复核前 | `.agents/config/model-roles.json`；`<插件根>/commands/review.md` §执行流程 |
| 爆炸半径 | 小改动但不确定还会碰坏什么时 | `.agents/skills/blast-radius/SKILL.md` |
| 决策留痕 | 长跑/无人值守要留可复核轨迹时 | `.agents/skills/show-me-your-work/SKILL.md` |
| 先问为什么 | 动手改一段不理解的代码前 | `.agents/skills/why/SKILL.md` |
| 多镜拆解 | 复核要覆盖多个风险面时 | `.agents/skills/interrogate/SKILL.md` |
| 先建地图 | 新页面/新主链要进验证面时 | `.agents/skills/create-verification-skill/SKILL.md` |
| 复盘落层 | 长任务落地后要固化配方时 | `.agents/skills/reflect/SKILL.md` |
| 盲评改动 | 技能/提示词改动要证据时 | `.agents/skills/eval/SKILL.md` |
| 暂停留痕 | 长跑中断/离开前要可续时 | `.agents/skills/pause-safely/SKILL.md` |
| 并行编排 | 设计选型或多切片覆盖时 | `.agents/skills/arena/SKILL.md`；`.agents/skills/swarm/SKILL.md` |
