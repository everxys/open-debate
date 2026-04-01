# AI 辩论场 - 数据库设计（当前实现）

数据库为 Docker Compose 中的 PostgreSQL，初始化/升级入口为 `docker/init.sql`。

## 设计原则

1. 表结构以当前可用功能为准，不提前为 V2 设计高耦合模型。
2. 权限控制在应用层完成（基于 session user_id），不依赖数据库 RLS。
3. 结构化输出优先存 JSONB（`debate_turns.structured_output`）。

## 表结构概览（V1）

```
users
  ├── email_verification_codes
  ├── ai_agents
  │   └── ai_agent_files
  ├── strategies
  │   └── strategy_roles
  │       └── strategy_role_files
  ├── debates
  │   ├── debate_agents
  │   │   ├── debate_agent_overrides
  │   │   └── debate_agent_files
  │   ├── debate_turns
  │   └── debate_files
  └── rate_limit_counters
```

## 关键表说明

### debates

- `enable_shared_facts`：是否允许维护并注入 `facts/board.md`；在当前实现中，通常由 workflow 中的独立总结器把它整理成结构化事实板

### debate_agent_files（辩论级覆盖 + 参与者记忆）

同一场辩论的同一个参与者（`debate_agents.id`）对应一套文件：

- 策略/辩论级覆盖文件（从策略复制进来）
- 参与者独立长时记忆：
  - `memory/log.jsonl`（追加）
  - `memory/summary.md`（压缩摘要）

### debate_files（辩论共享文件）

- `facts/board.md`：全场共享结构化事实板（由独立总结器维护时生效）

## 备注

- 如已有旧数据卷，升级依赖 `docker/init.sql` 的 `create table if not exists`/`alter table if not exists` 兼容策略。
