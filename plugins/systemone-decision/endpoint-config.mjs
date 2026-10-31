// endpoint-config.mjs — MCP 服务与需求预检 hook 的端点共享文件。
// 背景：hook 进程拿不到设置页注入的 SYSTEMONE_PLUGIN_* 变量（只有 MCP 服务进程有），
// 设置页切换供应商后 hook 仍打旧端点、失败后静默跳过。修复：MCP 服务每次启动把
// 「已解析」的端点（设置页 > 环境变量 > 默认的解析结果）落盘到共享文件，hook 读
// 同一份文件，两个进程天然指向同一个端点。
// 只共享 baseUrl / model / timeoutMs 三项非敏感字段——API Key 绝不落盘，仍只走环境变量。
// 路径基于本文件解析（而不是 cwd）：hook 进程的 cwd 是会话工作区，不是插件目录。
//
// 落盘位置：Agent Plugins 规范给宿主提供 PLUGIN_DATA——「跨插件更新保留的可写数据目录」，
// 端点共享文件属于运行时状态，落在那里才能跨插件更新存活。Claude Code / ZCode 等
// 非 Agent Plugins 宿主不提供该变量，此时回退到插件根 .endpoint.json（旧行为）。
// 读时两处都看，PLUGIN_DATA 优先；写时只写 PLUGIN_DATA（存在时）并清掉遗留的旧文件，
// 避免同一份配置存在两个副本、日后回退到旧文件时读到过期端点。

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
// 旧位置：插件根 .endpoint.json。保留读取能力，兼容没有 PLUGIN_DATA 的宿主。
const LEGACY_FILE = path.join(PLUGIN_ROOT, '.endpoint.json');

const dataDir = process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim() !== '' ? process.env.PLUGIN_DATA : null;
const DATA_FILE = dataDir ? path.join(dataDir, 'endpoint.json') : null;

// 读：PLUGIN_DATA 优先，回退插件根旧文件。
const READ_CANDIDATES = DATA_FILE ? [DATA_FILE, LEGACY_FILE] : [LEGACY_FILE];

/** 读一处配置；文件缺失/损坏或字段类型非法一律返回 null，调用方回退环境变量。 */
function readOne(file) {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    const baseUrl = typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== '' ? cfg.baseUrl : null;
    const model = typeof cfg.model === 'string' && cfg.model.trim() !== '' ? cfg.model : null;
    const t = Number(cfg.timeoutMs);
    const timeoutMs = Number.isFinite(t) && t > 0 ? t : null;
    return baseUrl || model || timeoutMs ? { baseUrl, model, timeoutMs } : null;
  } catch {
    return null;
  }
}

/** best-effort 落盘：失败仅 stderr 告警（hook 回退环境变量），绝不影响服务启动。
 *  写 PLUGIN_DATA（存在时）优先；它不可写就退回插件根，两处都失败才告警。 */
export function writeEndpointConfig({ baseUrl, model, timeoutMs }) {
  const payload = `${JSON.stringify({ baseUrl, model, timeoutMs }, null, 2)}\n`;
  const targets = DATA_FILE ? [DATA_FILE, LEGACY_FILE] : [LEGACY_FILE];
  const sleepMs = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  let lastErr = null;
  for (const file of targets) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      if (file === DATA_FILE) mkdirSync(dataDir, { recursive: true });
      writeFileSync(tmp, payload);
      // Windows 上目标文件正被 hook 并发读时 rename 可能 EPERM/EBUSY（decision-cache.mjs /
      // precheck-quota.mjs 同款场景已修）：有界重试，耗尽走外层告警——hook 回退环境变量。
      let renamed = false;
      for (let attempt = 0; !renamed; attempt += 1) {
        try {
          renameSync(tmp, file); // 临时文件 + 原子替换，读方不会读到半截 JSON
          renamed = true;
        } catch (e) {
          if (attempt >= 5 || !e || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e;
          sleepMs(25 * (attempt + 1));
        }
      }
      // 写到 PLUGIN_DATA 后清掉插件根的旧文件：两份副本日后只回退到旧文件会读到过期端点。
      if (file === DATA_FILE) {
        try {
          unlinkSync(LEGACY_FILE);
        } catch {}
      }
      return;
    } catch (e) {
      lastErr = e;
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  process.stderr.write(`[systemone-decision] 端点配置落盘失败，预检 hook 将回退环境变量：${lastErr?.message}\n`);
}

/** 读取共享端点：文件缺失/损坏或字段类型非法一律返回 null，调用方回退环境变量。 */
export function readEndpointConfig() {
  for (const file of READ_CANDIDATES) {
    const cfg = readOne(file);
    if (cfg) return cfg;
  }
  return null;
}

/** 回环主机名闭集：与 new URL().hostname 的输出口径对齐（IPv6 不带方括号）。 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** baseUrl 是否为不安全端点：非 https 且非本机回环。这类端点携带 Bearer Key 等于明文外泄凭据，
 *  MCP 服务与 hook 在发请求前都应据此拒绝（共享文件落在用户可写目录，值不可信）。
 *
 *  判据必须读**解析后的 hostname**，不能拿原始串做前缀正则（2026-10-29 实测）：
 *  旧实现用 `/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:\/]|$)/`。URL 的 userinfo 段出现在
 *  host 之前，于是 `http://localhost:8080@evil.example/v1` 的前缀命中 `localhost:8080`、冒号
 *  即满足分隔符，被整条判为「回环、安全」——而真正会被请求的 host 是 `evil.example`。
 *  实测三个变体全部判 safe：`http://localhost:8080@evil.example/v1`、
 *  `http://127.0.0.1:9@evil.example/v1`、`HTTP://LOCALHOST:80@evil.example/v1`。
 *  护栏看的是「开头像不像回环」，请求却发往「@ 之后那段」，两者不是同一个东西。
 *
 *  另：含内嵌凭据（userinfo）的 URL 一律判不安全。凭据不该出现在端点配置里——
 *  Key 走 Authorization 头，URL 里的口令只会被回显进日志与错误文案。 */
export function isInsecureBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return true;
  const raw = baseUrl.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    // 解析不了就不能证明它安全：宁可拒绝，也不把一个看不懂的串当成本机端点放行
    return true;
  }
  if (url.protocol === 'https:') return false;
  if (url.protocol !== 'http:') return true;
  // userinfo 存在即拒：`http://localhost@evil.example` 的 host 是 evil.example，
  // 且真实口令进过配置文件（会被错误文案回显）
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return !LOOPBACK_HOSTNAMES.has(host);
}

/** 端点的人类可读简称：只留 `<scheme>://<host>[:port]`，丢掉 path/query 与 userinfo。
 *  用于错误文案——把完整 URL 拼进工具结果会把内嵌口令原样回显给模型与日志。 */
export function endpointLabel(baseUrl) {
  try {
    const url = new URL(String(baseUrl).trim());
    const host = url.hostname ? `${url.hostname}${url.port ? `:${url.port}` : ''}` : '(unknown host)';
    return `${url.protocol}//${host}`;
  } catch {
    return '(unparsable baseUrl)';
  }
}

/** 设置页 / 环境变量交来的**数据文件路径**是否不可接受；可接受返回 null，否则返回拒绝理由。
 *
 *  背景：SYSTEMONE_LOG_FILE 与 SYSTEMONE_SCENARIOS_FILE 过去未经校验就交给 readFileSync /
 *  appendFileSync / writeFileSync。LOG_FILE 指到一个超过体积上限的非日志文件（如 6MB 的
 *  data.json）时，server 的截断分支会用一行标记**整体替换**该文件——用户数据当场消失。
 *  与 baseUrl 同理：设置页的值来自用户可写位置，不是可信输入。
 *
 *  三条硬规则（空值 = 功能关闭，由调用方先行判定，不进这里）：
 *   1. 必须是绝对路径。MCP 服务的 cwd 就是插件根，相对路径会把账本写进插件安装目录——
 *      那里跨项目共享、且下次插件更新即被覆盖。
 *   2. 扩展名必须在白名单内。指错文件时最坏结果是没写，而不是毁掉一个真实文件。
 *   3. 不得落在插件安装目录内，也不得落在任何 .git 目录段内（钩子与 ref 不是日志的去处）。
 */
export function rejectDataPath(value, extensions) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '路径含控制字符';
  if (!path.isAbsolute(raw)) return '必须是绝对路径（相对路径会落进插件安装目录，跨项目共享且随插件更新丢失）';

  const resolved = path.resolve(raw);
  // 段比较统一小写（2026-10-29 修复；2026-10-31 补 darwin）：Windows 与 macOS 默认卷大小写
  // 不敏感，`.GIT` 与 `.git` 是同一个目录，而旧实现按原样比较 `.git`，于是 `.GIT/` 下的路径轻松
  // 通过护栏——「不得落在 .git 目录内」在大小写不敏感卷上形同虚设。初版只落了 win32，
  // 注释声称管 macOS 代码却没管——darwin 默认卷（APFS/HFS+）同样大小写不敏感。
  const norm = (s) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
  const segments = resolved.split(/[\\/]+/);
  if (segments.some((s) => s.toLowerCase() === '.git')) return '路径位于 .git 目录内';
  const pluginRoot = norm(PLUGIN_ROOT);
  const probe = norm(resolved);
  if (probe === pluginRoot || probe.startsWith(`${pluginRoot}${path.sep}`)) {
    return `路径位于插件安装目录内（插件根=${PLUGIN_ROOT}）`;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!extensions.includes(ext)) {
    return `扩展名必须是 ${extensions.join(' / ')}（当前 ${ext || '无扩展名'}）——拒绝指向非数据文件，避免截断时毁掉真实文件`;
  }
  return null;
}
