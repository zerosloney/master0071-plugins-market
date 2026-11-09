#!/usr/bin/env node
// ledger-loader.mjs — 统一台账分片加载与写入器（2026-10-10 中期方案）
// 解决多人并发与单人多 worktree 并行时中央单文件写入冲突：
// 既兼容存量单文件 .agents/confirmations.jsonl，又透明支持分片目录 .agents/confirmations.d/*.jsonl。

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './paths.mjs';
import { withLedgerLock } from './ledger-shards.mjs';

// 默认根锚定 git root（paths.mjs 单源）：调用方不显式传根时，子目录调用不漂移。
// loadAllConfirmationsDetailed：统一视图 + 坏行大声计数（2026-11-05，对齐 agg-judgments
// .readShardsDetailed 口径）。此前 parseLines 的 catch 无计数无 stderr——坏行（半行撕裂 /
// 手改坏行）从所有视图静默消失，台账破损不可见。坏行仍不中断聚合（不因一行坏数据丢整本
// 视图），但计数必须出声——不可判定 ≠ 已放行。
export function loadAllConfirmationsDetailed(root = projectRoot()) {
  // 按 doc + stage + fingerprint 去重，**值与位置都保留末次出现**——append-only 台账末次生效
  // （重确认场景：同键多行仅 ts 不同时，取末次行判锚，见 check-loop-sections/s15-fingerprint.mjs
  // 内容绑定）。主台账先读、分片按文件名序后读，同键时后读覆盖（分片视为较新）。
  // 2026-11-05 顺序修复：此前 Map 去重「值保留末次、位置保持首次」——跨源（主台账+分片）时
  // 数组序 ≠ 追加时序，消费方取「末行」会取错行。现按最后一次出现的位置排序（值与位置同取
  // 末次），「视图末行 = 真末次」语义成立，取末行的消费方无感。
  const byKey = new Map();
  const lastPos = new Map(); // key → 最后一次读到的行序（全源统一计）
  let seq = 0;
  let badLines = 0;

  const parseLines = (text) => {
    for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const key = `${obj.doc || ''}|${obj.stage || ''}|${obj.fingerprint || ''}`;
        byKey.set(key, obj); // 覆盖 = 保留末次（值）
        lastPos.set(key, seq++); // 位置也取末次
      } catch {
        badLines++;
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

  if (badLines > 0) {
    console.error(`[ledger-loader] ${badLines} 坏行（JSON 解析失败跳过）——台账破损，这些行不进任何视图，请人工检查台账文件`);
  }

  return {
    rows: [...byKey.entries()]
      .map(([k, obj]) => ({ obj, pos: lastPos.get(k) }))
      .sort((a, b) => a.pos - b.pos)
      .map((e) => e.obj),
    badLines,
  };
}

export function loadAllConfirmations(root = projectRoot()) {
  return loadAllConfirmationsDetailed(root).rows;
}

export function writeConfirmation(root = projectRoot(), entry, { shard = false } = {}) {
  let targetFile;
  if (shard && entry.doc) {
    const shardDir = path.join(root, '.agents', 'confirmations.d');
    fs.mkdirSync(shardDir, { recursive: true });
    const baseName = path.basename(entry.doc, '.md');
    targetFile = path.join(shardDir, `${baseName}.jsonl`);
    // 2026-11-05 并发修复：追加全程持 `<分片>.lock`（withLedgerLock 单源，与 compact-ledgers /
    // ledger-shards 同一把锁）。此前 appendFileSync 无锁——compact-ledgers 收缩「锁内重读分片→
    // 并入主台账→unlink」期间落进来的确认行会随 unlink 静默丢失。锁被他人持有时等待，超时响亮
    // 抛错（fail-loud），绝不无锁写。
    withLedgerLock(targetFile, () => {
      fs.appendFileSync(targetFile, JSON.stringify(entry) + '\n', 'utf8');
    });
  } else {
    targetFile = path.join(root, '.agents', 'confirmations.jsonl');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    // 2026-11-08 并发修复（C3）：主台账分支同样持锁。此前裸 appendFileSync——compact-ledgers
    // 持 `<主台账>.lock` 做「读主→合并→tmp+rename 整写」，落在其 read 与 rename 之间的确认行
    // 会被 rename 整体抹掉（分片分支 2026-11-05 已修，主分支漏收）。与 compact / MCP confirm /
    // 分片分支共用同一把锁（withLedgerLock 单源）：锁被他人持有时等待，超时响亮抛错（fail-loud），
    // 绝不无锁写。
    withLedgerLock(targetFile, () => {
      fs.appendFileSync(targetFile, JSON.stringify(entry) + '\n', 'utf8');
    });
  }
  return targetFile;
}
