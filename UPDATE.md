## 2026-04-26

- 修复 `time zone "gmt+0800" not recognized` 的真实主链：新增 `lib/timestamps.ts` 统一把数据库读出的 `Date/timestamptz` 归一成 ISO 字符串，并把 `lib/runtime/debate-file-access.ts`、`lib/runtime/runtime-action-harness.ts`、`lib/debate-resume-jobs.ts`、`lib/quota-control.ts`、`lib/summary-jobs.ts`、`lib/debates.ts` 接到这套归一化上，避免 harness mutation journal、quota/resume、summary worker 等链路把 `Date` 直接 `String(...)` 成 `GMT+0800` 后再写回 Postgres。
- 重构辩论详情“文件”页的顶部结构：`app/(main)/debates/[id]/debate-files-panel.tsx` 里的文件工具栏不再用会互相挤压的 grid/纵向摘要布局，而是改成独立的“主信息区 + 按钮区” header，统计信息用单行 chip 式文本展示，宽度不足时按钮区整体下移而不是把标题和计数挤成竖排；`app/globals.css` 同步重写了这块 header 样式与文件页页头样式，并继续保留文件树卡片脱离全局 `treeRoot` 拉伸、按内容高度驱动滚动的布局。
- 修复辩论详情“文件”页的双滚动条：文件树区域不再复用全局 `treeRoot` 和外层 `overflow:auto` 包裹 `react-arborist`，而是重构成 `debateFilesTreeCard -> debateFilesTreeFrame -> Tree` 的单一滚动所有权结构，外卡片只负责边框与裁剪，树组件自己负责滚动，避免同一块文件树里再出现两根垂直滚动条。
- 继续收口小说工作台的 harness 修复边界：保留通用修复（`unlockAfterPhase` 只做解锁后按需可读、workflow-level writable target bootstrap、`HARNESS_ACTION_RESULT` 作为文件状态唯一真相），但撤回了 runtime 里对 `debate/ideas/*.md` 的全局默认猜测；现在 `resolveDebateIdeaBankPaths` 只认 workflow 显式 `ideaBank.*Path`，并新增测试锁定这一点，避免把某个工作台的目录约定硬编码进所有辩论的通用 runtime。与此同时也已核实当前“神作小说工作台”对应策略与其 workspace 下已有 debates 的持久化 `workflow.json` 本身就已经是显式 `ideaBank` 配置，因此这次不需要再额外回填数据库。
- 修正 `docker/seed_democratic_centralism_strategy.sql` 里 Phase 1.5 的投票示例：不再教模型调用旧的 `debate_vote_cast` + `selections` 结构，改为与主 runtime 一致的 harness `vote_cast` debate-action 协议，避免 reseed / 导入后把过时投票语义重新注入 prompt。
- 收口 harness 的读写面与目标推进链：runtime 现在把 shared readable surface 和 writable surface 分开计算，`list/search` 返回的路径会直接写回 seat working set，下一轮 policy 能从 `list/search` 正常推进到 `read`；`read` 也改成只允许读取当前已知 target，不再借 `allowedOutputPaths` 扩大到整个 shared 写入面。
- 完成主 runtime 的投票语义迁移收尾：`provider-orchestration` 不再保留未接入主链路的 provider-native tool 执行分支，投票提示统一改成通过 harness `vote_cast` action 发 ballot，并由 runtime 自己负责后续 official close/result 发布，不再提示模型手动 `debate_vote_close`。
- 删除死掉的 workflow `voting.custom.minOptions/maxOptions` 配置：`lib/workflow.ts` 的 schema/default/normalize/canonical 输出与示例 workflow 文件现在都只保留仍然生效的 `voting.governance`，避免 GUI/JSON 继续暴露一组根本不会影响 runtime 的伪配置。

## 2026-04-25

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

## 2026-04-24

- AI 配置新增 `Coding Plan` 限额治理：`ai_agents` 现在支持 `usageControlMode` 和共享 `quotaProfileId` 绑定；新增计划池 CRUD/API、导入导出快照复用、5 小时/周/月请求数窗口、平滑节流、手工外部消耗校正，以及 AI 测试/调试在受限时返回结构化 `QUOTA_THROTTLED`。
- 运行时所有真实 provider HTTP 请求现在都会先走统一配额保留：debate 主流程、summary generation、vote announcement、AI 配置页 test/debug 都会按请求次数计费；超过 60 秒等待时会暂停 debate、延后 summary job，并由新的 `debate_resume_jobs` 后台恢复机制自动续跑。
- 辩论与 AI 配置可观测性补强：AI 配置页新增 Coding Plan 管理区、计划池摘要和限额模式显示；debate `runtimeNotice` 新增 `quota_wait`；结构化日志补上 `quota.reserve / wait_inline / pause_debate / defer_summary_job / resume_debate / manual_adjustment`，并带计划池、已用配额、恢复时间等上下文。
- 修复 Windows 开发环境反复出现的 `ChunkLoadError` / `vendor-chunks` / `webpack-runtime` 缓存错乱：`scripts/dev-with-summary-worker.cjs` 现在会在启动前自动清理当前仓库遗留的 `next dev` / `start-server` / `summary-worker` 进程并删除 `.next`，再次执行 `npm run dev` 时会自动顶掉旧实例，避免多个 dev 进程同时占用同一份产物导致模块和 chunk 丢失。
- 调整 AI 配置页布局：`已有配置` 恢复到右侧主区域，`Coding Plan 池管理` 改为整行放在下方；AI 配置卡片操作按钮改成可换行，长 `Base URL`/文案允许断行，避免卡片边框被撑爆；同时移除了卡片里的“文件”入口，避免把 AI 配置页做成混杂的文件管理入口。

## 2026-04-23

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

## 2026-04-19

- 修复 summary worker 在本地 Postgres 重启/恢复期的进程级崩溃：`pg Pool` 现在会显式监听并吞掉空闲连接上的 `error` 事件，避免 `ECONNRESET` / `57P03 the database system is in recovery mode` 直接作为未处理事件把 Node 进程打死；同时数据库单例会在这类连接级故障后自动失效并重建，`ensureDbReady()` 的 schema 初始化失败也不再把 rejected promise 永久缓存住，数据库恢复后后续请求与 summary worker tick 可以自行重连继续跑。

## 2026-04-18

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

## 2026-04-13

- 辩论列表页的“清空已停止辩论”现在会同时纳入 `failed` 状态：后端清理条件已扩展为 `status in ('stopped', 'failed')`，前端统计与确认文案也同步改成“已停止/失败辩论”，避免失败辩论留在批量清理之外。
- 移除运行时所有 demo fallback：OpenAI / Anthropic provider 在空正文、伪工具调用补救失败、无工具降级仍无正文时不再伪造正常发言，而是统一抛出 `AI_EMPTY_RESPONSE`；开发环境中的 `demo-*` key 也不再返回模板内容，改为直接报配置错误。
- 辩论主循环的 provider 重试文案改为显式失败提示；当单席位连续 3 次调用都失败时，现在会追加一条 `context/generation_diagnostics.jsonl` 失败诊断记录，但不会写入 `debate_turns`、检索索引、memory 或 summary，避免假成功内容污染后续上下文。
- 新增最小 provider 守门测试：补上 `node:test + tsx` 的 `npm test` 脚本，并为“空输出必须失败 / demo key 禁用”添加单测，确保后续不会把伪成功 fallback 悄悄加回来。

## 2026-04-11

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

## 2026-04-02

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

## 2026-03-31

- 原始发言归档继续细化：运行时不再把一整轮都塞进单个 `debate/answers/round-<n>.md`，而是进一步拆成 `debate/answers/round-<n>/turn-<m>.md`，做到每一回一个文件，避免单轮文件继续膨胀。
- 重做辩论摘要体系：新增由策略 workflow 声明、在创建辩论时单独绑定 AI 的独立总结器；每回自动写入 `debate/turn_summaries/turn-<n>.md`，每轮只基于这些回摘要生成 `debate/round_summaries/round-<n>.md`，并把 `facts/board.md` 改成结构化事实板而不再逐回追加摘录。同时 SSE / 发言目录新增“AI 总结中...”状态，便于在两回之间观察总结进度。
- 新增 seat 级自动目录文件 `context/AGENTS.md`：系统会在每次生成前自动刷新，列出当前席位可见的私有文件、共享目录和用途摘要，帮助 AI 新开一轮时快速恢复文件上下文；同时修正 seat 覆盖文件与基础 `ai_agent_files` 的读取视图，现在两者会合并呈现，而不是“有任意 debate_agent_file 就把基础文件全遮住”。
- 继续把小说策略往“纯 workflow + prompt”收口：没有引入专门的 `ideaBank` 结构，而是在真实策略 workflow 里补了通用 `contextAccess`（允许按需读取 `debate/` 共享工作文件），并把原始点子池/筛选结果/事件映射等文件语义写进 opening prompt；同样配置已同步回数据库中的真实 `debate/workflow.json`。
- 删除 8 份已不再进入 docs 页面、也不再被代码或正式教程消费的小说方案草稿文档，保留真正仍在承担配置参照作用的 `docs/NOVEL_GODMODE_WORKFLOW.json` 与接手/教程类文档，减少仓库噪音。
- 新增 `docs/PROJECT_KNOWLEDGE_BASE.md`，整理项目全景、数据模型、运行时主流程、模块调用关系与接手须知，便于后续 AI 助手或新工程师快速接手项目。
- 平台默认 workflow 改为中立协作模式：无策略 `workflow.json` 时不再注入小说 deliverables、三角色职责和点子库语义，默认完成模式改为 `consensus_only`。
- 运行时角色解析改为从选举结果动态读取任意角色名，并新增 `workflow.completion.mode`、`workflow.rolesMeta`，让 workflow 自己定义完成规则和角色职责。
- 升级 `docs/NOVEL_GODMODE_WORKFLOW.json`：显式补上 `completion.mode = workflow_gate` 和 `rolesMeta`，避免小说神作模式在新版中因为默认语义变中立而提前收尾或弱化角色职责。
- 继续清理运行时 legacy 小说术语：`runtime/tools.ts`、`runtime-main.ts`、`debates.ts` 的默认投票/开票/诊断文案进一步改成中立表达，只把 `Phase 3 / Host / Supervisor` 保留在旧 workflow 兼容分支中。
- 新增通用质量检查框架：`deliverables.requiredFiles` 现已支持 `qualityChecks`，可表达 `requiredSections`、`requiredTerms`、`minBulletItems`、`counters`，不再只能依赖 `minChars / minMarkdownHeadings / requiredSnippets`。
- 去模板化重构：删除分类模板文件，不再把 generic/document/novel 当作系统内置概念；正式文档统一改成“纯 Workflow + Prompt”的通用讨论平台表述。
- 重写 `docs/PLATFORM_VS_NOVEL_SPLIT_PLAN.md` 为通用 workflow 架构说明，并同步更新 `docs/WORKFLOW_TUTORIAL.md`、`docs/PROJECT_KNOWLEDGE_BASE.md`、`docs/FAULT.md` 等文档的叙事。
- 把数据库里真实使用的小说策略 `debate/workflow.json` 同步到新版 `docs/NOVEL_GODMODE_WORKFLOW.json`，把增强后的 `qualityChecks` 正式应用到实际策略，而不只停留在文档中。
- 继续轻量化默认 workflow：默认阶段从 `analysis -> decision -> deliberation -> consolidation vote -> consolidation` 收缩成单阶段 `deliberation`，选举、收束投票、收束阶段和显式分析阶段只在 workflow 明确声明对应阶段时才进入默认摘要、阶段解析和界面说明。
- 进一步弱化默认阶段负担：默认 workflow 现在从第 1 轮直接进入实质讨论，不再默认要求先经历命名化的分析阶段；相关目录阶段解析和界面显示也已同步调整。
- 继续淡化默认“阶段机感”：辩论详情页的默认说明改成更接近“讨论规则”，默认轻量 workflow 下不再在发言目录和轮次列表里强调阶段标签，运行时也会优先注入更轻的 `Discussion guidance` 而不是完整阶段说明。
- 继续统一默认命名：对用户和模型暴露的摘要、提示、运行时通知，开始从 `Workflow 规则 / Workflow phase` 收口成更中性的“讨论规则 / Rule guidance”表述。
- 策略编辑页继续去主流程化：把“阶段注入提示词”“上下文读取策略”等入口改写成更明确的“可选增强”，强调默认可以直接讨论，只有需要复杂规则时才配置 workflow 阶段或目录读取规则。
- 继续淡化默认收尾心智：默认 workflow 不再显式内置 `consolidation` 阶段；如果 workflow 没有主动声明收束投票或收束阶段，运行时摘要和界面会明确显示“未配置”，而不是默认假设所有讨论都需要正式收尾阶段。
- 清掉最后一层小说硬编码：默认收束投票选项改成中性的“同意进入收束阶段 / 不同意，继续讨论”，默认选举文案不再写 `Phase 1.5`，角色职责提示和文件活动诊断也不再靠 `Host / Supervisor / Specialist` 的 legacy 兜底。
- 修正文档中的过时系统描述：`docs/PROJECT_KNOWLEDGE_BASE.md`、`docs/FAULT.md` 已改为“复杂 phase、选举、收束投票、角色职责都来自 workflow”，不再把 `Phase 3` 或三角色写成平台内建概念。
- 继续细化真实小说策略的质量门槛：为原先还只靠 `minChars / minMarkdownHeadings / requiredSnippets` 的世界观、历史、阵营、主线骨架、人物关系、关键场景文件补齐 `qualityChecks`，并已同步回数据库中的真实 `debate/workflow.json`。
- 修复 review 暴露的两个一致性问题：关闭共识检查时，完成判定允许正常结束但不会再把 `consensus_reached` 误写成“已达成”；同时默认轻量 workflow 下状态面板也不再额外显示阶段快照。
- 2026-04-01: round summary 默认提示词加厚，强调按回覆盖本轮关键推进/动作/风险；turn summaries 改为按 `debate/turn_summaries/round-<n>/turn-<m>.md` 分层存储，避免单目录爆满；文件记录新增“总结器写入”筛选，可单独查看独立总结器对回摘要、轮摘要和 `facts/board.md` 的写入活动。
- 2026-04-01: 强化 workflow 的上下文访问提示。当前阶段被锁定的共享文件现在会在 prompt 里明确标注“不要尝试读取，等解锁后再读”，同时把真实策略 `民主集中制共识算法（先赛马，再相马）` 的 opening prompt 也改成了同样语义，避免 AI 在投票前浪费回合去试读尚未开放的 `debate/*` 文件。
- 2026-04-01: 从 git 历史恢复一批之前删除但仍有参考价值的 `NOVEL_GODMODE_*` 文档，统一放到 `docs/restored_novel_godmode/`，并新增目录索引说明，避免它们继续混在当前主线 docs 里。
- 2026-04-01: 将当前数据库中策略 `民主集中制共识算法（先赛马，再相马）` 的角色文件按原始 tree 结构导出到 `docs/strategy_snapshot_democratic_centralism_current/`。每个角色单独一个目录，保留原始文件路径，并补充 `ROLE_META.md` / `system_prompt.md` 便于离线查看当前策略快照。
- 2026-04-01: 策略详情页新增“下载文件夹 / 上传文件夹覆盖”，支持把当前策略导出为保留 tree 结构的 ZIP 文件夹包，并通过选择本地文件夹整体覆盖当前策略；同时新增策略文件夹导入导出的 manifest 结构。
- 2026-04-01: 合并当前“民主集中制共识算法（先赛马，再相马）”策略与 `docs/restored_novel_godmode/` 中的高价值旧内容，新增 `docs/merged_democratic_centralism_strategy/` 作为策略源文件，并已把增强后的 `workflow`、`protocol/*`、`templates/debate_question.md` 回写到数据库中的当前策略。
- 2026-04-01: 继续把 `NOVEL_GODMODE_MASTER_PROMPT` 中未完全吸收的内容增强回当前策略：补强故事总前提、点子分层规则、事件/角色/终局失败判据、总结器的审判视角；新增 `protocol/40_idea_ledger_and_outline.md` 并同步到数据库中的当前策略。
- 2026-04-01: 对当前神作策略做了一轮不降质瘦身，压缩 `openingPrompt` 和部分 protocol / question 中的重复语义，保留核心高压目标，把细规则更多收束到 `protocol/*`，并同步回数据库中的当前策略。
- 2026-04-01: 继续把 `NOVEL_GODMODE_MASTER_PROMPT` 中缺失的高价值约束分层吸收回当前策略：新增 `protocol/50_arsenal_and_methods.md`，补回精简三层学科武器库、角色主场方法论、二刷成立级质量审判、阶段伪推进提醒，并同步到数据库中的当前策略。
- 2026-04-02: 给独立总结器调用加了轻量重试与退避；对 `fetch failed`、临时网络中断和常见限流错误会自动重试两次，减少 turn summary / facts board 偶发失败。
- 2026-04-02: 给独立总结器补了降级补偿链；turn summary / round summary / facts board 失败时会先写入 `context/summarizer_backlog.json` 待补队列，后续主循环和轮次边界会自动重试补生成，不再因为一次网络抖动直接丢摘要。
- 2026-04-02: 辩论页的总结状态现在会显示更完整的待补信息；summary job 新增失败原因和下次重试时间，前端会把“AI 待补生成 / AI 总结失败”的具体原因通过悬停提示展示出来，不再需要翻运行日志定位。
- 2026-04-02: 当前数据库策略 `民主集中制共识算法（先赛马，再相马）` 已从 5 个同质“通用议员”精简成 2 席：`通用议员 + 反驳者`。反驳者默认承担更高压的质量审判与拆错职责，但仍可被选为 Host / Supervisor；同时同步更新了策略 docs 源文件、开局问题模板、ground rules 和选举说明，避免继续隐含“多人同质赛马”的旧心智。
- 2026-04-02: 当前数据库策略继续扩成 3 席：`通用议员 + 反驳者 + 事件诡计工程师`。新增“事件诡计工程师”专门负责把大事件、诡计链、信息差、误导、反制、代价与余波做实，并同步更新了 docs 策略源、opening prompt、ground rules、选举说明和数据库中的真实策略。
- 2026-04-02: 平台级删除 `appointedRole / election / seat reorder / Supervisor` 运行模型，改成固定基础角色席位 + 固定 Host 主持流程。`workflow` schema 已去掉 `election` 和 `seatOrderRules`，官方投票只保留 `finalization / custom`，辩论详情页和策略编辑页也同步去除了选举心智。当前数据库策略 `民主集中制共识算法（先赛马，再相马）` 已重写成固定 `Host + 11 个内容席位` 的 12 席结构，并与 `docs/merged_democratic_centralism_strategy/` 源文件保持一致。
- 2026-04-02: 当前数据库策略继续扩成 5 席，补齐长期最优的核心创作会议结构：`通用议员 + 反驳者 + 事件诡计工程师 + 终局闭环官 + 人物关系审判官`。新增两类席位的专用 system prompt，并同步更新 docs 策略源、opening prompt、ground rules、选举说明和数据库中的真实策略。
- 2026-04-02: 当前数据库策略已按推荐配比扩成 12 席：`4 通用议员 + 2 反驳者 + 2 事件诡计工程师 + 2 终局闭环官 + 2 人物关系审判官`。继续保持 `role_order = 1` 为 owner role，独占 `debate/workflow.json`，其余 11 席共享同一套 protocol / template / ideas 文件。
- 2026-04-02: 新增辩论页在“使用策略”时增加“均匀分配 AI”按钮，可把当前已加载的 AI 配置按轮转方式平均绑定到所有启用席位，降低大席位策略的手动映射成本。
- 2026-04-02: 新增辩论页的总结器绑定区增加“随机 AI”按钮，可从当前已加载的 AI 配置中随机选择一台作为独立总结器，保留原有手动选择方式。
- 2026-04-02: 新增辩论页的问题输入框增加本地历史候选。聚焦问题框时会显示最近填写过的问题，可一键回填或清空历史，效果类似浏览器的表单历史提示，但支持当前使用的多行 textarea。
- 2026-04-02: 继续清理固定 Host 重构后的残留：删除 `workflow-phase.ts` 中已失效的 election helper；将官方投票结论文件从 `votes/directive.*` 更名为更中性的 `votes/decision.*`；并把策略文档 `30_election_and_veto.md` 重命名为 `30_host_and_quality_control.md`，同步更新知识库与教程中的相关说明。
- 2026-04-02: 调整当前神级小说策略的早期阶段节奏与命名：`Phase 1` 显式设置 `analysis.minRounds = 1`，确保新辩论第 1 轮稳定停在开题阶段；同时把 `Phase 2` 标题改为“子任务推进与方案成形”，并在阶段说明中补充“Phase 1 的成功标准是明确核心命题、底层约束、失败风险和下一阶段先推进的块”，避免一开局就呈现“内容锻造”的过重心智。 
- 2026-04-02: 删掉 workflow 中所有当前不属于硬约束的策略语义字段及其消费链，`workflow` 现在只保留真正被代码执行的 phase / completion / consensus / deliverables / contextAccess / summarizer / outputBudget 等硬规则；移除了 `rolesMeta`、`promptPolicies.openingPrompt`、`round1Fairness`、`responseFormat`、`voting.announcement`、`voting.governance.fallbackMode`、`deliverables` 中的角色分工与描述字段、以及 `contextAccess.label`。相关语义已回收到固定角色的 system prompt、`protocol/00_ground_rules.md`、`protocol/20_output_templates.md` 和 phase `injectedPrompt` 中，并同步写回当前数据库策略 `民主集中制共识算法（先赛马，再相马）`。
- 辩论详情页的参与者列表现在会显示每个 AI 在当前策略里的基础角色名，方便区分通用议员、反驳者、事件诡计工程师等固定席位。
- 辩论页每条发言的头部也会显示该 AI 的基础角色名，和参与者列表保持一致。
- 使用策略创建辩论时，现在可以给每个席位单独填写显示名称；留空时会自动回退为 `AI-1 / AI-2 / ...`，不再生成随机中文组合名。
- 修复辩论开始运行时误删 `context/base_role.json` 的问题；现在基础角色名会在运行中保留，参与者列表和发言头部都能稳定显示角色。
- 策略编辑页的多个分散保存按钮已合并成一个统一的“保存全部”，点击一次会顺序保存基础信息、阶段提示词、上下文读取规则和独立总结器配置。
- 策略“上传文件夹覆盖”现在会在真正覆盖前先解析 `manifest.json`，提示将保留、删除和新增哪些角色，避免误删角色后直接覆盖生效。

- 辩论实时状态与当前生成中的发言目录现在也会显示基础角色名（修复 live progress / chunk 事件未携带角色的问题）

- 统一辩论页角色显示顺序为 Seat-x · 角色名 · AI 名字，修复实时状态曾显示为 角色名 · Seat-x · AI 名字的问题
- 工作台详情页已从固定“原始点子库 / 项目说明 / 私有参考材料”文本框升级为真正的私有文件树编辑器；新增 `/api/workspaces/[id]/files` 文件级增删改查与移动接口，支持右键新建文件/文件夹、拖拽移动、分标签编辑和单文件保存。工作台基础信息保存与私有文件保存也已拆开，避免保存项目信息时覆盖掉最新私有文件内容。
- 工作台私有文件区已改成和策略页一致的左右双栏布局：左侧文件树，右侧文件编辑器；同时把顶部导航顺序调整为“辩论 / 工作台 / 策略 / AI 配置 / Docs”。
- 工作台“从工作台创建辩论”区域现在显式支持无限轮数：勾选“无限轮数”或将最大轮数设为 `0` 都表示不设轮数上限，不再需要靠隐含语义去猜。
- 工作台新增持久化的默认辩论配置：默认最大轮数与共享事实板会保存到工作台本身，列表页也可直接按默认配置一键从工作台创建辩论；工作台详情页底部创建按钮改为居中显示。
- 修复工作台默认辩论配置的真实数据库 schema 缺失问题，直接补齐 `workspaces.default_max_turns / default_enable_shared_facts`；同时工作台详情页新增底部“保存工作台”按钮，并在创建辩论或离开页面时对未保存更新给出确认提醒。
- 当前真实神级小说策略的 Phase 2 现在会在进入子任务推进阶段后自动读取 `debate/ideas/` 下的工作台私有素材，并在阶段注入提示中明确要求先消化 `raw-idea-bank / selected-s-tier / selected-a-tier / event-mappings` 等文件，再据此做筛选、重组和方案推进，避免“Phase 2 有流程提示但没有 ideas 输入”的问题。
- 当前真实神级小说策略的 `deliverables.requiredFiles[*].qualityChecks` 已全部移除，避免文件质量门槛过死；现在只保留 `minChars / minMarkdownHeadings / requiredSnippets` 这类更宽的约束。
- 当前真实神级小说策略的 `deliverables.requiredFiles[*].requiredSnippets` 也已全部移除，进一步放宽交付文件的硬性片段要求，改为主要依赖 AI 自主思考与更宽的长度/结构约束。
- 修复从工作台创建辩论时私有文件路径被错误去掉 `debate/` 前缀的问题；现在工作台中的 `debate/ideas/*` 会按原路径复制进辩论。同时已补正该工作台最近两场已创建辩论里的错误 `ideas/*` 路径为 `debate/ideas/*`。
- AI 配置页新增启用/禁用按钮；工作台中的“均匀分配 AI”和“总结器随机 AI”现在只会使用启用中的 AI。手动下拉仍会保留显示已禁用项，但会标注“已禁用”，避免自动分配继续选到这些配置。
- 修复辩论页左侧文件管理区域的高度链路：现在左侧侧栏与文件树都会严格按外层面板剩余高度伸展，文件树滚动区域不再只剩很小一段，展开大量文件时可视高度会更接近外边框的实际可用空间。
- 继续重构辩论页文件管理布局，移除左侧面板内部多余的嵌套 `panel`，改成“工具栏 + 文件树”两行结构，让文件树直接吃满大面板剩余高度，减少双层 padding/gap 吃掉可视空间的问题。
- 优化 `context/AGENTS.md` 的共享目录生成逻辑：现在 `debate/ideas/*` 会优先于 `debate/answers/*` 出现在目录里，并补充了 raw idea bank、S/A 级候选、事件映射、新增点子等文件的专用用途摘要，避免 idea 文件被大量发言归档挤掉看不见。
- 删除 `context/AGENTS.md` 的整套自动维护逻辑：运行时不再生成 seat 目录索引，也移除了相关常量、刷新调用和文档引用；同时清理了数据库里现存的 `context/AGENTS.md` 历史文件。
- 2026-04-11: 策略页改成“概览 + 折叠分区”结构，默认只展开 Workflow 与文件管理；角色编辑、导入导出与删除操作收进折叠区，策略概览集中呈现保存入口与共享/收藏状态。
- 2026-04-11: 策略页文件管理与角色重新合并，文件编辑视图直接跟随当前选中角色，避免角色与文件分离造成理解成本。
- 2026-04-12: 角色区内新增“角色文件”子分区，文件与角色强绑定并支持快速切换当前角色；角色列表与提示词单独折叠，降低干扰但保留编辑能力。
- 2026-04-12: 新增策略共享文件能力（独立共享文件表 + API + 策略页共享文件编辑区），导入/导出与 fork 同步支持 shared/ 目录。
- 2026-04-12: 已将当前策略中重复文件迁移为共享文件（脚本：`scripts/migrate-strategy-shared-files.cjs`）。
- 2026-04-12: 策略页改为分栏布局：左侧角色导航，右侧共享/角色文件与角色编辑；Workflow 与高级操作默认折叠并收缩文案。
- 2026-04-12: 策略页共享文件/角色文件/角色编辑改为左侧按钮切换显示，并高亮当前选中项。
- 2026-04-12: 策略页切换按钮高亮加强，并给右侧内容切换加入动效。
- 2026-04-12: 策略页切换按钮升级为高级动效高亮与过渡动画（Framer Motion）。
- 2026-04-12: 策略页切换高亮统一到 btn-active，并将过渡动画收敛为快速淡入+轻位移。
- 2026-04-12: 策略页切换高亮改为 btn-primary 蓝色，并放大角色编辑区与提示词输入框高度。
- 2026-04-12: 策略页三块内容区统一最小高度，保持视觉一致。
- 2026-04-12: 策略页三块内容区统一固定视口高度，并让文件区与角色编辑框撑满面板。
- 2026-04-18: 辩论状态页“失败原因”从卡片内双滚动改为“摘要卡 + 原始详情弹层”：主界面只显示提炼后的错误摘要与错误码，原始 payload 改到独立弹层里单滚动查看并支持复制，避免嵌套滚动条和状态区被长日志挤坏。
- 2026-04-18: AI 配置页新增“最近连通性校验”状态；保存配置后测试成功/失败都会持久化记录，列表与编辑区可见，且当 Provider / 模型 / Base URL / API Key 变更时会自动重置为未校验。
- 2026-04-18: 为 `next dev` 显式改用 webpack 内存缓存，避免 Windows 下 `PackFileCacheStrategy` 写 `.next/cache/webpack/*.pack` 时触发 `Failed to allocate memory` / `Caching failed for pack`。
- 2026-04-12: 策略页文件区容器改为内滚动，避免文件树溢出边框。
- 2026-04-12: 策略页文件区滚动改为 `overflow: auto`，避免无内容时也显示滚动条。
- 2026-04-12: 策略页文件树与编辑器高度改为自适应容器，避免固定高度导致溢出与空滚动条。
- 2026-04-12: 策略页角色管理面板高度上调，并修正树容器的内层布局以消除空滚动条。
- 2026-04-12: 策略页切换动效改为更快的同步切换，减少掉帧感。
- 2026-04-12: 策略页切换动画缩减为纯淡入淡出（80ms），进一步降低重绘开销。
- 2026-04-12: 策略页切换改为无动画的显示/隐藏，避免切换掉帧。
- 2026-04-12: 策略页切换改为惰性挂载 + startTransition，降低主线程阻塞。
- 2026-04-25: Playground 工具验收台的“测试集”区域新增“全选”选项，可一键选中全部测试集；取消全选时会回退到默认测试集，继续保持至少选中一组测试集的约束。
- 2026-04-12: 策略页隐藏面板启用 `contain` 隔离，进一步减少重绘开销。
- 2026-04-12: 策略页面板滚动条预留空间，避免首次切换引发边框抖动。
- 2026-04-12: 策略页切换改为绝对定位叠层，避免显示/隐藏触发布局抖动。
- 2026-04-12: 修复共享文件编辑区切换标签时的 `ensureTab` 未定义报错。
- 2026-04-12: 辩论页文件面板改为占满容器高度，避免只显示上半部分。
- 2026-04-12: 辩论页文件面板移除 tree 区固定最小高度，确保文件区填满侧栏。
- 2026-04-12: 辩论页文件区下载按钮固定宽度，避免选中数量变化导致布局跳动。
- 2026-04-12: 当前策略所有角色 System Prompt 已统一追加“文件/总结/轮次导览”提示。
- 2026-04-12: 更新当前策略导览提示，逐条写明 shared 文件用途与阅读顺序。
- 2026-04-12: 进一步细化策略导览，标注必读/建议读，并补充 seat 私有文件说明。
- 2026-04-12: 策略文件可读规则从 workflow 手写前缀迁到文件管理打标：新增 `strategy_file_access_rules` 表与 `/api/strategies/:id/file-access-rules` API，支持在共享文件/角色文件里直接把文件或文件夹标记为“每会话必读 / 按需可读 / 阶段解锁”；旧 `workflow.contextAccess` 会自动迁移并继续合成为运行时可读的 workflow 配置，策略页新增“阶段解锁（共享）”视图，旧的 pathPrefix/maxFiles/maxChars 手写编辑入口已收为只读说明。
- 2026-04-12: 总结任务 worker 增加数据库连接失败退避：遇到 `ECONNREFUSED` / PG 连接中断时不再持续刷整段错误栈，而是按失败次数退避重试并输出更短的“database unavailable”告警。
- 2026-04-12: `next start` 前新增构建产物自检脚本；当 `.next/prerender-manifest.json` 等关键文件缺失时，会先自动补跑 `next build`，避免半截构建目录导致启动直接报 `ENOENT`。
- 2026-04-12: 辩论页“文件记录”从单层时间倒序列表改为按 `AI -> Round -> Turn` 的折叠树；保留 `读取 / AI写入 / 总结器写入` 三类入口，默认展开 AI 层、Round/Turn 默认折叠，底层事件卡片与详情弹窗逻辑保持不变。
- 2026-04-12: 辩论页“文件记录”进一步重构为资源管理器式双栏布局：左侧改为轻量树导航选择 `AI / Round / Turn`，右侧集中展示当前节点下的具体记录与详情入口，减少卡片嵌套和长滚动带来的定位成本。
- 2026-04-12: 调整辩论页“文件记录”的响应式断点：平板/小桌面宽度下继续保持左右双栏，仅压缩左侧导航宽度；更窄屏幕才改为上下堆叠，避免右侧内容被推到树导航下方看不见。
- 2026-04-12: 修正窄屏下“文件记录”主内容不可见的问题：上下堆叠时改为右侧记录区优先显示、左侧树导航放到底部，并给主内容区稳定最小高度，避免进入页面先只看到树导航。
- 2026-04-12: 辩论页“文件记录”右侧详情列表改为紧凑行视图：保留路径、动作、角色、轮次、时间与 diff 摘要，但缩小边框与内边距，减少大卡片感，让单屏可浏览更多条记录。
- 2026-04-12: 宽屏下的“文件记录”不再塞在左侧固定窄栏里，而是直接占用辩论页主工作区；切到该标签时会隐藏发言内容与发言目录列，避免双栏资源管理器被外层三栏布局挤坏。
- 2026-04-12: 文件记录默认展开到 Turn 层级，并默认选中第一条可用 Turn，让右侧记录区一进入页面就展示更具体的回合记录，而不是停留在 AI/Round 总览。
- 2026-04-12: 文件记录左侧 AI 分组改为按名称自然排序，避免 `AI-12` 排在 `AI-2` 前或记录出现顺序导致的跳序问题。
- 2026-04-12: 文件记录左侧导航与右侧分页数据解耦：左侧 AI/Round/Turn 树只使用当前类别首屏快照，右侧“加载更多”只追加记录列表，不再把左侧 AI 列表范围一起扩大。
- 2026-04-12: 文件记录“加载更多”改为按当前选中的 AI/Round/Turn 过滤分页，并使用当前右侧列表最后一条作为 cursor，避免连续点击时加载到其他节点的数据而当前列表看起来没变化。
- 2026-04-12: 文件记录左侧树改为轻量完整导航索引（`mode=nav`）：左侧一次性加载完整 AI/Round/Turn/count 聚合，不再依赖事件列表分页；右侧仍按当前选中节点分页加载具体记录。默认只展开到 AI+Round，只有多个 Turn 的 Round 才需要展开 Turn。
- 2026-04-12: 文件记录点击左侧 AI/Round/Turn 时改为右侧局部加载，不再触发整个资源管理器面板的 loading 卸载，避免每次切换节点时外框闪烁。
- 2026-04-12: 修复 OpenAI 兼容运行时工具调用历史缺少 `tool_calls[].type = "function"` 的问题，避免下一轮请求被兼容接口以 `messages.tool_calls.type` 缺失拒绝。
- 2026-04-12: 辩论状态页的运行时失败原因改为短摘要 + 可展开原始详情，避免超长 API 错误文本挤压问题、总结任务和结构化事实板区域。
- 2026-04-12: 进一步收紧辩论状态页失败原因折叠样式：默认只显示“失败原因 + 错误码 + 点击展开详情”，详细 message 和原始 payload 仅在展开后显示并限制内部滚动高度。
- 2026-04-12: 辩论状态页“总结任务”改为默认折叠摘要，只展示回摘要/轮摘要/事实板与运行状态计数；展开后再显示重试/重建按钮和任务列表，减少对结构化事实板的挤压。
- 2026-04-13: 总结进程升级为独立可观测 worker：新增 `npm run worker:summary` 常驻消费 `debate_summary_jobs`，队列支持 `priority/run_after`、worker 心跳与 stale recovery；facts board 入队合并为固定 `facts:board` 并带 debounce，避免每回/每轮重复堆积，同时新增 worker health API 与辩论页总结任务中的 worker 在线状态展示。
- 2026-04-13: `npm run dev` 现在会同时启动 Next.js dev server 与独立 summary worker，并在 Next 进程中禁用嵌入式 summary worker，避免开发环境双 worker 抢任务。
- 2026-04-13: 继续优化 summary worker：入队后通过 Postgres `LISTEN/NOTIFY` 唤醒 worker，长 AI 总结期间定时刷新 job lease 与 worker heartbeat，避免长任务被误判 stale；同时为 active/running 总结队列补充 partial indexes，降低队列表增长后的扫描成本。
- 2026-04-18: 总结器队列改为短租约自愈：summary job lease 心跳收紧到 15s、stale 判定改为 45s，并结合 `debate_summary_workers` 的 `status/last_heartbeat_at` 回收失活锁；`facts_board` 入队前会先回收同辩论的 stale 运行任务，worker 停止时也会主动释放自己名下遗留锁。辩论页“总结任务”新增 `leaseState` 展示，可把 stale `running` 明确显示为“异常中断，等待自动恢复”，不再把卡死任务误看成一直运行或全部失败。
- 2026-04-18: “新增辩论”直建入口收紧为裸辩论模式：页面只显示已启用的 AI，隐藏“全场共享事实板”开关，并将创建说明改为“不注入 workflow 或预置文件”；后端直建辩论不再自动写入默认 `workflow.json`，同时新增硬校验，禁用中的 AI 不允许被选入辩论创建。
- 2026-04-18: 修复运行中强停进程后的重复发言问题：`runDebate` 启动时会先对账 `debate_turns` 与 `debates.current_turn`，若检测到“本回合已落盘但 current_turn 尚未推进”，会自动补齐轮次、token、共识与阶段快照，再继续运行，避免同一席位在服务恢复后把刚才那回重新生成一遍。
- 2026-04-21: 修复三处长期运行内存/状态膨胀风险：辩论 SSE 路由补上 `ReadableStream.cancel()` + 幂等 teardown，避免全局 live emitter 残留订阅；辩论详情页投票结果改为按需加载并限制本地缓存窗口，避免打开长辩论后把所有 round 的 vote JSON 常驻浏览器内存；运行注册表新增 heartbeat stale reap，防止异常退出后 `activeDebateRuns` 长期残留并阻塞后续运行。
- 2026-04-21: 继续修复 summary worker 的长期连接泄漏风险：`LISTEN/NOTIFY` wake listener 在数据库连接报错或启动失败时，现在会统一 `unlisten + release` 旧 `PoolClient`，停止 worker 时也复用同一套释放逻辑，避免数据库抖动后坏掉的 wake client 挂在进程里并随着重连次数累积。
- 2026-04-22: 修复辩论详情页状态区彩色栏之间个别贴连的问题：状态摘要区改为统一的纵向堆叠容器，给 `共识 / 阶段 / 自动恢复 / 总结任务` 等卡片提供一致的垂直间距，避免部分卡片因为没有自带 margin 而直接挤在一起。
- 2026-04-22: 修复移动端长错误状态把侧栏撑出边框的问题：状态区顶部的“当前席位 + 实时状态”改为上下堆叠，并给状态文本开启 `overflow-wrap:anywhere`，避免模型/接口返回的长错误 JSON 或 request id 把整个卡片横向撑爆。
- 2026-04-22: 修复 OpenAI 兼容 provider 因 `max_tokens` 超限直接报 `InvalidParameter` 的问题：运行时现在会按 provider 统一夹紧请求输出上限，OpenAI 路径默认和显式配置都不会超过 `32768`；agent 创建/更新/导入也新增同样的上限校验，并在读取旧配置时把超限 `max_output_tokens` 压到实际可用范围，避免库里残留的旧脏值继续把运行中的辩论打崩。
- 2026-04-26: `.gitignore` 新增 `.next-dev/`，避免 Next.js 开发态构建产物、热更新文件和 dev trace 持续污染工作区。
- 2026-04-26: 把小说工作台的 Phase 2 重新拉回 ledger 驱动：`workflow.json` 现在显式配置 `debate/ideas/current-battlefield.md` 与整套 idea-bank 衍生文件，Phase 2 提示改为先读 `current-battlefield`、再按需对照 `raw-idea-bank`，并明确这些文件就是 Phase 2 持续沉淀的权威 ledger，而不是留到 Phase 3 才写的空模板。
- 2026-04-26: 运行时新增阶段优先写目标：provider 编排会按当前 phase 选出 `current-battlefield / selected-s-tier / event-mappings / selected-a-tier` 等优先写文件，harness policy 会先暴露这批目标并把写入约束收窄到它们，避免 Phase 2 还没压出中间状态就被 `final/*` 重交付文件带偏。
- 2026-04-26: idea-bank inline 现在先注入 `current-battlefield`，只有战场摘要仍为空时才大段塞入 `raw-idea-bank`，降低模型被原始点子库淹没的概率；辩论页和 workflow 摘要也同步展示新的 `current-battlefield` 配置。
- 2026-04-26: 修复 harness 首轮 policy 与 prompt 已读共享文件脱节的问题：provider 编排现在会先收集本 turn 在 system/prompt 阶段隐式读到的可写共享文件，再把这些精确文件路径灌入 seat working set 并扩展运行时 `allowedOutputPaths`；同时 harness policy 只把真实可写的 shared target 视为 `known targets`，不再被 seat 文件或 read-only shared 文件误导，且 action 指令只展示当前实际允许的 JSON shape，避免再次出现 `ACTION_NOT_ALLOWED: write_append` 这类首轮错配。
- 2026-04-26: 新增统一的 Phase 2 ledger 模板与占位态识别：新 debate 创建时不再把 `selected-s-tier / selected-a-tier / event-mappings / rejected-or-merged / newly-invented-ideas / current-battlefield` 复制成旧占位文件，而是按当前 workflow 直接落盘新的 Phase 2 ledger 模板；repair 也会只在文件仍是旧模板/占位态时安全替换，不覆盖已有实质内容。
- 2026-04-26: harness 现在会按 Phase 2 ledger 的真实成熟度选写动作：缺失或模板态文件只开放 `write_replace`，结构化但未读的 ledger 只开放 `read`，只有已经成形且读过的 ledger 才开放 `write_section`；同时 `HARNESS_ACTION_RESULT` 会把 `section_merge`/heading 失败转换成明确的 `NEXT_RECOVERY_ACTION`，并在同一路径连续两次 heading mismatch 后锁死本 turn 的 `write_section`，避免继续空转。
- 2026-04-26: `repairDebate` 语义扩展到 `running / paused / failed`，repair 时会补齐 debate 级 `workflow.json` 的缺失 Phase 2 ledger 配置，并修复 debate 私有 `debate/ideas/*` ledger 文件；本地已对 debate `17eb9124-0f72-4c70-a38a-bbc249793ef1` 实际执行修复，当前状态已切回 `paused`，避免继续在旧模板上浪费回合。
