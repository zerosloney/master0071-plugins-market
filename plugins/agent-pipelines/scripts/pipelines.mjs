// pipelines.mjs — 管道参数与枚举的单源：PIPELINES 参数表、STOP_REASONS / TASK_STATUS 枚举、
// 单任务尝试上限 attemptLimit 与 max_iterations 覆盖规则。
//
// 背景：这批常量此前在 state.mjs / graph.mjs / render.mjs 各拷一份（PIPELINES 的
// maxCycles 10/8、stallMax 3/2、factor 0.8/0.75 三处只有 state 一份被测试锚定；
// 「max_iterations > 0 覆盖 maxCycles」这句规则在 state.mjs gateFor 与 graph.mjs 双写），
// 改一个默认值需要同步多处，漏一处就是文档 ↔ 脚本漂移。现在三个 CLI 与 equivalence
// 锚定测试都从这里取值。
//
// 消费方各自的增量（render 要 label/color 展示字段、graph 要 factor 预算折算、
// state 要 stallMax 判停）直接读同一条记录里的对应字段，不带各自的逻辑进来。

// 两条管道的全部参数：状态机判停（maxCycles/stallMax）、子任务预算（factor）、看板展示（label/color）。
export const PIPELINES = {
  ralph: { maxCycles: 10, stallMax: 3, factor: 0.8, label: "Ralph Pipeline", color: "#6366f1" },
  coding: { maxCycles: 8, stallMax: 2, factor: 0.75, label: "Coding Pipeline", color: "#0f766e" },
};

// 合法任务状态（validateState 校验 + render/serve 徽标白名单共用）
export const TASK_STATUS = new Set(["pending", "in_progress", "done", "blocked"]);

// 合法 stop_reason（validateState 校验 + render/serve 警告白名单共用；null = 仍在运行）
export const STOP_REASONS = new Set([null, "DONE", "ESCALATE", "BUDGET", "HOLD", "STALL", "MAX_CYCLES", "STOPPED"]);

// 默认单任务尝试上限：任一任务的 failures 达到自身 max_attempts（或本默认值）即 ESCALATE，
// 避免单任务无限重试。max_attempts 是执行者可写字段，缺省时用这里的最小兜底。
export const attemptLimit = 4;

/**
 * 生效轮次上限：max_iterations > 0 覆盖管道默认 maxCycles，否则用默认值。
 * state.mjs gate 在 gateFor 前必经 validateState（max_iterations 已保证为 >= 0 的整数）；
 * graph.mjs 不跑校验、直接读状态文件，故这里自带 Number.isInteger 防御，非法值回退默认。
 * @param {object} state - 管道状态对象
 * @param {string} pipeline - 管道名（PIPELINES 的键）
 * @returns {number} 本轮判停用的轮次上限
 */
export function effectiveMaxCycles(state, pipeline) {
  const spec = PIPELINES[pipeline];
  return Number.isInteger(state.max_iterations) && state.max_iterations > 0 ? state.max_iterations : spec.maxCycles;
}
