#!/usr/bin/env node
// git-merge-jsonl.mjs — Git 自定义合并驱动：JSONL 追加式台账并集去重（2026-10-10）
// 用于解决多人并发提 develop 或单人多 worktree 并行时，.agents/*.jsonl 尾部并发追加导致的 Git 合并冲突。
//
// 调用协议（由 .gitattributes 关联 merge=jsonl-union 触发）：
//   源仓形态（脚本随项目落 .agents/scripts/）：
//     git config merge.jsonl-union.driver "node .agents/scripts/git-merge-jsonl.mjs %O %A %B"
//   插件形态（脚本留插件内，2026-10-27 插件化）：驱动须指向插件内绝对路径——
//     git config merge.jsonl-union.driver "node <插件安装路径>/scripts/git-merge-jsonl.mjs %O %A %B"
//   （期望值由 check-local-gates.mjs / check-local-gate-config.mjs 按部署形态给出）
//   %O: 祖先版本路径 (ancestor/base)
//   %A: 当前分支版本路径 (current/ours，合并结果必须覆写回此文件)
//   %B: 对方分支版本路径 (other/theirs)
//
// 逻辑：
//   1. 读 %A 与 %B 全量非空行，按文本精确去重；输入侧各自丢弃**末尾不完整 JSON 行**（2026-11-05：
//      崩溃残留——进程写到一半被杀会留下半行，半行 ≠ 完整行，union 去重不掉、两输入各带一份
//      半行还会都进结果。末尾解析失败的行视为崩溃残迹丢弃并 stderr 计数；行中坏行维持现状）；
//   2. 保持 %A 既有行的原始顺序，将其余 %B 中新增的行追加在末尾；%A 侧原有空行原样保留
//      （2026-11-05：空行不属于并集行集，剥掉会让含空行的主台账经 compact 后不再是其旧 blob
//      的逐字节前缀扩展，被台账不变量门禁判 HARD-BLOCK）；%B 侧空行不并入；
//   3. 统一规范化为 LF 换行（末尾保留一个换行符），覆写回 %A 并 exit 0。

import fs from 'node:fs';

export function mergeJsonlLines(currentContent, otherContent) {
  const splitLines = (str) => String(str || '').replace(/\r\n/g, '\n').split('\n');
  // 末尾不完整 JSON 行 = 崩溃残迹：最后一个非空行解析失败 → 丢弃并 stderr 计数（1 行/输入）。
  // 行中坏行维持现状（不判不删——那不是崩溃形态，属台账内容问题，由行级校验管）。
  const dropTrailingCrumb = (lines) => {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') end--;
    if (end > 0) {
      try { JSON.parse(lines[end - 1]); } catch {
        console.error('[git-merge-jsonl] 丢弃末尾不完整 JSON 行 1 行（解析失败，按崩溃残迹处理）');
        end--;
      }
    }
    return lines.slice(0, end);
  };
  const currentLines = dropTrailingCrumb(splitLines(currentContent));
  const otherLines = dropTrailingCrumb(splitLines(otherContent));

  const seen = new Set();
  const result = [];
  for (const line of currentLines) {
    if (line.trim() === '') { result.push(line); continue; } // %A 侧磁盘原有空行原样保留
    if (!seen.has(line)) { seen.add(line); result.push(line); }
  }
  for (const line of otherLines) {
    if (line.trim() === '') continue; // %B 侧空行不并入（并入会跟 %A 空行排布打架）
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }

  return result.length > 0 ? result.join('\n') + '\n' : '';
}

// CLI 执行入口
if (process.argv[1] && process.argv[1].endsWith('git-merge-jsonl.mjs')) {
  const [, , ancestorPath, currentPath, otherPath] = process.argv;

  if (!currentPath || !otherPath) {
    console.error('用法: node git-merge-jsonl.mjs %O %A %B');
    process.exit(1);
  }

  const tmpPath = `${currentPath}.tmp`;
  try {
    const currentContent = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '';
    const otherContent = fs.existsSync(otherPath) ? fs.readFileSync(otherPath, 'utf8') : '';

    const merged = mergeJsonlLines(currentContent, otherContent);
    // 原子覆写 %A：直接 writeFileSync 先截断后写，中断会留下半写文件；同目录临时文件 + rename 保证要么旧要么新
    fs.writeFileSync(tmpPath, merged, 'utf8');
    fs.renameSync(tmpPath, currentPath);
    process.exit(0);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp 可能尚未创建 */ }
    console.error(`[git-merge-jsonl] 合并失败: ${err.message}`);
    process.exit(1);
  }
}
