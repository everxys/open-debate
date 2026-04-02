### 1. 项目全景图（Project Overview）

这是一个基于 Next.js 的“多 AI 参与辩论/协作写作平台”。用户先配置多个 AI Agent，再创建一场 Debate，让多个席位围绕问题轮流发言、投票、写共享文件，最终产出结构化结论或交付物。它解决的是“把多个大模型从单次问答，提升为可持续、多角色、可追踪、有中间产物的协作过程”。

技术栈清单：
- 前端：Next.js 15 App Router、React 19
- 后端：Next.js Route Handlers
- 数据库：PostgreSQL，驱动 `pg`
- 校验：`zod`
- 认证：`jose` + HttpOnly Session Cookie
- 编辑器/UI：Monaco Editor、react-arborist
- AI Provider：OpenAI / Anthropic
- 检索增强：自建 embedding 存储与余弦相似度检索，目前 retrieval provider 仅 `openai`

整体架构：
```text
页面(app/*)
  -> API 路由(app/api/*)
    -> 领域服务(lib/agents|strategies|debates|retrieval)
      -> 运行时(lib/runtime-main.ts + lib/runtime/*)
        -> PostgreSQL
```

核心思想是“Strategy 提供可复用的角色、Prompt 与 workflow 文件，Debate 是它们的运行实例”。创建 Debate 时，这些配置会被复制为辩论级覆盖与共享文件，然后运行时在这些文件上持续读写。

### 2. 目录结构解析（File Structure）

核心目录/文件：
- `app`：页面与 API 入口
- `app/api`：薄路由层，主要负责解析请求并调用 `lib/*`
- `lib/agents.ts`：AI 配置管理、连通性测试、导入导出、文件管理
- `lib/strategies.ts`：策略、角色、角色文件、workflow 配置管理
- `lib/debates.ts`：辩论创建、详情、文件查看、座位调整、启动/暂停/恢复/分段
- `lib/runtime-main.ts`：辩论运行主循环，项目最核心文件
- `lib/runtime`：运行时子模块，含工具、工作流、上下文拼装、文件存储、provider 适配
- `lib/workflow.ts`：工作流 DSL 的默认值、归一化与校验
- `lib/retrieval.ts`：embedding 配置、切块、索引、召回
- `docker/init.sql`：数据库真实 schema，权威数据模型来源
- `middleware.ts`：页面级鉴权与 admin 保护
- `docs/*`：设计/部署/功能说明，辅助理解，但以代码为准

配置/辅助文件：
- `package.json`：依赖与脚本
- `next.config.mjs`、`tsconfig.json`：框架配置
- `README.md`：运行说明，信息较简
- `UPDATE.md`：版本更新记录
- `SOUL.md`、`USER.md`：协作约定

### 3. 核心数据结构与模型（Data Models）

关键表：
- `users`：用户、角色、邮箱验证、登录失败锁定信息
- `ai_agents`：用户的 AI 配置；含 provider/model/baseUrl/apiKey 加密值
- `ai_agent_files`：Agent 私有文件
- `strategies` / `strategy_roles` / `strategy_role_files`：策略、角色、角色文件
- `debates`：辩论主表；含状态、当前 turn、共识、工作流阶段、运行时 notice、错误信息
- `debate_agents`：某场辩论中的席位实例；同一个 `ai_agent_id` 可复用为多个席位
- `debate_agent_overrides`：辩论级 system prompt 覆盖
- `debate_agent_files`：辩论中某席位的私有文件，也承载长期记忆
- `debate_files`：辩论共享文件，如 `workflow.json`、`facts/board.md`、`votes/*`、`final/*`
- `debate_turns`：每回合发言及结构化解析结果
- `debate_file_versions` / `debate_file_activity_logs`：共享文件版本与审计日志
- `retrieval_configs` / `debate_context_chunks` / `debate_context_embeddings`：检索配置、切块和向量

重要 Type：
- `DebateRecord`：辩论运行态主视图
- `DebateTurnRecord`：单次发言
- `StructuredOutput`：从模型输出中解析出的 `proposed_solution / arguments / agreement_score`
- `NormalizedDebateWorkflow`：归一化后的工作流配置，是运行时规则核心
- `OfficialVote`：官方投票 open/closed 状态对象，实际存到 `votes/open.json` 和 `votes/round-*.json`

数据流向：
- Strategy 生产角色 prompt 与模板文件，创建 Debate 时复制进 `debate_agent_overrides`、`debate_agent_files`、`debate_files`
- Runtime 读取 Agent 配置 + Debate 文件 + 历史 turns，生成新发言
- 新发言写入 `debate_turns`，并派生写入 memory、facts、votes、deliverables、retrieval chunks

### 4. 核心业务逻辑（Business Logic）⭐

功能模块 -> 执行流程

1. Agent 管理
- 输入：Agent 基本配置与 API Key
- 流程：`zod` 校验 -> `apiKey` 加密存库 -> 支持测试 provider 连通性 -> 支持复制/导出/导入文件
- 输出：脱敏后的 Agent View
- 边界：删除采用软删除 `deleted_at`；若 Agent 已被 pending/running/paused 的 Debate 使用，则拒绝删除

2. Strategy 管理
- 输入：策略名、角色列表、角色文件、可选 workflow
- 流程：创建 `strategies` -> 创建 `strategy_roles` -> 创建 `strategy_role_files`
- 输出：可复用的多角色讨论配置
- 特殊处理：`debate/workflow.json` 只允许最终保留一份“ownerRoleId”版本；fork 会复制角色及文件

3. 创建 Debate
- 入口：`createDebate`
- 模式 A：直接选 `agentIds`
  - 校验至少 2 个且归当前用户所有
  - 插入 `debates(status='pending')`
  - 插入 `debate_agents`
  - 自动写默认 `workflow.json`
- 模式 B：基于 Strategy
  - 校验 Strategy 可见、绑定的 Agent 属于当前用户
  - 插入 `debates`
  - 复制策略工作流与共享 debate 文件
  - 为每个绑定创建 `debate_agents`
  - 写入 `debate_agent_overrides.system_prompt`
  - 复制角色文件到 `debate_agent_files`
- 关键边界：策略文件中的 `memory/`、`debate/`、`context/`、`facts/`、`votes/`、`question/` 不会被种进席位文件，避免把旧辩论污染新辩论

4. 运行 Debate
- 入口：`startDebate` -> `runDebate`
- 主循环大致是：
```text
加载 debate + participants + workflow
while debate.status == running:
  选当前席位
  拼装 prompt 上下文
  调模型，必要时走工具调用轮
  持久化 turn
  更新检索索引、记忆、事实板、上下文用量
  若到轮次边界：
    生成 round summary
    自动封票/开票
    判断是否进入下一 workflow phase
    判断 deliverables 是否齐备、是否可完成
  sleep 1s
```
- 输出：`debate_turns`、`debate_files/*`、`debate_agent_files/*`、`debates.current_turn/status/...`
- 边界：
  - 运行中断可被自动恢复；不可恢复错误则把 Debate 置为 `failed`
  - pause/stop 后主循环会尊重 DB 状态
  - 有 `run-registry` 防止同一 Debate 重复并发运行

5. 文件工具与最终交付
- 运行时给模型暴露 `agent_files_*`、`debate_files_*`、`debate_vote_*`
- `final/*` 写入更严格：
  - 必须显式指定 `mode`
  - `replace` 需要先读版本信息
  - `section_merge` 必须提供已有标题
- 目的：防止最终稿被整篇误覆盖
- 审计：每次共享文件读写会进入 `debate_fil_activity_logs`

6. 工作流与官方投票
- `workflow.json` 定义固定角色席位下的 phase、收束条件、必交付文件、总结器和上下文访问规则
- 官方投票状态保存在 `votes/open.json`
- 封票后产出：
  - `votes/round-<n>.json`
  - `votes/round-<n>.md`
  - `votes/decision.md/json`
- 平台不再使用任命后角色；每个席位只保留固定基础角色，具体职责以策略里的 system prompt 和 `workflow.rolesMeta` 为准

魔法数字/硬编码：
- Session 7 天
- `MAX_TOOL_ROUNDS = 3`
- memory 压缩阈值 `60_000` chars，保留末尾 `120` 行，每 `6` turn 刷新摘要
- Prompt 硬上限：OpenAI `180_000` chars，Anthropic `220_000`
- deliverable shrink 保护：若旧内容超过 `2000` chars，新内容低于旧内容 `70%`，默认拒绝覆盖
- 自动分段阈值：
  - session prompt token / contextLength >= `0.75`
  - prompt chars / hard cap >= `0.82`
- 座位名随机生成最多尝试 `80` 次
- Debate `maxTurns` 允许 `0..200`，其中 `0` 表示无限轮

### 5. 模块间依赖与调用关系（Call Graph）

主要依赖关系：
- `app/api/*` -> `lib/agents|strategies|debates|retrieval`
- `lib/debates.ts` -> `lib/runtime.ts` -> `lib/runtime-main.ts`
- `lib/runtime-main.ts` -> `lib/runtime/tools|workflow-phase|context-inline|file-store|provider-*|retrieval`
- `lib/auth/session` 被几乎所有服务层复用
- `lib/db.ts` 是所有持久化入口，并负责 schema 兼容补丁与 runtime recovery 启动

核心调用链：
- 创建辩论：`POST /api/debates` -> `createDebate` -> `createDebateWithAgents|createDebateWithStrategy`
- 启动辩论：`POST /api/debates/[id]/start` -> `startDebate` -> `runDebate`
- 实时更新：
  - SSE：`/api/debates/[id]/events` -> `subscribeDebateLiveEvents`
  - 轮询：`/api/debates/[id]/progress` -> `getDebateLiveProgress`
- 服务重启恢复：`ensureDbReady` -> `ensureDebateRuntimeRecoveryStarted` -> 对所有 `status='running'` 的 Debate 再次 `runDebate`

全局状态/共享变量：
- DB Pool 单例：`globalThis.openDebatePool`
- 运行恢复 promise 单例
- 实时事件总线：`globalThis.__openDebateLive`
- Debate 运行互斥注册表：`run-registry`

这些都依赖 Node 进程内内存，跨实例部署时不是分布式协调。

### 6. 关键决策与设计取舍（Design Decisions）

能推断出的设计选择：
- 用 `debate_files`/`debate_agent_files` 模拟“辩论文件系统”，而不是把所有中间状态塞表字段：更适合 AI 工具读写、版本化和审计
- 用 DB 持久化状态 + 进程内事件总线：MVP 足够快，SSE 实现简单，但多实例扩展性一般
- 工作流配置存 JSON，而不是拆成很多表：迭代快，便于策略复制与版本兼容
- 检索实现放在应用层 JSON embedding，而非 PG vector：依赖更少，但查询效率和规模上限有限

技术债/临时方案：
- `db.ts` 里有大量 `alter table if not exists` 与兼容 backfill，说明 schema 演进频繁
- 很多地方用 `catch 42P01 -> MIGRATION_REQUIRED`，说明线上/旧数据卷兼容是常见问题
- runtime 逻辑极度集中在 `lib/runtime-main.ts`，维护成本高
- Anthropic/OpenAI 支持混在部分共享逻辑里，[需补充] 需要实际跑一遍 provider 差异验证

反常规实现：
- 辩论参与者角色不是持久化字段，而是从投票文件反推
- Debate 完成条件不只是 consensus，还受 workflow phase 和 required deliverables 约束
- 创建新 Debate 时会主动清理误种入的 memory/context/facts/votes 文件，明显是踩坑后的防御性设计

### 7. 接手须知（Onboarding Notes）

最容易踩坑的地方：
- `debates` 表字段和 `debate_files` 中的 `workflow.json`/`votes/*`/`context/*` 是双状态源，改一边常常不够
- `Strategy` 文件不是都能直接复制到 Debate；带有运行态语义的路径会被过滤
- `final/*` 写入有安全规则，直接 replace 很容易被拒
- 运行时恢复依赖进程内锁；如果以后做多副本部署，要先重做并发控制

高耦合修改提醒：
- 改 workflow 结构时，必须同时看 `lib/workflow.ts`、`lib/runtime/workflow-phase.ts`、`lib/runtime/tools.ts`、`lib/debates.ts`
- 改 debate 文件路径约定时，要同步改 constants、tool 校验、UI 文件查看、memory/facts/votes 注入逻辑
- 改 turn/round 计算时，要同步检查投票轮、phase 切换、自动分段、round summary
- 改 Agent 删除/复制逻辑时，要注意 `deleted_at`、active debate 引用、导入导出 pack 格式

### 8. 快速上手索引（Quick Reference）

常见操作对应位置：
- 新增/修改 Agent：`lib/agents.ts`
- 新增/修改 Strategy：`lib/strategies.ts`
- 创建/启动/暂停 Debate：`lib/debates.ts`
- 看运行主循环：`lib/runtime-main.ts`
- 改投票规则：`lib/runtime/tools.ts`
- 改 phase/workflow 规则：`lib/workflow.ts`、`lib/runtime/workflow-phase.ts`
- 改检索增强：`lib/retrieval.ts`
- 看数据库：`docker/init.sql`

如果要新增某类功能：
- 新增新的 Debate 运行规则：先从 `workflow.ts` 定义配置，再接 `runtime/workflow-phase.ts` 的阶段判断，最后落到 `runtime-main.ts`
- 新增新的共享文件工具：从 `runtime/provider-shared.ts` 的 tool schema + `runtime-main.ts` 的工具执行分支入手
- 新增新的 Strategy 能力：从 `strategies.ts` 的 role/file 复制逻辑入手，确认 Debate 实例化时如何继承
- 新增页面/API：遵循现有模式，UI 在 `app/(main)`，路由在 `app/api`，业务写进 `lib/*`
