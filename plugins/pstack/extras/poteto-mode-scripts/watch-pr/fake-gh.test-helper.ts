import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Windows 上跑 watch-pr 的 CLI 测试（2026-10-29 第四轮市场审查）
//
// 上游把假 gh 写成无扩展名的 shebang 脚本，放进 PATH 交给 `spawn("gh", [...])`，CLI 则由
// `spawnSync(process.execPath, [entry.ts, ...])` 启动。这在 POSIX 上成立，Windows 上两处都不成立。
//
// ## 假 gh：为什么必须是真 `.exe`
//   ① 裸名 `gh` 经 CreateProcess 解析时只试 PATHEXT 里的扩展名，无扩展名文件永远 ENOENT；
//   ② 补一个 `gh.cmd` 转发也不行——Node/Bun **硬性拒绝**把含 cmd.exe 特殊字符的参数交给
//      `.cmd`（`TypeError: The argument 'args[2]' contains a cmd.exe special character`），
//      而 watch-pr 的 GraphQL 查询必然含 `{ } ( ) "`。实测 node 与 bun 两个宿主都拒绝。
//   ③ 把 `gh.exe` 做成 node.exe 的副本、靠 `NODE_OPTIONS=--import` 的 shim 在解析参数前接管
//      也不成立：node 会先解析 `-f` 这类 gh 参数（`gh: bad option: -f`），shim 跑不到。
// 所以只能用 `bun build --compile` 出一个真 `.exe`。这个 exe 编译一次、预热一次后，
// **从 node 父进程启动**只需 40–80ms。
//
// ## 入口进程：为什么必须换成 node
// 实测在 bun 父进程里启动**任何** bun 二进制都要约 3.5s（`bun → bun.exe` 3.9s，
// `bun → node.exe` 93ms，`bun → cmd.exe` 20ms，`node → bun.exe` 65ms）。这与 `--compile`
// 无关、与继承的环境变量无关（逐个剔除 BUN_INSTALL_DIR / npm_config_registry / NPM_TOKEN，
// 乃至只在最小 env 下跑，都是 3.6s）。测试用例的子进程预算只有 5s，这笔 3.5s 直接把预算吃光——
// 这才是「12 条全部 timed out after 5000ms」的真正原因。
// 因此本套件在 Windows 上用 **node** 跑 CLI 入口（`--experimental-transform-types`，因为
// `deadline.ts` 用了参数属性），假 gh 用上面的 exe。实测四个典型场景各 450–500ms。
//
// POSIX 上两者都走上游原形（shebang 脚本 + `process.execPath`），行为完全一致。

let cachedNode: string | null = null;

/** node 的绝对路径。
 *  必须是绝对路径：个别用例故意把 PATH 收窄成「没有 gh」来验 spawn-failed 分支，
 *  裸名 `node` 在那种 PATH 下会连同入口一起找不到（实测 `ENOENT`）。
 *  探测发生在模块加载期，那时 PATH 还是调用者的正常 PATH。 */
function nodePath(): string {
  if (cachedNode !== null) return cachedNode;
  if (process.env.FAKE_GH_NODE) return (cachedNode = process.env.FAKE_GH_NODE);
  const finder = process.platform === "win32" ? "where" : "which";
  const found = Bun.spawnSync({ cmd: [finder, "node"], stdout: "pipe", stderr: "pipe" });
  const first = found.stdout
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  cachedNode = found.exitCode === 0 && first ? first : "node";
  return cachedNode;
}

/** CLI 入口该由谁启动。 */
export const cliRunner = (): { command: string; args: readonly string[] } =>
  process.platform === "win32"
    ? { command: nodePath(), args: ["--no-warnings", "--experimental-transform-types"] }
    : { command: process.execPath, args: [] };

const cacheByBody = new Map<string, { bin: string; env: Record<string, string> }>();

/**
 * 装一次假 gh（模块级缓存，整个测试文件共用）。
 *
 * Windows：编译 `gh.exe` 并预热；fixture 正文写在独立 `.ts` 里，用 `FAKE_GH_ENTRY` 指过去，
 * 场景仍由 `WATCH_FIXTURE` 等环境变量切换——上游 fixture 本来就是这么写的，正文无需改动。
 * POSIX：原样写 shebang 脚本。
 *
 * @param body fixture 源码（ESM，可用 top-level await）。
 */
export function installFakeGh(body: string): { bin: string; env: Record<string, string> } {
  // 按 body 内容缓存：同一测试文件里 body 通常一致（上游 fixture 就是一份），
  // 但 `fixture()` 这类包装函数会**每个用例各调一次**，不按内容缓存就会各编译一份——
  // `bun build --compile` 约 4.4s，直接撞满用例的 3–5s 预算（实测 `exit null` = 被自身超时打断）。
  const key = body;
  const hit = cacheByBody.get(key);
  if (hit !== undefined) return hit;
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  if (process.platform !== "win32") {
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!${process.execPath}\n${body}`);
    chmodSync(gh, 0o755);
    const posix = { bin: dir, env: {} as Record<string, string> };
    cacheByBody.set(key, posix);
    return posix;
  }

  const fixture = join(dir, "gh-fixture.ts");
  writeFileSync(fixture, body);
  const exe = join(dir, "gh.exe");
  const built = Bun.spawnSync({
    cmd: ["bun", "build", "--compile", "--outfile", exe, fixture],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0 || !existsSync(exe)) {
    throw new Error(
      `fake gh failed to compile (exit ${built.exitCode}): ${built.stderr.toString().slice(0, 400)}`,
    );
  }
  // 预热：编译产物的**首次执行**要建缓存（约 3.5–5s，之后 40–80ms）。这笔成本必须落在 setup 里，
  // 否则会吃光某个用例的 5s 预算。
  // 特意用一个独立的最小 fixture 预热——真实 fixture 对未知场景会抛错（它按 WATCH_FIXTURE 分支），
  // 拿它预热会直接失败（实测踩过）。
  const warmFixture = join(dir, "warm.ts");
  writeFileSync(warmFixture, "process.exit(0);\n");
  const warmExe = join(dir, "warm.exe");
  const warmBuilt = Bun.spawnSync({
    cmd: ["bun", "build", "--compile", "--outfile", warmExe, warmFixture],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (warmBuilt.exitCode === 0) {
    Bun.spawnSync({ cmd: [warmExe], stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  }
  const result = { bin: dir, env: {} as Record<string, string> };
  cacheByBody.set(key, result);
  return result;
}

/** 把 bin 目录前置到 PATH——分隔符必须按平台，POSIX 冒号在 Windows 上会让整条 PATH 失效。 */
export function pathWith(bin: string, base = process.env.PATH ?? ""): string {
  return `${bin}${delimiter}${base}`;
}

/**
 * 生成 entry 模块的 import 说明符（给 **node 运行时** 用）。
 *
 * node 的 ESM 加载器只接受 file:// URL：直接写裸 Windows 路径会得到
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'e:'`（实测）。bun 两种都接受，
 * 所以上游测试一直写裸路径。POSIX 上两者等价，保持裸路径与上游一致。
 *
 * 注意：**不要**把它用在假 gh 的 fixture 里——fixture 由 `bun build --compile` 打包，
 * 而打包器不认 file:// 说明符（`Could not resolve: "file:///..."`，实测）。
 */
export function moduleSpecifier(absPath: string): string {
  if (process.platform !== "win32") return absPath;
  return new URL(`file:///${absPath.replaceAll("\\", "/")}`).href;
}
