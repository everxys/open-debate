# AI 辩论场 - 数据库设计文档

## 数据库

Docker Compose 中的 PostgreSQL

---

## 设计原则

1. 只保留 `MVP` 必需表。
2. 不为 V2 功能预先引入高耦合表结构。
3. 结构化结果优先存为 JSONB，避免过早拆成观点图谱模型。
4. 所有业务表启用 RLS。

---

## MVP 表结构概览

```
users
   ├── ai_agents
   ├── debates
   │    ├── debate_agents
   │    └── debate_turns
   └── debate_exports (可选)
```

---

## 1. ai_agents

| 字段 | 类型 | 约束 | 描述 |
|------|------|------|------|
| id | UUID | PK | AI 配置 ID |
| user_id | UUID | NOT NULL | 归属用户 |
| name | TEXT | NOT NULL | 名称 |
| provider | TEXT | NOT NULL | `openai` / `anthropic` |
| model | TEXT | NOT NULL | 模型名 |
| base_url | TEXT | NOT NULL | Provider API Base URL |
| api_key_encrypted | TEXT | NOT NULL | 加密后的 API Key |
| api_key_masked | TEXT | NOT NULL | 脱敏展示值 |
| system_prompt | TEXT | NULL | 系统提示词 |
| is_active | BOOLEAN | NOT NULL DEFAULT TRUE | 是否可用 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 更新时间 |

---

## 2. debates

| 字段 | 类型 | 约束 | 描述 |
|------|------|------|------|
| id | UUID | PK | 辩论 ID |
| user_id | UUID | NOT NULL | 归属用户 |
| question | TEXT | NOT NULL | 辩论问题 |
| status | TEXT | NOT NULL | `pending/running/paused/completed/stopped/failed` |
| max_turns | INTEGER | NOT NULL DEFAULT 10 | 最大轮数 |
| current_turn | INTEGER | NOT NULL DEFAULT 0 | 当前轮次 |
| token_budget | INTEGER | NULL | token 预算 |
| token_used | INTEGER | NOT NULL DEFAULT 0 | 已用 token |
| consensus_reached | BOOLEAN | NOT NULL DEFAULT FALSE | 是否提前达成共识 |
| consensus_summary | JSONB | NULL | 简化共识结果 |
| last_error_code | TEXT | NULL | 最后错误码 |
| last_error_message | TEXT | NULL | 最后错误信息 |
| started_at | TIMESTAMPTZ | NULL | 开始时间 |
| finished_at | TIMESTAMPTZ | NULL | 结束时间 |
| stopped_reason | TEXT | NULL | 停止原因 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 更新时间 |

---

## 3. debate_agents

| 字段 | 类型 | 约束 | 描述 |
|------|------|------|------|
| id | UUID | PK | 关联 ID |
| debate_id | UUID | NOT NULL | 辩论 ID |
| ai_agent_id | UUID | NOT NULL | AI 配置 ID |
| turn_order | INTEGER | NOT NULL | 发言顺序 |
| turn_count | INTEGER | NOT NULL DEFAULT 0 | 已发言次数 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 创建时间 |

唯一约束：

- `UNIQUE(debate_id, ai_agent_id)`
- `UNIQUE(debate_id, turn_order)`

---

## 4. debate_turns

| 字段 | 类型 | 约束 | 描述 |
|------|------|------|------|
| id | UUID | PK | 发言 ID |
| debate_id | UUID | NOT NULL | 辩论 ID |
| ai_agent_id | UUID | NOT NULL | 发言 AI |
| turn_number | INTEGER | NOT NULL | 轮次 |
| content | TEXT | NOT NULL | 原始发言 |
| structured_output | JSONB | NULL | 解析出的结构化结果 |
| parse_status | TEXT | NOT NULL DEFAULT 'ok' | `ok/fallback` |
| token_used | INTEGER | NOT NULL DEFAULT 0 | 本轮 token |
| response_time_ms | INTEGER | NULL | 响应耗时 |
| retry_count | INTEGER | NOT NULL DEFAULT 0 | 本轮已重试次数 |
| error_code | TEXT | NULL | 错误码 |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | 创建时间 |

建议索引：

- `(debate_id, turn_number)`
- `(debate_id, created_at)`

---

## 可选表：debate_exports

如需要记录导出历史，可增加：

| 字段 | 类型 | 描述 |
|------|------|------|
| id | UUID | 主键 |
| debate_id | UUID | 辩论 ID |
| user_id | UUID | 用户 ID |
| format | TEXT | `markdown` |
| created_at | TIMESTAMPTZ | 导出时间 |

---

## 明确不在 MVP 的表

以下表暂不建立：

- `viewpoints`
- `turn_arguments`
- `solutions`
- `scheme_scores`
- `user_votes`
- `user_interventions`
- `consensus_log`

原因：这些表都属于高级共识、图谱分析或用户干预能力，会放大实现与维护成本。

---

## RLS 原则

当前版本不依赖数据库原生 RLS，而是在应用层基于 session user_id 做权限校验。

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 收敛为 MVP 最小表模型，移除 V2 高复杂度表 |
| 1.0 | 2026-03-06 | 初始数据库设计 |
