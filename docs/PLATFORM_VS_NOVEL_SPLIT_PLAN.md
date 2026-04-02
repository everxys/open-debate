# 通用 Workflow 架构说明

## 目标

把项目收口成一个纯通用的 AI 讨论平台：

- 系统只提供通用能力：多席位、阶段机、投票、共享文件、完成条件、质量检查
- 不内置任何题材或任务分类
- 所有差异只通过 `debate/workflow.json` 和提示词表达

## 已落地原则

### 1. 默认规则保持中立

- 无策略 workflow 时，系统使用中立默认 workflow
- 默认不会注入小说语义、文档语义或其他题材语义
- 默认完成模式为 `consensus_only`

### 2. 角色与阶段完全由 workflow 定义

- 平台层不固定任何题材角色名
- workflow 可以自由定义：
  - 固定角色席位
  - 阶段标题
  - 阶段说明
  - 发言顺序
  - 完成条件

### 3. 质量检查是通用能力，不属于任何题材

- 现有基础检查仍保留：
  - `minChars`
  - `minMarkdownHeadings`
  - `requiredSnippets`
- 新增统一扩展入口：
  - `qualityChecks.requiredSections`
  - `qualityChecks.requiredTerms`
  - `qualityChecks.minBulletItems`
  - `qualityChecks.counters`

这些字段不表达“小说模式”或“文档模式”，只表达该 workflow 对交付物的具体质量要求。

## Workflow 字段约定

### `completion.mode`

```json
{
  "completion": {
    "mode": "consensus_only"
  }
}
```

可选值：

- `consensus_only`
- `consensus_plus_outputs`
- `workflow_gate`

### 固定角色职责

当前平台不再把角色职责写进 workflow。推荐做法是：

- 用固定角色名定义席位类型
- 用对应 `system prompt` 写清角色边界
- 用 `protocol/*` 写清阶段推进、文件分工和质量审判规则

### `deliverables.requiredFiles[].qualityChecks`

```json
{
  "qualityChecks": {
    "requiredSections": ["结论", "依据", "建议"],
    "requiredTerms": ["风险", "权衡"],
    "minBulletItems": 6,
    "counters": [
      {
        "label": "options",
        "patterns": ["方案"],
        "minCount": 3
      }
    ]
  }
}
```

用途：

- 用统一字段表达结构完整性
- 用统一字段表达术语覆盖度
- 用统一字段表达信息数量要求
- 用统一字段表达特定内容出现次数

## 示例原则

- 仓库可以出现 workflow 片段示例
- 这些示例只用于说明字段组合方式
- 这些示例不是系统内置分类，也不是产品概念

## 后续方向

- 继续清理文档里残留的分类化语言
- 让更多真实策略迁到 `qualityChecks`
- 保持平台层只描述机制，不描述题材
