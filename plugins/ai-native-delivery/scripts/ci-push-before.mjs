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
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    advisory(`changes API HTTP ${res.status}`);
    return null;
  }
  return res.json();
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
