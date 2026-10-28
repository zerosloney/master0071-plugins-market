// binding.mjs — done 内容绑定指纹的复原重算（2026-10-28 自 check-loop-kit.mjs 原位切出，函数体逐字未改）。
//
// 切出原因：bindingSha256 是「done/closed 终态文档改正文后补重确认」的唯一口径，被 check-loop 检查 15
//   （s15-fingerprint）与 append-compensation.mjs 共用。此前它住在 check-loop-kit.mjs，而 kit 是
//   **被 import 即执行**的基础设施层（根解析 + 枚举加载 + git 索引构建，含 fail-loud exit）——于是
//   append-compensation 仅为一个纯函数 import kit，就继承了「非 git 目录 exit 0」的顶层副作用：
//   在非 git 目录运行补偿行工具会静默不工作且返回成功码（2026-10-28 市场审查实测复现）。
//
// 本模块零副作用、零项目依赖（只用 node:crypto），可被任意脚本安全 import。kit 侧以 re-export
//   保留原导出面（`export { bindingSha256 } from './binding.mjs'`），section 与既有测试无需改动。
import { createHash } from 'node:crypto';

// bindingSha256：done 内容绑定的复原重算（检查 15 专用）——confirm-doc.mjs computeFingerprint 的逆推：
// lines 已 CRLF 归一（split(/\r?\n/)），frontmatter 区内首个「状态:」行保分隔符换值为 prev（`状态:  done`
// 双空格 → `状态:  approved`——与前向按原行字面计算对称，非规范分隔符不误伤；行尾空白等更奇异格式仍会
// 失配，触发前提本身已违反「确认落态唯一入口」约定，接受），全文剔「确认指纹:」行后 join('\n') 再 sha256。
export function bindingSha256(lines, prevStatus) {
  const isDelim = (l) => /^---\s*$/.test(l);
  const out = [];
  let i = 0;
  if (isDelim(lines[0] || '')) {
    out.push(lines[0]);
    let replaced = false;
    for (i = 1; i < lines.length; i++) {
      if (isDelim(lines[i])) { out.push(lines[i]); i++; break; }
      if (!replaced && /^状态:/.test(lines[i])) {
        out.push(lines[i].replace(/^(\s*状态:\s*)\S.*$/, `$1${prevStatus}`));
        replaced = true;
      } else out.push(lines[i]);
    }
  }
  for (; i < lines.length; i++) out.push(lines[i]);
  return createHash('sha256').update(out.filter((l) => !/^确认指纹:/.test(l)).join('\n'), 'utf8').digest('hex');
}
