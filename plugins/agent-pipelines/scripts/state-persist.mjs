// state-persist.mjs — 状态文件的持久化原语单源：原子写、事件日志、文件锁。
//
// 拆分自 state.mjs（三缝拆分的持久层）：本模块只认「文件路径」，不认管道语义与命令行——
// 零管道知识（pipeline 在 logEvent 里只是透传字符串字段）、零 CLI 依赖（不解析 argv、
// 不打印用法）。state.mjs（CLI 编排）与 state-core.mjs（域逻辑）都从这里取原语。
// readEvents 是事件日志读取的唯一实现（含轮转段合并）；render.mjs 的 loadEvents 也委托到这里。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

// 与各 CLI 脚本同款的错误纪律（args.mjs / graph.mjs / render.mjs 各持一份同实现）：
// 一行 stderr + exit 2。withLock 超时与 readState 读失败用它——process.exit 语义是既有行为，
// 不改成 throw（那会把错误处理扩散到每个调用点、改变锁的退出路径）。
function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 其它 pid 残留的 `${file}.*.tmp`（持有者被 kill -9，无法自我清理）会在同目录永久堆积。
// writeAtomic 成功路径上机会性清扫：只删同目录匹配 `${file}.*.tmp` 且 mtime 超过 5 分钟的
// tmp——正在写的 tmp mtime 是新鲜的，不会误删；锁接管产生的 `${file}.lock.*.tmp` 同模式
// 一并被覆盖。纯卫生，任何失败静默，不挡主流程。
const TMP_STALE_MS = 5 * 60 * 1000;

function sweepStaleTmp(file) {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const full = path.join(dir, name);
      let mtimeMs;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue; // 可能刚被别的进程清掉
      }
      if (now - mtimeMs > TMP_STALE_MS) {
        try {
          unlinkSync(full);
        } catch {}
      }
    }
  } catch {}
}

export function writeAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // 清理同 pid 的陈旧 tmp（进程被 kill -9 残留）：writeFileSync 以 w 模式覆盖，写坏也无妨
    try {
      unlinkSync(tmp);
    } catch {}
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
  sweepStaleTmp(file);
}

// readState 的非退出版本：gate --apply 要在锁内读状态，而锁内 process.exit 不会跑 withLock 的 finally、
// 会把锁留在盘上，因此读取错误先带出锁外，由调用方统一 fail（错误信息与 readState 完全一致）。
export function readStateSoft(file) {
  if (!existsSync(file)) return { error: `state file not found: ${file}` };
  try {
    return { state: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: `state file is not valid JSON (${file}): ${err.message}` };
  }
}

export function readState(file) {
  const { state, error } = readStateSoft(file);
  if (error) fail(error);
  return state;
}

function eventsFile(file) {
  const base = path.basename(file).replace(/\.json$/, "");
  return path.join(path.dirname(file), `${base}.events.jsonl`);
}

// completion_promise 早停的边车标记（2026-11-05，方案 b）：与状态文件同目录的 <状态基名>.promise.json，
// 由 orchestrator 专属的 `promise` 子命令经 writeAtomic（tmp+rename）写入，不碰状态文件本体。
// 路径派生与 eventsFile 同款（.json → .promise.json）；无 .json 后缀时退化为直接追加。
export function promiseFile(file) {
  return `${file.replace(/\.json$/, "")}.promise.json`;
}

// gate 只认边车标记：存在且 value 非空（trim 后）才构成早停依据。状态体里的 completion_promise
// 字段彻底不参与判定——状态文件是执行者可写的普通 JSON，写一行字符串就能伪造「用户显式早停」，
// 旧机制已被伪造实测利用。标记损坏/字段缺失按「无标记」处理（继续 = 安全默认，不因垃圾早停）。
export function readPromiseValue(file) {
  const marker = promiseFile(file);
  if (!existsSync(marker)) return "";
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8"));
    return isObject(parsed) && typeof parsed.value === "string" ? parsed.value.trim() : "";
  } catch {
    return "";
  }
}

// 事件日志上限（2026-10-28 市场审查）：无人值守长跑会让 <file>.events.jsonl 无界增长，而 readEvents
// 每次都全量读+解析。到上限即轮转：把当前文件改名为 .1（覆盖旧 .1），新行写新文件——最坏占用约
// 2×MAX，且保留最近一段历史供 `events` 子命令回看。轮转失败一律静默（观测面不得挡住主流程）。
const EVENTS_MAX_BYTES = 5 * 1024 * 1024;

function rotateEventsIfNeeded(log) {
  try {
    if (!existsSync(log)) return;
    if (statSync(log).size < EVENTS_MAX_BYTES) return;
    renameSync(log, `${log}.1`);
  } catch {
    /* 权限/竞态：跳过轮转，继续追加（宁可超限也不丢事件） */
  }
}

export function logEvent(file, pipeline, event, state, extra = {}) {
  try {
    // 相对路径（相对 cwd）：事件日志可能随仓库分发，绝对路径会泄露本机目录结构。
    // Windows 跨盘符时 path.relative 无法相对化、直接返回绝对路径——退化为 basename 守住承诺。
    const relFile = path.relative(process.cwd(), file);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      pipeline,
      file: !relFile || path.isAbsolute(relFile) ? path.basename(file) : relFile,
      round: state && state.round,
      stop_reason: state ? state.stop_reason ?? null : null,
      tasks:
        state && Array.isArray(state.tasks)
          ? { done: state.tasks.filter((task) => task && task.status === "done").length, total: state.tasks.length }
          : undefined,
      pid: process.pid,
      ...extra,
    });
    const log = eventsFile(file);
    rotateEventsIfNeeded(log);
    appendFileSync(log, `${line}\n`, "utf8");
  } catch {}
}

// 事件日志读取的唯一实现（含轮转段合并）。轮转文件（.1）在前、当前文件在后，保持时间序
// （.1 是较早的一段）。两者都可能不存在。消费方：
//   · state.mjs 的 events 子命令（tail 直传）；
//   · render.mjs 的 loadEvents（2026-11-01 修复史见那边注释）——render 此前只打开当前段、
//     丢轮转段历史，修复时内联了一份合并读，本次双实现去重后委托到这里。
// 单行解析失败跳过该行（观测面不挡主流程）；非对象 JSON 行不在此过滤，由消费方按需自守。
// 跳过不是无声消失（2026-11-07，质量审计 §3.4）：坏行意味着日志曾被截断/写坏，丢弃时在
// stderr 打一行计数（含文件名）供审计侧察觉，不打断读取、不改变返回的事件内容。
export function readEvents(file, tail) {
  const log = eventsFile(file);
  const parts = [];
  let malformed = 0;
  for (const p of [`${log}.1`, log]) {
    if (!existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // 读失败跳过该段，不因观测面挡住 events 输出
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        parts.push(JSON.parse(line));
      } catch {
        malformed += 1;
      }
    }
  }
  if (malformed > 0) {
    process.stderr.write(`[agent-pipelines] skipped ${malformed} malformed event line(s) in ${log}\n`);
  }
  return tail > 0 ? parts.slice(-tail) : parts;
}

// 写状态与 gate --apply 共用一把锁：同一仓库两个会话同时写时串行化，避免整份覆盖。
// 锁内容是 `<pid> <iso时间>`：release 与陈旧接管都靠内容判归属（迟到的释放不能误删
// 接管者的新锁；持有者已死的残留锁可以提前接管，不必等满陈旧阈值）。
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 2000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 锁内容首段是持有者 pid；解析不出（垃圾内容/旧格式）返回 null，此时只按 mtime 龄判陈旧。
function lockOwnerPid(content) {
  const pid = Number.parseInt(String(content), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // 进程存在但无权发信号 → 仍视为存活
  }
}

export function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid} ${new Date().toISOString()}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  // 只释放仍属于自己的锁：fn 持锁超过 STALE 阈值时锁可能已被后来者原子接管，迟到的 release
  // 若无条件 unlink 会删掉新持有者的锁，第三方便可再获取，两个写者并发读-改-写。
  const release = () => {
    try {
      if (readFileSync(lock, "utf8") !== owner) return;
      unlinkSync(lock);
    } catch {
      /* 已被接管/清理 */
    }
  };
  // 陈旧锁接管（移植 worktree-ops/mcp/core.mjs acquireConfigLock 的已验证模式）：
  // 不用 unlink+重建——stat 判陈旧到删掉之间锁可能已被他人接管重建，无条件删会误删新
  // 持锁者的锁、还留下「无锁窗口」让第三方插空。改为把自身 pid 写临时文件后 rename 原子
  // 替换锁文件：要么整体换掉要么不动，不存在「误删他人新锁」的中间态。并发接管时最后
  // 替换者的 pid 留在锁里，输家 release 的内容比对保证不误删赢家的锁。返回是否接管成功。
  const takeOverStale = () => {
    try {
      const mtimeMs = statSync(lock).mtimeMs;
      let stale = Date.now() - mtimeMs > LOCK_STALE_MS;
      if (!stale && Date.now() > deadline) {
        // 崩溃残留锁的 30s 阻塞：接管原本必须等锁龄超过 LOCK_STALE_MS，而 LOCK_WAIT_MS=2s
        // 早到——残留锁出现后的头 30s 里每个操作都白等 2s 再 exit 2。锁内容带持有者 pid：
        // 等待已超 deadline 且 pid 已死即为残留锁实锤，立即进入接管；pid 存活（正当持锁者
        // 只是慢）绝不提前接管，互斥与超时报错语义都不变。
        const pid = lockOwnerPid(readFileSync(lock, "utf8"));
        stale = pid !== null && !pidAlive(pid);
      }
      if (!stale) return false;
      const tmp = `${lock}.${process.pid}.${Date.now().toString(36)}.tmp`;
      let replaced = false;
      try {
        writeFileSync(tmp, owner, "utf8");
        renameSync(tmp, lock);
        replaced = true;
      } finally {
        if (!replaced) {
          try {
            unlinkSync(tmp);
          } catch {
            /* 临时文件可能已被 rename 或根本没写成 */
          }
        }
      }
      // 回读守卫（2026-11-07，审计 M3）：stat 判陈旧到 rename 之间，另一进程可能已对同一把
      // 残留锁完成接管——rename 的原子性只保证内容归属最后替换者，不保证接管互斥，两个
      // 「接管成功」会双双进入临界区，后提交者的陈旧读覆盖先提交者的写入。rename 后回读锁
      // 内容：仍是自己才返回 true；已被他人顶掉（或锁刚被释放消失）则返回 false，走普通
      // 竞争退避重试。
      return readFileSync(lock, "utf8") === owner;
    } catch {
      /* 锁刚好被释放/替换（Windows 上 rename 目标被占用等）→ 按普通竞争退避重试 */
      return false;
    }
  };
  for (;;) {
    let acquired = false;
    try {
      const fd = openSync(lock, "wx");
      // writeSync 失败也要关 fd：锁文件句柄一旦泄漏，Windows 上该文件一直被本进程占用，
      // 后续 unlink/接管都会被拖累。
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    if (!acquired && !takeOverStale()) {
      if (Date.now() > deadline) fail(`state file is locked by another process: ${lock}`);
      sleepMs(25);
      continue;
    }
    try {
      return fn();
    } finally {
      release();
    }
  }
}
