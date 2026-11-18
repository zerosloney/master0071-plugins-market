# NOTICE — tech-code-refactoring 第三方资产声明

本插件的 skill 内容、分析脚本（`skills/code-analyzer/scripts/analyze.mjs` 等）与全部清单均为本仓库原创作品（© 2026 master0071，MIT）。

唯一的第三方内容是 vendored 运行时资产：`skills/code-analyzer/scripts/vendor/`（多语言 AST 分析的解析器运行时，随插件目录分发以保证市场安装即用，无需任何包管理器安装步骤）。

## vendored 资产清单

| 文件 | 来源 | 许可 |
|------|------|------|
| `web-tree-sitter.js` / `web-tree-sitter.wasm` | [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) 0.27.2（npm 分发的官方 dist） | MIT — © Max Brunsfeld 等，全文见同目录 `LICENSE-web-tree-sitter` |
| `tree-sitter-{javascript,typescript,tsx,python,java,go,rust,c,cpp}.wasm` | [tree-sitter-wasms](https://www.npmjs.com/package/tree-sitter-wasms) 0.1.13 预编译产物 | 聚合包 Unlicense（公共领域），全文见同目录 `LICENSE-tree-sitter-wasms`；各 grammar 的上游仓库均为 MIT（tree-sitter/tree-sitter-javascript、-typescript、-python、-java、-go、-rust、-c、-cpp，2026-11-18 经 GitHub API 逐一核对） |

## 使用方式与边界

- 运行时按需懒加载（只加载目标语言实际出现的 grammar wasm）；资产缺失、加载失败或环境无 WebAssembly 时，脚本自动降级为启发式分析（JS/TS 正则级）或纯文件计数，不崩溃。
- 不得从 vendor 目录执行任何代码；其中仅包含解析器数据与运行时（`.js`/`.wasm`），由 `analyze.mjs` 经 Node 的 WebAssembly 接口加载。
