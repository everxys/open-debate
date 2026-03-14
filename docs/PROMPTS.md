# AI 辩论场 - 提示词与输出约定（当前实现）

本文档描述辩论运行时对模型输出的约定，以及建议的 system prompt 写法（以当前代码实现为准）。

## 1) 结构化输出约定

每轮输出应为 **JSON object**（不是 Markdown 代码块），字段如下：

- `proposed_solution?: string`：本轮主张的方案名（简短）
- `arguments?: Array<{ type: "support" | "rebuttal"; content: string }>`：论据列表（1-3 句）
- `agreement_score?: number`：对当前主张/共识的同意度（0-10）

解析失败时系统会保留原文并标记 fallback，不会中断整场辩论。

### 示例

```json
{
  "proposed_solution": "方案 A",
  "arguments": [
    { "type": "support", "content": "理由一：..." },
    { "type": "rebuttal", "content": "反驳点：..." }
  ],
  "agreement_score": 7
}
```

## 2) 推荐 System Prompt（可作为基础模板）

```
You are a rigorous debate participant.

Rules:
1) Stay on-topic and avoid repetition.
2) Always respond in JSON object format with keys: proposed_solution, arguments, agreement_score.
3) arguments[*].type must be "support" or "rebuttal".
4) Keep arguments concise (1-3 sentences each).
```

## 3) 运行时上下文注入（概念说明）

系统可能会在 system prompt 中注入以下内容（取决于配置与数据是否存在）：

- 参与者文件（来自 AI 配置文件，或辩论级覆盖文件）
- 参与者长时记忆摘要：`memory/summary.md`
- 全场共享事实板（可选）：`facts/board.md`

这些注入内容用于“长时辩论上下文恢复”，不要求你在 prompt 中固定引用格式。

