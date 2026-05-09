const JARGON_PATTERNS = [
  /100%/gi,
  /P[0-3]/g,
  /闭环/g,
  /落库/g,
  /全量/g,
  /校验/g,
  /硬约束/g,
  /对齐/g,
  /沉淀/g,
  /体系/g,
  /机制/g,
  /框架/g
];

const PROCESS_PATTERNS = [
  /HARNESS_ACTION_RESULT/g,
  /ok\s*:\s*true/gi,
  /写入确认/g,
  /成功落库/g,
  /已落库/g,
  /文件已更新/g,
  /工具调用/g,
  /\bv\d+\b/gi,
  /version/gi
];

const CONCRETE_PATTERNS = [
  /原因/g,
  /证据/g,
  /例如/g,
  /比如/g,
  /步骤/g,
  /导致/g,
  /文件/g,
  /函数/g,
  /代码/g,
  /页面/g,
  /按钮/g,
  /错误/g,
  /路径/g,
  /数据/g,
  /字段/g,
  /用户/g,
  /角色/g,
  /事件/g,
  /方案/g,
  /风险/g,
  /改动/g,
  /测试/g
];

function countMatches(text: string, patterns: RegExp[]) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

export type HumanOutputAssessment = {
  needsRewrite: boolean;
  reason: string | null;
  jargonCount: number;
  processCount: number;
  concreteCount: number;
};

export function assessHumanOutput(text: string, input: { toolCallsCount?: number | null } = {}): HumanOutputAssessment {
  const normalized = text.replace(/\s+/g, " ").trim();
  const jargonCount = countMatches(normalized, JARGON_PATTERNS);
  const processCount = countMatches(normalized, PROCESS_PATTERNS);
  const concreteCount = countMatches(normalized, CONCRETE_PATTERNS);
  const lengthBucket = Math.max(1, Math.ceil(normalized.length / 800));
  const startsLikeToolReceipt = /^(✅|写入确认|已完成|本轮操作确认|确认[:：])/.test(normalized);

  if ((input.toolCallsCount ?? 0) > 0 && (startsLikeToolReceipt || processCount >= 2) && concreteCount < 3) {
    return {
      needsRewrite: true,
      reason: "final text mainly repeats tool/file status instead of useful content",
      jargonCount,
      processCount,
      concreteCount
    };
  }

  if (jargonCount >= 7 * lengthBucket && concreteCount < 4 * lengthBucket) {
    return {
      needsRewrite: true,
      reason: "final text has too much process jargon and too little concrete content",
      jargonCount,
      processCount,
      concreteCount
    };
  }

  return {
    needsRewrite: false,
    reason: null,
    jargonCount,
    processCount,
    concreteCount
  };
}

export function buildHumanOutputRewritePrompt(assessment: HumanOutputAssessment) {
  return [
    "Rewrite your previous final answer in plain language.",
    "Rules:",
    "- Do not call any action/tool.",
    "- Do not report file write success, version numbers, ok:true, or harness/tool status.",
    "- Say the useful content directly: who/what changed, why it matters, what evidence or concrete detail supports it, and what should happen next.",
    "- Avoid abstract words such as 100%, closed loop, full validation, alignment, system, mechanism, framework unless they are absolutely necessary.",
    "- Keep it concise.",
    assessment.reason ? `Why rewrite: ${assessment.reason}.` : null
  ]
    .filter(Boolean)
    .join("\n");
}
