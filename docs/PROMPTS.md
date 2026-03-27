# AI 辩论场 - 提示词与输出约定（当前实现）

本文档描述辩论运行时对模型输出的约定，以及建议的 system prompt 写法（以当前代码实现为准）。

## 1) 输出格式约定

每轮输出应为 **给人看的 Markdown**（推荐），方便阅读与回溯。

系统仍支持（可选）结构化字段：如果模型输出的是 JSON（`proposed_solution / arguments / agreement_score`），运行时会尝试解析并把它转换为可读 Markdown，同时把结构化字段存到数据库里；解析失败会保留原文并标记 fallback，不会中断整场辩论。

### 示例（可选 JSON：系统会自动转成可读 Markdown）

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
 2) Respond in readable Markdown for humans.
 3) Do not output raw JSON objects. If you need structure, use headings and bullet points.
 4) Stay concise and avoid repetition.
```

## 3) 运行时上下文注入（概念说明）

系统可能会在 system prompt 中注入以下内容（取决于配置与数据是否存在）：

- 参与者文件（来自 AI 配置文件，或辩论级覆盖文件）
- 参与者长时记忆摘要：`memory/summary.md`
- 全场共享事实板（可选）：`facts/board.md`
- 若 workflow 配置了 `contextAccess`，则会按目录规则区分：
  - `alwaysRead`：每次生成、每个新会话都会自动重新注入
  - `readWhenNeeded`：不会自动注入，但模型可通过文件读取工具按需读取
  - `unlockAfterPhase`：到指定 phase 之前既不会自动注入，也不允许工具读取；解锁后会自动注入

这些注入内容用于“长时辩论上下文恢复”，不要求你在 prompt 中固定引用格式。
