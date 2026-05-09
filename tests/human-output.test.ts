import test from "node:test";
import assert from "node:assert/strict";

import { assessHumanOutput } from "@/lib/runtime/human-output";
import { removeProcessStatusLines } from "@/lib/runtime/summary-generation";

test("assessHumanOutput asks for rewrite when final text is mostly a tool receipt", () => {
  const result = assessHumanOutput("✅ 写入确认：`debate/ideas/current-battlefield.md` v20 已成功落库，100%闭环。", {
    toolCallsCount: 1
  });
  assert.equal(result.needsRewrite, true);
});

test("assessHumanOutput keeps concrete plain-language content", () => {
  const result = assessHumanOutput(
    "这里的问题是角色动机还不够清楚。下一步应该先补两个人为什么反对合作，再决定事件怎么写。",
    { toolCallsCount: 0 }
  );
  assert.equal(result.needsRewrite, false);
});

test("removeProcessStatusLines strips process-only facts board lines", () => {
  const result = removeProcessStatusLines(
    [
      "## 已确认共识",
      "- 主线目标是让角色通过公开信息推导出规则漏洞。",
      "- 写入确认：current-battlefield.md v20 已成功落库。",
      "## 未决问题",
      "- 还缺少两个核心角色的具体动机。"
    ].join("\n")
  );
  assert.match(result, /主线目标/);
  assert.match(result, /具体动机/);
  assert.doesNotMatch(result, /写入确认/);
  assert.doesNotMatch(result, /v20/);
});
