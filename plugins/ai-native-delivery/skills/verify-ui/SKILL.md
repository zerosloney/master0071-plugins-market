---
name: verify-ui
description: 启动本地服务并用浏览器实测 UI 改动（只读验证、不留脏数据）。用于在缺乏自动化测试基建时进行功能兜底验证。
---

# verify-ui — UI 实测引导

## 目标
通过浏览器手动/半自动操作，验证 UI 改动符合预期，并提供可审计的证据。

**分工（2026-10-21 第 2 批明确，不合并）**：本文件只载**方法**（怎么做实测——环境/选点/证据/清理）；执行**契约**（环境安全/禁自修/HALT 礼仪/交付物形态）单源在 `agents/ui-verifier.md`——委派子代理时以契约为准，主智能体自测时按本文件执行。

## 触发条件
- 用户要求：`实测` / `UI 验证` / `浏览器验证`。

## 工作流

### 1. 环境准备
- **服务启动**：参考 `.agents/notes/runtime-env.md` 启动必要服务。记录所有启动进程。
- **多 worktree 并行**：设环境变量 `ENGINE_SLOT`（2026-10-27 插件化迁移脱敏更名，机制不变；缺省 0 = 主仓端口）使 API / 前端 / CDP 三组端口整体偏移，避免与另一棵 worktree 抢端口；端口表、每棵 worktree 执行序与残留风险见 `.agents/notes/runtime-env.md` §6.1b（端口字面量单一权威 `scripts/verify/e2e/ports.mjs`）。
- **浏览器配置**：使用较新版本的 Chromium 内核 headless 模式（如 Edge `--headless=new`）。
- **鉴权注入**：通过 API 获取 token $\rightarrow$ 注入 localStorage $\rightarrow$ **执行整页重载** (Page.reload)。

### 2. 执行验证
- **路径覆盖**：选点优先取特性地图（`features/`，见「特性地图」节）；至少执行一条「正常路径」和一条「失败/边界路径」(校验/空态/权限)。
- **导航处理**：Hash 模式用 `goto`；深链接 (Query 变化) 用 `hardGoto` (about:blank 中转)。
- **证据采集**：截图、网络报文或控制台日志。将路径记录在任务文档的「验收标准」项后。

### 3. 清理收尾
- **数据回滚**：按 POST 响应返回的 ID 精确删除临时数据。禁止模糊匹配删除。
- **进程关闭**：关闭所有在 §1 中记录的进程。
- **结果汇报**：按 `页面 / 步骤 / 期望 vs 实际 / 证据` 格式汇报；末行附「**特性地图覆盖 M/N**」（M=本次实测覆盖的地图特性数、N=`features/` 条目总数，未覆盖项逐一留名）。仅记录缺陷，不直接修代码。

## 特性地图（features/）

`features/` 每核心特性一文件，用户 POV 四段：**到达路径**（怎么到这页）/ **驱动**（怎么操作它）/ **可观察终态**（什么现象证明它工作）/ **Gotchas**（坑与前置）。地图是被维护的验证源——一个只驱动顺手入口的证明，当地图还列着其他入口时，是不完整的。

- **选点**：实测与关单抽验按地图取覆盖面；当前覆盖面以 `features/` 目录为准（种子五件核心特性：采购主链 / 状态色板 / 数量单价精度 / 汇率本币预览 / 出库驳回库存归还），随功能演进增删。
- **新增特性**：新页面或新主链上线时同步建文件，四段缺一不建。入口来源以 `frontend/src/router/index.ts` 的路由为源波次——路由有、地图无 = 待补；地图有、路由无 = 待删或改写（不保留失效特性）。
- **覆盖缺口 / 骨架生成**（本技能自带脚本）：`node skills/verify-ui/scripts/gen-verify-feature.mjs --check`（或 `--json`）列未覆盖路由，`--route <path>` 只写四段 H2 + TODO 骨架（不编造驱动步骤）。完整访谈流程（surface/run/drive/observe/isolate）按技能自身四段方法执行（如宿主装有提供该访谈技能的插件可配合使用）。
- **月度漂移维护**（无新门禁，随关单触发）：① 取路由/组件近月 diff 作源波次；② 只对触及的特性跑一次实测；③ 修正最多一笔提交；④ 每个失败先判「地图漂移」还是「代码缺陷」——前者改地图，后者进 incident，不混写。
- **机器漂移检查**（2026-10-22）：`check-regression-consistency.mjs` 在 check-loop §27（hygiene）与 `confirm-doc` 关单前置运行——地图引用的 `#/路由` / `frontend/src/*` / `workflow/*.md` / `scripts/verify/*.mjs` 悬空即红；代码符号悬空只 advisory（可能是生成物/外部库）。机器只查**引用存在性**；「驱动步骤还能不能走通」仍需实测，机器不假装能证明行为。
- **Never weaken the journey**：前置条件缺失时按失败记录并把原因写进该特性 Gotchas，禁为了让用例通过而弱化验证路径。
- **地图漂移**：应用一变地图就开始烂——发现页面/行为与地图不符时，先修地图再出结论（地图是验证的源，不是验证的果）。

## 技术要求与约束

### 技术细节单源 = harness（勿在本文件复制）
`scripts/verify/e2e/harness.mjs` 是 UI 实测技术细节的**单一真相源**——写脚本时 import 其导出，勿手写等价逻辑（完整清单：`grep '^export' scripts/verify/e2e/harness.mjs`）。覆盖：会话/导航、交互（Vue 原生 setter、去空白点击、Escape 关弹层）、断言取数（覆盖层可见且末位、虚拟滚动**以接口响应为准禁数 DOM**、请求计数**已排除 OPTIONS 预检**）、网络/控制台/toast 采集、断言汇总与证据落盘、直连 SQL。

### 仅剩的纪律（harness 无法代劳）
- **协议**：优先 HTTP 避免自签证书拦截。
- **缓存**：若出现「部分改动生效」，必须重启 dev server。
- **进程管理**：长命服务必须以独立进程启动（如 PowerShell `Start-Process`）。
- **Shell 禁令**：禁止在启动服务的 shell 命令末尾接管道（如 `| tail`），否则子进程继承 stdout 句柄导致命令永不返回。
- **CDP 采集时机**：每次导航前重置 Console/Log 采集器；toast 观察器必须在导航动作**前**安装。
- **实测脚本三件套（缺一不可）**：`installNetCapture(ctx)`、`seedSession(token, { reload: true })`、`hardGoto(url)`。缺 `installNetCapture` 时 `hardGoto` 因 `ctx.netState` 未初始化而抛错；`reload: false` 下仅哈希变化不重载文档，Pinia 仍持有注入前的空 token，实测会被踢回 `/login`。验证锚：2026-10-23 汇率设置主从实测（连续 4 轮脚本返工后收口）。
- **本人门/权限门页面以「真身」播种会话（2026-10-23 追加；2026-10-26 缺省身份改为真身）**：`seedSession(ctx, token)` 已改为从所播 token 的 JWT claims 解出**真实登录身份**写入 `auth_user`（不再写死 Admin——Admin 账号已不在 Auth_User，且 Admin 身份下「当前用户 vs 记录创建人」判可操作性的页面（如 `/mto-changes` 行内「编辑」走 `canEdit = status===1 && isCreator`）所有入口恒置灰，脚本会误判成「没有可编辑行」而看不出真因）。仅当需要**与 token 账号不同**的身份（如双账号测创建人/他人门）才手工播种：取 `POST /api/v1/auth/login` 响应里的 `jobNo`/`displayName`/`dept`，`localStorage.setItem('auth_user', …)` 后 reload；账号池里哪些账号真能过门，记进对应 `features/<特性>.md` 的「到达路径」。验证锚：2026-10-23 需求变更编辑抽屉实测（连续 3 轮「编辑入口: none」）。
- **表格选择态**：清空遗留勾选按 `data-row-key` 去重逐行点击，且与后续勾选**分两拍**执行（同一 tick 内行勾选处理器读到的是重渲染前的旧 `selectedRowKeys`，连点会把已清行又选回）；表头全选框在半选/无选态下点击是「全选」而非「清空」（antd 循环：无→全、全→无、部分→全）。验证锚：verify-po-field-alignment-ui A10（2026-10-22 连续 4 轮返工后收口）。
- **汇总行必须能区分「跑完」与「中途异常」（2026-10-23 追加）**：把断言汇总写在 `finally` 里、只按 `pass == results.length` 判 GREEN 的脚本，在断言途中抛异常时会「跑一半 + 打印 GREEN + 退出码 0」——**假绿**。写法：主体包 `try/catch`，`catch` 里追加一条失败断言（含错误信息）并落进报告，退出码随之为 1。实测锚：`scripts/verify/business/verify-pml-pbs-relation-host-ui.mjs` 首版（脚本内 `dbQuery` 因缺技能脚本抛错，只跑到第 3 条断言却报 3/3 GREEN）。
- **脚本内直连库前先确认 `dbQuery` 可用**：`harness.dbQuery` 依赖本机 `~/.agents/skills/database-explorer/scripts/db_tool.py`，未安装该技能时直接抛 python 报错。不连库也能立的判据优先（如「两条读路径顺序一致」）；必须连库核对的基准值，改为取到人工证据里留痕，别让门禁依赖未装工具。
- **覆盖层/抽屉内探针交互三坑（2026-10-24 基础数据四模块实测，连续 3 轮返工后收口）**：① antd 对两字中文按钮插空格（「保 存」「返 回」），`innerText.trim()` 精确匹配必落空——比较前先 `.replace(/\s+/g,'')` 归一；② 输入赋值按 placeholder 找元素须**限定在目标容器内**（`layer.querySelectorAll('input')`），全局 `querySelectorAll` 会命中覆盖层底下的列表/树搜索框（如仓库页「搜索仓库名称/编码」包含「仓库名称」，表单赋值静默落空 → 必填校验拦保存，POST 计数为 0 的假象）；③ `a-select` 的 `.ant-select-clear` 图标**悬停才渲染**，直接 click 查不到节点——先对 select 派发 mouseenter/mouseover、等一拍再点。验证锚：`tmp/e2e/verify-basedata-overlay-ui.mjs`（run5 三类断言全红 → run7 38/38 绿）。
- **写断言前先探真实 DOM 形状，勿从 CSS 源码反推（2026-10-23 追加）**：皮肤/控件规则常写成**后代选择器**（`.foo .ant-input-affix-wrapper`），而 antd 会把组件传入的 `class` 与内部结构类打在**同一元素**上（`<a-input class="foo">` 带 `#prefix` 时渲染为 `<span class="ant-input-affix-wrapper foo">`），后代组合子因此**永不命中**——照 CSS 源码读出来的「期望几何」是假的。写法：先跑一次性探针（打印目标元素 `outerHTML` + `getComputedStyle`）再定断言；拿不准时改用与规范数值解耦的不变量（如「两页容器几何逐项相等」），把规范对账降为 NOTE，避免把错误几何固化成期望值。验证锚：`scripts/verify/e2e/warehouse-tree-search-align-check.mjs` 首版按 CSS 断言「容器 32px / 3px / 灰底 / 无边框」，实测两页（含未报障的对照页）全是 antd 默认 42px / 6px / 白底 / `#D9D9D9` 边框，8 条断言全红、整轮返工（incident 2026-10-23-warehouse-tree-search-box-align）。
- **覆盖层/弹层页驱动表单控件须把查询限定到覆盖层根（2026-10-24 追加）**：列表页开覆盖层后，搜索栏与覆盖层表单存在同名 label/占位（如 `/pml` 的「项目号」「托盘号」），`.querySelector('.ant-form-item')` / `setInput` 全局找会命中**被覆盖层挡住的搜索栏控件**——真实鼠标点击落空、选择/填值全不生效且不报错（下拉都打不开，不是选项点不中）。写法：表单定位一律加覆盖层根类前缀（如 `.pml-detail .ant-form-item`）再找 label/控件；验证锚：PML 覆盖层跃迁实测（连续 2 轮 C5-C8 全红后收口，探针 `tmp/e2e/verify-pml-detail-layer.mjs`）。
- **无 API 时用合成 JWT 播种会话，`exp` 必须取近未来（2026-10-26 追加）**：纯布局/文案改动不需要后端，可免登录 API——自造 `header.payload.sig` 注入 `localStorage.auth_token`（store 的 `readAuthValue` 走 localStorage 兜底路径），payload 带 `exp` 即过 `hasValidSession`。**坑**：`exp` 写到远端（如 2100 年）会经 `store.armExpiry()` 的 `setTimeout(remain)` 按 int32 溢出而**立即**触发 `expireSession()` → 清空 localStorage 并弹回 `/login`；症状是「token 明明注入了却每次跳登录页、localStorage 事后为空」，极易误判成鉴权/代理/跨域问题。写法：`exp = Math.floor(Date.now()/1000) + 1800`。配套两点：① 注入后经 `about:blank` 中转再硬导航（hash 同文档切换不重载文档，Pinia 仍持注入前的空态，路由守卫照样弹登录）；② 先断掉应用自身噪声（AG Grid 试用 license 过期 banner、API 未起时的 `Network Error`）再断言「控制台零错误」。验证锚：2026-10-26 MTO/PML 工具栏靠左实测（探针 `tmp/e2e-20261026-toolbar-left-align/probe.mjs`，5 轮定位后 8/8 绿）。
- **AG Grid 列表页量宽与截断判定（2026-10-26 追加）**：单元格开销是 **32px**（`.ag-cell` 的 `padding 15px×2` + 边框 2，实测），**不是** 16 / 24——按「内容宽 + 24」定宽会让正常长度也截断（实证：项目号 80px 时内容盒仅 48 < 所需 54，10/10 行截断，白跑一轮）。写法：① 量宽用**隐藏 DOM span**（复制 `font` / `letter-spacing`）而不是 canvas；② 定宽 `ceil10(max(列头需求, 内容 p90 需求) + 32 + 8)`，离群值交给 `tooltipShowMode:'whenTruncated'`；③ 判截断**直接比 `.ag-cell` 的 `scrollWidth > clientWidth`**（`ag-cell-value` 与 `ag-cell` 是同一元素，不要去找内层子节点）；④ 量横向溢出用 `.ag-center-cols-viewport`——量 `.ag-body-viewport` 会因 ag-grid 收走 `overflow-x` 而恒得「无溢出」的**假绿**；⑤ 视口外的列（列虚拟化）不在 DOM 里，`.ag-header-cell` 计数 ≠ 列总数。验证锚：`scripts/verify/business/verify-mtochange-list-batch-search-columns-ui.mjs` F 段（DOM 实测 p90 宽表 + 逐列数据集级截断率）。
- **探针脚本两坑（2026-10-26 追加）**：① `ctx.evaluate` 返回的已是**对象**（内部做过 JSON.parse），再套一层 `JSON.parse` 必抛 `"[object Object]" is not valid JSON`；② 探针主体须 `try { … } finally { await ctx.close?.() }`——断言中途抛异常会残留 headless 浏览器占住 CDP 端口，下一轮 `launch` 直接 fail-fast 报「端口已被占用（疑似上一轮残留）」，症状与代码无关极易误判。验证锚：同上一行的探针（首轮崩在断言中途，第二轮起 CDP 9353 被占）。
- **分段/单选控件点击按渲染形态定位，勿只找 `<button>`（2026-10-27 追加）**：`a-radio-button` / `a-segmented` / tabs 渲染为 label/div 而非 button 元素，`querySelectorAll('button')` 按文本找必落空且不报错——按组件渲染类找（如 `.ant-radio-button-wrapper`）。验证锚：六模块样式整改 PR「明细视图」切换实测（首轮静默未点中，整页探针全空）。
- **antd 固定表头表格 tbody 首行是量测行（2026-10-27 追加）**：`:scroll={y}` 下 antd 渲染 `.ant-table-measure-row`——高 0、td 无 `ant-table-cell` 类、white-space normal，且排首位；行高/单元格计算值探针必须跳过它再取真实数据行，否则全表「假 0 假 normal」，疑似样式未生效白查四轮。验证锚：contractTemplate/editor 变量清单表（探针假象排除后真实行 nowrap/13px/ellipsis 全中）。
- **单文件改动未生效而他文件正常 → 先 touch 该文件再考虑重启 dev server（2026-10-27 追加）**：vite 文件监听偶发漏事件使该模块滞留旧编译产物；touch 存一次即触发重编译，比重启代价小一个量级。验证锚：editor.vue bordered 改动滞留（touch 后即时生效）。
