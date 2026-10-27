# 特性：需求变更 编辑抽屉（明细信息表）

> 特性地图。事实锚点为建档时点代码，漂移时先修地图再出结论。
> 建档 2026-10-23（L1 plan `workflow/plans/2026-10-23-mtochange-edit-detail-material-code-width.md`，实现提交 `fb9b0311`）。

## 到达路径

hash 路由 `#/mto-changes`（采购 › 需求变更）→ 点「查询」取数 → **鼠标悬停目标行**（行右缘浮出操作浮层 `.row-hover-panel`）→ 点浮层内「编辑」（`<a class="action-edit">`，非 button）→ 打开「编辑需求变更」抽屉 → 「明细信息」卡片内的表格。

- **行操作入口在 hover 浮层里**（固定操作列已于 2026-10-22 前后的列表改造中删除）：须先 `mouseover` 到 `.ag-row`，浮层才渲染；直接查 DOM 找不到按钮。
- **「编辑」入口是 `<a>`，且不满足资格时不再渲染**（2026-10-26 用户口径①变更；原「五按钮常驻 + `.action-disabled` 置灰」已删除——若仍按 `.action-disabled` 找入口，恒找不到）。用 `button` 选择器同样找不到它。
- **编辑入口有「本人创建」门**（`canEdit = status === 1 && isCreator`，`isCreator` 比 `authStore.user.jobNo` 与行的 `createdByJobNo`）。未提交单（`status=1`）未必由当前账号创建，逐页翻也可能一行都不可编辑。
  - 实测可编辑账号：`JAMTC006`（杨晋奇）/ `JAMTC002`（沈霁宇）/ `JAMTC003`（毛天宇），对应未提交单的 `createdByJobNo`（2026-10-23 实测）。
  - `harness.seedSession(ctx, token)` 2026-10-26 起自动按 token 的 JWT claims 播种**真实登录身份**——用 `getToken('JAMTC006')` 等显式取号后直接 seedSession 即过本人门；仅当需要与 token 账号不同的身份时才手工 `localStorage.setItem('auth_user', …)` 播种（`jobNo`/`displayName`/`dept` 取自 `POST /api/v1/auth/login` 响应）。
  - `harness.getToken(username)` 显式传用户名时**不会**补缺省密码（`password` 保持 `undefined`，请求体里被丢掉 → 401），须显式传第二参。

## 驱动

进入 `#/mto-changes` → 点「查询」→ 在可编辑行点「编辑」→ 量「明细信息」表。

## 可观察终态

- 明细表**全列表头与数据单元格均单行**（不折行）。表头折行的根因是**列宽 < 表头单行实宽 + 内边距 16px**；按此定值后 12 列表头行数全为 1（2026-10-23 第 2 轮，commit `d7576588`）。列宽现状与实测依据：

  | 列 | 宽 | 表头实宽 | 内容最宽 |
  |---|---|---|---|
  | MTO行号 | 90 | 59 | 8 |
  | 物资编码 | 130 | 56 | 106（14 位编码单行实宽） |
  | 物资名称 | 150 | 56 | 269（`ellipsis`） |
  | 规格型号 | 120 | 56 | 65（`ellipsis`） |
  | 原需求数量(辅) | 120 | 93 | 8 |
  | 利库数量(辅) | 100 | 79 | 8 |
  | 变更数量(辅) | 100 | 79 | — |
  | 变更后需求数量(辅) | 150 | 121 | 8 |
  | 使用单位(辅) | 100 | 79 | 14 |
  | 备注 | 120 | 28 | — |
  | 可用性 | 90 | 42 | 28 |
  | 操作 | 120 | 28 | 56（旧数据行两按钮约 176，仍裁切） |

- 明细表数据行为单行：改前「物资编码」列 100px 时 14 位编码折成 2 行、文本块高 41px，整行被撑到 61px；改后 130px，编码单行（块高 19px），整行 49px（2026-10-23，`fb9b0311` + `d7576588`）。
- 编辑抽屉含可编辑输入框（变更数量 `a-input-number` / 备注 `a-input`），**单行基线是 49px 而非只读表的 39px**——与 2026-10-21 出库申请编辑抽屉实测同值。判「是否折行」看单元格文本块高，不看整行行高。

## Gotchas

- **冻结列的 `scrollWidth` 不可用作溢出判据**：`fixed: 'left'`/`'right'` 列的 `scrollWidth` 恒为 `clientWidth + 30`（实测改前 133/103、改后 189/159 为同一常量偏移）。判「文本放得下」须比 **文本单行实宽 vs 可用宽（`clientWidth − 左右内边距`，本表内边距合计 16px）**。
- 该表「物资名称 / 规格型号」带 `ellipsis: true`（`white-space: nowrap`，单行省略）；其余文本列无 ellipsis，宽度不足即折行。新增文本列须自己给足宽度或加 `ellipsis`。
- **量列宽用「表头单行实宽」而非肉眼估**：把表头文本塞进复制了 `th` computed 字体的隐藏 `nowrap` span 量宽（`font` 简写复制在部分环境不生效，会量出偏小值——逐属性复制 fontFamily/fontSize/fontWeight/fontStyle/letterSpacing）。脚本 `tmp/measure-mtochange-col-widths.mjs`（逐列输出「表头实宽 / 内容最宽 / 渲染宽 / 内边距 / 恰好容下 / 现折行」）。
- 全局 `style.css` 的单行口径只挂在 `.list-table` 上，**不覆盖**本抽屉的表；别指望全局规则兜住抽屉内的折行。
- 已知未修：旧数据行（`mtoOrderDetailID` 为空）「操作」列同时渲染「选择物资 + 删除」，超出该列 120px 可用宽，「删除」被裁掉（2026-10-23 实测截图可见）。
