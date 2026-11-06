#!/usr/bin/env node
// compact-ledgers.mjs — 台账分片打包归并器（2026-10-10 中期方案配套工具）
// 用途：在里程碑节点或发布前，可选运行本脚本将 .agents/confirmations.d/*.jsonl
// 中的分片确认行安全合并回归档主台账 .agents/confirmations.jsonl 并清理分片。
//
// 保持追加不变量：合并时原有主台账行严格保持前缀不变，分片新行追加在末尾。

import fs from 'node:fs';
import path from 'node:path';
import { mergeJsonlLines } from './git-merge-jsonl.mjs';
import { projectRoot, resolveProjectRoot, ledgerRefusal, testAnyRootAllowed } from './paths.mjs';
import { withLedgerLock } from './ledger-shards.mjs';

// 写侧 fail-closed（2026-11-05）：打包归并会整写主台账并删片，必须解析到 git 仓库根才可执行
//（对齐 MCP requireRoot 口径）。旧口径 projectRoot() 回退 cwd——非 git 目录（含 bare 仓）跑
// compact 会把主台账「就地」写进调用目录，违反「台账只落使用项目仓库根」不变量。
{
  const pr = resolveProjectRoot();
  if (!pr.root && !testAnyRootAllowed()) {
    console.error(`[compact-ledgers] ❌ ${ledgerRefusal(pr.status, pr.detail)}`);
    console.error('hint: 在使用项目的 git 仓库内运行（或先 git init）。');
    process.exit(1);
  }
}

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

// 2026-11-05 并发修复：此前「读分片→tmp+rename 写主→unlink 分片」全程无锁——收缩期间并发确认
// 追加（ledger-loader.writeConfirmation / confirm-doc）落到该分片时，新行既没进 merged 又随
// unlink 静默丢失。现在每个分片的「锁内重读→并入主台账→删片」都在 `<分片>.lock` 临界区内执行
//（复用 ledger-shards.mjs 的 withLedgerLock，与 writeConfirmation 同一把锁），追加者自然互斥：
//   · 追加者先持锁 → compact 等待，超时即响亮报错退出，分片原样（重跑安全）；
//   · compact 先持锁 → 追加者等 compact 删片释放后重建同名分片追加，行不丢（留待下次收缩）。
// 锁获取失败响亮报错退出（fail-loud），不静默跳过——无锁收缩正是丢行根因。
// 已处理的分片行已安全并入主台账，任一步失败后重跑皆幂等（合并按行去重）。
const readMain = () => (fs.existsSync(mainLedger) ? fs.readFileSync(mainLedger, 'utf8') : '');
let compacted = 0;

for (const file of shardFiles) {
  const filePath = path.join(shardDir, file);
  try {
    withLedgerLock(filePath, () => {
      // 锁内重读：拿到锁的瞬间分片内容才是稳定的（上方目录枚举只是候选名单）
      let shardText;
      try {
        shardText = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        throw new Error(`读取分片失败: ${file} (${err.message})`);
      }
      const merged = mergeJsonlLines(readMain(), shardText);
      // 原子覆写主台账：直接 writeFileSync 会先截断原文件，进程中途崩溃将损坏主台账；
      // 改为同目录临时文件 + rename，任一步失败时主台账原样、分片未删，可安全重跑。
      const tmpMain = `${mainLedger}.tmp`;
      try {
        fs.writeFileSync(tmpMain, merged, 'utf8');
        fs.renameSync(tmpMain, mainLedger);
      } catch (err) {
        try { fs.unlinkSync(tmpMain); } catch { /* tmp 可能尚未创建或删除失败 */ }
        throw new Error(`主台账写入失败: ${err.message}`);
      }
      try {
        fs.unlinkSync(filePath); // 行已并入主台账，删片失败只留下分片待重跑（去重，重跑安全）
      } catch { /* 忽略删除异常 */ }
      compacted++;
    });
  } catch (err) {
    console.error(`[compact-ledgers] ${err.message}`);
    console.error('[compact-ledgers] 已中止打包：主台账与未处理分片保持原样（已处理分片的行已安全并入主台账）；请解决后重跑（合并按行去重，重跑安全）。');
    process.exit(1);
  }
}

// 若目录为空，尝试删除空目录
try {
  if (fs.readdirSync(shardDir).length === 0) {
    fs.rmdirSync(shardDir);
  }
} catch { /* 忽略 */ }

console.log(`[compact-ledgers] ✅ 打包完成！${compacted}/${shardFiles.length} 个分片的确认行已整合至 .agents/confirmations.jsonl，分片已清理。`);
