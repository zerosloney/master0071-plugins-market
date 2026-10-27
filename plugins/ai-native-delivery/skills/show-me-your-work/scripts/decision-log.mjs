#!/usr/bin/env node
// decision-log.mjs — 决策 TSV 追加器（show-me-your-work 2026-10-22，pstack 借鉴）
// 用法：node .agents/skills/show-me-your-work/scripts/decision-log.mjs <logfile> <phase> <decision> <why> <evidence> <result>
// 行为：首用写表头；ts 自动；单元格去 tab/换行；以 = + - @ 开头的单元格加单引号（防表格注入）。
// 口径：append-only——错行不删，追加一行 supersede；证据是指针（commit/file:line/artifact），不是段落。
import fs from 'node:fs';
import path from 'node:path';

const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult';
const [logfile, phase, decision, why, evidence, result] = process.argv.slice(2);
if (!logfile || !phase || !decision) {
  console.error('用法：node .agents/skills/show-me-your-work/scripts/decision-log.mjs <logfile> <phase> <decision> <why> <evidence> <result>');
  process.exit(2);
}
const cell = (v) => {
  const s = String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
const row = [new Date().toISOString(), phase, decision, why, evidence, result].map(cell).join('\t');
const abs = path.resolve(logfile);
fs.mkdirSync(path.dirname(abs), { recursive: true });
if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) fs.writeFileSync(abs, `${HEADER}\n`);
fs.appendFileSync(abs, `${row}\n`);
console.log(`✅ 决策已记 ${logfile}`);
