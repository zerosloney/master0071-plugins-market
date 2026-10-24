import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// This tooling is bun-only (import.meta.dir, Bun.spawnSync, bun.lock). Fail with a
// clear message instead of an opaque `import.meta.dir is undefined` crash under node.
if (typeof Bun === "undefined") {
  console.error(
    "pstack poteto-mode tooling requires bun (https://bun.sh). Install bun, then re-run."
  );
  process.exit(1);
}

const scriptsDirectory = import.meta.dir;
const nodeModulesDirectory = join(scriptsDirectory, "node_modules");
const commanderPackagePath = join(
  nodeModulesDirectory,
  "commander",
  "package.json"
);
const installKeyPath = join(
  nodeModulesDirectory,
  ".poteto-mode-tools-install-key"
);

function currentInstallKey(): string {
  return createHash("sha256")
    .update(readFileSync(join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(readFileSync(join(scriptsDirectory, "bun.lock")))
    .digest("hex");
}

export function ensureDependenciesInstalled(): void {
  const installKey = currentInstallKey();
  if (
    existsSync(commanderPackagePath) &&
    existsSync(installKeyPath) &&
    readFileSync(installKeyPath, "utf8").trim() === installKey
  ) {
    return;
  }

  // The install is in place (bun resolves bare imports like commander by
  // walking up from this script, so a cache directory outside the plugin tree
  // would not be found). State why a failure happens instead of bubbling an
  // opaque spawn error: a read-only plugin checkout surfaces in the probe
  // write below, a machine with no network access in the spawn failure.
  try {
    writeFileSync(installKeyPath, "");
  } catch (error) {
    console.error(
      `pstack poteto-mode tooling cannot write its install key in ${nodeModulesDirectory}: the plugin directory looks read-only or blocked. Make ${scriptsDirectory} writable (or pre-run "bun install --frozen-lockfile --production" there), then re-run.`,
    );
    throw error;
  }

  const result = Bun.spawnSync(
    [process.execPath, "install", "--frozen-lockfile", "--production"],
    { cwd: scriptsDirectory }
  );
  if (result.exitCode !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.error(
      `pstack poteto-mode tooling could not install its dependencies in ${scriptsDirectory}. This needs network access on first use (or a warm bun cache); after a offline failure, re-run once online.`,
    );
    throw new Error(
      `bun install --frozen-lockfile exited with status ${result.exitCode}`
    );
  }
  if (!existsSync(commanderPackagePath)) {
    throw new Error(
      "bun install --frozen-lockfile completed without installing commander"
    );
  }

  writeFileSync(installKeyPath, `${installKey}\n`);
}
