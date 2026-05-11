---
date: 2026-04-11
type: Changed
title: 2026-04-11 更新汇总
scope: project
---

- 辩论页开始/暂停/恢复/终止按钮的 POST 请求新增 XHR 兜底：正常仍走 `fetch`，但当浏览器扩展或网络层让 `window.fetch` 直接抛出 `Failed to fetch` 时，会自动重试一次，减少控制按钮被拦截卡死的问题。
- 修复 OpenAI 兼容接口在历史消息里携带工具调用时偶发缺少 `tool_calls[].type` 的问题：现在 provider 边界会统一补齐 `type: "function"`，并在重新启动辩论时清理旧的运行错误提示，避免已修复问题继续残留在页面上。
- 开始按 Kysely 重构数据库访问层：新增 `lib/db-schema.ts` 与 `lib/db.ts` 中的 Kysely 入口，先把 `workspace` 和 `runtime file-store` 两条低风险链路迁到 Kysely，连接池仍复用现有 `pg Pool`，避免引入第二套连接管理。
- 策略与检索模块也已迁到 Kysely：`lib/strategies.ts` 和 `lib/retrieval.ts` 的查询、事务与 upsert 全面收口，相关表类型补齐到 `lib/db-schema.ts`。
- 辩论与 workflow 阶段模块已迁到 Kysely：`lib/debates.ts` 和 `lib/runtime/workflow-phase.ts` 的查询与写入全量收口，debates 相关表类型补齐并用 Kysely 统一查询风格。
- AI 代理与验证码模块也已迁到 Kysely：`lib/agents.ts` 与 `lib/verification.ts` 改用 Kysely 查询/事务，并补齐 `ai_agent_files`、`email_verification_codes` 的 schema 定义。
- 运行时与任务队列也完成 Kysely 收口：`lib/runtime-main.ts`、`lib/runtime/tools.ts`、`lib/summary-jobs.ts`、`lib/summary-job-worker.ts`、`lib/rate-limit.ts`、`lib/auth.ts`、`lib/debate-role-types.ts`、`lib/debate-runtime-recovery.ts` 全部改为 Kysely 访问，并补齐 `users / rate_limit_counters / debate_summary_jobs` 的 schema。
- NPM 依赖安全修复：升级 `next` 到 `15.5.15`，并补充 `dompurify / brace-expansion / picomatch / flatted` 的 overrides；当前 `npm audit` 已清零。
- Next 配置更新：`experimental.typedRoutes` 迁到 `typedRoutes`，并补上 `outputFileTracingRoot` 以消除 workspace root 警告。
- AI 配置页的启用/禁用操作不再使用浏览器系统默认确认框，已改成页面内自定义弹窗，交互风格与现有面板保持一致。
- AI 配置列表新增 `全部 / 已启用 / 已禁用` 三个 tab，默认显示“全部”，可以直接按状态筛选。
- AI 配置卡片和筛选 tab 都补上了更明显的状态标识：启用显示绿点，禁用显示红点，状态一眼可见。
