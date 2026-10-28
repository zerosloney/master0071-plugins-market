// scenarios.mjs — SystemOne 场景库：纯数据 + 查找；题型规则（校验/规整/派生配对）收拢在 question-types.mjs。
//
// 一个"场景"= 一组结构化问题（choice / noul / score）+ 可选派生字段（derive）与建议模板（recommendation）。
// 字段格式：
//   questions[qid] = { type, label?, instructions, criteria? }  // criteria：choice=选项映射，score=分级标签数组
//   derive[name]   = { question, values: [] }                    // 分值（取整、越界钳制）按下标映射为派生值
//   recommendation = 建议模板，语法见 format.mjs 的 renderTemplate
//   confidenceThreshold = 场景级低置信度默认阈值（0~1，可选），调用参数可覆盖
//
// 前四个场景沿用 0.1.x 预设工具的判据（审核违规类型等产品判据更细），其余移植自 dsh-system-one 0.4.0。

import { hasCriteria, isSupportedType, stringifyCriteria, supportsDerive, validateCriteria } from './question-types.mjs';

export const BUILTIN_SCENARIOS = [
  {
    id: 'customer_service',
    title: '客服运营 · 工单派单与分流',
    description: '判断工单归属团队、严重程度，以及是否需要立即升级/通知值班。',
    aliases: ['工单分流', '客服', '派单'],
    questions: {
      department: {
        type: 'choice',
        label: '受理部门',
        instructions: '该工单应分派给哪个团队处理？',
        criteria: {
          technical: '产品故障、集成和技术缺陷类问题',
          billing: '支付、退款、账单和计费问题',
          account: '账号、登录、权限和安全问题',
          product: '产品功能咨询、使用帮助和需求建议',
          other: '无法归入以上类别的其他问题',
        },
      },
      severity: {
        type: 'score',
        label: '严重程度',
        instructions: '该工单的严重程度是？',
        criteria: [
          '轻微问题，不影响功能',
          '部分功能受影响，但存在替代方案',
          '核心功能不可用，没有替代方案',
          '造成严重业务或安全影响',
        ],
      },
      escalate: {
        type: 'noul',
        label: '立即升级',
        instructions: '该工单是否需要立即升级或通知值班人员处理？',
      },
    },
    derive: { priority: { question: 'severity', values: ['P4', 'P3', 'P2', 'P1'] } },
    recommendation: '转 {department} 处理（优先级 {priority}）。{escalate?需立即通知值班人员|无需紧急升级}',
  },
  {
    id: 'content_moderation',
    title: '内容审核 · 违规判定与处置',
    description: '判断处置动作（通过/复审/拒绝）、违规类型、风险等级。',
    aliases: ['内容审核', '审核'],
    questions: {
      action: {
        type: 'choice',
        label: '处置动作',
        instructions: '应如何处置该内容？',
        criteria: {
          approve: '内容合规，直接通过',
          review: '存在可疑内容，转人工复审',
          reject: '内容明显违规，拒绝发布或屏蔽',
        },
      },
      category: {
        type: 'choice',
        label: '违规类型',
        instructions: '该内容的主要违规类型是？',
        criteria: {
          none: '无违规内容',
          spam_ads: '垃圾广告或灌水',
          fraud: '欺诈、诈骗',
          pornography: '色情低俗',
          violence: '暴力血腥',
          insult: '辱骂或人身攻击',
          politics: '政治敏感内容',
          privacy: '泄露隐私或机密信息',
          other: '其他违规',
        },
      },
      risk: {
        type: 'score',
        label: '风险等级',
        instructions: '该内容的风险等级是？',
        criteria: ['无风险', '轻微风险，不影响使用者', '中等风险，需要处理', '严重风险，须立即处置'],
      },
    },
    recommendation: '处置动作「{action}」，违规类型「{category}」，风险等级 {risk}。{category?存在违规内容，建议按处置动作尽快处理|未发现违规内容}',
  },
  {
    id: 'agent_routing',
    title: '智能体路由 · 任务分派与转人工',
    description: '为任务选择执行 Agent、评估复杂度、判断是否需要转交人工。',
    aliases: ['任务路由', '路由'],
    questions: {
      agent: {
        type: 'choice',
        label: '执行 Agent',
        instructions: '该任务应交给哪个 Agent 执行？',
        criteria: {
          generalist: '通用助手：日常问答、简单事务处理',
          coder: '编码助手：代码编写、调试、重构、技术问题',
          researcher: '研究助手：信息检索、资料汇总、深度调研',
          data_analyst: '数据分析助手：数据处理、统计分析、图表制作',
          writer: '写作助手：文案、文档、创意写作',
        },
      },
      complexity: {
        type: 'score',
        label: '复杂度',
        instructions: '该任务的复杂度是？',
        criteria: [
          '简单任务，一步即可完成',
          '中等任务，需要少量推理或工具调用',
          '复杂任务，需要多步推理和多次工具调用',
          '极复杂任务，需要长期规划或多智能体协作',
        ],
      },
      needs_human: {
        type: 'noul',
        label: '转人工',
        instructions: '该任务是否高风险或超出 Agent 能力，需要转交人工处理？',
      },
    },
    derive: { effort: { question: 'complexity', values: ['S', 'M', 'L', 'XL'] } },
    recommendation: '交给 {agent} 执行（规模 {effort}）。{needs_human?建议转人工处理|可自动执行}',
  },
  {
    id: 'result_verification',
    title: '结果校验 · 任务满足度判定',
    description: '给定原始任务与待检结果，判断是否满足要求、主要问题与质量等级。',
    aliases: ['结果校验', '校验'],
    questions: {
      passed: {
        type: 'noul',
        label: '是否通过',
        instructions: '该结果是否正确满足了任务的全部要求？',
      },
      main_issue: {
        type: 'choice',
        label: '主要问题',
        instructions: '该结果的主要问题是？',
        criteria: {
          none: '未发现问题',
          factual_error: '存在事实性错误',
          incomplete: '遗漏了任务要求',
          hallucination: '编造了不存在的内容、数据或引用',
          unsafe: '存在安全或合规风险',
          format: '格式或形式不符合要求',
        },
      },
      quality: {
        type: 'score',
        label: '质量等级',
        instructions: '该结果的质量等级是？',
        criteria: [
          '质量差，需要重做',
          '质量一般，存在明显缺陷',
          '质量良好，仅有可接受的小问题',
          '质量优秀，可直接采用',
        ],
      },
    },
    recommendation: '结果{passed?满足任务要求，可直接采用|未完全满足要求}，质量等级 {quality}，主要问题「{main_issue}」。',
  },
  {
    id: 'sales_lead',
    title: '销售线索 · 质量评分与分配',
    description: '评估线索质量、分配归属，判断是否值得主动跟进。',
    aliases: ['lead_scoring', '线索评分', '销售'],
    questions: {
      quality: {
        type: 'score',
        label: '线索质量',
        instructions: '这条线索的质量有多高？',
        criteria: ['无效线索', '低质量', '中等质量', '高质量', '极高意向'],
      },
      owner: {
        type: 'choice',
        label: '线索归属',
        instructions: '这条线索应该分配给谁？',
        criteria: {
          enterprise_sales: '大客户销售',
          smb_sales: '中小客户销售',
          channel: '渠道团队',
          self_service: '自助注册，无需跟进',
        },
      },
      follow_up: {
        type: 'noul',
        label: '是否跟进',
        instructions: '这条线索是否值得主动跟进？',
      },
    },
    recommendation: '线索质量 {quality}，分配给「{owner}」。{follow_up?值得主动跟进|暂不跟进}',
  },
  {
    id: 'risk_control',
    title: '金融风控 · 交易异常与风险等级',
    description: '评估交易异常程度、划分风险等级，判断是否需要人工复核。',
    aliases: ['fraud', '风控', '反欺诈'],
    questions: {
      anomaly: {
        type: 'score',
        label: '异常评分',
        instructions: '这笔交易的异常程度有多高？',
        criteria: ['完全正常', '轻微异常', '可疑', '高度可疑', '明确欺诈'],
      },
      risk_level: {
        type: 'choice',
        label: '风险等级',
        instructions: '这笔交易应归入哪个风险等级？',
        criteria: {
          low: '低风险',
          medium: '中风险',
          high: '高风险',
          critical: '极高风险',
        },
      },
      manual_review: {
        type: 'noul',
        label: '人工复核',
        instructions: '是否需要转人工复核？',
      },
    },
    recommendation: '交易异常评分 {anomaly}，风险等级「{risk_level}」。{manual_review?需转人工复核|可自动放行}',
  },
  {
    id: 'recruiting',
    title: '招聘 HR · 简历匹配与流程推进',
    description: '评估简历匹配度、判断是否进入下一轮，并给出岗位归属建议。',
    aliases: ['hr', 'resume', '招聘'],
    questions: {
      match: {
        type: 'score',
        label: '匹配度',
        instructions: '这份简历与岗位的匹配度有多高？',
        criteria: ['不匹配', '匹配度较低', '基本匹配', '匹配度较高', '高度匹配'],
      },
      next_round: {
        type: 'noul',
        label: '进入下一轮',
        instructions: '是否建议进入下一轮面试？',
      },
      position: {
        type: 'choice',
        label: '岗位归属',
        instructions: '这份简历更适合哪个岗位？',
        criteria: {
          backend: '后端工程师',
          frontend: '前端工程师',
          algorithm: '算法工程师',
          product: '产品经理',
          operation: '运营',
          talent_pool: '人才库储备',
        },
      },
    },
    recommendation: '简历匹配度 {match}，建议岗位「{position}」。{next_round?进入下一轮|本轮不通过}',
  },
  {
    id: 'data_governance',
    title: '数据治理 · 打标、归因与敏感识别',
    description: '自动打标文档、归因数据问题，并识别是否包含敏感数据。',
    aliases: ['governance', '数据标注', '数据治理'],
    questions: {
      tags: {
        type: 'choice',
        label: '文档标签',
        instructions: '这份文档应该打上哪个标签？',
        criteria: {
          contract: '合同与法务',
          finance: '财务与账单',
          product_doc: '产品文档',
          technical_doc: '技术文档',
          hr_doc: '人事文档',
          other: '其他',
        },
      },
      root_cause: {
        type: 'choice',
        label: '问题归因',
        instructions: '数据问题最可能的根因是什么？',
        criteria: {
          upstream_missing: '上游数据缺失',
          pipeline_bug: '采集/加工链路缺陷',
          schema_change: '模型或口径变更',
          business_change: '业务规则变更',
          unknown: '无法判断',
        },
      },
      sensitive: {
        type: 'noul',
        label: '敏感数据',
        instructions: '这份数据是否包含敏感信息（个人信息或商业机密）？',
      },
    },
    recommendation: '文档标签「{tags}」，问题归因「{root_cause}」。{sensitive?包含敏感数据，需脱敏处理|非敏感数据}',
  },
  {
    id: 'education',
    title: '教育内容 · 知识点、难度与合规',
    description: '归类题目知识点、评定难度等级，并预检内容合规性。',
    aliases: ['edu', '教学内容', '教育'],
    questions: {
      knowledge_point: {
        type: 'choice',
        label: '知识点',
        instructions: '这道题考查哪个知识点？',
        criteria: {
          algebra: '代数',
          geometry: '几何',
          probability: '概率统计',
          physics_mechanics: '力学',
          physics_electricity: '电学',
          chemistry: '化学',
          language: '语文/英语',
          other: '其他',
        },
      },
      difficulty: {
        type: 'score',
        label: '难度等级',
        instructions: '这道题的难度有多高？',
        criteria: ['入门', '基础', '中等', '较难', '竞赛级'],
      },
      compliance: {
        type: 'noul',
        label: '合规预检',
        instructions: '内容是否通过合规预检（无违规内容、无错误导向）？',
      },
    },
    recommendation: '知识点「{knowledge_point}」，难度 {difficulty}。{compliance?合规预检通过|存在合规风险，需人工复核}',
  },
  {
    id: 'requirements',
    title: '需求与变更 · 优先级、风险与派发',
    description: '评估需求优先级、变更风险等级，判断是否需要拆分并派发子任务。',
    aliases: ['requirement', '变更管理', '需求'],
    questions: {
      priority: {
        type: 'score',
        label: '优先级',
        instructions: '这个需求或变更的优先级有多高？',
        criteria: ['可延后', '低优先级', '中优先级', '高优先级', '最高优先级，需立即排期'],
      },
      change_risk: {
        type: 'choice',
        label: '变更风险',
        instructions: '这个变更的风险等级是什么？',
        criteria: {
          low: '低风险，可直接上线',
          medium: '中风险，需灰度验证',
          high: '高风险，需完整回归',
          critical: '极高风险，需专项评审',
        },
      },
      subtask_dispatch: {
        type: 'noul',
        label: '拆分派发',
        instructions: '是否需要拆分并派发子任务？',
      },
    },
    recommendation: '优先级 {priority}，变更风险「{change_risk}」。{subtask_dispatch?需拆分并派发子任务|无需拆分}',
  },
  {
    id: 'software_dev',
    title: '软件开发 · 任务类型、复杂度与处置',
    description: '判断编码请求属于缺陷修复、功能开发、重构、评审、测试、文档还是构建运维，评估复杂度并给出处置建议。',
    aliases: ['software', 'dev', 'coding', '开发', '编程', '编码', '研发'],
    questions: {
      task_type: {
        type: 'choice',
        label: '任务类型',
        instructions: '这个编码请求属于哪一类开发任务？',
        criteria: {
          bugfix: '修复缺陷或报错',
          feature: '新增功能或能力',
          refactor: '重构、整理或清理代码',
          review: '代码评审与质量检查',
          test: '编写或修复测试',
          docs: '文档、注释与说明',
          build: '构建、依赖、CI 与环境',
          perf: '性能优化',
          other: '其他开发任务',
        },
      },
      complexity: {
        type: 'score',
        label: '复杂度',
        instructions: '完成这个任务需要改动的范围有多大？',
        criteria: [
          '单点改动，一处即可完成',
          '局部改动，涉及少数几个文件',
          '跨模块改动，需要理解多处上下文',
          '系统性改动，影响架构或大量代码',
        ],
      },
      needs_context: {
        type: 'noul',
        label: '需先探查代码库',
        instructions: '动手前是否需要先检索代码库、阅读相关实现或运行验证？',
      },
    },
    derive: { effort: { question: 'complexity', values: ['S', 'M', 'L', 'XL'] } },
    recommendation: '任务类型「{task_type}」，改动规模 {effort}。{needs_context?建议先检索代码库并确认相关实现|可直接动手}',
  },
  {
    id: 'test_failure',
    title: '测试失败 · 根因分流与阻塞判定',
    description: '判断测试失败的根因类别（代码缺陷/环境/不稳定）、阻塞等级，以及是否值得先原样重跑。',
    aliases: ['测试失败', 'ci', 'test'],
    questions: {
      cause: {
        type: 'choice',
        label: '失败根因',
        instructions: '该测试失败最可能的原因是？',
        criteria: {
          code: '代码缺陷导致的功能回归',
          env: '环境、依赖或配置差异导致',
          flaky: '测试本身不稳定（时序、竞态、随机数据）',
          data: '测试数据或夹具过期失真',
          other: '其他或暂无法归类',
        },
      },
      blocking: {
        type: 'score',
        label: '阻塞等级',
        instructions: '该失败对合并/发布的阻塞程度是？',
        criteria: [
          '可忽略，不阻塞合并',
          '局部影响，可带病合并但需跟进',
          '阻塞合并，需当次修复',
          '阻塞发布，影响主干',
        ],
      },
      retry_first: {
        type: 'noul',
        label: '先重跑确认',
        instructions: '先原样重跑一次以排除偶发因素，是否值得？',
      },
    },
    derive: { block: { question: 'blocking', values: ['不阻塞', '可跟进', '阻塞合并', '阻塞发布'] } },
    recommendation: '根因「{cause}」，{block}。{retry_first?先原样重跑一次确认稳定性|直接按根因排查处理}',
  },
  {
    id: 'pr_review',
    title: '代码评审 · 合并门禁判定',
    description: '判断一次代码变更的评审结论（放行/打回/阻塞）、变更风险，以及是否需要第二评审人。',
    aliases: ['pr', '评审', 'code review'],
    questions: {
      verdict: {
        type: 'choice',
        label: '评审结论',
        instructions: '综合该变更的质量与风险，评审结论应为？',
        criteria: {
          approve: '可合并',
          comment: '放行但需附带跟进意见',
          changes: '需要修改后重新提审',
          block: '阻塞合并（存在重大问题）',
        },
      },
      risk: {
        type: 'score',
        label: '变更风险',
        instructions: '该变更的引入风险是？',
        criteria: [
          '无风险：纯文档、注释或格式化',
          '低风险：局部逻辑且有测试覆盖',
          '中风险：跨模块或影响公共接口',
          '高风险：核心链路、数据或安全相关',
        ],
      },
      needs_second: {
        type: 'noul',
        label: '需第二评审人',
        instructions: '是否需要第二位评审人独立复核？',
      },
    },
    derive: { gate: { question: 'verdict', map: { approve: '通过', comment: '通过（附意见）', changes: '打回修改', block: '阻塞' } } },
    recommendation: '结论「{gate}」，风险等级 {risk}。{needs_second?需第二评审人复核后放行|单一评审结论即可生效}',
  },
  {
    id: 'incident_response',
    title: '事故响应 · 定级与处置',
    description: '给线上事故定级（S1~S4）、判断是否回滚及回滚方式，以及是否立即拉起应急响应。',
    aliases: ['事故', '故障', 'incident'],
    questions: {
      severity: {
        type: 'score',
        label: '事故等级',
        instructions: '该线上事故的等级是？',
        criteria: [
          'S4 轻微：个案受影响、有绕过方案',
          'S3 一般：部分用户受影响',
          'S2 严重：核心功能受损、影响面大',
          'S1 致命：全站不可用或数据丢失',
        ],
      },
      rollback: {
        type: 'choice',
        label: '回滚处置',
        instructions: '是否需要回滚，以何种方式？',
        criteria: {
          none: '无需回滚，可前向修复',
          partial: '部分回滚（灰度/单实例）',
          full: '整体回滚到上一稳定版本',
          other: '其他处置方式',
        },
      },
      escalate: {
        type: 'noul',
        label: '拉起应急',
        instructions: '是否需要立即升级拉起应急响应（值班/应急群）？',
      },
    },
    derive: { level: { question: 'severity', values: ['S4', 'S3', 'S2', 'S1'] } },
    recommendation: '事故定级 {level}。处置：{rollback}。{escalate?立即拉起应急响应并同步值班|按常规流程处理并持续观察}',
  },
  {
    id: 'security_triage',
    title: '安全告警 · 真伪判定与遏制',
    description: '判断安全告警真伪（真实威胁/误报/证据不足）、影响面，以及是否需要立即遏制。',
    aliases: ['安全', '告警', 'security'],
    questions: {
      verdict: {
        type: 'choice',
        label: '告警真伪',
        instructions: '综合告警内容与上下文，判定应为？',
        criteria: {
          true_positive: '真实威胁，需要处置',
          false_positive: '误报，可关闭',
          needs_evidence: '证据不足，需要进一步取证',
        },
      },
      impact: {
        type: 'score',
        label: '影响面',
        instructions: '若为真实威胁，影响面是？',
        criteria: [
          '无实际影响',
          '有限影响：单点或实验环境',
          '中等影响：内部系统或部分用户',
          '严重影响：生产、核心数据或外部用户',
        ],
      },
      contain_now: {
        type: 'noul',
        label: '立即遏制',
        instructions: '是否需要立即采取遏制措施（封禁/隔离/下线）？',
      },
    },
    derive: { verdict_label: { question: 'verdict', map: { true_positive: '真实威胁', false_positive: '误报', needs_evidence: '证据不足' } } },
    recommendation: '判定「{verdict_label}」，影响面 {impact}。{contain_now?立即执行遏制并同步安全值班|按常规流程取证跟进}',
    // 安全判定宁可多复核：默认阈值高于全局 0.7
    confidenceThreshold: 0.8,
  },
];

/**
 * 按 id 或别名查找场景（大小写不敏感）。
 * @param {object[]} scenarios - 场景库（内置 + 自定义合并后的列表）
 * @param {string} ref - 场景 id 或别名
 * @returns {object | undefined}
 */
export function findScenario(scenarios, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return undefined;
  const needle = ref.trim().toLowerCase();
  return scenarios.find(
    (s) => s.id.toLowerCase() === needle || s.aliases.some((a) => a.toLowerCase() === needle)
  );
}

// ---------- 自定义场景（设置页 SYSTEMONE_PLUGIN_SCENARIOS / 环境变量 SYSTEMONE_SCENARIOS 注入） ----------

/**
 * 校验一个自定义场景定义。
 * @param {unknown} spec - 场景定义
 * @returns {string[]} 问题列表，空数组表示合法
 */
export function validateScenario(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['场景必须是对象'];
  if (typeof spec.id !== 'string' || spec.id.trim() === '') problems.push('缺少 id');
  if (typeof spec.title !== 'string' || spec.title.trim() === '') problems.push('缺少 title');
  const questions = spec.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    problems.push('缺少 questions 对象');
    return problems;
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) problems.push('questions 至少需要 1 个问题');
  if (ids.length > 16) problems.push(`questions 最多 16 个（当前 ${ids.length} 个，延迟随问题数线性增长）`);
  for (const [qid, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      problems.push(`问题 ${qid} 必须是对象`);
      continue;
    }
    if (!isSupportedType(q.type)) {
      problems.push(`问题 ${qid} 的 type 必须是 choice/noul/score`);
      continue;
    }
    if (typeof q.instructions !== 'string' || q.instructions.trim() === '') {
      problems.push(`问题 ${qid} 缺少 instructions`);
    }
    // criteria 规则与 decide 侧 validateQuestions 同一套口径（question-types 收拢，谁严以谁为准）
    for (const problem of validateCriteria(q)) {
      problems.push(`问题 ${qid}（${q.type}）的 criteria ${problem}`);
    }
  }
  if (spec.aliases !== undefined && (!Array.isArray(spec.aliases) || spec.aliases.some((a) => typeof a !== 'string' || a.trim() === ''))) {
    problems.push('aliases 必须是非空字符串数组');
  }
  if (spec.derive !== undefined) {
    if (spec.derive === null || typeof spec.derive !== 'object' || Array.isArray(spec.derive)) {
      problems.push('derive 必须是 {派生名: {question, values|map}} 对象');
    } else {
      // 逐项校验到 deriveFields 真正消费的形状：校验放行但运行时静默丢弃的定义（缺 values/map、
      // values 非数组被 Array.isArray 分支跳过、question 指向不存在的 qid、values/map 与题型不配、
      // values 档数超过分级数）在这里拦截，走统一的「整条跳过并告警」路径
      for (const [name, d] of Object.entries(spec.derive)) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
          problems.push(`派生 ${name} 必须是 {question, values|map} 对象`);
          continue;
        }
        if (typeof d.question !== 'string' || d.question.trim() === '') {
          problems.push(`派生 ${name} 的 question 必须是非空字符串`);
          continue;
        }
        // question 必须落到本场景真实存在、题型合法的问题上，否则 deriveFields 取不到值、
        // recommendation 里的 {派生名} 会渲染成空串
        const target = questions[d.question];
        if (!target || typeof target !== 'object' || !isSupportedType(target.type)) {
          problems.push(`派生 ${name} 的 question "${d.question}" 不是本场景的有效问题（可用：${ids.join('、')}）`);
          continue;
        }
        if (d.values === undefined && d.map === undefined) {
          problems.push(`派生 ${name} 需要 values（分值映射数组）或 map（选项映射对象）之一`);
        } else {
          if (d.values !== undefined) {
            if (!Array.isArray(d.values)) {
              problems.push(`派生 ${name} 的 values 必须是数组`);
            } else if (d.values.length === 0) {
              problems.push(`派生 ${name} 的 values 不能为空数组`);
            } else if (!supportsDerive(target.type, 'values')) {
              problems.push(`派生 ${name} 的 values 按分值下标取值，只能用于 score 问题（${d.question} 是 ${target.type}）`);
            } else if (Array.isArray(target.criteria) && d.values.length > target.criteria.length) {
              // values 比分级数还多：多出来的档位永远取不到，是写错了——整条拦截。
              // 反过来（values 比分级数少，如 4 级量表只想映射到 3 档优先级）允许存在：
              // 按前 N 档映射，超出部分由 deriveFields 钳到最后一档。原先要求长度严格相等，
              // 4 级量表想给 3 档优先级就只能整条场景被跳过——失败方式隐蔽且难自查。
              problems.push(`派生 ${name} 的 values 长度 ${d.values.length} 超过问题 ${d.question} 的分级数 ${target.criteria.length}`);
            }
          }
          if (d.map !== undefined) {
            if (d.map === null || typeof d.map !== 'object' || Array.isArray(d.map)) {
              problems.push(`派生 ${name} 的 map 必须是 {键: 值} 对象`);
            } else if (!supportsDerive(target.type, 'map')) {
              problems.push(`派生 ${name} 的 map 按选项键取值，只能用于 choice 问题（${d.question} 是 ${target.type}）`);
            }
          }
        }
      }
    }
  }
  if (spec.recommendation !== undefined && typeof spec.recommendation !== 'string') {
    problems.push('recommendation 必须是字符串');
  }
  if (
    spec.confidenceThreshold !== undefined &&
    (typeof spec.confidenceThreshold !== 'number' || !Number.isFinite(spec.confidenceThreshold) || spec.confidenceThreshold < 0 || spec.confidenceThreshold > 1)
  ) {
    problems.push('confidenceThreshold 必须是 0~1 之间的数字');
  }
  return problems;
}

/**
 * 解析自定义场景（支持多个来源，按数组顺序应用：靠后的源同 id 覆盖靠前的）并合并内置场景。
 * 同 id（大小写不敏感）覆盖，否则追加；非法条目跳过并记入 problems，不影响其余场景。
 * @param {{ label: string, json: string }[]} sources - 场景来源列表（设置页 / 环境变量 / 文件）
 * @returns {{ scenarios: object[], problems: string[] }}
 */
export function resolveScenarios(sources) {
  const scenarios = BUILTIN_SCENARIOS.map((s) => ({ ...s, source: 'builtin' }));
  const problems = [];
  // 内置场景同样过一遍校验器：只告警、不丢弃（丢一个内置场景等于能力缺失），
  // 让新增场景的同类缺陷在启动期就暴露，而不是等到运行时报错才被发现。
  for (const s of BUILTIN_SCENARIOS) {
    const issues = validateScenario(s);
    if (issues.length > 0) {
      problems.push(`内置场景 ${s.id} 定义异常（不影响加载）：${issues.join('；')}`);
    }
  }
  const list = Array.isArray(sources) ? sources : [];
  for (const { label, json } of list) {
    const raw = typeof json === 'string' ? json.trim() : '';
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      problems.push(`${label} JSON 解析失败：${e.message}`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      problems.push(`${label} 必须是 JSON 数组（[...]）`);
      continue;
    }
    const indexById = new Map(scenarios.map((s, i) => [s.id.toLowerCase(), i]));
    parsed.forEach((spec, i) => {
      const issues = validateScenario(spec);
      if (issues.length > 0) {
        problems.push(`${label} #${i + 1}（${spec && spec.id ? spec.id : '未命名'}）已跳过：${issues.join('；')}`);
        return;
      }
      const entry = normalizeScenario(spec);
      const key = entry.id.toLowerCase();
      if (indexById.has(key)) {
        scenarios[indexById.get(key)] = entry;
      } else {
        indexById.set(key, scenarios.length);
        scenarios.push(entry);
      }
    });
  }
  return { scenarios, problems };
}

/** 规范化自定义场景：补齐可选字段、字符串化 criteria，标记 source: 'custom'。 */
function normalizeScenario(spec) {
  const questions = {};
  for (const [qid, q] of Object.entries(spec.questions)) {
    const question = {
      type: q.type,
      instructions: String(q.instructions),
      label: typeof q.label === 'string' && q.label.trim() !== '' ? q.label : qid,
    };
    if (hasCriteria(q.type)) {
      question.criteria = stringifyCriteria(q.type, q.criteria);
    }
    questions[qid] = question;
  }
  return {
    id: spec.id,
    title: spec.title,
    description: typeof spec.description === 'string' ? spec.description : '',
    aliases: Array.isArray(spec.aliases) ? spec.aliases.filter((a) => typeof a === 'string' && a.trim() !== '') : [],
    questions,
    derive: spec.derive && typeof spec.derive === 'object' ? spec.derive : {},
    recommendation: typeof spec.recommendation === 'string' ? spec.recommendation : '',
    confidenceThreshold: typeof spec.confidenceThreshold === 'number' && Number.isFinite(spec.confidenceThreshold) ? spec.confidenceThreshold : undefined,
    source: 'custom',
  };
}
