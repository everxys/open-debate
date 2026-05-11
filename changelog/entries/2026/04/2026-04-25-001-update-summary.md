---
date: 2026-04-25
type: Changed
title: 2026-04-25 更新汇总
scope: project
---

- Playground 工具验收台把“全选测试集”从整行复选项收成了标题区小按钮，减少占位，同时保留一键选满和回退默认测试集的逻辑。
- 修复 Playground checklist 运行时落库失败：`playground_tool_checklists.tool_name` 的数据库 check constraint 之前还停留在旧工具名单，新增的 `harness_read / harness_write / harness_vote_cast` 会直接触发约束错误；现在 `lib/db.ts` 启动时会自动重建 `playground_tool_checklists_tool_name_check` 到新名单，`docker/init.sql` 也已同步，老库和新库都能正常记录 harness checklist 结果。
- 让 AI 配置页左右两栏高度做成真正的同步关系：`app/(main)/agents/page.tsx` 现在用 `ResizeObserver` 监听左侧编辑面板高度，并把同一高度显式施加给右侧“已有配置”面板；右侧内部列表区继续只在自己的 viewport 里滚动，因此以后左栏新增字段、提示文案或额外配置项时，右栏会自动等高跟随，而不是再依赖 CSS 拉伸碰运气。
- 继续修正辩论“文件”页与 AI 配置页的空白高度问题：文件页不再默认把树面板撑到剩余整块高度，`app/(main)/debates/[id]/debate-files-panel.tsx` 现在按树节点数量估算内容高度、到视口上限后再滚动，并把移动/窄屏下的 `debateSidebarPanelMemory` 改为自动高度，避免单列模式被 `debateViewportPanel` 固定高度强行拉出大空白；AI 配置页则把外层 grid 改为顶部对齐、右侧列表 panel 不再被左侧编辑器拉伸，同时取消卡片右侧灰色栏的整卡拉伸，解决列表底部和右侧栏内部反复出现的大块留白。
- 继续收紧 AI 配置页卡片布局：把 `app/(main)/agents/page.tsx` 里的 AI 条目改成明确的 `main / aside / metric pills` 结构，并把样式收口到 `app/globals.css`；右侧状态/操作栏现在使用固定合理宽度并拉满整卡高度，不再出现“右栏下面一大块空白”，左侧信息区改为自适应更紧凑的指标网格，也修掉了 P2 类配置在右侧浪费大量横向空间的问题。
- 修复辩论详情“文件”页树面板高度反复塌缩、下方出现大块空白的问题：把文件树视口从 `app/(main)/debates/[id]/page.tsx` 抽到新的 `app/(main)/debates/[id]/debate-files-panel.tsx`，由专门组件统一管理 toolbar / context menu / `react-arborist` 高度观察；同时把文件页的父容器改为锁定外层滚动、只让文件树自身接管剩余高度，避免 `debateSidebarContent` 和树视口双重滚动/量高互相打架，后续这块布局问题不再需要在主页面里散改。
- 修复 harness action 与 turn 落库之间的“一半成功”窗口：新增 `debate_turn_mutations` journal（见 `docker/init.sql` / `lib/db-schema.ts`），共享文件写入与 `vote_cast` 现在会先记录 pending before/after 快照；provider 回合异常时会即时回滚本轮 pending mutation，turn 真正落库成功后再立刻标记 committed；`runDebate` 在每次当前 turn 开始前还会自动 reconcile 残留 pending journal，避免出现“文件/投票已改，但对应发言没落库”的脏状态。
- 把 debate runtime 的主契约切到 harness action protocol：新增 `lib/runtime/runtime-action-harness.ts`，现在 provider 主循环会优先要求模型输出单个 ` ```debate-action``` ` JSON block，由 harness 自己解析并执行 `list / search / read / write_replace / write_append / write_section / vote_cast`，不再把 provider-native `tool_calls` 当作唯一正确路径。
- 新增 seat 级 working set 持久化：每个席位会把最近读写文件和 canonical source files 写入 `context/working_set.json`，恢复对话时会把这批目标直接注入 prompt，并据此按 runtime state 缩小可见 action 面，避免每次 resumed turn 都重新全树探索。
- 新增 harness 侧写入瘦身与语义循环检测：模型侧写入动作只需要给出 path/content/heading，版本校验和安全写入仍由底层 safe-write engine 自动补齐；同时 provider 主循环会对重复 `search/read/list`、同路径近似重复写入、`list <-> search` 振荡直接报 `AI_TOOL_LOOP_DETECTED`。
- Playground 新增第二层 harness capability check：基础/投票测试集现在额外包含 `Harness Read / Harness Write / Harness Vote Cast`，校验模型是否能按新 action 协议完成闭环，而原有 provider-native checklist 继续保留为 smoke 测试。
- 新增 `tests/runtime-action-harness.test.ts`，并扩展 `tests/playground-checklist.test.ts` 覆盖 harness case；`npx tsc --noEmit --pretty false` 与 `npm test` 已通过。

- 把 `TODO.md` 收口成只保留 tool harness 重构这一项，删除了此前其他已完成或次优先级的历史条目，避免后续讨论继续发散。
- 把下一阶段的 tool harness 重构方案写进了 `TODO.md`：不再把 provider-native `tool_calls` 视为唯一正确路径，后续改造将围绕 harness 自有 action protocol、按 runtime state 缩小动作面、seat working set、瘦身写入语义、语义型循环检测，以及让 Playground 对齐 harness 合同而不是只测 provider 原生 tool-calling。
- 去掉了 provider 的“无工具模式”补救和固定 `MAX_TOOL_ROUNDS = 3` 限制：OpenAI / Anthropic 运行时现在不再在工具链后偷偷切纯文本重试，也不再用固定 3 轮截断工具循环；遇到伪 `tool_calls` 或 provider 不支持工具时会直接报错暴露真实问题，辩论详情页的诊断文案也同步改成“不再自动切到无工具模式重试”。
- 关闭了这套小说 workflow 的 `finalization.autoOpenVote`：`docs/NOVEL_GODMODE_WORKFLOW.json`、`docs/WORKFLOW_TUTORIAL.md`、`docker/seed_democratic_centralism_strategy.sql` 以及本地 `output/workflow.json` 现在都改为默认不自动发起收束前表决；同时已把本地数据库里“民主集中制共识算法（先赛马，再相马）”策略及其 workspace 下已有 debate 的持久化 `workflow.json` 一并回填为 `false`，避免第 3 轮再自动跳进 Phase 2.5。
- 回滚了测试集勾选区过重的整块蓝色高亮，改为只加强下方工具卡片的选中态；当前选中项现在用更克制的浅蓝底、细内描边和轻阴影区分，避免把测试集 checkbox 区做得过满过硬。
- Playground 测试集勾选态高亮加强：测试集 checkbox 卡片现在在选中时会有更明显的蓝色边框、浅蓝底色和阴影，不再只靠小 checkbox 本身提示“当前已选中”。
- Playground checklist 批量测试提速：`全部测试` 后端改成按 3 项一批的限流并发执行，前端“补测未过项”也改成并发发起单项补测，明显减少等待时间，同时避免一次性把所有 case 全并发打满 provider。
- 把 Playground checklist 的投票工具约束改回“直接本地 SQL 定义”：`docker/init.sql` 与 `lib/db.ts` 的 `playground_tool_checklists` 建表定义现在直接包含 `debate_vote_open / debate_vote_cast / debate_vote_close`，并删掉了我此前临时加的运行时 `drop/add constraint` 单次修补逻辑。
- Playground 工具验收台的批量补测逻辑改成覆盖“失败 + 未测”两类项，按钮文案收成 `补测未过项`，避免用户误以为它只会处理已失败项而漏掉还没跑过的工具。
- Playground checklist 现在支持按“测试集”运行：新增 `基础测试集` 与 `投票测试集`，前端改为可见 checkbox 列表且默认只勾选基础集；左侧工具项与右侧详情会显示所属测试集，`全部测试` 只跑当前勾选的 suite。后端 checklist 定义改成 suite-aware，tool schema 与 DB 约束补上 `debate_vote_open / debate_vote_cast / debate_vote_close`，playground sandbox 也新增了最小投票开票/投票/关票模拟与结果文件落盘。
- Playground checklist 测试补强：新增 suite 默认值、suite -> case 展开、runtime tool coverage drift 保护，以及投票关票 evaluator 校验，避免以后 runtime 已暴露工具但 checklist/test 没跟上。
- 把 Playground checklist 下一阶段需求整理进 `TODO.md`：明确改成“测试集”模型，要求 `基础测试集` 默认勾选、`投票测试集` 可选勾选，并补上 suite-aware 后端结构、UI 勾选列表、coverage drift 测试、基础文件工具强化校验等执行项，避免后续直接开做时目标继续漂。
- Playground 右侧“当前状态”进度条现在直接显示每段阶段名称：详情区的 5 段状态条改成“标签 + 进度段”结构，`请求模型 / 接收输出 / 工具执行 / 文件变动 / 结果校验` 会直接展示在条上方，不再只靠颜色猜当前分段。
- 修正 Playground 工具验收台未测卡片的高度不一致：`idle` 状态不再额外渲染一行重复的“未测”阶段摘要，避免 p1 这类未测展示比 p2 终态卡片更高、看起来不齐。
- Playground checklist 改成真实 SSE 阶段流：新增 `queued / requesting_model / receiving_model_output / executing_tools / sandbox_changed / validating_result / passed / failed` 阶段模型，`playground_tool_checklists` 现在会持久化当前阶段、阶段开始时间、阶段索引、最近一次阶段轨迹和最近进度消息；新增 `/api/agents/playground/checklist/stream` SSE route 与 `lib/playground/live.ts` 轻量订阅中心，Playground 页面改用 `EventSource` 实时接收 `snapshot / checklist_progress / checklist_finished`，左侧每个工具项显示紧凑阶段进度条与当前阶段文案，右侧详情新增“当前状态”和“阶段轨迹”，同时失败项会保留真实卡住阶段而不是一律覆盖成通用 failed。
- 继续收口 Playground 进度 UI：已通过/失败这类终态不再在同一块里重复显示多次；每个阶段进度段新增 hover tooltip，可直接看到该绿条/红条对应的具体阶段，左侧 meta 信息也改成更紧凑的单行分隔显示。
- 继续压缩 Playground 左侧 checklist 卡片：工具状态已从进度条下方的单独一行挪到标题同一行，避免“已通过”这类终态独占一整行造成留白。
- 调整 Playground checklist 卡片列宽：收窄右侧“测试”按钮列并固定较小按钮宽度，把更多横向空间让给标题区，避免 `Agent Files List / Debate Files Read` 这类工具名被过早折成两行。
- Playground 已进一步收成真正的“工具验收台”：页面不再暴露高级自由调试模式，只保留 AI 选择、单项测试、全部测试、清空结果和最近一次 trace 详情；每个 checklist case 现在都是更复杂的多步文件工具链路（如先 list/search/stat 再 read/write），并且 Playground checklist 的真实模型请求会按 `playground_checklist` 计入该 AI 的 Coding Plan 次数。
- Playground 工具验收台新增“只重测失败项”按钮：会按当前失败工具串行重跑，不影响已通过项，继续复用单项测试接口、持久化状态和最近一次 trace。
- Playground checklist 视觉进一步压缩：左侧验收项改成更紧凑的行式布局，状态从文字 pill 改成白/绿/红小圆点，并新增 `?` 悬浮说明按钮，移动到问号上即可查看每项的用途、最近测试时间和失败原因。
- Playground checklist 交互继续收口：左侧卡片整行点击即可切换右侧详情，去掉了“查看详情”按钮；单项按钮文案收成“测试”，错误信息与 tooltip 都改成强制断行，避免长 provider 报错把卡片或悬浮层撑出边框。
- 修复 Playground checklist 的 hydration 报错：左侧整行项不再用外层 `button` 包裹内部 `?` / `测试` 按钮，改成带键盘可达性的可点击容器，避免 `<button>` 嵌套 `<button>`。
- Playground 的 sandbox files 现在改成文件管理器视图：复用了仓库现有的 `fs-tree + react-arborist + treeRoot/treeRow` 文件树体系，初始文件和运行后文件都可以在左侧树里切换、右侧预览；同时把 Playground 左侧主栏进一步压窄，减少 checklist 区域对详情区的挤压。
- 新增顶级导航 `Playground` 与真实 AI tool sandbox：新增 `/playground` 页面和 `/api/agents/playground` 接口，可直接选择已启用 AI、填写 system/user prompt、勾选文件工具、配置初始 sandbox 文件，并查看 assistant timeline、tool args/result、最终输出、断言结果和运行后文件树。Playground 复用现有 provider/tool schema 与 quota 治理，但所有读写都落在隔离的内存 sandbox，不会污染真实 debate/workspace/strategy 文件。
- 辩论参与者面板里的“加入新的 AI”下拉现在只显示已启用的 AI 配置；后端 `appendAgentToDebate` 也同步要求 `ai_agents.is_active = true`，避免通过旧缓存或手工请求把已禁用配置继续加进运行中的辩论。
- 隔离 Next.js 开发与生产构建产物：`next.config.mjs` 现在支持通过 `OPEN_DEBATE_NEXT_DIST_DIR` 指定产物目录，`npm run dev` 会固定使用 `.next-dev`，避免开发态和 `.next` 生产产物共用同一套 `vendor-chunks`/`webpack-runtime` 文件，减少大改后反复出现的 `Cannot find module './vendor-chunks/kysely.js'`、`ChunkLoadError` 等缓存污染问题。
- 更新 Windows 开发启动器：`scripts/dev-with-summary-worker.cjs` 启动前会同时清理 `.next-dev` 和遗留 `.next`，然后用 `.next-dev` 启动 Next dev，继续保留旧进程清理逻辑。
- 在 `USER.md` 记录了本仓库的 Next.js 开发环境约定：这类 chunk/module 缺失优先按缓存或旧进程污染处理，并统一通过 `npm run dev` 管理单套开发进程。

- 辩论文件管理新增“文件状态与时间线”能力：新增 `lib/debate-file-status.ts` 统一聚合 debate / debate-agent 文件的创建时间、修改时间、最近读取时间、最近写入人、读取/写入次数和事件时间线；`/api/debates/[id]/file-info` 现在直接返回扩展后的文件状态、版本记录和时间线，新增 `/api/debates/[id]/file-statuses` 给文件树批量渲染状态摘要。
- 辩论详情页文件树现在会直接显示每个文件的轻量状态摘要：包括当前版本、最近读取和最近更新时间；右键菜单“获取文件信息”已升级为“查看文件状态与时间线”，弹窗里可直接查看文件概况、版本记录和按时间排序的创建/修改/读取事件，不再需要手动翻文件记录页猜单个文件发生过什么。
