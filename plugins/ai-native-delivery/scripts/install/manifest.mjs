// install/manifest.mjs — sha256 安装台账（2026-11 安装引擎重构新增）
// 形状：{ plugin, version, files: { "<相对路径，/ 分隔>": "<sha256>" } }，落 <root>/.agents/install-manifest.json。
// 台账语义同 lock 文件：**入库共享**（init 不把它写进 .gitignore 标记块），记录「上次安装给到的基线」——
// apply 段据此区分「种子升了」（update）与「用户改了」（conflict skip）。
// 哈希口径：统一 **CRLF→LF 归一后** sha256——种子源与落盘目标同一归一，Windows autocrlf 检出差异
// 不构成假冲突（先例：confirm-doc.mjs computeFingerprint 同归一）。git hooks 记**渲染后**正文
//（渲染时已归一 LF）；gitignore 标记块不入账（块级合并不是整文件）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { engineDir } from '../paths.mjs';

export const MANIFEST_FILENAME = 'install-manifest.json';
export const manifestPath = (root) => path.join(engineDir(root), MANIFEST_FILENAME);

// hashText(text)：CRLF→LF 归一 → sha256 hex。所有入账哈希（种子源 / 落盘目标 / 渲染后钩子）同一口径。
export function hashText(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function hashFile(abs) {
  return hashText(fs.readFileSync(abs, 'utf8'));
}

// serializeManifest(manifest)：稳定序列化（2 空格缩进 + 收尾换行）。apply 段先比对此文本、
// 一致则不重写——幂等契约「重复跑零改动」要求台账字节也不动（测试做全树 mtime 快照比对）。
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// readManifest(root)：缺文件 / 损坏（JSON 解析失败或 files 非对象）→ null。返回 null 时 apply 段
// 进领养模式（现状哈希全部记入新账、不覆盖任何文件）——损坏按缺失处理是**不丢数据**的方向：
// 领养永不覆盖，最坏代价只是丢掉「可传播升版」的基线。
export function readManifest(root) {
  let raw;
  try { raw = fs.readFileSync(manifestPath(root), 'utf8'); } catch { return null; }
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return null;
    return m;
  } catch { return null; }
}

// writeManifestAtomic(root, manifest)：同目录 tmp + rename 原子写（写法口径同 mcp/core.mjs
// writeAtomic，自包含不 import mcp/——安装段与 MCP 服务是两个进程面，不共代码也不共状态）。
// 直接 writeFileSync 是「先截断后写」，进程中途崩溃会留下半写台账；失败清 tmp 重抛，原文件保持原样。
export function writeManifestAtomic(root, manifest) {
  const target = manifestPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, serializeManifest(manifest), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp 可能尚未创建 */ }
    throw new Error(`安装台账写入失败：${target}（${err.message}）——原文件应保持原样，请核对后重试`);
  }
}
