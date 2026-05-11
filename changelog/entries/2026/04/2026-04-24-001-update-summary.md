---
date: 2026-04-24
type: Changed
title: 2026-04-24 更新汇总
scope: project
---

- AI 配置新增 `Coding Plan` 限额治理：`ai_agents` 现在支持 `usageControlMode` 和共享 `quotaProfileId` 绑定；新增计划池 CRUD/API、导入导出快照复用、5 小时/周/月请求数窗口、平滑节流、手工外部消耗校正，以及 AI 测试/调试在受限时返回结构化 `QUOTA_THROTTLED`。
- 运行时所有真实 provider HTTP 请求现在都会先走统一配额保留：debate 主流程、summary generation、vote announcement、AI 配置页 test/debug 都会按请求次数计费；超过 60 秒等待时会暂停 debate、延后 summary job，并由新的 `debate_resume_jobs` 后台恢复机制自动续跑。
- 辩论与 AI 配置可观测性补强：AI 配置页新增 Coding Plan 管理区、计划池摘要和限额模式显示；debate `runtimeNotice` 新增 `quota_wait`；结构化日志补上 `quota.reserve / wait_inline / pause_debate / defer_summary_job / resume_debate / manual_adjustment`，并带计划池、已用配额、恢复时间等上下文。
- 修复 Windows 开发环境反复出现的 `ChunkLoadError` / `vendor-chunks` / `webpack-runtime` 缓存错乱：`scripts/dev-with-summary-worker.cjs` 现在会在启动前自动清理当前仓库遗留的 `next dev` / `start-server` / `summary-worker` 进程并删除 `.next`，再次执行 `npm run dev` 时会自动顶掉旧实例，避免多个 dev 进程同时占用同一份产物导致模块和 chunk 丢失。
- 调整 AI 配置页布局：`已有配置` 恢复到右侧主区域，`Coding Plan 池管理` 改为整行放在下方；AI 配置卡片操作按钮改成可换行，长 `Base URL`/文案允许断行，避免卡片边框被撑爆；同时移除了卡片里的“文件”入口，避免把 AI 配置页做成混杂的文件管理入口。
