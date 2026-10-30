import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { object } from "./landing.ts";
import { cliRunner, installFakeGh, moduleSpecifier, pathWith } from "./fake-gh.test-helper.ts";

function fixture(
  body: (
    run: (...args: string[]) => {
      status: number | null;
      output: Record<string, unknown>;
    },
    file: string,
    dir: string
  ) => void
) {
  const dir = mkdtempSync(join(tmpdir(), "shipping-cli-"));
  const file = join(dir, "state.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: "pr-id",
      state: "OPEN",
      headRefOid: "head",
      baseRefName: "main",
      baseRefOid: "stored-base",
      baseRef: { target: { oid: "base" } },
      autoMergeRequest: { enabledAt: "now" },
      mergeQueueEntry: { id: "queue" },
      mergeCommit: null,
    })
  );
  // 假 gh 装一次（Windows 上要编译 + 预热，见 fake-gh.test-helper.ts 的根因注释）。
  const fake = installFakeGh(`import { readFileSync, writeFileSync } from 'node:fs';
import { fakeGitHub } from ${JSON.stringify(join(import.meta.dir, "shipping.test-helper.ts"))};
const state = JSON.parse(readFileSync(process.env.SHIPPING_STATE, 'utf8'));
const response = fakeGitHub(state, process.argv.slice(2));
writeFileSync(process.env.SHIPPING_STATE, JSON.stringify(state));
console.log(JSON.stringify(response));
`);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(moduleSpecifier(join(import.meta.dir, "shipping-cli.ts")))}; process.exitCode = await main(process.argv.slice(2));`
  );
  const run = (...args: string[]) => {
    // Windows 上用 node 跑入口：bun 父进程启动 bun 二进制固定约 3.5s，会吃光 3s 预算。
    const runner = cliRunner();
    const result = spawnSync(runner.command, [...runner.args, entry, ...args], {
      encoding: "utf8",
      timeout: 3000,
      env: {
        // Windows 的 node.exe 需要系统目录才能起；POSIX 的 shebang 用绝对路径，不受影响。
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD" }
          : {}),
        PATH: pathWith(fake.bin),
        SHIPPING_STATE: file,
      },
    });
    return {
      status: result.status,
      output: object(JSON.parse(result.stdout), "CLI result"),
    };
  };
  try {
    body(run, file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 这条用例要起 **3 个** CLI 子进程（inspect / cancel-pending / 读回），Windows 上每个子进程是
// node 启动 + 一次假 gh 调用，实测合计约 5.1s，刚越过 bun 默认的 5s 用例超时。这不是产品慢，
// 而是「多往返用例」与「单往返预算」不匹配——上游默认 5s 是为单往返设的。故显式给 20s。
it("the CLI inspects, saves, cancels both mechanisms, and reads back in fresh processes", () =>
  fixture((run, file, dir) => {
    const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
    expect(inspected.status).toBe(0);
    expect(object(inspected.output.record, "record").revision).toEqual({
      context: { owner: "owner", repo: "repo", number: 1 },
      headRefOid: "head",
      baseRefName: "main",
      baseRefOid: "base",
    });
    const saved = join(dir, "record.json");
    writeFileSync(saved, JSON.stringify(inspected.output));
    const cancelled = run("cancel-pending", "--record", saved);
    expect(cancelled.status).toBe(0);
    expect(cancelled.output).toMatchObject({
      kind: "cancelled",
      record: { pending: { autoMerge: false, queueEntryId: null } },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      autoMergeRequest: null,
      mergeQueueEntry: null,
    });
  }), 20_000);

it("the CLI refuses a changed base without cancelling anything", () =>
  fixture((run, file, dir) => {
    const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
    const saved = join(dir, "record.json");
    writeFileSync(saved, JSON.stringify(inspected.output));
    const changed = {
      ...JSON.parse(readFileSync(file, "utf8")),
      baseRef: { target: { oid: "advanced" } },
    };
    writeFileSync(file, JSON.stringify(changed));
    const result = run("cancel-pending", "--record", saved);
    expect(result.status).toBe(1);
    expect(result.output.kind).toBe("changed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(changed);
  }));

it("the CLI treats a missing queue field as unavailable", () =>
  fixture((run, file) => {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.mergeQueueEntry;
    writeFileSync(file, JSON.stringify(raw));
    const result = run("inspect", "--repo", "owner/repo", "--pr", "1");
    expect(result.status).toBe(1);
    expect(result.output.kind).toBe("unavailable");
  }));

for (const state of ["CLOSED", "MERGED"]) {
  it(`the CLI inspects a ${state} PR with a deleted base and refuses cancellation`, () =>
    fixture((run, file, dir) => {
      const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
      expect(inspected.status).toBe(0);
      const saved = join(dir, "record.json");
      writeFileSync(saved, JSON.stringify(inspected.output));
      const terminal = {
        ...JSON.parse(readFileSync(file, "utf8")),
        state,
        baseRef: null,
        autoMergeRequest: null,
        mergeQueueEntry: null,
        mergeCommit: state === "MERGED" ? { oid: "merged" } : null,
      };
      writeFileSync(file, JSON.stringify(terminal));
      const record = {
        state,
        revision: { baseRefOid: "stored-base" },
        mergeCommitOid: state === "MERGED" ? "merged" : null,
      };

      const observed = run("inspect", "--repo", "owner/repo", "--pr", "1");
      expect(observed.status).toBe(0);
      expect(observed.output).toMatchObject({ kind: "inspected", record });
      const cancelled = run("cancel-pending", "--record", saved);
      expect(cancelled.status).toBe(1);
      expect(cancelled.output).toMatchObject({ kind: "not-open", record });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(terminal);
    }));
}
