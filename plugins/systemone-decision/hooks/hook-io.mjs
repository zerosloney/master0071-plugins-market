// hook-io.mjs — 两个 hook 入口（requirement-clarity / pretool-risk）共用的 stdin/stdout 协议壳。
// 契约与各自内核一致：stdin = hook JSON；handle 返回 null 时静默 exit 0（fail-open），
// 返回对象时序列化为 stdout；异常写 stderr 后 exit 0，绝不阻塞用户输入或工具调用。
// 判定内核不在这里（clarity.mjs / risk-gate.mjs），本文件只做读取、deadline 与退出协议。

/** stdin 字符上限：与 MCP 侧 server.mjs 的 state 上限（STATE_MAX_CHARS = 100K）对齐。 */
export const STDIN_MAX_CHARS = 100_000;

/** hook 进程的总预算（毫秒）：与 hooks.json 的 handler 15s 超时对齐，留 1s 收尾余量。 */
export const HOOK_BUDGET_MS = 14_000;

/** 预算耗尽时传给内核的 timeout 哨兵：没有时间发远端请求，内核只能按「输入不可信」fail-closed。 */
export const NO_BUDGET_MS = 1;

/** 读 stdin 为字符串；达到 STDIN_MAX_CHARS 即停止读取并以 truncated 标记返回（不等流到 EOF）。 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ raw, truncated });
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (truncated) return;
      raw += c;
      if (raw.length >= STDIN_MAX_CHARS) {
        truncated = true;
        raw = raw.slice(0, STDIN_MAX_CHARS);
        // destroy() 不触发 end 只触发 close：靠 close 立即收尾，超大残流不再读
        process.stdin.destroy();
      }
    });
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
    process.stdin.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * 协议壳：读 stdin → 解析 JSON → 以剩余预算调用 handle → 交由 main 输出并退出。
 * stdin 与判定请求共享一个 deadline（而非各自接力）：stdin 花掉多久，请求就只剩多少
 * （留 1s 进程收尾余量），总和锁死在 hooks.json 的 handler 15s 内。killer 保留为
 * stdin 异常挂起时的兜底自毁，避免每次输入都吃满 hook 进程超时。
 *
 * @param {(input: object, timeoutMs: number, truncated: boolean) => Promise<object|null>} handle
 *   truncated = 输入不可信（stdin 超限**或**时间预算耗尽），由调用方决定走向
 *   （预检放行、风险闸 fail-closed）
 * @param {object} [opts] - { budgetMs, now }：预算上限与取时函数（测试注入用，生产取默认值）
 * @returns {Promise<object|null>} handle 的返回值；handle 判定放行时为 null（fail-open）
 */
export async function runHook(handle, opts = {}) {
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : HOOK_BUDGET_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const startedAt = now();
  const killer = setTimeout(() => process.exit(0), 14000);
  let stdin;
  try {
    stdin = await readStdin();
  } finally {
    clearTimeout(killer);
  }
  let input = {};
  if (!stdin.truncated) {
    try {
      input = stdin.raw.trim() ? JSON.parse(stdin.raw) : {};
    } catch {
      input = {};
    }
  }
  const left = budgetMs - (now() - startedAt) - 1_000;
  // 预算耗尽**不能**直接放行：这里 return null 会让宿主收到空输出 = 静默放行，
  // 而「stdin 到达过慢」恰恰是宿主管道背压/超大上下文的那一次，最需要闸门。
  // 仍然走 handle，把 truncated 置 true，由风险闸既有的 fail-closed 分支转人工确认。
  if (left <= 0) return handle(input, NO_BUDGET_MS, true);
  return handle(input, left, stdin.truncated);
}

/** 入口：跑协议壳，结果序列化到 stdout 后 exit 0；异常写 stderr（fail-open，exit 0）。 */
export function main(handle, label) {
  runHook(handle)
    .then((out) => {
      const text = out ? JSON.stringify(out) : '';
      if (!text || process.stdout.write(text)) process.exit(0);
      process.stdout.once('drain', () => process.exit(0));
    })
    .catch((e) => {
      process.stderr.write(`[systemone-decision hook] ${label}：${e && e.message ? e.message : e}\n`);
      process.exit(0);
    });
}
