import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliRunner, installFakeGh, moduleSpecifier, pathWith } from "./fake-gh.test-helper.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// 假 gh 装一次（Windows 上要编译 + 预热，见 helper）；场景由 WATCH_FIXTURE 切换。
const fake = installFakeGh(`import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const scenario = process.env.WATCH_FIXTURE;
appendFileSync(process.env.WATCH_CALLS, JSON.stringify(args) + '\\n');
if (scenario === 'slow') {
  writeFileSync(process.env.WATCH_PID, String(process.pid));
  await new Promise(resolve => setTimeout(resolve, 2000));
}
const noCi = scenario.startsWith('no-ci');
const fail = (stderr) => { console.error(stderr); process.exit(1); };
let value;
if (args.some(a => a.includes('query PullRequestFacts'))) {
  value = { data: { repository: { pullRequest: { headRefOid: 'head', baseRef: { target: { oid: 'base' } }, mergeable: 'MERGEABLE', mergeStateStatus: scenario === 'no-ci-blocked' ? 'BLOCKED' : 'CLEAN', reviewDecision: noCi ? null : 'APPROVED', headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergedAt: null, isDraft: false } } } };
} else if (args[0] === 'pr' && args[1] === 'checks') {
  if (scenario === 'no-ci-unauthorized') fail('HTTP 401: Bad credentials (https://api.github.com/graphql)');
  if (noCi) fail("no checks reported on the 'feature' branch");
  value = [{ name: 'ci', state: 'SUCCESS', bucket: 'pass', description: '', link: '', workflow: '' }];
} else if (args.some(a => a.includes('query PrCheckRollup'))) {
  if (scenario === 'no-ci-rollup-fails') fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } } };
} else if (noCi && args.some(a => a.includes('query PrCommitStatuses'))) {
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: null } }] } } } } };
} else if (args[0] === 'pr' && args[1] === 'list') {
  value = [{ number: 1, headRefName: 'main', baseRefName: 'main', headRepository: { name: 'repo', nameWithOwner: 'fork/repo' }, headRepositoryOwner: { login: 'fork' } }];
} else if (args[0] === 'repo' && args[1] === 'view') {
  value = { defaultBranchRef: { name: 'main' } };
} else if (args.some(a => a.includes('query ReviewThreads'))) {
  const after = args.find(a => a.startsWith('after='));
  const thread = (n, resolved) => ({ id: 't' + n, isResolved: resolved, comments: { nodes: [] } });
  const paginated = scenario === 'threads' || scenario === 'stuck-cursor';
  value = { data: { repository: { pullRequest: { reviewThreads: {
    nodes: paginated ? (after ? [thread(100, false)] : Array.from({length: 100}, (_, n) => thread(n, true))) : [],
    pageInfo: { hasNextPage: paginated && (!after || scenario === 'stuck-cursor'), endCursor: paginated ? 'next' : null }
  } } } } };
} else if (args.some(a => a.includes('query PrCommitStatuses'))) {
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: { state: 'SUCCESS' } } }] } } } } };
} else { throw new Error('unexpected fixture command: ' + JSON.stringify(args)); }
console.log(JSON.stringify(value));
`);

function run(scenario: string, extra: string[] = [], path?: string) {
  const dir = mkdtempSync(join(tmpdir(), "watch-transport-"));
  directories.push(dir);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(moduleSpecifier(join(import.meta.dir, "cli.ts")))}; process.exitCode = await main(process.argv.slice(2));\n`
  );
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(callsFile, "");
  const pidFile = join(dir, "pid");
  const started = performance.now();
  // Windows 上用 node 跑入口：bun 父进程启动 bun 二进制固定约 3.5s，会吃光 5s 预算
  // （根因与实测数据见 fake-gh.test-helper.ts 的注释）。
  const runner = cliRunner();
  // Windows 上 node.exe 起不来若缺 SystemRoot/PATHEXT 这类系统变量：POSIX 的 shebang 用绝对路径
  // 恰好不受影响，所以上游只给 PATH 是够的。这里只在 Windows 上补必需项，不整体继承 process.env
  // （实测整体继承会让 fake gh 的 PATH 覆盖失效，反而弄坏三条用例）。
  const baseEnv = process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        SystemDrive: process.env.SystemDrive ?? "C:",
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\system32\\cmd.exe",
        TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
        TMP: process.env.TMP ?? "C:\\Windows\\Temp",
      }
    : {};
  const result = spawnSync(
    runner.command,
    [...runner.args, entry, "--owner", "owner", "--repo", "repo", "--pr", "1", ...extra],
    {
      encoding: "utf8",
      timeout: 6000,
      env: {
        ...baseEnv,
        // PATH 分隔符必须按平台；Windows 上假的 gh 是真 .exe（见 helper）。
        PATH: path ?? pathWith(fake.bin),
        WATCH_FIXTURE: scenario,
        WATCH_CALLS: callsFile,
        WATCH_PID: pidFile,
      },
    }
  );
  return {
    ...result,
    elapsed: performance.now() - started,
    calls: readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
    pidFile,
  };
}

it("reads page two before reporting unresolved review threads", () => {
  const result = run("threads");
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: { kind: "review-threads", threads: [{ id: "t100" }] },
  });
  expect(
    result.calls.filter((args) => args.includes("after=next"))
  ).toHaveLength(1);
});

it("rejects a repeating page cursor instead of looping or silently truncating", () => {
  const result = run("stuck-cursor", ["--max-query-errors", "1"]);
  expect(result.status).toBe(7);
  expect(
    result.calls.filter((args) =>
      args.some((arg) => arg.includes("ReviewThreads"))
    )
  ).toHaveLength(2);
});

it("keeps a fork main branch distinct from destination main during stack discovery", () => {
  const result = run("fork", ["--stack", "--status-only"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "STATUS",
    rows: [{ context: { number: 1 } }],
  });
});

const verdicts = (stdout: string): unknown[] =>
  stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

// The no-ci fixtures replay what gh returned for a mergeable PR in a repository
// with no checks configured: `gh pr checks` exits 1 with "no checks reported"
// and the head commit's statusCheckRollup is null.
it("reports a first sighting of no checks on a status-only pass", () => {
  const result = run("no-ci", ["--status-only", "--max-query-errors", "1"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "STATUS",
    terminal: true,
    rows: [{ kind: "open", ci: { kind: "ci-unreported" } }],
  });
});

// Confirming no checks takes 60 seconds of wall time, so a test on the real
// clock can only show the wait. A loaded machine fits fewer polls into the
// deadline, so this asserts what each poll said and not how many there were.
it("keeps a PR with no checks waiting through short-interval polls until the deadline", () => {
  for (const scenario of ["no-ci", "no-ci-blocked"]) {
    const result = run(scenario, [
      "--max-query-errors",
      "1",
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ]);
    expect(result.status).toBe(5);
    const emitted = verdicts(result.stdout);
    for (const wait of emitted.slice(0, -1))
      expect(wait).toMatchObject({
        kind: "WAITING",
        reason: { kind: "checks-unreported" },
      });
    expect(emitted.at(-1)).toMatchObject({ kind: "TIMEOUT" });
  }
});

it("fails closed when the check queries fail instead of reporting no checks", () => {
  for (const scenario of ["no-ci-unauthorized", "no-ci-rollup-fails"]) {
    const result = run(scenario, ["--status-only", "--max-query-errors", "1"]);
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      kind: "BLOCKER",
      blocker: { kind: "status-query" },
    });
  }
});

it("exits 7 with a JSON verdict when gh is not on PATH", () => {
  // Windows 上入口本身是 node（见 cliRunner），把 PATH 整个换成 /nonexistent 会让 node 也找不到，
  // 子进程根本起不来。改成「PATH 里只有 node 自己所在的目录，没有 gh」——语义仍是「gh 不在 PATH」。
  // node.exe 在 Windows 上需要系统目录才能加载运行时 DLL，所以这里不能只给 node 所在目录。
  const ghlessPath = process.platform === "win32"
    ? [dirname(process.execPath), `${process.env.SystemRoot ?? "C:\\Windows"}\\system32`].join(";")
    : "/nonexistent";
  const result = run("missing-gh", [], ghlessPath);
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    exitCode: 7,
    blocker: {
      kind: "status-query",
      failures: 1,
      failure: { kind: "spawn-failed", retryable: false },
    },
  });
});

it("cancels an in-flight command at the CLI deadline", () => {
  const result = run("slow", ["--timeout", "0.25"]);
  expect(result.status).toBe(5);
  expect(result.elapsed).toBeLessThan(1500);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ kind: "TIMEOUT" });
  const pid = Number(readFileSync(result.pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
