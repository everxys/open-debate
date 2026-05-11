---
date: 2026-04-23
type: Changed
title: 2026-04-23 更新汇总
scope: project
---

- 修复浏览器错误日志只显示 `{}` 的问题：logger 现在会规范化空错误对象和 DOMException/AbortError 这类非枚举浏览器错误，并把结构化字段序列化进首行日志；辩论详情页读取发言正文失败时会额外记录 action、debateId、turnNumber、HTTP status 和 API error，避免 `failed to load turn detail {}` 无法定位。
- 继续拆分 `lib/runtime-main.ts`：把官方投票公告生成抽到 `lib/runtime/vote-announcement.ts`，保留原先的 Seat-1 公告席位选择、provider 调用、fallback 公告和文件落盘逻辑；`runtime-main` 只保留 facade 转发与主循环调用，当前主文件降到约 1225 行。
- 继续拆分 `lib/runtime-main.ts`：把上下文 inline loader、seat/shared context access 自动读取、recent turns 拼装、workflow phase 提示和 idea bank inline 逻辑抽到新文件 `lib/runtime/runtime-inline-loaders.ts`；`runtime-main` 继续保持 facade 转发和 `runDebate` 原调用方式不变，主文件已进一步降到约 1382 行。
- 修复文件记录页签切换筛选后范围串位的问题：读取 / AI写入 / 总结器写入现在会隔离各自的导航树与已选范围，切换过程中旧 action 的慢请求不会覆盖当前视图，避免从 P1 切到读取再切回 AI写入时自动跳到 P2。
- 修正生成诊断对工具调用的误判：现在不会再因为 `toolCallsCount > 0` 就直接标成“工具打断”；当模型最终 `finishReason=stop/end_turn` 且正文完整落库时，会显示为“工具后正常结束”，只有最终停止原因仍停在 `tool_calls/function_call` 时才提示工具流程中断。
- 抽出共享下载 ZIP 基础设施：新增 `lib/zip.ts` 统一负责 ZIP stream 生成、DOS 时间戳、CRC32、central directory 和 ASCII 下载名归一化；辩论文件下载与策略导出下载 route 复用同一实现，保留各自的选择/权限/响应头逻辑不变；新增 `tests/zip.test.ts` 覆盖同步和异步 entries，当前 `npm test` 覆盖 30 条测试。
- 继续收口 runtime 裸日志：验证码邮件的 console delivery 改用 server logger 记录，剩余 `console.*` 仅保留在 logger 自身 fallback 和 CLI 脚本交互输出里。
- 扩展高风险路径测试覆盖：新增 `tests/http.test.ts`、`tests/db.test.ts`、`tests/summary-job-worker.test.ts`、`tests/debate-lifecycle.test.ts`、`tests/download-route.test.ts`，直接覆盖 API wrapper 成功/失败 envelope、JSON body fallback、DB recoverable pool error、summary worker 并发配置与连接错误分类、辩论 lifecycle 状态门禁、下载路由空选择校验。
- 新增 API route wrapper 层：`lib/http.ts` 现在提供 `apiRoute(...)`、统一成功 JSON、JSON body 读取、params 解析、可选 session 鉴权和 route/method/meta 错误上下文，统一收口到 `toErrorResponse(...)`；已迁移 agents、debates、strategies、workspaces、retrieval、model catalog 等 36 个高重复 JSON 路由，下载/SSE/上传等特殊响应路由暂时保留原专用实现。
- 拆分两个大型客户端详情页：`app/(main)/debates/[id]/page.tsx` 抽出文件树同步 hook、Esc 关闭 hook、注入提示词弹窗和左侧 tab rail；`app/(main)/strategies/[id]/page.tsx` 抽出类型/工具、文件读取规则 data hook、面板挂载 hook、提示词弹窗、概览区和高级操作区。业务逻辑、请求路径和页面文案保持不变，`npx tsc --noEmit --pretty false` 已通过。
- 继续拆分 `lib/runtime-main.ts`：把 debate file 访问与审计持久化整块抽到新文件 `lib/runtime/debate-file-access.ts`，统一承接 `listMergedSeatFiles`、`recordDebateFileActivity`、`recordImplicitFileReads`、`writeDebateFileWithMode` 以及 `agent_files_* / debate_files_*` 工具入口；`runtime-main` 继续只保留 import/re-export 与上层调用衔接，在不改业务逻辑的前提下主文件已进一步降到约 1936 行。
- 继续拆分 `lib/runtime-main.ts`：把 summary job 编排与 summary 生成核心再切成 `lib/runtime/summary-orchestration.ts` 和 `lib/runtime/summary-generation.ts`，`enqueue* / retry / live sync / runSummaryJobByRecord` 与 `generateTurnSummary / generateRoundSummary / refreshFactsBoardFromSummaries` 不再混在主文件里；`runtime-main` 维持 facade 和原调用面不变，便于下一步继续处理 `runDebate` 主循环。
- 继续拆分 `lib/runtime-main.ts`：把边界自动化相关逻辑继续拆成独立子模块，新增 `lib/runtime/workflow-summary.ts`、`lib/runtime/boundary-segments.ts`、`lib/runtime/boundary-votes.ts`，把 `appendWorkflowSummaryLines`、`startAutoSegment*`、投票边界自动开关与 fallback 公告生成从主文件里搬走；`lib/runtime/boundary-automation.ts` 也改成转发这些更细的 runtime 模块，`runtime-main` 在保持 facade 和原调用点不变的前提下进一步降到约 3910 行。
- 继续拆分 `lib/runtime-main.ts`：把 `finishDebate`、一次性自动恢复、runtime notice、recoverable interruption 判定、summary job 不可重试判定、phase snapshot 持久化这些运行时状态流转逻辑抽到新文件 `lib/runtime/runtime-state.ts`；`runtime-main` 继续保留对外 facade 和原调用点，当前行为不变，但主文件已进一步降到约 4299 行。
- 继续拆分 `lib/runtime-main.ts`：把响应解析、turn/debate/agent 归一化、上一轮共识计算这些纯函数抽到新文件 `lib/runtime/runtime-parsing.ts`，`runtime-main` 继续只做 import/re-export 和原调用点衔接；这一步不改业务逻辑，也为后面继续拆 `summary / runDebate` 主链路先清出一层稳定边界。
- 开始拆分 `lib/runtime-main.ts`：先把 `memory / context usage / generation diagnostics` 这一整块子域抽到新文件 `lib/runtime/memory.ts`，并把通用小工具抽到 `lib/runtime/runtime-utils.ts`；`runtime-main` 继续对外 re-export 这些函数，当前调用面不变，但主文件已先从约 4943 行降到约 4490 行，给后续继续拆 `summarizer / runDebate` 主链路腾出空间。
- 新增统一日志框架：补上 `lib/logger/shared.ts`、`lib/logger/server.ts`、`lib/logger/client.ts`，统一支持 `debug / info / warn / error` 四级日志、结构化字段、错误对象规范化和 child scope；服务端日志继续落到 `log/node-runtime-YYYY-MM-DD.log`，并可通过 `OPEN_DEBATE_LOG_LEVEL` / `NEXT_PUBLIC_OPEN_DEBATE_LOG_LEVEL` 控制输出级别。
- 补强关键服务端错误日志：`lib/http.ts` 现在会统一记录 API 失败（区分 4xx/5xx）；`lib/db.ts`、`lib/runtime/provider-shared.ts`、`lib/summary-job-worker.ts`、`lib/rate-limit.ts`、`lib/verification.ts`、`scripts/summary-worker.ts` 都已接入统一 logger，数据库连接异常、worker 租约/唤醒失败、runtime 错误、验证码表缺失等关键问题不再只剩裸 `console.error(error)`。
- 补上核心业务动作日志：辩论的 `start / pause / resume / repair / stop` 现在会记录 lifecycle 日志；对应 API 路由和 `summary-jobs`/验证码发送入口都会带上 `route / method / debateId / action` 等上下文，便于直接从日志定位是哪条接口、哪场 debate、哪个动作出错。
- 补强前端排障信息：辩论列表页和辩论详情页里原本没有上下文的失败输出，已改成带 action / debateId / turnNumber / file path 等上下文的 browser logger，尤其是“加载更早发言 / 读取正文 / 重置 usage session / 自动恢复设置 / 忽略失败 / 启停辩论 / 读取文件 / 下载 / 读诊断”等关键操作。
