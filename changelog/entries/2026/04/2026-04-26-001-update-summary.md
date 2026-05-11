---
date: 2026-04-26
type: Changed
title: 2026-04-26 更新汇总
scope: project
---

- 收紧 runtime 的“说人话”输出链路：新增 `lib/runtime/human-output.ts` 检查工具回合后的最终发言，遇到只复述写入成功、版本号、`ok:true` 或高密度 `100%/闭环/落库/P0/P1/全量校验` 且缺少具体内容的回复，会要求模型重写一次；同时强化 harness 指令，文件写入状态继续由程序记录，正文必须讲具体内容、原因和下一步。`facts/board.md` 现在会过滤写入确认、版本、待授权等流程状态，流程类信息另写入 `facts/process-state.md`，避免普通参与者继续被流程话术带偏。
- 修复 `time zone "gmt+0800" not recognized` 的真实主链：新增 `lib/timestamps.ts` 统一把数据库读出的 `Date/timestamptz` 归一成 ISO 字符串，并把 `lib/runtime/debate-file-access.ts`、`lib/runtime/runtime-action-harness.ts`、`lib/debate-resume-jobs.ts`、`lib/quota-control.ts`、`lib/summary-jobs.ts`、`lib/debates.ts` 接到这套归一化上，避免 harness mutation journal、quota/resume、summary worker 等链路把 `Date` 直接 `String(...)` 成 `GMT+0800` 后再写回 Postgres。
- 重构辩论详情“文件”页的顶部结构：`app/(main)/debates/[id]/debate-files-panel.tsx` 里的文件工具栏不再用会互相挤压的 grid/纵向摘要布局，而是改成独立的“主信息区 + 按钮区” header，统计信息用单行 chip 式文本展示，宽度不足时按钮区整体下移而不是把标题和计数挤成竖排；`app/globals.css` 同步重写了这块 header 样式与文件页页头样式，并继续保留文件树卡片脱离全局 `treeRoot` 拉伸、按内容高度驱动滚动的布局。
- 修复辩论详情“文件”页的双滚动条：文件树区域不再复用全局 `treeRoot` 和外层 `overflow:auto` 包裹 `react-arborist`，而是重构成 `debateFilesTreeCard -> debateFilesTreeFrame -> Tree` 的单一滚动所有权结构，外卡片只负责边框与裁剪，树组件自己负责滚动，避免同一块文件树里再出现两根垂直滚动条。
- 继续收口小说工作台的 harness 修复边界：保留通用修复（`unlockAfterPhase` 只做解锁后按需可读、workflow-level writable target bootstrap、`HARNESS_ACTION_RESULT` 作为文件状态唯一真相），但撤回了 runtime 里对 `debate/ideas/*.md` 的全局默认猜测；现在 `resolveDebateIdeaBankPaths` 只认 workflow 显式 `ideaBank.*Path`，并新增测试锁定这一点，避免把某个工作台的目录约定硬编码进所有辩论的通用 runtime。与此同时也已核实当前“神作小说工作台”对应策略与其 workspace 下已有 debates 的持久化 `workflow.json` 本身就已经是显式 `ideaBank` 配置，因此这次不需要再额外回填数据库。
- 修正 `docker/seed_democratic_centralism_strategy.sql` 里 Phase 1.5 的投票示例：不再教模型调用旧的 `debate_vote_cast` + `selections` 结构，改为与主 runtime 一致的 harness `vote_cast` debate-action 协议，避免 reseed / 导入后把过时投票语义重新注入 prompt。
- 收口 harness 的读写面与目标推进链：runtime 现在把 shared readable surface 和 writable surface 分开计算，`list/search` 返回的路径会直接写回 seat working set，下一轮 policy 能从 `list/search` 正常推进到 `read`；`read` 也改成只允许读取当前已知 target，不再借 `allowedOutputPaths` 扩大到整个 shared 写入面。
- 完成主 runtime 的投票语义迁移收尾：`provider-orchestration` 不再保留未接入主链路的 provider-native tool 执行分支，投票提示统一改成通过 harness `vote_cast` action 发 ballot，并由 runtime 自己负责后续 official close/result 发布，不再提示模型手动 `debate_vote_close`。
- 删除死掉的 workflow `voting.custom.minOptions/maxOptions` 配置：`lib/workflow.ts` 的 schema/default/normalize/canonical 输出与示例 workflow 文件现在都只保留仍然生效的 `voting.governance`，避免 GUI/JSON 继续暴露一组根本不会影响 runtime 的伪配置。
