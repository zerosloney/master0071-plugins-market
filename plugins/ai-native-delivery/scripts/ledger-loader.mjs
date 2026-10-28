#!/usr/bin/env node
// ledger-loader.mjs — 统一台账分片加载与写入器（2026-10-10 中期方案）
// 解决多人并发与单人多 worktree 并行时中央单文件写入冲突：
// 既兼容存量单文件 .agents/confirmations.jsonl，又透明支持分片目录 .agents/confirmations.d/*.jsonl。

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './paths.mjs';

// 默认根锚定 git root（paths.mjs 单源）：调用方不显式传根时，子目录调用不漂移。
export function loadAllConfirmations(root = projectRoot()) {
  // 按 doc + stage + fingerprint 去重，**保留末次出现**——append-only 台账末次生效（重确认场景：
  // 同键多行仅 ts 不同时，取末次行判锚，见 check-loop-sections/s15-fingerprint.mjs 内容绑定）。
  // 主台账先读、分片按文件名序后读，同键时后读覆盖（分片视为较新）。
  const byKey = new Map();

  const parseLines = (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const key = `${obj.doc || ''}|${obj.stage || ''}|${obj.fingerprint || ''}`;
        byKey.set(key, obj); // 覆盖 = 保留末次
      } catch {
        // 坏行容忍跳过（与既有门禁一致）
      }
    }
  };

  // 1. 读主台账文件（存量基线）
  const mainFile = path.join(root, '.agents', 'confirmations.jsonl');
  if (fs.existsSync(mainFile)) {
    try {
      parseLines(fs.readFileSync(mainFile, 'utf8'));
    } catch (err) {
      // 读失败不中断（fail-soft），但必须出账——本函数是 hard-block 门（s15）的数据源，IO 抖动不能伪装成「确认未对账」
      console.error(`[ledger-loader] 读取失败: ${mainFile} (${err.message})——台账视图可能缺该来源行`);
    }
  }

  // 2. 读分片目录 .agents/confirmations.d/*.jsonl
  const shardDir = path.join(root, '.agents', 'confirmations.d');
  if (fs.existsSync(shardDir) && fs.statSync(shardDir).isDirectory()) {
    try {
      const files = fs.readdirSync(shardDir).filter((f) => f.endsWith('.jsonl')).sort();
      for (const file of files) {
        try {
          parseLines(fs.readFileSync(path.join(shardDir, file), 'utf8'));
        } catch (err) {
          console.error(`[ledger-loader] 读取失败: ${file} (${err.message})——台账视图可能缺该来源行`);
        }
      }
    } catch (err) {
      console.error(`[ledger-loader] 读取失败: ${shardDir} (${err.message})——台账视图可能缺该来源行`);
    }
  }

  return [...byKey.values()];
}

export function writeConfirmation(root = projectRoot(), entry, { shard = false } = {}) {
  let targetFile;
  if (shard && entry.doc) {
    const shardDir = path.join(root, '.agents', 'confirmations.d');
    fs.mkdirSync(shardDir, { recursive: true });
    const baseName = path.basename(entry.doc, '.md');
    targetFile = path.join(shardDir, `${baseName}.jsonl`);
  } else {
    targetFile = path.join(root, '.agents', 'confirmations.jsonl');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  }

  fs.appendFileSync(targetFile, JSON.stringify(entry) + '\n', 'utf8');
  return targetFile;
}
