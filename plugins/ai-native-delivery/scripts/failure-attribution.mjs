// failure-attribution.mjs — 门禁失败归因（env / flaky / real）
// 目的：红单必须可信。共享 dev 库死锁、缺依赖/缺二进制是环境假红；把它们与真回归分开，
//   AI 才不会在假红上反复重跑或开始考虑 --no-verify（红线）。归因只标注，不改裁决。
// 口径：env 优先（缺件/网络/依赖），其次 flaky（已知并发/锁/句柄争用签名），否则 real。
// 诚实边界：签名匹配是启发式——归因写进失败行供人复核，不自动降档（降档须 owner 裁决 + 复评日）。
export function classifyFailure(text) {
  const s = String(text || '');
  if (/NU1100|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Cannot find module|MODULE_NOT_FOUND|not recognized as an internal|command not found|ENOENT[^\n]*node_modules|gitleaks.*(?:not found|未安装)|eslint.*(?:not found|未安装)/i.test(s)) return 'env';
  if (/Msg 1205|deadlock|死锁|Execution Timeout|syscall: rm|resource temporarily unavailable|EAGAIN/i.test(s)) return 'flaky';
  return 'real';
}
