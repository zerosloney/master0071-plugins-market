#!/usr/bin/env node
// 在 CI 上解析本次构建关联提交里最老一笔的第一父，
// 用 logging command 写入 CI_PUSH_BEFORE，供 check-lane-surface --ci 做整段 push diff。
// CI 供应商差异留适配点（2026-10-27 插件化迁移口径）：内联默认按 Azure DevOps 供建变量
// （SYSTEM_* / BUILD_BUILDID）+ changes API + ##vso 输出指令形态实现；换供应商改 loadChanges
// 取数段与输出指令两处，ciPushBefore 纯函数不感知供应商。
// 任何失败都 exit 0：缺令牌、HTTP 非 200、空列表、第一父不是 sha → stderr advisory，
// 泳道门退回 HEAD~1。不在这里访问网络以外的副作用。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ciPushBefore } from './check-lane-surface.mjs';

const advisory = (msg) => {
  console.error(`ci-push-before: advisory: ${msg}——泳道 CI 退回 HEAD~1`);
};

const argOf = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
};

const loadChanges = async () => {
  const file = argOf('--changes-file');
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const token = process.env.SYSTEM_ACCESSTOKEN || '';
  const collection = process.env.SYSTEM_COLLECTIONURI || '';
  const project = process.env.SYSTEM_TEAMPROJECT || '';
  const buildId = process.env.BUILD_BUILDID || '';
  if (!token || !collection || !project || !buildId) {
    advisory('缺少 SYSTEM_ACCESSTOKEN / SYSTEM_COLLECTIONURI / SYSTEM_TEAMPROJECT / BUILD_BUILDID');
    return null;
  }
  const url = `${collection.replace(/\/?$/, '/')}${encodeURIComponent(project)}/_apis/build/builds/${encodeURIComponent(buildId)}/changes?api-version=7.1`;
  // SYSTEM_COLLECTIONURI 由流水线环境提供，属不可信输入：拼成 http:// 就是把 Bearer 令牌
  // 明文送出（也可能被指向任意主机）。本机回环放行——自建 Agent 与本地调试确实用 http。
  // 口径同本仓 systemone-decision 的 isInsecureBaseUrl（那边在 0.5.5 补的）。
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    advisory(`SYSTEM_COLLECTIONURI 不是合法 URL：${collection}`);
    return null;
  }
  const loopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1])([:\/]|$)/i.test(url);
  if (endpoint.protocol !== 'https:' && !loopback) {
    advisory(`拒绝向非 https 端点附带 Bearer 令牌（凭据会明文外泄）：${endpoint.origin}`);
    return null;
  }
  // 本脚本对 CI 的承诺是「任何失败都 exit 0」：fetch 抛错（DNS / 拒连 / 坏端口）与
  // 非 JSON 响应体都必须收成 advisory，否则未捕获拒绝直接把整条流水线打红——
  // 泳道门只是拿不到 CI_PUSH_BEFORE、退回 HEAD~1 而已，不值得为此挂构建。
  let res;
  try {
    res = await fetch(endpoint.href, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    advisory(`changes API 请求失败（${e.cause?.message || e.message}）`);
    return null;
  }
  if (!res.ok) {
    advisory(`changes API HTTP ${res.status}`);
    return null;
  }
  try {
    return res.json();
  } catch (e) {
    advisory(`changes API 响应不是合法 JSON（${e.message}）`);
    return null;
  }
};

const changes = await loadChanges();
if (changes) {
  const parentOf = (id) => {
    const r = spawnSync('git', ['rev-parse', `${id}^`], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  };
  const { before, reason } = ciPushBefore(changes, parentOf);
  if (!before) advisory(reason);
  else console.log(`##vso[task.setvariable variable=CI_PUSH_BEFORE]${before}`);
}
process.exit(0);
