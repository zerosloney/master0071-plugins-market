// agent-pipelines 共享参数解析：5 个脚本此前各自复制同一份 parseArgs，任一改动需同步 5 处。
// 语法：--key value / --key=value / --key（布尔真）；非 -- 开头进位置参数 _。
// next 以 -- 开头时视为布尔（--json --file x），因此值本身以 -- 开头的场景不支持（与原行为一致）。
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq > 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[body] = true;
    else {
      out[body] = next;
      i += 1;
    }
  }
  return out;
}
