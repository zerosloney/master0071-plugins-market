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
 *   cycles = 真正处在环里的节点（SCC 判定，与 state.mjs validateState 的 DFS 同口径；环的下游节点不算）
 *   errors = 未知依赖 / 无字符串 id / 重复 id 的条目
 */
export function analyzeDependencies(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const errors = [];
  // 重复 id（2026-11-05）：validateState 写入口会拒绝 `duplicate task id`（state.mjs），这里同口径报错。
  // 旧实现静默合并——同 id 条目的 depends_on 被并进同一节点、入度双计，graph.mjs 对
  // validateState 必拒的状态返回 ok=true。口径：只让首次出现的条目参与建图，重复出现按次报错。
  const firstOf = new Map();
  for (const task of list) {
    const id = task && task.id;
    if (typeof id !== "string") continue;
    if (firstOf.has(id)) errors.push(`duplicate task id: ${id}`);
    else firstOf.set(id, task);
  }
  const ids = [...firstOf.keys()];
  const idSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
  const built = new Set();

  for (const task of list) {
    if (!task || typeof task.id !== "string") {
      errors.push("task without a string id");
      continue;
    }
    if (built.has(task.id)) continue; // 重复条目已在上面报错，不再参与建图
    built.add(task.id);
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
  // 迭代式（2026-11-07，审计 m1）：递归版沿最长依赖链一层层递归，2 万节点链式 depends_on
  // 直接 RangeError，graph/render 调用点不接 → 崩栈 exit 1 恰是 FAIL 码，与「有环/未知依赖」
  // 混读。显式栈帧 [id, depth, 已分流的孩子数] 与递归同序同剪枝（depth<=layer 剪枝 + visiting
  // 环防护）；帧只在推入孩子前自增游标，回到帧首时游标必 >0，入口判定对每帧恰执行一次。
  const layer = new Map();
  const visiting = new Set();
  const walk = (root, rootDepth) => {
    const frames = [[root, rootDepth, 0]];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [id, depth] = frame;
      if (frame[2] === 0) {
        if (depth <= (layer.get(id) ?? -1) || visiting.has(id)) {
          frames.pop();
          continue;
        }
        visiting.add(id);
        layer.set(id, depth);
      }
      const children = next.get(id) || [];
      if (frame[2] < children.length) {
        const child = children[frame[2]];
        frame[2] += 1;
        frames.push([child, depth + 1, 0]);
      } else {
        frames.pop();
        visiting.delete(id);
      }
    }
  };
  for (const id of ids) if (indegree.get(id) === 0) walk(id, 0);
  for (const id of ids) if (!layer.has(id)) walk(id, 0); // 环内节点兜底

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
  // 环成员（2026-11-05 修正口径）：旧实现「Kahn 没吐出来的都算环」会把环的下游节点也点名
  // （a↔b 加 c→b 时给出 [a,b,c]，render 据此打印「存在环：c」，误导排查方向），与 validateState
  // 的 DFS（只报真环成员，state.mjs）口径不一。用 Tarjan 强连通分量判定：SCC 大小 ≥2 或自环
  // 即环成员；输出仍按 ids 顺序，稳定可比对。order 维持 Kahn 原样：排不进的节点不进拓扑序。
  // 迭代式（2026-11-07，审计 m1，同上方分层的爆栈因）：栈帧 [v, 已处理的孩子下标] 复刻递归序
  // ——遇未访孩子就地初始化再下推；帧弹出时把 low 上传父帧（若孩子已弹出自己的 SCC，则
  // low[w]=index[w]>index[父]≥low[父]，min 恒不生效，与递归的无条件上传等价），随后按
  // low==index 收 SCC。
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const inCycle = new Set();
  let counter = 0;
  const stronglyConnected = (root) => {
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    const frames = [[root, 0]];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame[0];
      const children = next.get(v);
      if (frame[1] < children.length) {
        const w = children[frame[1]];
        frame[1] += 1;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          frames.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const component = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            component.push(w);
          } while (w !== v);
          if (component.length > 1 || children.includes(v)) {
            for (const member of component) inCycle.add(member);
          }
        }
      }
    }
  };
  for (const id of ids) if (!index.has(id)) stronglyConnected(id);
  const cycles = ids.filter((id) => inCycle.has(id));

  return { ids, layer, order, cycles, errors };
}
