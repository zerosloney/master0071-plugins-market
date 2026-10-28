// agent-pipelines 共享参数解析：5 个脚本此前各自复制同一份 parseArgs，任一改动需同步 5 处。
// 语法：--key value / --key=value / --key（布尔真）；非 -- 开头进位置参数 _。
//
// 本版把「无法识别的 -- 形式」显式化——旧实现「下一项以 -- 开头就当布尔」，会静默吞掉值：
//   `--forbidden --weird` → forbidden 被置成 true（scope 规则整条消失），还凭空多出一个 --weird 键。
//   用户显式传的参数就这么没了，脚本不报错、退出码 0，越界检查被绕过。
//
// 现在每个脚本显式登记自己的开关（spec.boolean / spec.value），两种形态都给出确定结果：
//   - 登记为 boolean 的开关只取布尔值，不吃下一项（`--json --file x` 仍是 json=true、file=x）；
//   - 登记为 value 的开关一律把下一项当自己的值，值以 -- 开头也照收
//     （`--forbidden --weird` 与 `--forbidden=--weird` 等价）；
//   - 未登记的 -- 形式按未知参数报错并列出已知开关，不静默吞掉。
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.boolean || []);
  const values = new Set(spec.value || []);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      if (!key) fail(`invalid argument "${arg}": missing option name`);
      assertKnown(key, booleans, values);
      // 布尔开关允许 --flag=false 显式关掉；其余取值按原样保留
      out[key] = booleans.has(key) ? body.slice(eq + 1) !== "false" && body.slice(eq + 1) !== "0" : body.slice(eq + 1);
      continue;
    }
    if (booleans.has(body)) {
      out[body] = true;
      continue;
    }
    if (values.has(body)) {
      const next = argv[i + 1];
      if (next === undefined) fail(`--${body} requires a value`);
      out[body] = next;
      i += 1;
      continue;
    }
    fail(`unknown argument "--${body}"${knownHint(booleans, values)}`);
  }
  return out;
}

function assertKnown(key, booleans, values) {
  if (!booleans.has(key) && !values.has(key)) fail(`unknown argument "--${key}"${knownHint(booleans, values)}`);
}

function knownHint(booleans, values) {
  const known = [...booleans, ...values].sort();
  return known.length ? `; known options: ${known.map((item) => `--${item}`).join(", ")}` : "";
}

function fail(message) {
  process.stderr.write(`[agent-pipelines] ${message}\n`);
  process.exit(2);
}
