// install/baseline.mjs — 升级三方合并的基线留存（2026-11 安装引擎重构新增）
// 蓝本：agentic-flow-kit src/install/baseline.mjs 判据级移植（结构自建，不 import 蓝本仓、不共代码）。
// 装户时把「上次给到的模板正文」留一份在 <root>/.agents/.install-baseline/；升级时以基线为 base、
// 磁盘现状为 ours、新模板为 theirs 走 git merge-file 三方合并——种子升级得以传播进用户改过的文件
//（clean 自动合并 / conflict 带冲突标记显式出账），git 不可用才由调用方回退旧的哈希冲突跳过语义。
// 口径约定：
//   - 基线面**不含 git hook 条目**：钩子无三方合并语义（陈旧自装钩子走覆盖刷新，见 apply.mjs），
//     「只写文本类资产进基线」由调用方 apply.mjs 保证，本模块不裁剪、不感知钩子。
//   - 本机不入库：.install-baseline/ 是本机数据，不进 gitignore 标记块账面——条目（BASELINE_DIR_NAME）
//     由 init-engine 的 .gitignore 标记块统一管理，本模块不管 gitignore。
//   - CRLF→LF 归一（口径同 manifest.mjs hashText）：writeBaseline 落盘前与 mergeThreeWay 写临时
//     文件前统一归一——Windows autocrlf 检出差异既不进基线、也不构成假冲突。
// git 调用：不经 git-core spawnGit——它按 cwd+args 记忆化结果，而 merge-file 参数含一次性临时路径，
// 缓存无复用价值且随合并次数无限增长（整份合并正文常驻内存）；其基础设施告警文案也是 git 探测语义。
// 仅复用其 GIT 常量（Windows git.exe 显式解析 + CHECK_LOOP_GIT 测试注入点），spawn 走本模块
// spawnSync + windowsHide。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { engineDir } from '../paths.mjs';
import { GIT } from '../git-core.mjs';

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

// 三方合并：git merge-file 以 base 为基线、ours 为磁盘现状、theirs 为新模板。临时目录写三文件
//（写前 CRLF→LF 归一，同 writeBaseline 口径）→ `git merge-file -p -q -L current -L baseline -L kit`。
// 退出码判据：0=clean；1–127=conflict（git 以冲突块数作退出码，text 带冲突标记）；
// >127 / 负值 / status 非数值（信号杀死）/ 进程 error = unavailable——git 不可用或异常，
// 调用方回退跳过语义。finally 清理临时目录。返回 { status, text? }。
export function mergeThreeWay({ base, ours, theirs }) {
  const norm = (t) => String(t).replace(/\r\n/g, '\n');
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-merge-'));
    const oursFile = path.join(dir, 'ours');
    const baseFile = path.join(dir, 'base');
    const theirsFile = path.join(dir, 'theirs');
    fs.writeFileSync(oursFile, norm(ours), 'utf8');
    fs.writeFileSync(baseFile, norm(base), 'utf8');
    fs.writeFileSync(theirsFile, norm(theirs), 'utf8');
    const result = spawnSync(
      GIT,
      ['merge-file', '-p', '-q', '-L', 'current', '-L', 'baseline', '-L', 'kit', oursFile, baseFile, theirsFile],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || typeof result.status !== 'number' || result.status < 0 || result.status > 127) {
      return { status: 'unavailable' };
    }
    return {
      status: result.status === 0 ? 'clean' : 'conflict',
      text: result.stdout,
    };
  } catch {
    return { status: 'unavailable' };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
