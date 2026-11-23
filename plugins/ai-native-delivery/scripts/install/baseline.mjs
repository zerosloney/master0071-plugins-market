// install/baseline.mjs — 升级三方合并的基线留存（2026-11 安装引擎重构新增）
// 蓝本：agentic-flow-kit src/install/baseline.mjs 判据级移植（存储结构自建；2026-11 内核单源化起
// mergeThreeWay 复用 kit kernel，经 ../lib/kit-kernel.mjs 适配缝转发，本模块不再自带合并实现）。
// 装户时把「上次给到的模板正文」留一份在 <root>/.agents/.install-baseline/；升级时以基线为 base、
// 磁盘现状为 ours、新模板为 theirs 走 git merge-file 三方合并——种子升级得以传播进用户改过的文件
//（clean 自动合并 / conflict 带冲突标记显式出账），git 不可用才由调用方回退旧的哈希冲突跳过语义。
// 口径约定：
//   - 基线面**不含 git hook 条目**：钩子无三方合并语义（陈旧自装钩子走覆盖刷新，见 apply.mjs），
//     「只写文本类资产进基线」由调用方 apply.mjs 保证，本模块不裁剪、不感知钩子。
//   - 本机不入库：.install-baseline/ 是本机数据，不进 gitignore 标记块账面——条目（BASELINE_DIR_NAME）
//     由 init-engine 的 .gitignore 标记块统一管理，本模块不管 gitignore。
//   - CRLF→LF 归一（口径同 kit kernel hashText）：writeBaseline 落盘前统一归一（mergeThreeWay 的
//     临时文件归一在 kit kernel，同一口径）——Windows autocrlf 检出差异既不进基线、也不构成假冲突。
// git 调用（三方合并部分随 mergeThreeWay 归 kit kernel）：merge-file 参数含一次性临时路径，
// git-core spawnGit 的 cwd+args 记忆化对其无复用价值，kit kernel 侧直接 spawnSync + windowsHide。
import fs from 'node:fs';
import path from 'node:path';
import { engineDir } from '../paths.mjs';

// 基线根 = <root>/.agents/.install-baseline/；BASELINE_DIR_NAME 是相对 .agents 的目录名，
// gitignore 标记块（plan.mjs GITIGNORE_ENTRIES）写的条目就是它。
export const BASELINE_DIR_NAME = '.install-baseline';

const baselineRoot = (target) => path.join(engineDir(target), BASELINE_DIR_NAME);

// 二进制资产没有文本三方合并语义，不进基线。
const BINARY_EXT = new Set(['.exe', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.woff', '.woff2', '.zip', '.gz', '.pdf']);

export function isBinaryPath(rel) {
  return BINARY_EXT.has(path.extname(String(rel)).toLowerCase());
}

// 基线条目的绝对路径；rel 是 posix 相对路径（'/ '分隔，同 manifest.files 键形）。
export function baselinePath(target, rel) {
  return path.join(baselineRoot(target), ...String(rel).replace(/\\/g, '/').split('/'));
}

export function readBaseline(target, rel) {
  try {
    return fs.readFileSync(baselinePath(target, rel), 'utf8');
  } catch {
    return null;
  }
}

// 落盘前 CRLF→LF 归一；二进制条目拒收（返回 false，调用方不为其记账）。
export function writeBaseline(target, rel, text) {
  if (isBinaryPath(rel)) return false;
  const abs = baselinePath(target, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(text).replace(/\r\n/g, '\n'), 'utf8');
  return true;
}

// 删单条基线，并向上清空空目录——止于基线根，不越界动 .agents 下其他内容。
export function removeBaseline(target, rel) {
  const abs = baselinePath(target, rel);
  try {
    fs.rmSync(abs, { force: true });
  } catch {
    return false;
  }
  const root = baselineRoot(target);
  let dir = path.dirname(abs);
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  return true;
}

// 全量列举基线条目（posix 相对路径，升序）。基线根不存在 → 空数组。
export function listBaselines(target) {
  const root = baselineRoot(target);
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

// 删掉 keepRels 之外的全部基线（升级完成后清理已消失的条目）；dryRun 只报告不落盘。
export function pruneBaselines(target, keepRels, { dryRun = false } = {}) {
  const keep = keepRels instanceof Set ? keepRels : new Set(keepRels || []);
  const removed = [];
  for (const rel of listBaselines(target)) {
    if (keep.has(rel)) continue;
    removed.push(rel);
    if (!dryRun) removeBaseline(target, rel);
  }
  return removed;
}

// mergeThreeWay：三方合并机件（git merge-file，clean/conflict/unavailable 三态），单源在
// agentic-flow-kit kernel（判据超集），经 lib/kit-kernel.mjs 适配缝转发——本模块只保留基线存储。
export { mergeThreeWay } from '../lib/kit-kernel.mjs';
