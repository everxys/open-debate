主要缺陷

[x] 默认 workflow 不是通用默认，而是“轻度小说默认”。
本次已修复。
证据原先在 `lib/workflow.ts` 和 `lib/debates.ts`。默认 phase 标题、Phase 3 入场表决、Host/Supervisor/Specialist、ideaBank、`deliverables.requiredFiles` 里的世界观 / 章节 / 伏笔 / `novel_outline_v2.md` 都已经是小说语义。现在平台默认 workflow 已改成中立协作模式，默认完成模式也改成了 `consensus_only`。

[~] 运行时把“通用协作引擎”和“小说写作流程”耦合得太深。
本次已继续清理一轮。
原问题主要在 `lib/runtime-main.ts`、`lib/runtime/tools.ts`、`lib/runtime/workflow-phase.ts`，完成条件默认围绕“进入 Phase 3”“最终交付文件齐备”“Phase 3 入场投票通过”展开。现在 `completion.mode` 已经拆开，默认不再强制 deliverables 和 finalization phase，默认收束投票选项也已改成中性的“同意进入收束阶段 / 不同意，继续讨论”。剩余问题主要是少量旧文档和题材说明还没完全收口。
补充进展：
- `runtime-main.ts` 的自动开票标题和注释已去掉 `Phase 1.5 / Host first / Supervisor last` 这类默认心智暗示
- `debates.ts` 的文件活动标签已改成中性诊断，不再依赖 `Host / Supervisor / Contributor`
- `provider-shared.ts` 的角色职责提示已不再默认依赖 `Host / Supervisor / Specialist` 的 legacy 兜底

[x] 角色体系表面可配置，实质上高度偏向固定三分工。
本次已修复默认路径。
教程里虽然写“角色名是任意字符串”，但代码里的大量职责提示、文件写入建议、UI 展示、审计标签都围绕 `Host / Supervisor / Specialist` 三类展开。现在 `lib/debate-role-types.ts` 已改为动态读取任意选举角色，`lib/runtime/provider-shared.ts` 也已改成只看 `workflow.rolesMeta` / `writingPolicy`，UI 不再把三角色当唯一合法值。

[x] deliverables 机制太强，会把“文件生产”误当成“问题解决”。
本次已修复默认路径。
现在系统不再默认要求 `final/*` 或 `outputs/*` 才算完成。默认 workflow 使用 `consensus_only`，只有显式配置为 `consensus_plus_outputs` 或 `workflow_gate` 时，deliverables 才会成为完成门槛。

[~] phase 语义是“创作推进阶段”，不是“通用议题推进阶段”。
本次已继续改善。
现在默认 phase 已经进一步收缩成只剩一个 `deliberation`，选举、收束投票、收束阶段和显式分析阶段都不再默认出现在平台 workflow 里，只在 workflow 明确写出对应阶段时才会出现。底层仍保留这些能力，所以这条问题还没彻底结束，但默认路径已经明显更像通用讨论系统了。
补充进展：
- 辩论详情页在默认轻量 workflow 下，已经把“Workflow 规则”收敛成更像“讨论规则”的简洁说明
- 发言目录顶部和每轮列表里的默认阶段标签已隐藏，避免默认讨论看起来像一套正式阶段机
- 运行时给模型的提示也会优先用更轻的 `Discussion guidance`，而不是默认灌一整段 `Workflow phase`
- 默认暴露给用户的摘要和运行时提示标题，也在继续从 `Workflow 规则 / Workflow phase` 收口成更中性的“讨论规则 / Rule guidance”
- 策略编辑页里，workflow 相关入口也开始强调“这是可选增强”，不再暗示复杂 phase 配置是默认主路径

[~] 质量门槛更像“厚度门槛”，对小说很有用，对通用问题不一定对。
本次已完成第一阶段改造，并开始落到真实策略。
现在底层已经支持 `deliverables.requiredFiles[].qualityChecks`，可用来表达更通用的质量检查，例如：
- `requiredSections`
- `requiredTerms`
- `minBulletItems`
- `counters`

旧的 `minChars / minMarkdownHeadings / requiredSnippets` 仍然保留，所以这条问题还没彻底结束；但系统已经不再只能靠“字数 / 标题数 / 关键词”三个门槛吃天下了。并且数据库里当前真实使用的小说策略 `debate/workflow.json` 已经同步到新版 `qualityChecks` 规则，不再只是文档示例。
补充进展：
- 原先还没迁到 `qualityChecks` 的世界观、历史、阵营、主线骨架、人物关系、关键场景 6 份文件，现在也已经补齐结构项、术语项、要点数或计数器
- 当前小说 workflow 的所有必交文件都已经不再是“只看字数和标题”的老式门槛

[x] ideaBank 已经进入平台能力层，说明平台默认世界观仍偏“创意生产型”。
本次已修复默认路径。
现在 ideaBank 仍然作为可选 workflow 扩展存在，但不再属于平台默认 workflow，也不再在新建辩论页面里被当成默认心智模型展示。

[~] 文档和命名里仍残留“分类模板”心智，不够彻底通用。
本次已开始去模板化。
现在系统底层已经是中立机制，但文档里曾经仍带有 `generic/document/novel` 这类分类化叙事和模板文件。当前已删除这些分类模板文件，并把说明文档改成“只有 workflow + prompt，没有内置分类”的表达。剩余问题主要是少量题材文档还会把某些 workflow 组合称作某种模式，需要继续收束语言。

我认为最核心的问题，不是“策略不够通用”，而是“平台默认语义还不够中立”。

如果只改策略，不改默认能力层，你还是会反复遇到这几类问题：

- 没写清 workflow，也可能误以为系统内置了某种任务分类
- 角色名可配置，但行为提示仍偏 Host/Supervisor/Specialist
- 非写作任务也会被 deliverables/Phase 3 机制裹挟
- 平台会把“最终写稿”当成最标准的结束方式

当前建议的下一步优先级：

1. 继续清理题材文档中的“模式 / preset”语言。
   目标是让仓库里的所有正式说明都只强调 workflow 和 prompt 组合，而不是分类概念。

2. 继续细化真实策略中的质量门槛。
   现在所有必交文件都已经迁到 `qualityChecks`，下一步更适合针对事件、角色、章节、终局做更锋利的质量判据，而不是继续补覆盖率。

3. 继续收口知识文档。
   重点是把历史描述里仍残留的 `Phase 3 / Host / Supervisor / Specialist` 平台化说法清干净，避免误导后续接手者。
