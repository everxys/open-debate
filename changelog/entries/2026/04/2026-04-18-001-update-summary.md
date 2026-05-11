---
date: 2026-04-18
type: Changed
title: 2026-04-18 更新汇总
scope: project
---

- 调整辩论页状态栏信息层级：failed 且已显示失败原因时不再重复显示 `停止原因: runtime error`；轮次 / token / 共识 / 阶段快照改成更醒目的彩色状态标签；问题区改为较短的预览框并引导通过“放大”查看完整内容，避免问题正文挤占整块侧栏。
- 新增辩论页“一次性自动恢复”按钮：手动启用后，下一次如果辩论进入 `failed`，后端会自动把该辩论从 `failed` 修复回 `running` 并立即重试一次，同时立刻消耗掉这次机会；如果再次失败，将正常停留在 `failed`，不会无限循环重试。该设置是持久化的，刷新页面或关闭标签页不会丢。
- 修复辩论页总结任务数字长期停留在旧值：详情页现在会在正常加载/轮询时主动拉取 `/summary-jobs` 作为真值并覆盖本地缓存，SSE 初始包也不再把进程内残留的历史 live job 重新混回页面；这样 `排队/运行中` 会跟数据库一致，不会再把早已不存在的 45 个排队任务挂在当前 running 辩论上。同时修正手动 `rebuild_round` 仍沿用旧轮次算法的问题，带官方投票轮的辩论不会再因为手动重建重新生成错误的 `turn:*` 依赖。
- 修复 summary worker 对过期/错误 OpenAI token 的处理：OpenAI 兼容接口返回 `invalid_api_key`、`invalid access token`、token 过期或 401 时，provider 现在会抛出明确的 `AI_INVALID_API_KEY`；turn summary / round summary / facts board / summary worker 遇到这类永久鉴权错误时不再盲目重试或反复刷新失败，而是直接把任务标成失败并提示更新总结器凭证。
- 修复 round summary 依赖 turn 号计算错误：当辩论中出现官方投票轮时，实际轮次号会跳过纯投票轮；round summary 现在会先把实际轮次映射回真实发言轮次，再计算依赖的 `turn:*` 列表和轮摘要写入锚点，避免生成永远等不到的 blocked 任务。
- 修复辩论页总结器状态误导：状态区现在只展示当前 debate 对应的 summary worker，避免全局旧 worker 的 `turn:26` 等历史任务串到当前辩论；worker 生命周期累计“完成/失败”不再显示在单个辩论面板里，避免误读为当前辩论完成数；summary worker 默认改为 3 并发处理，可通过 `OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY=1..8` 调整，减少回摘要串行积压。
- 当前真实策略补入通用状态纪律提示词：新增 shared 文件 `protocol/05_state_discipline.md`，要求所有角色区分确认状态、提案、持久写入、替代状态、路径权威、来源转换和矛盾处理；所有角色导航目录已加入该文件，`protocol/20_output_templates.md` 补上每回 `State Delta`，`protocol/40_material_and_outline_ledger.md` 补充与通用状态纪律的关系。
- 新建工作区不再自动创建任何默认文件模板；工作区文件完全由用户手动添加或由具体策略/流程显式提供，避免平台默认夹带 `debate/ideas/*` 结构。
- 去掉上一轮修复中不够通用的 runtime 路径假设：运行时不再自动把 `debate/ideas/*` 当成所有辩论的标准路径，也不再按 `selected-* / rejected-*` 等固定文件名识别影子文件；现在只依据当前 workflow 声明的 source-of-truth / allowed paths 做通用拦截。
- 修复长流程辩论的真源漂移与重复回合风险：workflow idea bank 派生文件会自动加入 AI 可写路径，同名 `outputs/*` 影子文件写入会被拒绝；`debate_files_write` 返回明确的写入确认；发言落盘加 per-debate advisory lock 与重复 turn 检测，新库新增 `debate_turns(debate_id, turn_number)` 唯一索引，旧库若已有重复会告警而不自动删数据。
- 新增 `npm run repair:duplicate-turns` 修复脚本：默认 dry-run 列出重复发言；加 `-- --apply` 时会先把较晚重复行归档到 `debate_files/context/repair/*.json`，再删除重复行并创建唯一索引。
- 继续修复 idea bank 真源路径：运行时会把 workflow 显式配置的 idea-bank 派生文件加入提示与可写路径；新增 `npm run repair:idea-bank-shadows`，可把历史 `outputs/selected-*` / `outputs/rejected-*` 迁回正式 `debate/ideas/*`。本地已迁移 7 个历史影子文件。
- 修复辩论运行恢复/失败收尾的 Postgres 错误：runtime 读取数据库时间字段时统一归一为 ISO，避免 `GMT+0800` 被 Postgres 误当作非法时区；`finishDebate` 改为类型明确的 Kysely update，避免 nullable 错误字段触发 `could not determine data type of parameter`。
- 辩论详情页的发言列表/正文 GET 请求新增 XHR 兜底，并对 debate id 做 URL 编码；当浏览器扩展拦截 `fetch` 导致 `Failed to fetch` 时，会自动重试一次，减少打开发言正文时的控制台 TypeError。
- “忽略失败原因”改为直接依赖数据库列；移除了业务代码里的自动补列逻辑，并为本地 `debates` 表手动补上 `ignored_runtime_error_signature` / `ignored_runtime_error_at`。
