---
date: 2026-04-02
type: Changed
title: 2026-04-02 更新汇总
scope: project
---

- 新增“工作台”项目层：现在可以先基于共享策略创建私有工作台，再在工作台里保存题目、原始点子库、私有说明和默认 AI 绑定，最后从工作台创建辩论。工作台对应新增 `workspaces / workspace_role_bindings / workspace_files` 表、相关 API 与页面入口，策略页主按钮也已从“直接创建辩论”改成“创建工作台”。
- 工作台默认私有文件结构补齐为完整的 `debate/ideas/*` 工作目录，加上 `debate/notes/project-brief.md` 和 `debate/reference/private-materials.md`。这样原始点子池和筛选工作文件归工作台所有，不再跟着共享策略一起传播。
- 当前数据库里的“民主集中制共识算法（先赛马，再相马）”已完成一轮去私货化：共享策略中的 `debate/ideas/*` 文件全部删除，`templates/debate_question.md` 改成由工作台注入项目题目和素材的通用版，`protocol/40_idea_ledger_and_outline.md` 改成更通用的 `protocol/40_material_and_outline_ledger.md`。
- 继续把当前策略往“神级小说通用策略”收口：`workflow.json` 中明显项目专属的交付文件名已经改成更通用的版本，例如 `core-cast / pressure-cast-and-rivals / major-events / relationship-arcs-and-tensions / novel_bible`；`终局闭环官` 与 `人物关系审判官` 的 prompt 里也去掉了 `终局布局者 / 宿敌 / 纯爱 / 背叛` 这类过于项目特定的用词。
- 文档入口同步更新：`docs/FEATURES_CURRENT.md` 和 `docs/API_DESIGN.md` 已改成“策略 -> 工作台 -> 辩论”的新心智，不再继续描述“直接使用策略创建辩论”的旧主路径。
- 旧的 `debates/new` 页面已收口成“纯手动创建辩论”入口：如果带着 `strategyId` 访问，会自动跳转到对应的工作台创建页；页面本身不再承载“直接从策略创建辩论”的旧 UI 和旧流程。
- 辩论列表页的已结束区域改成统一的 `清空...` 弹窗：现在只保留“按已完成轮数阈值批量清空 stopped 辩论”，不再暴露“一键清空全部已停止辩论”，避免误删。
- `/api/debates/purge-stopped` 后端接口已同步收口，只接受“按轮数阈值清空 stopped 辩论”的请求，不再保留任何“清空全部已停止辩论”的分支。
- AI 总结系统重构为数据库任务队列：新增 `debate_summary_jobs` 表承载 `turn_summary / round_summary / facts_board` 三类总结任务，支持 `queued / running / retry_wait / blocked / failed / completed / dead_letter` 状态、依赖、重试、锁与恢复，不再使用 `context/summarizer_backlog.json` 作为真源。
- 辩论主流程与总结完全解耦：主循环现在只负责在每回/每轮边界 enqueue 总结任务，不再等待回摘要、轮摘要或 facts board 完成，下一回讨论可以直接继续推进；总结改由独立后台 worker 抢占任务并异步执行。
- 新增总结 worker 与恢复逻辑：服务启动后会自动启动 summary worker，周期性回收超时 `running` 任务并继续处理 `queued / retry_wait / blocked` 任务；即使 debate 已 `completed`，总结任务也会继续后台补齐。
- 总结输出加了轻量 post-check：回摘要、轮摘要、facts board 现在会校验最小长度与必需 Markdown section，避免把空摘要、报错回显或明显垃圾内容直接写入文件。
- 辩论页升级了“总结任务”可观测性：状态栏现在会显示总结任务总览、待补/失败数量和活跃任务列表，并支持直接触发 `重试失败总结` 与 `重建 facts board`；发言目录和轮目录的“AI 总结中 / 待补生成 / 失败”标记已改为读取新的数据库 job 状态。
- 新增 `app/api/debates/[id]/summary-jobs` 接口，支持查看总结任务列表以及手动执行 `retry_failed / rebuild_turn / rebuild_round / rebuild_facts`，为后续更完整的总结控制台打下基础。
