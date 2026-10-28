// dag.mjs — 任务依赖图的单源分析：未知依赖、拓扑序、环与分层。
//
// 背景（2026-10-28）：graph.mjs（CLI：拓扑序 + 子任务预算）与 render.mjs 的 layoutGraph
// （看板：分层列 + 拓扑序）此前各写一份，约 35 行同构代码。两处的分叉不是假设——环检测
// 一边用 Set 查找、另一边用 Array.includes（O(n²)）；未知依赖的报错文案也各写一次。
// 这类重复的实际代价是「改一处忘另一处」：修一个环判定 bug 时很容易只改看得见的那份。
//
// 差异只在各自的增量：graph 要子任务预算（maxCycles × factor），render 要层号（最长依赖链）。
// 所以这里只抽共同的那半，增量留在调用方。

/**
 * 分析任务依赖图。纯函数，不读写文件。
 * @param {Array<object|null>} tasks - state.tasks（允许 null / 缺 id 的条目，会计入 errors 而非崩溃）
 * @returns {{ids: string[], layer: Map<string, number>, order: string[], cycles: string[], errors: string[]}}
 *   layer  = 节点 → 层号（无依赖为 0，= 最长依赖链长度）
 *   order  = Kahn 拓扑序（同层按 id 字典序，保证输出稳定可比对）
 *   cycles = 排不进拓扑序的节点（即处在环里的）
 *   errors = 未知依赖 / 无字符串 id 的条目
 */
export function analyzeDependencies(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const ids = list.map((task) => task && task.id).filter((id) => typeof id === "string");
  const idSet = new Set(ids);
  const errors = [];
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));

  for (const task of list) {
    if (!task || typeof task.id !== "string") {
      errors.push("task without a string id");
      continue;
    }
    for (const dep of Array.isArray(task.depends_on) ? task.depends_on : []) {
      if (!idSet.has(dep)) {
        errors.push(`task ${task.id}: unknown dependency ${dep}`);
        continue;
      }
      next.get(dep).push(task.id);
      indegree.set(task.id, indegree.get(task.id) + 1);
    }
  }

  // 分层：层 = 最长依赖链长度；无依赖为 0 层。
  // 兜底初值必须是 -1 而不是 0：`get() ?? 0` 会让首次访问的节点因 `0 <= 0` 直接返回，
  // layer 永远为空、全部任务挤在第 0 列（分层失效，2026-10 实测踩过）。
  const layer = new Map();
  const visiting = new Set();
  const visit = (id, depth) => {
    const current = layer.get(id) ?? -1;
    if (depth <= current) return;
    if (visiting.has(id)) return; // 环防护：环内节点不再沿环加深，防止无限递归
    visiting.add(id);
    layer.set(id, depth);
    for (const child of next.get(id) || []) visit(child, depth + 1);
    visiting.delete(id);
  };
  for (const id of ids) if (indegree.get(id) === 0) visit(id, 0);
  for (const id of ids) if (!layer.has(id)) visit(id, 0); // 环内节点兜底

  // 拓扑序：用 indegree 的副本，避免污染上面的分层判定。
  const pending = new Map(indegree);
  const queue = ids.filter((id) => pending.get(id) === 0).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const dependent of next.get(id) || []) {
      pending.set(dependent, pending.get(dependent) - 1);
      if (pending.get(dependent) === 0) queue.push(dependent);
    }
  }
  // 环 = 拓扑排序没吐出来的节点；用 Set 查找（此前 render 侧是 Array.includes，O(n²)）
  const ordered = new Set(order);
  const cycles = ids.filter((id) => !ordered.has(id));

  return { ids, layer, order, cycles, errors };
}
