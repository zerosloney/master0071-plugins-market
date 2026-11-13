# papercuts — 确认税与摩擦记录
- 2026-11-13 eval E3 首基线：无头代理走 L2 全档需 46+ 轮（门禁迭代环是正当消耗），轮次预算初始低估——已调 70 轮；另提示 new-task.md L2 节可考虑给出"fill-intent→fill-spec→confirm→fill-plan 单命令序列"降低无头代理探索成本（owner 复评）
- 2026-11-13 eval 断言口径教训：按"在途态"写断言会被做得太完整的 agent 打脸（agent 连 closeout 都跑完，文档归档后 live 目录空）——断言应按"生命周期终态"写（git 历史见证 + 引擎门禁作内容仲裁），已改
- 2026-11-13 eval transcript 原只存结果信封（max_turns 时为空）无法复盘——已修（stream-json 逐轮事件留档）；夹具仓清理偶发 EPERM（runner 子进程句柄延迟释放）已有 WARN 降级，无害待观察
- 2026-11-13 契约漂移：fill-plan --lite 产「验证与验收（lite）」节、closeout 验收计数器只认「## 验收标准」——lite plan 关单时验收计数恒 0/0 并报缺节。修法二选一：closeout 认 lite 别名节，或 lite 模板直接产「## 验收标准」（owner 复评后择一，暂以手工补节绕过）
- 2026-11-13 承诺面指纹归一口径有漏：关单前勾验收证据 + 补「## 验收标准」节（为过验收计数器，见上条漂移）双双触发承诺面指纹变化，走 --reconfirm 才能关单——gate 文案自认"仅勾验收/补证据不应触发"，节标题移位也进了承诺面归一，与②豁免口径矛盾（owner 复评后修归一）
- 2026-11-13 范围门缩写路径无早期反馈：plan 改动方案写「`.codex/.omp/.zcode` 三宿主 plugin.json」式缩写，extractDeclared 静默丢弃 → 推送范围门才拦（两天两次实证：eval-harness-fixes、pr-review-shims-scope）——已根修：check-scope.mjs 单源新增 suspiciousDeclarations，confirm-doc 确认/重确认双路径拦「形似路径但按判据会被丢弃」的反引号 token（0.3.6）
- 2026-11-13 承诺面漂移门再添一实例（并入上条同根线程）：approved 后把验收占位符「<逐条可测试…>」替换为真实判据（属「填验收」范畴）仍触发指纹漂移须 --reconfirm——与「勾验收/补证据不应触发」自认口径的矛盾同根（归一判据漏占位符行），owner 复评时合并处理
