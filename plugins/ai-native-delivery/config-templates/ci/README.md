# ci/ — L-ci 项目适配模板（参考件，不随 init-engine 播种）

三层拦截模型的第三层。插件自带两层——PreToolUse 风险闸 / 写前门（Claude 式 hook 宿主）与
init-engine 装进 `.git/hooks/` 的四钩子（任何宿主，拦提交 / 推送）；本目录是**第三层 CI
拦合入面**的项目适配点：PR 合入前在服务端把同一套确定性门再跑一遍，本机 `--no-verify`
或宿主 hook 缺席都绕不过它。判据与 git hooks 同源（同一套 check-loop / verify 脚本），
CI 层不新增判据。

文件：

- `github-actions-verify.yml.template` — GitHub Actions 示例（无模型步 + 注释形态的可选诊断步）
- `github-actions-bands.yml.template` — check-bands 定时巡检示例（schedule cron 触发 → advisory 报告入 artifact）
- `github-actions-eval.yml.template` — 提示面 eval 套件手动触发示例（workflow_dispatch；真实调用模型，自备凭据）
- 本 README — 用法与授权边界

## 为何不默认接线

- init-engine 只落使用项目的运行时（`.agents/` 与 `workflow/`）；CI 是项目侧资产，插件无法
  预知项目用哪个 CI、插件在 runner 上以什么形态在场（托管 runner 上没有宿主安装缓存）；
- 可选诊断步涉及凭据与授权，属**项目自治**——插件不替项目决定要不要把无交互模型调用接进 CI；
- 所以模板只做参考件：随插件分发、复制后手改。`install/plan.mjs` 的 `configSeedFiles`
  排除清单把 `ci/` 挡在 `.agents/config/` 种子之外（先例同 githooks/、pipelines/），
  init-engine 不播种、安装台账不追平。

## 三步接入

1. 复制 `github-actions-verify.yml.template` 到使用项目 `.github/workflows/ai-native-delivery.yml`；
2. 按 workflow 内【改这里 1/4–3/4】注释改三处：`env.PLUGIN_ROOT`（插件根解析，市场仓随检出 /
   宿主常驻安装路径 / vendor 进仓，三方案任选）、action pin（建议按 commit SHA 固定）、
   市场仓检出步（选后两方案时删改）；
3. 首跑全绿后，再决定要不要解注释末尾的可选诊断步（自备凭据与授权，见下节）。

## 定时巡检（check-bands）

`github-actions-bands.yml.template` 是 check-bands 的独立定时巡检参考件——verify 模板管
PR / push 合入面的门禁车道，这份管**周期观测**：schedule（cron）定时对主仓跑
`check-bands.mjs --root .`，报告 `tee` 进 artifact（保留天数项目自调）。三步接入：

1. 复制模板到使用项目 `.github/workflows/ai-native-delivery-bands.yml`；
2. 按【改这里 1/3–3/3】改：cron 频率（示意值，项目自调）、`env.PLUGIN_ROOT`（与 verify
   模板同三方案）、市场仓检出步（选 vendor / 常驻安装方案时删改）；
3. `workflow_dispatch` 手动首跑验证，之后按 cron 自动巡检。

边界重申：越带只出**建议指令**，处置走人工或 owner 另行授权的 runner 面；退出码 1
（有越带）会让 job 红出来当信号——想只记录不红，模板里附了 `|| true` 的替代形态
（注释形态，默认不接线）。本模板不含任何自动执行 agent 的步骤（插件红线）。

## 提示面 eval 套件（手动触发）

`github-actions-eval.yml.template` 是提示面 eval 套件（`test/eval.mjs`）的独立手动
触发参考件——与 verify / bands 两模板的分工：那两份跑**确定性门**（零凭据零模型），
这份**真实调用模型**（`claude -p` 驱动夹具任务）：改命令 / skills / agents 正文后的
行为回归，判据只看终态工件（不用裁判模型，判据哲学与跑法见插件 README「提示面 eval
套件」节）。因为模型调用需凭据、每次触发都有 token 费用，只有 `workflow_dispatch`
手动触发，不挂 push / PR 自动车道（仓级 CI 零凭据纪律装不下它）。三步接入：

1. 复制模板到使用项目 `.github/workflows/ai-native-delivery-eval.yml`；
2. 按【改这里 1/4–4/4】改四处：`env.PLUGIN_ROOT`（与 verify 模板同三方案）、action
   pin、市场仓检出步（选 vendor / 常驻安装方案时删改）、模型凭据（解开 `ANTHROPIC_API_KEY`
   注释行，secrets 注入，模板不携带样例值）；
3. `workflow_dispatch` 手动触发验证：inputs.eval_id 填单条 id（如 E4）先跑一条，
   全绿后再跑全量四条。

边界重申：eval 在 runner 临时夹具仓里跑，不改主仓任何文件；transcript 落 runner 临时
目录、由模板收进 artifact 留复盘。runner 不在场时套件按 SKIP 出账不误报 FAIL，但
四条全 SKIP 等于没跑——先确认凭据与 claude 安装步都绿。

## 授权边界

- **无模型步**（check-loop `--all` + verify `--full`）：纯确定性脚本，零凭据零网络，任何项目可直接接；
- **可选诊断步**（`claude -p "…"` 无交互模型调用）：属项目自治——要不要接、用什么凭据、提示词
  与费用，全部由项目裁决；密钥一律经 CI secrets 注入，模板与插件都不携带密钥样例值；提示词按
  「只读诊断、不改文件」约束，结论仍走人工 / PR 处置；
- **确定性带监测旁路**（`check-bands`，advisory）：越带只出建议指令，绝不自动执行——见插件
  README「确定性带监测」节，workflow 内附注释形态的定时旁路样例，独立定时巡检模板另见
  `github-actions-bands.yml.template`（用法见上节）。

## 与四 git hooks 的分工

| 层 | 载体 | 拦截时点 | 绕过面 |
| --- | --- | --- | --- |
| L-hook | PreToolUse 风险闸 / 写前门（Claude 式 hook 宿主） | 工具调用前 | 宿主关闭插件 hook |
| L-git | `.git/hooks/` 四钩子（pre-commit / pre-push / commit-msg / post-commit advisory） | 提交 / 推送前 | `--no-verify`（deny 地板另拦该参数） |
| L-ci（本目录） | 项目侧 CI | PR 合入前（服务端） | 仅能改 CI 配置的人 |

CI 层兜的是前两层缺席或被绕过的面（`.omp` 宿主无 PreToolUse、贡献者本机没装钩子、
`--no-verify` 本机跳钩）；它不替代关单时的 verify——关单凭证仍以本地 verify 落账为准。
