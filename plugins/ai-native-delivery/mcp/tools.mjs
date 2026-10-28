// ai-native-delivery MCP server — tool definitions.
//
// 恰好 7 个治理工具（设计文档 §3.3，控制 schema 开销；三个闭环层各至少一个入口）。
// 每个条目自带 JSON Schema（required/type/enum；additionalProperties:false——拼错的参数名
// 被拒绝而不是被静默忽略）与 handler；handler 全部落在 mcp/core.mjs（包装已迁脚本，
// MCP 不重造逻辑、无自有存储）。

import {
  ToolError,
  toolGradeTask,
  toolReadContext,
  toolUpdateLedger,
  toolConfirm,
  toolVerifyGate,
  toolLedgerStats,
  toolPolicyStatus,
} from "./core.mjs";

// 显式项目根参数（2026-10-28 插件根守卫配套）：宿主按 Agent Plugins 规范把 MCP 服务起在插件根里时，
//   进程 cwd 反映的是插件安装位置，据此推断「用户要操作哪个仓库」不可靠（守卫会硬失败）。
//   root 是那时的唯一可靠出口——调用方显式指明使用项目的 git 仓库根。
const ROOT_PROP = {
  root: {
    type: "string",
    description: "可选：使用项目的 git 仓库根（绝对路径）。缺省按服务进程的工作目录解析；该目录若落在插件安装目录内，工具会明确报错而不猜。",
  },
};

const tools = [
  {
    name: "grade_task",
    description:
      "两问定级：对任务描述做风险泳道判级（L1 协作道 / L2 契约 / L3 数据结构）。第①问结构面（schema/迁移 SQL/DI/认证管线）命中即 L3；第②问契约或共享口径（闭集四类：编码权威/共享契约/既有接口语义/全局横切，∪ 项目 lane-surfaces.txt product 段触达面）命中即 L2；都没有即 L1。返回 {level, hits[], rationale}——判级有据（hits 非空）可测。禁止按严重程度从 L1 往上滑。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: { type: "string", description: "任务描述（自由文本；一句话即可，判据按词面与触达面清单匹配）。" },
        ...ROOT_PROP,
      },
      required: ["description"],
    },
    handler: (args) => toolGradeTask(args),
  },
  {
    name: "read_context",
    description:
      "跨会话恢复（断崖恢复入口）：汇总 workflow/INDEX.md 存在性与头部、plans/specs/intents 三目录在途文件（状态 draft/approved）、.agents/confirmations.jsonl（∪ 分片）最近 5 行。项目未初始化时返回 {initialized:false, hint} 而非报错。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...ROOT_PROP },
    },
    handler: (args) => toolReadContext(args),
  },
  {
    name: "update_ledger",
    description:
      "交付台账原子更新：在 workflow/ 树内建文件（create，已存在则拒绝）或追加行（append）。路径白名单防逃逸（拒绝绝对路径与 ../）；写前跑 check-ledger-invariant 轻量前置，失败即拒写并返回原因。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: { type: "string", description: "workflow/ 树内的相对路径（如 workflow/papercuts.md）。" },
        content: { type: "string", description: "要写入（create）或追加（append）的内容文本。" },
        mode: { type: "string", enum: ["create", "append"], description: "create=建文件（已存在拒绝）；append=追加行（自动补行尾换行）。" },
        ...ROOT_PROP,
      },
      required: ["file", "content", "mode"],
    },
    handler: (args) => toolUpdateLedger(args),
  },
  {
    name: "confirm",
    description:
      "写确认记录：向 .agents/confirmations.jsonl 追加一行 {ts, task, decision, evidence, fingerprint}；指纹复用 confirm-doc.computeFingerprint（sha256 64 位 hex，供指纹校验对账）。调用纪律：确认须来自用户真实放行，evidence 请带可对质的证据原文。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "任务标识（一句话，含文件名更佳）。" },
        decision: { type: "string", description: "确认决定（如 用户放行 / draft→approved / 拒绝及理由）。" },
        evidence: { type: "string", description: "证据原文（用户对话原话/放行依据），供事后对质。" },
        ...ROOT_PROP,
      },
      required: ["task", "decision", "evidence"],
    },
    handler: (args) => toolConfirm(args),
  },
  {
    name: "verify_gate",
    description:
      "跑闭环门禁车道并回报裁决（status 字段三态：passed=跑完且通过 / failed=跑完且有违例 / not-executed=超时或启动失败，**没跑完不等于通过**；另附 exit code + stdout/stderr 摘要，截断至 8KB 防爆）：hard=默认车道（check-loop 硬门，不带 flag）、hygiene=卫生段（--hygiene）、all=两段都跑（--all）。cwd 锚定项目根。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lane: { type: "string", enum: ["hard", "hygiene", "all"], description: "缺省 hard（硬门车道）。" },
        ...ROOT_PROP,
      },
    },
    handler: (args) => toolVerifyGate(args),
  },
  {
    name: "ledger_stats",
    description:
      "台账体量与不变量状态：workflow/ 文件数/字节/最新 mtime、.agents/*.jsonl 各账行数、check-ledger-invariant 不变量校验结果——供 compact/archive 台账卫生决策。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...ROOT_PROP },
    },
    handler: (args) => toolLedgerStats(args),
  },
  {
    name: "policy_status",
    description:
      "治理进化环可见性：policyVersion（项目侧 engine.json 优先，未初始化标注插件种子来源）、gate-budgets 预算、judgments.jsonl per-rule 聚合与退役候选（口径如实标注）、rule-budgets 棘轮状态（check-loop-sections 段数与 hard 车道数 vs 上限）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...ROOT_PROP },
    },
    handler: (args) => toolPolicyStatus(args),
  },
];

export { tools, ToolError };
