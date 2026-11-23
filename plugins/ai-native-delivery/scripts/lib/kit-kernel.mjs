// lib/kit-kernel.mjs — kernel 机件适配缝（2026-11 内核单源化）：hashText / hashFile /
// dirtyTreeDigest / mergeThreeWay 单源在全局安装的 agentic-flow-kit（判据为插件侧已验证超集，
// CRLF→LF 归一口径一致）。本文件是全插件唯一知道 kit 包位置的解析点；惰性解析 + 进程内缓存，
// 不顶层 await——doctor 等纯静态检查在 kit 缺席时须能跑完自诊断（kitKernelStatus 探测不抛错）。
// 热路径（check-loop 链）不经此文件。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// 最低 kit 版本：kernel 门面（agentic-flow-kit#75）随 2.12.0 首发的下限。
export const MIN_KIT_VERSION = '2.12.0';

// 统一修复提示（fail-loud 错误消息的固定尾巴）。
const FIX_HINT = 'npm install -g agentic-flow-kit@latest（开发机可设 FLOW_KIT_ROOT 指向 kit 包根）';

// parseVersion(v)：严格 x.y.z 三段数值；非该形态（前缀 / 预发布后缀等）视为不合格。
const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

// atLeast(v, min)：三段数值逐位比较。
const atLeast = (v, min) => {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
};

// resolveKitRoot()：只定位不校验。FLOW_KIT_ROOT（指 kit 包根，含 package.json）设置了就认，
// 指错由 loadKernel 的校验 fail-loud，不回退 npm root -g；缺省走 `npm root -g` 末行 + /agentic-flow-kit。
function resolveKitRoot() {
  const env = process.env.FLOW_KIT_ROOT;
  if (env) return env;
  // 命令字符串形式（shell:true + args 数组触发 DEP0190；此处参数为固定字面量，无拼接面）。
  const r = spawnSync('npm root -g', { encoding: 'utf8', windowsHide: true, shell: true });
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (r.error || r.status !== 0 || !line) {
    throw new Error(`无法定位全局 agentic-flow-kit（npm root -g 无输出或失败）——${FIX_HINT}`);
  }
  return path.join(line, 'agentic-flow-kit');
}

// loadKernel()：惰性解析 + 进程内缓存。版本门禁（≥ MIN_KIT_VERSION，三段数值比较）→ 包完整性
//（package.json 可读 + src/kernel/index.mjs 在位）→ require 同步加载（Node ≥ 22.12 支持 require ESM）。
// 任一不合格 throw Error（中文一句 + 修复提示），调用方按需自捕。
let cached = null;
function loadKernel() {
  if (cached) return cached;
  const root = resolveKitRoot();
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch { /* 包不完整 → 统一不合格分支 */ }
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`agentic-flow-kit 包不完整（读不到合法 version：${root}）——${FIX_HINT}`);
  }
  if (!atLeast(parsed, parseVersion(MIN_KIT_VERSION))) {
    throw new Error(`agentic-flow-kit 版本过低（${version} < ${MIN_KIT_VERSION}）——${FIX_HINT}`);
  }
  const entry = path.join(root, 'src', 'kernel', 'index.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`agentic-flow-kit 包不完整（缺 src/kernel/index.mjs：${root}）——${FIX_HINT}`);
  }
  let kernel;
  try {
    kernel = createRequire(import.meta.url)(entry);
  } catch (err) {
    throw new Error(`加载 kit 内核失败（${err && err.message ? err.message : err}）——require ESM 需 Node ≥ 22.12（当前 ${process.version}），请升级 Node 后重试；${FIX_HINT}`);
  }
  cached = { root, version, kernel };
  return cached;
}

// kitKernelStatus()：探测不抛错（doctor 自检用）。{ ok:true, root, version } | { ok:false, error }。
export function kitKernelStatus() {
  try {
    const { root, version } = loadKernel();
    return { ok: true, root, version };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// 四机件同步包装：转发到缓存的 kernel 模块（签名与 kit kernel 门面逐一对应）。
export const hashText = (text) => loadKernel().kernel.hashText(text);
export const hashFile = (abs) => loadKernel().kernel.hashFile(abs);
export const dirtyTreeDigest = (root) => loadKernel().kernel.dirtyTreeDigest(root);
export const mergeThreeWay = (args) => loadKernel().kernel.mergeThreeWay(args);
