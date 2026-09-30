#!/usr/bin/env node
// requirement-clarity.mjs — UserPromptSubmit hook：SystemOne 需求明确度预检。
// 契约：stdin = hook JSON（取 prompt 字段）；stdout 仅在判定"需求不明确"时输出一条
// hookSpecificOutput.additionalContext 注入上下文，其余一律静默 exit 0（fail-open）——
// 无 Key、寒暄捷径、网络失败都不阻塞用户输入，诊断走 stderr。
// 门限与插件 README「需求明确度预检」一致：clarity ≤ 1 或 proceed < 0.6。
// 低置信度不改门限，只在命中的结论里附注——硬信号归 hook，软怀疑归 Agent。

const GATE = { clarityMax: 1, proceedMin: 0.6 };
const CASUAL = /^(好的?|好吧|可以|是的?|对滴?|行|嗯+|哦+|不了|不用了?|再见|收到|继续|谢谢|多谢|麻烦了|辛苦了|ok|okay|yes|thanks?|thank you)[!。.，,～~！?\s]*$/i;

const QUESTIONS = {
  clarity: {
    type: 'score',
    instructions: '该开发任务的需求明确程度是？',
    criteria: [
      '模糊：目标都不清楚',
      '偏低：目标清楚但范围或关键约束不明',
      '较高：目标范围清楚，细节可自行决策',
      '明确：目标、范围、验收都清楚',
    ],
  },
  missing: {
    type: 'choice',
    instructions: '当前最需要澄清的信息是？',
    criteria: {
      goal: '目标/预期结果',
      scope: '范围与边界',
      acceptance: '验收标准',
      constraint: '技术约束或依赖',
      none: '无明显缺失',
    },
  },
  proceed: {
    type: 'noul',
    instructions: '不做额外澄清就推进，返工风险是否可接受？',
  },
};

function env() {
  const timeoutRaw = Number(process.env.SYSTEMONE_TIMEOUT_MS);
  return {
    apiKey: process.env.SYSTEMONE_API_KEY || process.env.UNISOUND_API_KEY || '',
    baseUrl: (process.env.SYSTEMONE_BASE_URL || 'https://maas-api.unisound.com/v1').replace(/\/+$/, ''),
    model: process.env.SYSTEMONE_MODEL || 'u2-decision',
    // 时间预算按最严的一侧（MiniMax：handler timeout 上限 10s）统一收紧：
    // 请求 6s < 自毁 7s < MiniMax handler 8s < ZCode handler 15s。
    // MiniMax 的 hook handler 不支持 env 字段，无法给两端配不同预算，只能取小值。
    // 实测真实接口延迟约 0.1s，6s 仍有 60 倍余量；hook 失败绝不阻塞用户输入。
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 6000) : 5000,
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

async function decide(state) {
  const cfg = env();
  const res = await fetch(`${cfg.baseUrl}/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, state, questions: QUESTIONS }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data && typeof data === 'object' && data.answers && typeof data.answers === 'object' ? data.answers : null;
}

// 归一化：字段缺失或题型不符一律返回 null，由调用方 fail-open
function scoreOf(a) {
  if (!a || a.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null;
  return {
    score: a.score,
    level: (a.legend || {})[String(Math.round(a.score))] || null,
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
  };
}

function choiceOf(a) {
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
  return { value: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

function noulOf(a) {
  const p = a && typeof a.noul === 'number' && Number.isFinite(a.noul) ? a.noul : null;
  return p === null ? null : { probability: p, confidence: Math.max(p, 1 - p) };
}

function verdictLine(clarity, missing, proceed) {
  const conf = [clarity.confidence, missing.confidence, proceed.confidence].filter((c) => c !== null);
  const low =
    conf.length > 0 && Math.min(...conf) < 0.7 ? `（注意：本次判定最低置信度 ${Math.min(...conf).toFixed(2)}，偏低）` : '';
  const miss =
    missing.value === 'none'
      ? '未识别出明显缺失，但推进返工风险偏高'
      : `最需要澄清：${missing.value}（${QUESTIONS.missing.criteria[missing.value] || ''}）`;
  return (
    `[SystemOne 需求预检] 该需求判定为不明确：明确度 ${clarity.score.toFixed(1)}/3${clarity.level ? `（${clarity.level}）` : ''}；` +
    `${miss}；不澄清就推进的可接受概率 ${proceed.probability.toFixed(2)}。` +
    `建议先按上述维度向用户澄清，再开始实现，不要直接动手。${low}`
  );
}

async function main() {
  // stdin 异常挂起时的兜底自毁，避免每次输入都吃满 hook 进程超时
  const killer = setTimeout(() => process.exit(0), 7000);
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length < 10 || CASUAL.test(prompt)) return null; // 空输入 / 寒暄捷径
  if (!env().apiKey) return null; // 未配置 Key，静默跳过
  const answers = await decide(prompt);
  const clarity = answers ? scoreOf(answers.clarity) : null;
  const missing = answers ? choiceOf(answers.missing) : null;
  const proceed = answers ? noulOf(answers.proceed) : null;
  if (!clarity || !missing || !proceed) return null; // 响应不完整，fail-open
  if (clarity.score > GATE.clarityMax && proceed.probability >= GATE.proceedMin) return null; // 明确，零噪音
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: verdictLine(clarity, missing, proceed),
    },
  });
}

main()
  .then((out) => {
    if (!out || process.stdout.write(out)) process.exit(0);
    process.stdout.once('drain', () => process.exit(0));
  })
  .catch((e) => {
    process.stderr.write(`[systemone-decision hook] 预检跳过：${e && e.message ? e.message : e}\n`);
    process.exit(0);
  });
