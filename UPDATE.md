## 2026-03-20

- 重构：辩论页将“参与者面板”抽成局部组件 `ParticipantsPanel`，把新增 AI、上下文累计、席位调整等展示从主页面条件渲染中拆出，不改现有功能
- 重构：辩论页将“辩论文件面板”整体抽成局部组件 `DebateFilesPanel`，主页面条件渲染从内联大块 JSX 调整为面板级组合，提升可读性与后续扩展性，不改现有交互
- 重构：辩论页将文件栏右键菜单抽成局部组件 `DebateFilesContextMenu`，减少主页面文件面板分支里的内联菜单 JSX，不改现有交互
- 重构：辩论页将文件栏顶部工具区抽成局部组件 `DebateFilesToolbar`，减少主渲染区按钮/状态绑定的内联代码，不改现有功能
- 重构：辩论页将 `workflow` 规则面板抽成局部组件 `WorkflowRulesPanel`，减少主页面条件渲染中的内联 UI 体积，不改现有功能
- 重构：辩论页将“文件信息弹窗”和“下载进度弹窗”抽成局部组件，并清理内联 modal JSX，降低主页面渲染区域复杂度，不改现有交互
- 重构：辩论页文件栏抽出下载文件名解析、下载流进度读取、文件信息请求等 helper，并收敛相关类型定义，减少主组件中的请求细节代码，不改现有功能
- 重构：辩论页文件栏抽出“文件索引映射”和“多选计算”纯函数，收敛组件内分支逻辑，提升可读性与后续扩展性，不改现有交互
- 重构：辩论页 `workflow` 规则读取改为顶层请求 helper + 单一状态对象，减少分散的 loading/markdown 状态与重复请求拼装代码，不改现有功能
- 重构：将辩论页 `workflow` 规则 Markdown 的格式化逻辑与默认文案提升为顶层纯函数/常量，减少页面主组件体积，提升可读性，不改功能
- 重构：抽出 workflow 必交文件的公共格式化 helper，并合并 runtime / 页面 /摘要里的重复展示逻辑，提升可读性与后续扩展性，不改现有行为
- 小说细纲质量门槛继续加严：`deliverables.requiredFiles` 新增 `minMarkdownHeadings` 与 `requiredSnippets`，运行时会校验标题数量和关键结构词，避免只靠堆字数过关
- 小说细纲交付升级为“多文件 + 最少字数”机制：默认 workflow 与民主集中制 seed 不再只要求 `final/novel_outline_v2.md`，而是要求故事核心、人物卡、世界观、结构设计、章节细纲、伏笔回收表、总汇总稿等多份文件，并为每份文件增加 `minChars` 门槛
- 运行时完成校验同步升级：`deliverables.requiredFiles` 现在会同时检查“文件存在 + 内容非空 + 达到最少字数”，否则不会自动 `completed`
- 交付规则开始具备硬限制：`workflow.deliverables.requiredFiles` 不再只是提示词，运行时会在完成前检查这些文件是否已实际写入且非空；缺失时不会自动 `completed`
- workflow 配置化第四阶段：新增 `phaseMachine.transitionRules`，把 Phase 2 起始轮次、是否自动开选举票、Phase 4 进入条件、是否必须进入 Phase 4 才能完成，正式收进 `workflow.json`
- runtime 改为按 `phaseMachine.transitionRules` 判定阶段与完成条件，阶段摘要/辩论页规则面板也会直接显示这些切换规则
- 阶段机开始具备硬限制：`Phase 2` 才允许角色选举，`Phase 4` 才允许自定义/最终投票；未进入 `Phase 4` 时不再把辩论标记为 `completed`
- workflow 配置化第三阶段：把 Phase 1-4 正式结构化为 `phaseMachine.phases`，默认 workflow 与民主集中制 seed 同步携带四阶段定义
- runtime 开始读取阶段机：每回合提示词会明确注入“当前阶段 + 阶段目标 + 全部阶段机”，辩论页 Workflow 摘要也会显示阶段机配置
- 删除回滚机制：民主集中制 seed 不再要求“监管者一票否决并回滚”，监管者职责收敛为监督遗漏、指出偏差、要求补齐
- workflow 配置化第二阶段：新增 `voting.governance`，把平票处理策略、最大重投次数、平票后的建议模式抽到 `workflow.json`
- runtime 不再在平票时默认按最小席位偷偷判胜；当 `tieBreaker=revote` 时会按 workflow 自动保留/重开投票，并写入“先补信息再重投”的官方指令
- workflow 配置化第一阶段：新增 `promptPolicies`、`deliverables`、`voting.announcement.fallback`，把 Round 1 公平性提示、输出格式约束、允许写入路径、必交文件、公告 fallback 从 runtime/seed 文案里抽到 `workflow.json`
- runtime 开始真正读取 workflow 新配置：AI 提示词、`debate_files_write` 路径限制、投票公告 fallback 不再写死只认 `final/|outputs/`、`Seat-1`
- 民主集中制 seed 与默认 workflow 同步升级：补充交付路径、最终文件、输出格式与公告 fallback 配置
- 辩论详情页文件栏：支持 `Ctrl + 左键` 多选、`Shift + 左键` 区间多选，并增加右键菜单下载选中项
- 辩论详情页文件栏：下载选中项时增加实时进度条与已下载大小显示
- 辩论详情页文件栏：右键新增“获取文件信息”，可查看文件字数、大小、创建时间、修改时间
- 修复文件信息接口：不再错误依赖 `debates.deleted_at` 列，兼容当前数据库结构
- 辩论详情页文件栏：单文件下载改为直接原文件下载；下载进度改为弹窗；移除文件栏提示文案
- 新增辩论文件打包下载接口：可将选中的文件/文件夹展开后打成 zip 下载
- 清理未引用代码：删除未使用的 `components/auth/logout-button.tsx`、`components/docs/doc-markdown.tsx`、`scripts/openrouter-model-context.mjs`
- 精简现有实现：文档页直接复用 `MarkdownView`，移除 `role-files-manager` 中未被使用的包装导出；同时去掉 `MarkdownView` 内未使用的 fenced-code `lang` 字段
- 清理未接入站内文档的孤儿文件：删除 `docs/BACKGROUND_JOBS.md`、`docs/CONSENSUS_ALGORITHM.md`、`docs/DEBATE_QUESTION_DEMOCRATIC_CENTRALISM.md`、`docs/STRATEGY_DEMOCRATIC_CENTRALISM.md`、`docs/workflow-driven-voting-plan.md`

## 2026-03-18

- 运行时：第 1 轮不再向席位注入完整 seats 名单（仅告知自身 Seat-X + 公平性约束），避免开局就“评价/分配”其他席位导致看起来像有记忆
- 创建/开始辩论：禁止并清理从策略角色文件意外 seed 的内部路径（`debate/*`、`context/*`、`facts/*`、`votes/*`、`question/*`），避免新辩论读取到上一场残留的“记忆/段落/台账”
- 轮次架构：默认 `workflow.json` 调整为 Round 1 正序发言、Round 2 反序发言（轮次边界自动 reverse）；Round 3 起自动开选举投票（主持人/监管者）
- DB：`debate_agents` 增加 `display_name`（每席位随机唯一名）；`debate_turns` 增加 `debate_agent_id` + `seat_number`，避免复用同一 AI 配置时“错认人/错认席位”
- 运行时：提示词强化 “Round / Turn（本轮第几回） vs 全局 Turn #N”，避免把 Round 2 Turn 1 理解成“第 21 个席位/第 21 个人”
- 辩论详情页：发言目录与查看器标题同时显示 `#全局序号 + 第 X 轮第 Y 回 (+ Seat-X)`
- 辩论详情页：参与者的上下文百分比改为进度条（绿→黄→红）并保留百分比文字；参与者显示为 `Seat 顺位 + display_name`，并在旁边显示对应 AI 配置名
- seed SQL：民主集中制策略 `workflow.json` 的 `seatOrderRules` 改为 reverse（Round 2 反序），不再 rotate

## 2026-03-17

- 运行时：75% 自动“新会话”阈值改为按单席位“本段累计（sessionPromptTokens/contextLength）”判断，不再错误地按单次请求的 promptTokens 判断，避免长期讨论仍不触发分段
- 运行时：即使缺少 contextLength，也会持续写入 `context/usage_log.jsonl` 与累计 totals（ratio 为空时前端显示 `?`），避免“校准累计”提示 No usage log
- 辩论详情页：参与者栏的 `ctx`/`本段累计` 在 ratio 缺失时显示 `?`（不再出现 NaN%）；并展示“新会话次数”（= 会话编号-1）
- 校准累计 API：当尚无 usage log 时不再返回 404，改为返回 multiplier=1 的提示结果（可在产生若干轮记录后再次校准）
- 辩论详情页：左侧“记忆”改为“文件”，提供辩论全量文件管理器（debate_files + debate_agent_files），可浏览并打开查看内容
- 辩论详情页：发言目录按轮次折叠时不再渲染子列表；轮询拉取发言改为增量 after=lastTurnNumber（减少大轮次卡顿）
- 辩论文件查看弹窗：当内容被截断时提供“开头/末尾/加载更多”控制；读取接口 `maxChars` 增加 2,000,000 chars 上限，避免误配置导致页面卡死
- 运行时：新增工具 `debate_files_write`（所有席位可用），允许写入 `final/*` 或 `outputs/*`，用于把最终交付物落盘为辩论文件
- Token 统计：移除“估算+校准累计”，改为仅在模型返回真实 `usage` 时统计上下文百分比与本段累计；OpenAI 侧保持流式输出，流结束后后台追加一次“usage probe”请求仅取 `usage`（max_tokens=1）用于统计
- seed：民主集中制策略提示词补充 Skill 说明与硬性交付要求（最终表决通过后必须 `debate_files_write` 到 `final/novel_outline_v2.md`）
- 鉴权：修复 middleware 引用 `next/headers` 导致 Edge 运行时潜在崩溃的问题（抽离 `lib/session-core.ts`，middleware 改为仅依赖 Edge-safe 模块）
- 工程：补齐 ESLint 最小配置与依赖（`eslint@8` + `eslint-config-next@15.2.0`），让 `next lint` 可非交互运行
- 投票：自定义“方案投票”候选项数量由策略 `workflow.json` 的 `voting.custom.minOptions/maxOptions` 控制（默认不截断，按席位数生成）
- 投票：投票候选列表在注入到每个席位提示词时会按席位做稳定洗牌，降低“总是选前几位”的位置偏差
- 投票：投票起始轮次完全由策略 `workflow.json` 的 `election.startRound` 控制（自动开票也遵从该值）
- 投票：自动开票的状态提示不再硬编码“第 2 轮结束后”
- 投票：公告生成席位由策略 `workflow.json` 的 `voting.announcement.announcer` 控制（支持按 seat 或按角色 role 指定）
- 共识：阈值由策略 `workflow.json` 的 `consensus` 控制（enabled/minAvgScore/requireAllSeats）
- 运行时：Seats 列表不再固定 `limit 50`，避免席位数增长时提示词/Checkpoint 缺席
- 运行时：工具读文件/注入上下文默认不再按 chars 截断（显示全部）
- 文件管理：列表接口不再返回全量 content，改为按需读取；文件夹删除改为后端批量删除；拖拽 hover 降低无效 rerender
- 新增脚本：从 OpenRouter Models API 拉取模型 `context_length`（用于按 75% 阈值自动分段）
- AI 配置：新增 `contextLength`（tokens，可选），可从“模型目录”自动填充，用于后续按 75% 阈值自动分段
- AI 配置：新增“返回 JSON”调试按钮（复用测试连接接口 `?debug=1`），用于查看 Provider 原始返回并判断是否包含 usage
- 运行时：基于返回的 `usage.prompt_tokens`（不看 total）+ 配置的 `contextLength`，在轮次边界自动开始新段落（>= 75%）
- 辩论详情页：发言内容新增“跟随最新”按钮，开启后自动滚动到最新输出
- 运行时：官方投票若已开启但未封票，则在轮次边界自动封票（不改投票结果），并要求下一轮首位席位统计并公布结果
- DB：移除 `debate_agents(debate_id, ai_agent_id)` 唯一约束，允许同一场辩论复用同一个 AI 配置到多个席位
- AI 配置：修复“删除”按钮未检查后端错误导致看起来无效的问题（例如配置已被辩论使用时会提示失败）
- 辩论列表页：进行中辩论点击“删除”会提示“必须先终止才能删除”（不再无反应）
- 删除接口：`pending/running/paused` 状态统一禁止删除，避免误删进行中的辩论
- 辩论详情页：切换辩论 `id` 时重置本地 state，并防止旧的异步 `loadDebate()` 回写，避免新辩论短暂显示上一场辩论的发言/文件内容（看起来像“记忆”残留）
- 策略：duplicate 角色时不再自动追加 ` (copy)`，保持角色名一致
- 策略详情页：角色列表支持多选并批量删除（至少保留 2 个角色，保存后生效）
- 策略详情页：角色多选改为 `Ctrl + 左键` 切换选择、`Shift + 左键` 范围选择（`Ctrl+Shift` 追加范围）

## 2026-03-16

- 辩论详情页：运行控制按钮移动到“发言目录”标题上方
- 辩论详情页：恢复“停止”按钮（结束整场辩论）
- AI 配置页：拉取列表强制 `no-store`，避免删除/修改后列表因缓存不刷新；删除确认文案改为“仅进行中辩论占用时不可删”
- 民主集中制策略：Phase 2 投票后增加“计票员汇总并宣布结果”的强制规则
- 辩论详情页：发言目录按轮次插入“投票结果”入口，点击后在中间展示汇总
- 运行时：向模型注入最近若干轮发言上下文，支持 Seat-1/主持人读其他议员发言进行计票与汇总
- 创建辩论（使用策略）：角色映射允许重复使用同一个 AI 配置（一个配置可同时扮演多个席位）
- 社区策略：支持收藏 / 取消收藏、Fork 到“我的策略”
- 辩论详情页：停止按钮更名为“终止”
- 辩论详情页：修正实时“当前轮次/发言 #”显示（区分轮次与发言序号）
- 辩论详情页：发言内容面板高度增加，接近整页显示
- 辩论详情页：新增记忆查看入口（共享事实板 + 每个 AI 记忆摘要/log）
- 辩论详情页：修复记忆查看按钮（使用 debate_agent_id 读取，避免旧数据“file not found”）
- 运行时：强化轮次/席位规则提示，避免把“Turn #15”误解为“15 位议员”
- 运行时：新增官方投票工具（开票/投票/封票），封票后写入“主持人/监管员”官方指令并注入后续上下文
- 运行时：第 2 轮结束后强制自动开票（优先按 `workflow.json` 开启“角色选举”，否则退化为自定义方案投票）；封票后自动用 Seat-1 新对话生成投票公告并注入后续上下文，避免忘记开票/播报
- 运行时：修复“共识达成时跳过轮次边界投票封票/开票”的逻辑漏洞（投票开/封票不再被 `consensus.reached` 阻断；存在 open vote 时强制保持辩论 running）
- 辩论详情页：移除“新段落”按钮（仍保留自动分段/轮次边界 checkpoint 逻辑）
- 官方投票：自定义投票封票结果补齐 `prompt` 字段；逐票明细展示 `voterSeat`，避免复用同一 AI 配置导致“投票人重名”误解为少票
- 辩论详情页：移除发言目录上的“回到当前”按钮（发言内容面板已提供同功能按钮）
- 辩论记忆/文件管理：修复 `.jsonl` 长行溢出（强制断词换行）；后端对 `.jsonl` 默认截断并优先返回末尾，避免大文件卡顿
- 辩论详情页：参与者栏显示“上下文使用百分比（prompt_tokens/context_length）”（仅在模型返回 usage 且已配置 contextLength 时显示）
- 辩论详情页：参与者栏不再显示 provider；当 usage 缺失时用估算 token 显示 `ctx ~xx%`，避免长期为 `ctx ?`
- 辩论详情页：参与者栏显示“本段累计消耗百分比”（按单个席位的会话起点做增量，最多 100%）；每席位提供“新会话”按钮单独重置累计；并提供“校准累计”按钮（基于最近若干轮用 API usage 对估算值进行倍率校准）
- 运行时：75% 上下文阈值触发的“新会话/新段落”改为仅对触发的席位生效（不再全局重置所有席位的 recent turns 注入窗口）
- 辩论详情页：参与者列表显示每个席位累计“新会话”次数（会话编号）
- 辩论问题：房主可在暂停后随时更新；保存时生成问题 diff，并在后续回合全局注入给所有 AI
- 辩论详情页：问题“放大”弹窗在暂停中也可编辑与保存
- 辩论问题：保存时写入版本历史（v0001/v0002...），支持查看历史并生成版本间 diff
- 辩论详情页：保存问题后弹窗提示成功；版本 diff 支持左右对比视图（新增绿/删除红/改动蓝）
- 辩论详情页：问题编辑框支持行号；版本对比行号区域也按变更类型着色提示
- 辩论详情页：问题编辑时行号按新增/删除/修改着色提示；左右对比视图移除横线分隔
- 辩论详情页：问题编辑行号标记改用更稳定的行级 diff 对齐，避免变更位置偏移
- 辩论详情页：修复编辑行号标记在空行/尾随换行场景下的误判（误报新增/删除）
- 官方投票/角色机制改为 `workflow.json` 驱动（默认关闭；`enabled/startRound/roles/speakingOrder` 可配置）；创建辩论时从策略角色文件 `debate/workflow.json` 复制为辩论 `workflow.json`；选举结果/官方指令/席位顺序约束不再写死 Host/Supervisor
- 新增内置 Docs：`/docs` 目录 + `workflow` 超详细教程；顶部导航增加 `Docs`
- workflow 最佳实践补强：新增 `workflowVersion` + 校验；新增受限 `seatOrderRules`（rotate/reverse）支持在轮次边界自动重排（不依赖选举）
- seed：民主集中制策略的角色名统一为“通用议员”（避免与可变 Seat 顺序混淆）
- 辩论详情页：移除“席位顺序/应用官方顺序/刷新角色”面板，改为展示 `workflow.json` 的可读规则摘要；轮询请求加固，避免偶发 “Failed to fetch” 崩溃
- 辩论详情页：workflow 规则面板移动到参与者列表下方；规则标题更小、Markdown 列表缩进更紧凑
- 运行时：支持“分段对话”兜底（轮次边界生成 checkpoint；重置 recent turns 注入窗口；以共享 segment checkpoint + 记忆继续推进）
- 辩论详情页：补齐若干异步请求的异常捕获，避免出现未处理的 Promise rejection（例如 `[object Event]`）
- 辩论详情页：新增“辩论文件（只读）”列表（按 prefix 浏览 `debate_files`，方便查看 `votes/*` 等文件）
- 辩论详情页：左侧栏改为 VSCode 风格 Tabs（辩论状态/参与者/Workflow/文件/记忆），点击切换
- 辩论详情页：左侧栏 Tab 改为图标并提供悬停提示；文件管理默认显示文件树，点击文件弹窗查看内容
- 辩论详情页：记忆栏移除摘要/log，改为打开 AI 文件管理弹窗并在弹窗内查看文件
- 辩论详情页：移除“文件管理”Tab（功能合并到“记忆”）
- runtime：删除未使用的 `randomInt`/`aggregateConsensus` 等死代码（不改业务逻辑）
## 2026-03-14

- 辩论支持长时记忆（按参与者独立）：自动维护 `memory/log.jsonl`（追加）与 `memory/summary.md`（压缩摘要）
- 辩论增加全场共享“事实板”：可在创建辩论时选择开启；开启后自动维护 `facts/board.md` 并注入后续上下文
- 创建辩论支持“无限轮次”开关：直到达成共识或用户手动停止
- 辩论移除 Token 预算控制：不再因 token 达到预算自动停止（仅展示 token 统计）
- 构建提速：`next build` 跳过 ESLint 与 TypeScript 校验（可改为在 CI/本地单独跑）
- 取消辩论/策略的 2-5 数量限制：不再限制上限（仍要求至少 2 个参与者/角色）

## 2026-03-16

- 席位顺序支持重排：辩论详情页可在 `pending` 或 `paused`（需轮次边界）状态对参与者上移/下移
- 增加“应用官方顺序”：读取 `votes/directive.json`，一键将 Host 置顶、Supervisor 置底并提交重排
- 运行时在轮次边界自动应用 `seats/pending_reorder.json`（如选举后生成的 Host/监管席位调整）
- 辩论详情页定时刷新增加容错：后端不可达/网络波动不再抛出 “Failed to fetch” 白屏
- 新辩论默认不继承旧记忆：运行时/策略角色复制时忽略 `memory/*` 文件，避免跨辩论把“记忆文件”带入上下文
- 启动全新辩论（`pending` 且 `current_turn=0`）时强制清理 `memory/*` 与共享事实板，保证第一位 AI 首次发言无历史记忆
- 兼容 `memory\\*` / `Memory/*` 等路径变体：过滤与清理基于标准化路径，避免 Windows 路径导致“记忆文件”漏网
- 第一轮强制无长期上下文：在 `messageNumber <= participantCount` 时不注入 `memory/*` 与共享事实板，避免“开局带记忆”
- 投票规则调整：前 2 轮禁止官方投票；第 2 轮结束后（第 3 轮起）才能开启选举/投票，并且前端投票结果仅读取官方 `votes/round-*.json`

## 2026-03-15

- 策略“民主集中制共识算法”改为通用议员：不再用固定人设限制发挥；主持人/监管者仅在选举后切换职责
- 补充 seed SQL：一键插入通用议员版本策略（可改席位数）
- AI 配置支持导出 / 导入（加密文件，包含 API Key；导入无需重新填写）
- 创建辩论时使用策略：角色复制/删改仅作用于本次创建（不再修改原策略）
- 新建 AI 配置：隐藏 System Prompt（可在编辑时再填）
- AI 配置移除 System Prompt：System Prompt 仅在策略/辩论覆盖层配置
- 创建辩论：问题长度上限提升到 50,000 字符（避免长 IDEA 失败）
- 创建辩论页：问题输入框增加 50,000 字符限制与固定高度滚动，避免遮挡参与者区域
- 辩论列表/详情页：问题展示保留换行（pre-wrap）并限制显示高度/行数，避免长文本把页面撑爆
- 创建辩论页 / 辩论详情页：问题增加“放大”按钮（弹窗查看/编辑），便于处理超长内容
- 辩论详情页：未开始前可编辑并保存问题；开始后展示“当前轮到谁/状态”，并通过 SSE 实时追加输出
- 辩论轮次语义修正：`最大轮数/轮次` 现在按“全员各发言一次=1 轮”计算；共识也仅在一轮结束时判定，避免每人说一次就结束/轮次跳号
- OpenAI 运行时支持真正的流式输出：服务端解析 `stream=true` 的 SSE 增量，并通过辩论 SSE 推送到前端实时展示
- 辩论输出不再强制结构化 JSON：AI 可自由输出 Markdown（不再限制表达）；详情页以 Markdown 渲染 AI 输出
- 辩论列表页支持删除自己的辩论（运行中需先停止），并提供 `DELETE /api/debates/[id]`
- 辩论列表页新增 Tab：公开辩论 / 我的辩论；我的辩论可一键“公开/取消公开”（`debates.is_shared`）
- 辩论列表页：拉取列表失败（如 401/500）时不再崩溃，并展示错误提示
- 辩论列表页：公开辩论 Tab 也显示“新增辩论”按钮
- AI 配置导入：选择文件后不再立刻清空 input，避免一直显示 “no file chosen”
- 辩论详情页：辩论状态只显示当前 AI；发言内容移到主面板；发言记录改为右侧可折叠目录；暂停/恢复/停止收敛为一个“操作”按钮
- 辩论详情页：目录不再展示正文；点击目录在中间预览并高亮选中项；增加“回到当前”；整体页面宽度加宽
- 辩论详情页：中间发言内容加宽；运行控制按钮移动到发言目录上方并按状态切换（开始/暂停/恢复）
- 辩论输出：检测到 `proposed_solution/arguments/agreement_score` 这类 JSON 时自动转成可读 Markdown 保存与展示，并在运行时强制提示模型不要输出 JSON
- 民主集中制策略 seed：移除“必须输出 JSON”的硬性约束（改为 Markdown）
- 运行时：暂停/停止状态在回合结束写库时不再被覆盖，暂停更可靠；发言目录控制按钮移动到标题下方

## 2026-03-13

- 新增策略页：`/strategies`（我的策略 / 社区分享）
- 策略支持手动编辑：多个角色的 `System Prompt` + 文件
- 策略文件管理对齐 AI 配置文件管理：右键菜单新建文件/文件夹、Tabs、多文件编辑、拖拽移动路径、删除文件夹
- 策略支持分享 / 删除 / 使用（`使用` 会带入到创建辩论页）
- 创建辩论支持选择策略：将策略角色映射到当前用户 AI 配置；AI 数量不足时可勾选部分角色（仍需至少 2 个）
- 运行时支持辩论级覆盖：`System Prompt` 与文件优先从 debate override 读取，不污染全局 AI 配置

## 2026-03-12

- 新增用户角色：`user` / `admin`（`users.role`，默认 `user`；注册时可用 `ADMIN_EMAILS` 指定管理员邮箱）
- 顶部栏改为右上角头像菜单：安全管理 / 监控面板（仅 admin）/ 退出
- 新增安全管理页：`/settings/security`（修改密码）
- 新增监控面板：`/admin/observability`（仅 admin）
- 新增健康检查：`/api/health`
- 中间件不再强制把已登录用户从 `/login`、`/signup` 重定向回首页（避免残留 session 时“点登录无反应”）
- `ADMIN_EMAILS` 会覆盖旧 session 里的 `role`（避免管理员邮箱因旧 token 导致进不去 `/admin/*`）
- AI 配置：已有配置支持“修改”（同页编辑，当前编辑项高亮；API Key 可留空表示不变）
- 文件管理：VS Code 风格 tree，右键新建文件/文件夹、删除文件（支持删除文件夹）
- 文件管理：目录区改为可占满页面高度并滚动显示
- AI 配置：新增“复制（duplicate）”，会连同文件一起复制
- AI 配置：编辑态高亮增强（更明显）
- AI 配置：编辑态高亮样式调整，并在编辑时同时高亮左侧编辑面板；保存修改前二次确认
- AI 配置：编辑面板与卡片高亮风格统一；取消按钮移至底部并使用灰色样式
- 文件管理：右键菜单触发区域扩展到整个目录面板
- 文件管理：右键菜单打开时再次右键会移动菜单（不再先关闭）
- AI 配置：编辑态按钮顺序调整（测试 / 取消 / 保存）
- 文件管理：支持拖拽文件到文件夹（移动路径），文件不再显示“文件夹箭头”图标
- 文件管理：编辑区改为 Tabs（支持同时打开多个文件，未保存用圆点提示），并修复拖拽到文件夹的交互
- 文件管理：引入 `react-arborist`（树）+ `monaco-editor`（编辑器），替换自研 tree/textarea
- 辩论详情页重构：将 `status` 面板中的问题编辑/查看区抽成局部组件 `StatusQuestionPanel`，减少主页面内联 JSX 并保持原有交互不变
- 辩论详情页重构：将 `status` 面板中的运行状态摘要抽成局部组件 `StatusSummaryPanel`，让左侧状态分支结构更清晰
- 上下文新会话修正：75% 阈值统计在缺少 provider usage 时回退到估算 prompt tokens，并修正首个 session 的 baseline 计算，避免自动切会话过晚或完全不触发
- 上下文新会话接口修正：手动开始新会话时新增 `debateAgentId` 归属校验，避免把无效席位写进上下文统计文件
- 投票阶段修正：即使提前达成共识，正式最终投票阶段也不会早于 workflow 的 `election.startRound`；默认会先完整跑完前两轮，再从第三轮开始进入投票阶段
- 选举轮修正：角色选举投票时改为“只投票不发言”；提示词明确禁止追加分析，运行时也会把选举轮正文统一替换为中性占位内容，避免后续席位受前面发言影响
