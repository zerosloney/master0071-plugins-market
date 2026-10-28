#!/usr/bin/env node
// compact-ledgers.mjs — 台账分片打包归并器（2026-10-10 中期方案配套工具）
// 用途：在里程碑节点或发布前，可选运行本脚本将 .agents/confirmations.d/*.jsonl
// 中的分片确认行安全合并回归档主台账 .agents/confirmations.jsonl 并清理分片。
//
// 保持追加不变量：合并时原有主台账行严格保持前缀不变，分片新行追加在末尾。

import fs from 'node:fs';
import path from 'node:path';
import { mergeJsonlLines } from './git-merge-jsonl.mjs';
import { projectRoot } from './paths.mjs';

// 根锚定 git root（paths.mjs 单源）：在子目录调用时台账仍归仓库根，不落进子目录。
const root = projectRoot();
const mainLedger = path.join(root, '.agents', 'confirmations.jsonl');
const shardDir = path.join(root, '.agents', 'confirmations.d');

if (!fs.existsSync(shardDir) || !fs.statSync(shardDir).isDirectory()) {
  console.log('[compact-ledgers] 未发现分片目录 .agents/confirmations.d/，无需打包。');
  process.exit(0);
}

const shardFiles = fs.readdirSync(shardDir).filter((f) => f.endsWith('.jsonl')).sort();
if (shardFiles.length === 0) {
  console.log('[compact-ledgers] 分片目录无 .jsonl 文件，无需打包。');
  process.exit(0);
}

console.log(`[compact-ledgers] 发现 ${shardFiles.length} 个分片文件，正在打包合并...`);

const currentMain = fs.existsSync(mainLedger) ? fs.readFileSync(mainLedger, 'utf8') : '';
let shardCombined = '';

for (const file of shardFiles) {
  const filePath = path.join(shardDir, file);
  try {
    shardCombined += '\n' + fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[compact-ledgers] 读取分片失败: ${file} (${err.message})`);
    console.error('[compact-ledgers] 已中止打包：主台账与全部分片保持原样；请解决后重跑（合并按行去重，重跑安全）。');
    process.exit(1);
  }
}

const merged = mergeJsonlLines(currentMain, shardCombined);
// 原子覆写主台账：直接 writeFileSync 会先截断原文件，进程中途崩溃将损坏主台账；
// 改为同目录临时文件 + rename，任一步失败时主台账原样、分片未删，可安全重跑。
const tmpMain = `${mainLedger}.tmp`;
try {
  fs.writeFileSync(tmpMain, merged, 'utf8');
  fs.renameSync(tmpMain, mainLedger);
} catch (err) {
  try { fs.unlinkSync(tmpMain); } catch { /* tmp 可能尚未创建或删除失败 */ }
  console.error(`[compact-ledgers] 主台账写入失败: ${err.message}`);
  console.error('[compact-ledgers] 已中止打包：主台账原样、分片未删除；请解决后重跑（合并按行去重，重跑安全）。');
  process.exit(1);
}

for (const file of shardFiles) {
  try {
    fs.unlinkSync(path.join(shardDir, file));
  } catch { /* 忽略删除异常 */ }
}

// 若目录为空，尝试删除空目录
try {
  if (fs.readdirSync(shardDir).length === 0) {
    fs.rmdirSync(shardDir);
  }
} catch { /* 忽略 */ }

console.log(`[compact-ledgers] ✅ 打包完成！全量确认行已整合至 .agents/confirmations.jsonl，分片已清理。`);
