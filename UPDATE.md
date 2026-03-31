## 2026-03-31

- 运行时结构性重构继续推进：`lib/runtime-main.ts` 的 `callProvider()` 已下沉到真实的 `lib/runtime/provider-orchestration.ts`，把 provider prompt 组装、OpenAI / Anthropic tool loop、vote-close 后公告副作用、usage / diagnostics 归一化从主文件迁出；`runtime-main.ts` 继续保留稳定入口转发，对外行为、返回结构、工具调用顺序与投票后续处理保持不变
- 运行时解环收口：`lib/runtime-main.ts` 不再静态 import `lib/runtime/provider-orchestration.ts`，`callProvider()` 改为懒加载转发，先消除 provider 编排与主运行时之间的运行时循环依赖；后续会继续把共享 helper 从 `runtime-main.ts` 逐步下沉成独立模块
- 运行时共享层继续下沉：新增 `lib/runtime/provider-shared.ts`，把 provider 编排与主运行时共用的一组低风险 helper 提取出来，包括日志包装、prompt token 估算、输入裁剪、provider tool schema、基础 system prompt、响应格式指令、chunk 推送与选项摘要等；`lib/runtime/provider-orchestration.ts` 不再依赖这些实现仍留在 `runtime-main.ts` 中
- 运行时结构性重构继续推进：`lib/runtime-main.ts` 把一批低耦合实现下沉到真实子模块，其中 `lib/runtime/context-inline.ts` 现在承接 context access 规则解析、prompt 预算裁剪与 phase snapshot；`lib/runtime/tools.ts` 现在承接官方投票读写流转与 debate 文件写入相关纯 helper。对外行为、投票文案、文件路径、落库顺序与 `runDebate()` 出口保持不变，目标是继续把超长运行时主文件收敛为编排层
- 修复 recent-turn 窗口与席位数失配：运行时 recent context 之前被 `Math.min(8, ...)` 硬卡到最多 8 条消息，席位数超过 8 时甚至装不下一整轮最新发言；现在 recent window 至少覆盖最近完整一轮，避免大席位辩论里漏掉刚结束轮次的后半段发言
- 运行时门面化拆分：把超长 `lib/runtime.ts` 整体迁到 `lib/runtime-main.ts`，将 `lib/runtime.ts` 收敛为 `runDebate()` 门面导出；同时新增 `lib/runtime/context-inline.ts`、`lib/runtime/tools.ts`、`lib/runtime/provider-orchestration.ts`、`lib/runtime/boundary-automation.ts` 作为按子域组织的内部出口，先把公共导入路径与文件职责边界拉直，后续再继续把 `runtime-main.ts` 内部实现逐块下沉
- 安全修复：`lib/crypto.ts` 不再在生产环境静默回退到硬编码默认密钥；现在只有开发/本地环境允许 fallback，生产环境缺少 `ENCRYPTION_KEY` 会直接报错，同时同步更新 `docs/DEPLOYMENT.md` 说明
- Prompt 性能优化（安全收敛版）：`lib/runtime.ts` 继续优化 prompt 装配成本，但明确弃用 retrieval TTL 缓存；`planPromptContext()` 改为一次预分桶后按固定顺序消费，`recent turns` 改成先取结构化 rows、最后再格式化，OpenAI / Anthropic 路径里的 `systemInline` 也收敛成单次构造复用
- 上下文治理语义升级：`lib/runtime.ts` 的 prompt 装配从“末端硬裁整包消息”调整为“按 `core / retrieved / recent / optional` 分层预算装配”；核心上下文固定保底，长历史优先通过 retrieval 注入，`recent turns` 收敛为小窗口兜底，`clipMessagesToInputLimit()` 退回为最后保险丝
- 运行时重构：`lib/runtime.ts` 的并发门禁从裸 `Set` 升级为带 `runToken / startedAt / heartbeatAt / userId` 的运行注册表；重复启动同一辩论时仍会直接忽略，但现在会记录占用日志，且 `finally` 只释放当前持有者，避免误删
- 运行时拆分：新增 `lib/runtime/constants.ts`、`lib/runtime/file-store.ts`、`lib/runtime/provider-openai.ts`、`lib/runtime/run-registry.ts`、`lib/runtime/workflow-phase.ts`，把常量、文件读写、OpenAI 调用、并发注册表、workflow/投票阶段判定等逻辑从超长 `runtime.ts` 中拆出，保留 `@/lib/runtime` 的 `runDebate()` 出口不变
- 代码重构：收敛重复逻辑，保持行为不变
  - `lib/runtime.ts`：提取 debate / debate_agent 文件读取的公共查询骨架，统一空结果与缺表兼容处理
  - `lib/agents.ts`：合并 provider health check / debug 的公共请求流程，保留原有返回结构与错误语义
  - `lib/debates.ts`：拆分过长的 `createDebate()`，按直接选 agent 与基于 strategy 两条路径分别组织
- 代码重构：优化核心库文件的可读性和结构
  - `lib/auth.ts`：提取公共的用户角色处理逻辑 `resolveUserRole()` 和 `fetchUserBySession()`，减少重复代码
  - `lib/crypto.ts`：添加常量 `ALGORITHM` 和 `IV_LENGTH`，优化函数命名和注释
  - `lib/http.ts`：简化 `toErrorResponse()` 结构，添加函数注释
  - `lib/session.ts`：提取 `SESSION_COOKIE_MAX_AGE` 常量，优化 `readSession()` 逻辑
  - `lib/types.ts`：为所有类型定义添加清晰的注释说明
  - `lib/validation.ts`：按功能分组添加注释（Agent/Retrieval/File/Debate/Strategy schemas），简化对象定义
  - `lib/db.ts`：优化函数注释，简化条件判断逻辑
  - `lib/agents.ts`：提取 `parseNullableInt()` 辅助函数，优化 `normalizeAgentRow()` 结构
  - `lib/strategies.ts`：按功能分组添加注释（DB row types/Normalizers/Error helpers/Auth helper/View helpers）
  - `lib/line-diff.ts`：将 `void headNew; void tailNew;` 改为更有意义的注释说明，解释变量未使用的原因
- 组件重构：优化组件结构和可读性
  - `components/auth/user-menu.tsx`：重命名 `initials()` 为 `getAvatarInitial()`，优化 effect 逻辑，提取 `handleLogout()` 函数
  - `components/nav/main-nav.tsx`：为 `isActive()` 和 `MainNav()` 添加注释，添加返回类型注解

## 2026-03-29

- 为旧的 failed 辩论补上修复入口：新增 `POST /api/debates/[id]/repair`，可把 owner 自己的 `failed` 辩论手动修复回 `paused`，同时在辩论列表页和详情页增加“修复为暂停中”按钮，方便把待机/断网前已经失败的旧辩论拉回可恢复状态
- Windows 待机/网络中断降级为自动暂停：runtime 最外层异常处理之前会把所有未捕获错误一律记成 `failed`；现在对 `AI_NETWORK_ERROR`、超时、连接被中止、socket 断开等明显可恢复的中断，改为把辩论状态自动落成 `paused`，并写入“已自动暂停”的运行时提示，设备或网络恢复后可直接继续
- 调整“加载更多发言”交互：追加更早历史后，目录现在只新增对应轮次条目，不再自动展开新加载进来的轮次，避免打断当前浏览位置
- 修复最近窗口目录混入超早投票轮：发言目录之前会把整场辩论所有 `votes/round-*.json` 对应的轮次都塞进当前目录，即使页面只加载了最近 120 条 turn，也会把很早以前的第 3 轮这类投票轮混进来。现在只会把“落在当前已加载轮次窗口内”的投票轮加入目录；当前 live / open vote / current round 仍会保留
- 修复辩论详情“当前轮”优先级写反：页面之前会先取 `latestVoteRound`，再看 `latestCompletedRound`，导致一场已经跑到上百轮的长辩论，只要投票文件最后停在第 3 轮，目录顶部就会一直错误显示“第 3 轮”为当前轮。现在改成优先使用实时轮次 / open vote / 最新已完成发言轮，只有在缺少这些信息时才回退到最新投票轮
- 修复辩论详情首屏 turn 窗口方向写反：`/api/debates/[id]/turns?limit=120` 之前按正序 `limit`，实际返回的是“最早 120 条”而不是“最近 120 条”，导致长辩论看起来像只剩前 20~30 轮，点“加载更多”后也会因为当前最老 turn 已经是 1 而直接没反应。现在首次限量加载会改成按倒序取最新窗口，再翻回正序返回
- 辩论详情页补上长历史提示：`/debates/[id]` 的“发言目录”现在会明确说明“默认只展示最近 120 条发言，历史没有丢失”，并把按钮文案改成“加载更多发言（追加 50 条）”，避免长辩论只看到约 20~30 轮时误以为持久化失败

## 2026-03-25

- 会话必读目录与阶段门禁上线：`workflow.json` 新增 `contextAccess.alwaysRead / readWhenNeeded / unlockAfterPhase`，可把 shared 与 seat 目录配置成“每会话自动读取 / 仅按需读取 / 到指定 phase 后才允许读取”；runtime 不再只能整包塞 agent files，而是按目录规则自动注入，并在新会话里重新带上必读内容
- 共享文件读取能力补齐：运行时新增 `debate_files_read` 工具，并把 `agent_files_read / list / search` 一起接入 `contextAccess` 门禁；未解锁目录会返回 `LOCKED_UNTIL_PHASE`，不在清单内的目录会被明确拒绝；检索注入也会避开未授权文件路径
- 策略页新增“上下文读取策略”GUI 和完整 workflow 配置接口：`/strategies/[id]` 现在可直接配置每会话必读目录、按需可读目录、阶段后解锁目录；后端新增 `/api/strategies/[id]/workflow-config`，并在辩论详情的 workflow 摘要里显示当前读取策略
- 收紧 AI 表达风格为硬约束：默认 workflow、seed 策略和 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 现在统一要求“输出是给人看的”，默认必须用普通人能直接看懂的话来讲，禁止故意写得太高端、太文绉绉、太像术语表；只有在前沿科学内容里确实绕不开时，才允许保留必要术语，而且必须顺手翻成人话解释
- 长辩论上下文治理第一版落地：runtime 新增统一 prompt 预算规划器，按优先级分别裁剪 question / workflow / segment / recent turns / memory / facts / agent files，并在 `maxInputTokens` 缺失时回退使用 `contextLength`；自动新 segment 触发条件也补上 prompt 字符占比阈值，不再只盯 usage 比例
- 新增长辩论检索层：新增独立检索配置页 `/settings/retrieval` 与对应 API，可单独配置 OpenAI 兼容 embedding 模型；数据库新增 `retrieval_configs`、`debate_context_chunks`、`debate_context_embeddings`，运行时会把 turn、memory summary、shared facts、round summary、segment checkpoint 索引成 chunk，并在生成 prompt 时按当前问题/阶段/近期讨论检索相关旧历史注入 `Relevant history`
- 把 `debate_files_write` 写出的关键交付文件纳入检索索引：运行时写入 `final/*`、`outputs/*` 等允许的交付文件后，会立即按 chunk 切块并写入 retrieval chunk/embedding，后续 `Relevant history` 可以直接召回这些交付文件内容
- 修复 OpenAI 兼容 provider 的超长输入崩溃：runtime 之前只按 `maxInputTokens` 粗略裁剪消息，遇到某些 provider 额外施加的字符长度硬上限时，仍会因为 prompt 过长直接报 `Range of input length should be [1, 202752]`。现在 `openai` 链路会额外套一层保守字符上限裁剪，并在 `maxInputTokens` 未配置时回退使用 `contextLength`，减少长 system prompt / 大文件内联 / 长记忆导致的直接失败

## 2026-03-23

- 修复选举轮落库正文丢失真实票型：之前所有席位在 `Phase 1.5` 投票成功后，turn 正文都会被统一替换成“本席位仅完成投票”，导致后续 AI 从历史发言读取时误以为没人写明 `Host / Supervisor` 选择。现在运行时会把真实 `selections` 与投票理由摘要写回该席位的投票正文，后续席位和人工复盘都能直接看到实际票型
- 收紧单轮点子数量与展开深度：默认 workflow、默认新建辩论配置、示例 workflow、seed 策略和主母本提示词现在统一要求“每次发言最多只允许重点讨论 5 个点子，默认更推荐只打 1 到 3 个”，并明确禁止一口气抛很多点子却每个只讲一句；每个被保留展开的点子都必须说明思考过程、运作机制、为什么优先、为什么比前案强，以及如何说服反对者
- 修复“纯投票轮不算轮次”导致的阶段错位：运行时与 turns API 现在都会把官方投票轮计入实际 round，第三轮如果是纯投票，下一次发言会正确显示为第四轮，不会再把第四轮发言误判成第三轮并继续注入 `Phase 1`
- 修复发言目录遗漏纯投票轮和 live 新轮：左侧目录现在会把 `votes/round-*.json`、当前 open vote 轮，以及正在生成但尚未落库的新轮次一起并入目录，不再只根据已落库 turn 生成轮次列表
- 修复投票结果不及时展示：投票结果索引出现后会自动预取该轮结果；在“跟随最新”开启且当前轮是纯投票轮时，主视图也会自动切到该轮投票结果
- 修复 `Phase 2.5` 过早开启：`Phase 2` 设为 `minRounds = null` 后，之前运行时把“未设限”按 `0` 处理，导致主持人/监管者选举一结束，下一轮就直接自动开 `Phase 2.5` 入场表决。现在前后端统一改成：无论 `Phase 2` 是否配置 `minRounds`，至少先完整进行 1 轮 `Phase 2` 讨论，之后才允许进入 `Phase 2.5`
- 阶段逻辑残留补修：扩展 workflow 兼容层，对旧数据里 `Phase 3 / 3.5 / 4` 的 injected prompt 也自动改写成新编号 `Phase 2 / 2.5 / 3`，避免标题升级后提示词正文仍在说旧阶段；同时在 `turn_end` 后强制刷新 vote index 和 open vote 状态，修复官方投票刚关闭时目录与投票结果偶发延迟 1 个刷新周期的问题
- 阶段编号整体前移并修复目录判定：默认 workflow、默认新建辩论配置、示例 workflow、seed 策略里的后续阶段统一改成 `Phase 2 / Phase 2.5 / Phase 3`；目录判定新增“若该轮已有 closed official vote，则优先按该票型认阶段”，修复第 3 轮选举仍显示 `Phase 1`、选举通过后又错跳到旧 `Phase 3.5` 的问题；投票结果文案、自动开票标题和运行时提示也同步改成新编号
- 辩论列表页新增终止按钮：`/debates` 的“进行中”卡片现在会为创建者显示“终止”按钮，直接调用现有停止接口终止辩论；公开辩论列表也会根据 `isOwner` 正确判断是否显示该按钮，非创建者不会看到也不能终止别人的辩论
- 禁止首轮抢跑投票：把“Phase 1 与 Phase 1 之前严禁提前投票、严禁写‘我投谁’、严禁提前宣布主持人/监管者”补进默认 workflow、默认新建辩论配置、示例 workflow、民主集中制 seed 策略和母本提示词；同时给 Phase 1 新增显式 injected prompt，要求只能做候选建议，不能做正式表决
- 辩论攻击性与阶段自由度升级：默认 workflow、默认新建辩论配置、示例 workflow 和民主集中制 seed 策略统一改成 `minRounds = null`，不再用阶段最少轮数硬卡流程；同时把“后发言者优先提出更强替代案、必要时可以直接推翻前案”写进开局提示词、Phase 3 强化提示词和主母本提示词，避免后续 AI 只会围着第一个方案做温和补充
- 新增一次性迁移脚本：`npm run migrate:workflow-phase-1-5` 会批量扫描数据库里的 `debate_files.workflow.json` 与 `strategy_role_files.debate/workflow.json`，把旧的 `Phase 2 · 民主选举` 选举阶段改写成 canonical 的 `Phase 1.5` 配置，并补齐 `transitionRules.election.reopenUntilPassed / discussionRoundsBetweenVotes`
- 旧 workflow 数据自动升级：读取旧 `Phase 2 · 民主选举` 配置时会自动按 `Phase 1.5` 解释；策略 workflow 保存、以及用策略创建辩论复制 `workflow.json` 时，也会自动写回 canonical 新格式，旧策略会随着正常使用逐步完成升级
- Phase 1.5 选举阶段上线：原先“主持人与监管者选举”改为正式的 `Phase 1.5`；若本轮未选出结果，系统不再同轮硬重开，而是先回到 `Phase 1` 补充一轮全员发言，再按 workflow 配置自动发起下一次 `Phase 1.5` 选举。相关配置新增到 `transitionRules.election.reopenUntilPassed / discussionRoundsBetweenVotes`，默认值为 `true / 1`
- 辩论列表页同步显示恢复状态：`/debates` 的卡片头部新增“恢复中 / 已自动恢复” badge，并在卡片摘要里展示恢复说明与时间，不用进入详情页也能看出哪些辩论是进程中断后自动续跑的
- 自动恢复提示样式升级：辩论详情页状态面板里的恢复提示不再只是灰字，而是改成独立提示卡和显眼 badge，能一眼区分“恢复中”与“已自动恢复”
- 自动恢复状态可见化：`debates` 新增运行时恢复注记字段；进程重启后被自动接管的辩论会先显示“恢复中”，运行时真正接手后切换为“已自动恢复并继续运行”；详情页状态面板会直接展示这条提示，手动开始/恢复时会清掉旧恢复标记，避免残留脏状态
- 进程恢复机制上线：新增 Node 启动期恢复器，服务进程被杀或重启后会自动扫描数据库里仍处于 `running` 的辩论，并重新拉起运行时继续推进；恢复过程会写入 `log/node-runtime-YYYY-MM-DD.log`，且恢复启动失败后不会把进程永久锁死，后续仍可再次重试
- Phase 3.5 复投 bug 修复：修正自动开票函数中过早返回导致 `finalization_vote` 首次开票/失败后复投都无法触发的问题；同时把等待复投期间的阶段判定从错误的常驻 `Phase 3.5` 改回正常讨论态，避免目录和提示词在“中间讨论轮”里持续误判为投票轮
- Phase 3.5 复投链路改成 workflow 可配置：`transitionRules.finalization` 新增 `reopenUntilPassed` 和 `discussionRoundsBetweenVotes`；默认行为是“入场表决不通过后，先进行 1 轮全员补充发言，再自动发起下一轮 Phase 4 入场复投”，直到全员同意为止
- Phase 4 前新增正式阶段 `Phase 3.5 · Phase 4 入场表决`：它是独立的提示词注入阶段，专门用于判断“是否已经具备进入 Phase 4 的条件”并完成入场投票；目录、运行时阶段机、默认 workflow、seed 策略和示例 workflow 都已同步支持 `finalization_vote`
- “跟随最新”状态打架修复：手动点旧发言或旧投票时会自动退出跟随；点击“回到当前”或 live 卡片时会重新进入跟随；同时补了一层状态自愈，避免出现按钮亮着但实际停在旧内容、并且还同时显示“回到当前”的矛盾状态
- Phase 4 进入机制重做：删除基于“共识达成 / 打开 custom 票”推断进入 finalization 的旧逻辑，改为正式的 `finalization` 入场表决；默认在最早可进入轮次自动开票，且要求全员同意，表决通过后下一轮才正式进入 Phase 4，不再出现阶段来回回退
- 辩论详情页参与者面板滚动修复：`participants` 分支改为自身接管纵向滚动，左侧固定高度容器下不再把超长参与者列表直接裁掉，也不再出现“内容被截断但没有滚动条”的问题
- AI 表达守则升级为硬约束：在小说策略开局提示、Phase 2、Phase 4，以及 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 中明确加入“必须讲人话、禁止只给简短结论/标签/速记句、提出方案时必须把机制与后果展开讲清楚”的硬规则；默认 workflow 也补上同类 opening prompt，并提高默认输出预算，减少 AI 发言像看不懂的速记提纲
- 系统文件缺失改为空返回：`/api/debates/[id]/files` 针对 `votes/open.json`、`context/usage.json`、`context/usage_totals.json`、`question/history.json` 这类运行早期可能尚未生成的系统文件，缺失时不再返回 404，而是返回空默认内容，避免详情页初始化请求刷出一串无意义 404
- 辩论详情页补出失败原因与停止原因：详情接口现在透传 `lastErrorCode`、`lastErrorMessage`、`stoppedReason` 与运行时阶段快照；左侧 `status` 面板会直接显示失败原因、停止原因和最后执行到的阶段，不再只剩一个 `failed` 标签
- Node 运行时日志开始落盘：新增 `lib/server-log.ts`，把辩论运行时的主异常与关键 warning 追加写入项目根目录 `log/node-runtime-YYYY-MM-DD.log`，服务端不再只把错误打到控制台
- 辩论阶段显示改为“运行时快照优先”：数据库新增 `workflow_phase_kind/title/round`，运行时在每轮推进时持久化当前阶段；详情页目录会优先使用这份阶段快照，避免辩论在 `failed/stopped/completed` 后又被前端回推成 `Phase 3`

## 2026-03-21

- 辩论详情页加载容错加固：`loadDebate()` 改为用 `Promise.allSettled` 收敛详情与 turns 并发请求，服务重启或瞬时断网时不再把浏览器原生 `Failed to fetch` 直接冒到页面调用栈
- 发言目录虚拟占位移除：右侧目录不再使用轮次级虚拟 spacer/估算高度，而是直接渲染当前窗口里的全部轮次，彻底消除展开某一轮后与下一轮之间出现大段空白的错位问题
- 发言目录空白修复：右侧目录轮次项去掉 `content-visibility / containIntrinsicSize` 的额外占位干扰，并在展开/收起、投票标记或阶段信息变化时主动重新测量高度，避免某一轮展开后和下一轮之间出现大段空白
- 辩论页发言目录精简：右侧目录不再展示每条发言的摘要 preview，只保留轮次、回合、席位、姓名和时间，减少噪声与目录区额外文本渲染
- 辩论页可选运行时文件探测降噪：`votes/open.json`、`context/usage.json`、`context/usage_totals.json` 在当前 turn 缺失时只记录一次 404，并在没有新 turn 产生前跳过重复探测；等到新 turn 到来后再自动重试，避免网络面板被相同 404 持续刷屏
- 辩论页初始化请求收敛：`loadWorkflowRules` 不再依赖自身 `loading` 状态重建，避免初始化 effect 被反复触发，间接导致 `workflow.json` 与 `question/history.json` 在进入页面时连续重复请求
- 辩论页 workflow 面板修复：`workflow` 栏改成“头部固定 + 内容区独立滚动”，不再因为左侧父容器 `overflow: hidden` 导致长规则 Markdown 被直接裁掉
- 小说策略表达风格收紧：在 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 之外，继续把“尽量说人话、不要空泛大词、提到点子必须展开讲清机制与后果、禁止只报结论不解释过程”的约束同步补进 `docker/seed_democratic_centralism_strategy.sql` 的 `openingPrompt`、`Phase 1`、`Phase 3` 注入提示词，让新导入的策略在实际辩论中也会少说黑话、少做一句话点子汇报
- 辩论页 turns 索引继续内聚：将最近窗口里的 `summaries / byId / roundGroups / latest` 收成统一的 `TurnWindowState`，并通过 `updateTurnWindow()` 在摘要变更时一次性重建，避免页面其余部分再基于 `turnSummaries` 额外 `useMemo` 整批派生这些索引，进一步降低长辩论下的重复重算与临时对象分配
- 记忆文件查看继续降驻留：辩论页记忆弹窗新增统一 `closeMemoryDialog`，关闭时会立即释放 `memoryContent / path / truncation / maxChars / target` 等大状态；切换记忆文件或切片方向时也会先 abort 旧请求，并用请求 token 防止旧响应回填，减少大字符串在前端 state 里的无意义驻留与竞态覆盖
- 下载路由继续降峰值：`/api/debates/[id]/download` 不再先把所有选中文件正文整批查出并放进 `contentByVirtualPath / zipEntries`，而是保留排序后的文件元数据；单文件下载时按需读取这一条，多文件 zip 输出时也改成逐文件读取、逐文件写入流，进一步降低大文件/多文件下载时的服务端内存驻留峰值
- 辩论页轮询降级为 SSE fallback：不再在进入详情页后常驻每 1.5 秒整场 `loadDebate()` 刷新；现在优先依赖 SSE 事件推进实时状态，并在 `turn_end` / 连接报错时主动刷新一次；只有 SSE 断开或超过阈值时间未收到事件时，才会以低频 fallback 轮询兜底，进一步减少长辩论下的无效请求、对象重建与前端内存压力
- 诊断结果读取继续瘦身：新增 `/api/debates/[id]/turns/[turnNumber]/diagnostics` 单条诊断接口，辩论页“查看诊断结果”不再整份拉取 `context/generation_diagnostics.jsonl` 到浏览器再本地 split / parse / reverse，而是按 turnNumber 直接读取对应记录，进一步降低长辩论下诊断弹窗的前端内存占用
- 辩论详情页继续瘦身：把“生成诊断 / 保存成功 / 问题放大查看 / 问题历史与对比 / 记忆文件查看”几块大弹窗抽成独立组件 `DiagnosticsDialog`、`SaveSuccessDialog`、`QuestionZoomDialog`、`QuestionHistoryDialog`、`MemoryDialog`，同时把问题 diff 行类型提为独立 `QuestionDiffRow`，进一步降低 `app/(main)/debates/[id]/page.tsx` 主渲染区复杂度
- 辩论页 turns 窗口化：`/api/debates/[id]/turns` 现在支持 `before / after / limit / mode=summary|full`，默认返回轻量摘要并带 `hasMore`；新增 `/api/debates/[id]/turns/[turnNumber]` 按需拉取单条完整正文；辩论页改为常驻最近窗口摘要、旧记录分页回放、正文按需加载，并在发言目录中显示摘要预览，降低长辩论下的前端内存与重算压力
- 发言目录进一步窗口化：辩论页右侧“发言目录”改成独立滚动区域，并只渲染当前滚动窗口附近的轮次，远处轮次用占位高度顶住；配合已有摘要化数据流，继续压低长辩论下的 DOM 数量与浏览器内存占用
- 辩论页 turns 状态收口：新增按 `id` / `round` 的索引化派生结构，目录选中当前发言时不再反复全量线性查找；同时移除无意义的“最新已加载 turn”窗口状态，进一步减少长辩论下的页面重算与状态噪音
- 发言目录虚拟化加强：右侧目录轮次项抽成可复用组件，并通过 `ResizeObserver` 记录每个轮次块的真实高度参与窗口计算，不再只靠固定估算值顶 spacer；长辩论下滚动定位和目录开合后的占位会更稳定
- 正文详情缓存优化：中间栏按需读取的 turn detail 缓存改成显式 LRU 顺序，查看过的旧发言会提升保留优先级，不再仅按 turnNumber 粗暴截断；在长辩论里来回切换旧正文时更不容易反复重新请求
- 辩论详情页 hooks 收口：`loadDebate / loadQuestionVersionMeta / loadWorkflowRules / loadAllFilesIndex / refreshQuestionDiff / ensureTurnDetail` 等核心加载函数改为稳定回调，相关 `useEffect` 依赖同步补齐；`app/(main)/debates/[id]/page.tsx` 这页自身的 `react-hooks/exhaustive-deps` warning 已清零
- hooks warning 全量清零：继续把 `agents`、`agent files`、`new debate`、`strategies`、`strategy detail` 等页面里的加载函数收成 `useCallback` 并补齐 effect 依赖；`npm run lint` 现已无任何 ESLint warning 或 error
- 辩论详情页继续拆分：把中间栏“发言内容 / 实时输出 / 投票结果 / 正文加载中”整块条件渲染抽成独立组件 `DebateViewerPanel`，同时把投票结果 Markdown 生成提为顶层 helper，主页面渲染区进一步瘦身
- 内存风险收敛：下载路由不再先把整个 ZIP `Buffer.concat` 到内存里，而是改为边遍历边流式输出，降低大文件/多文件下载时的峰值内存；同时辩论页实时 SSE 订阅不再依赖 `liveMessageNumber` 反复重建连接，改为稳定订阅 + ref 比较当前 turn，减少长会话下的连接抖动与前端内存压力
- 小说神作模式继续补强“广泛跨学科 + 主场学科”规则：在 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 与 `docker/seed_democratic_centralism_strategy.sql` 中明确，核心天才不应是只会一门学科的窄专家，而应普遍具备广泛跨学科能力；同时每位核心天才仍需拥有 1-2 个压倒性的主场学科或主场方法论，用来形成真正鲜明的压制方式与角色辨识度
- 小说神作模式补回交叉学科与前沿科学：在 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 与 `docker/seed_democratic_centralism_strategy.sql` 的开局提示词、Phase 1、Phase 3 中，重新明确要求主动吸收行为经济学、认知科学、计算社会科学、复杂系统、控制论、运筹学、人工智能安全、分布式系统、网络安全、量子信息、合成生物学、脑机接口、神经工程、材料科学、纳米技术、机器人学、计算复杂性理论、科技伦理、赛博法学等交叉学科与前沿科学
- 小说神作模式学科武器库升级为“三层结构”：把刚才补充过的传统学科、交叉学科、前沿科学统一整理成“核心层 / 增强层 / 杀手锏层”，并同步写入 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 与 `docker/seed_democratic_centralism_strategy.sql`，要求后续智斗设计遵循“核心层打底、增强层互锁、杀手锏层少量精准引爆”
- 小说提示词补强“多学科智斗”：在 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 以及 `docker/seed_democratic_centralism_strategy.sql` 的开局提示词、Phase 1、Phase 3 注入提示词中，明确要求积极调用心理学、社会工程学、逻辑学、博弈论、物理学、化学、经济学、政治学、信息论、工程学等学科，把知识真正落进规则、骗局、制度、证据链和胜负结构，而不是停留在空泛的“高智商对话”
- 小说策略题材边界收紧：在 `docker/seed_democratic_centralism_strategy.sql` 的开局提示词、Phase 1、Phase 3 注入提示词，以及 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 中新增“智斗主导、科学体系可解释、禁止玄幻/修仙/魔法/超自然机制成为核心解题手段”的硬约束，避免讨论逐渐滑向玄幻设定
- 辩论页实时状态修复：流式 `chunk` 事件之前错误地把 `roundNumber` 当成 `turnNumber` 发给前端，导致“当前：Seat-X · 第 N 轮 · #M”偶尔闪成离谱编号；现已改为发送真实 `messageNumber`，并在前端对 chunk 事件做保守兜底，不再随意改写当前发言序号
- 辩论页参与者面板补充“会话计数”：基于 `context/usage_totals.json` 里的 `sessionId` 显示当前是第几段上下文；手动点击“新会话”或系统自动重置上下文后，这个计数会自动 +1
- 运行时兼容性修复：当 OpenAI 兼容模型返回 `finishReason=tool_calls` 但实际没有任何工具调用时，系统会自动追加一次“禁用工具的纯文本重试”，避免像 `qwen3.5-plus` 这类模型在普通发言中被伪工具调用提前截断；诊断弹窗也会把这类情况单独标成“疑似伪工具调用”
- 辩论页参与者面板增强：每个席位现在都会显示三项长度信息：总上下文长度（context）、单次最大输入、单次最大输出；辩论详情接口也同步透传 `max_input_tokens / max_output_tokens`
- Docker 初始化 SQL 同步：`docker/init.sql` 中的 `ai_agents` 表结构新增 `context_length`、`max_input_tokens`、`max_output_tokens`，并补了 `alter table ... add column if not exists`，保证新库初始化和旧库升级都能拿到这三个字段
- AI 配置字段语义修正：`contextLength` 恢复为“总上下文长度”，新增的 `maxInputTokens / maxOutputTokens` 明确表示“单次请求的输入/输出上限”；三者不再互相回填或混用，避免把上下文窗口误当成单次输入上限
- AI 配置与运行时上限控制升级：AI 配置页新增“最大输入 Token / 最大输出 Token”字段，并落库保存到 `ai_agents.max_input_tokens / max_output_tokens`；复制、导入导出也会保留它们；运行时请求生成时会优先参考 AI 配置里的最大输出上限来夹住 `max_tokens`
- 运行时输出预算取值修正：`workflow.promptPolicies.outputBudget.* = null` 现在不再被 `?? 1800/3600` 悄悄回退成默认值；不设上限会真正保留为 `null`，再结合 AI 配置里的 `maxOutputTokens` 或应用级高上限决定最终请求值
- AI 配置页模型目录增强：OpenRouter 模型目录现在除了 `contextLength` 之外，也会尽量解析并展示 `max_output_tokens / max_completion_tokens` 一类的最大输出上限；模型选择弹窗与编辑表单都会显示“上下文 / 最大输出”两项，方便判断像 `kimi-k2.5` 这样的模型到底有没有公开输出上限元数据
- 辩论页诊断弹窗升级：不再只展示原始 JSON，而是先给出“平台截断 / 工具打断 / 业务逻辑覆盖 / 业务侧改写 / 正常结束”的可读总结与依据，再提供原始诊断 JSON 折叠查看，方便快速判断正文为什么看起来不完整
- 辩论页诊断能力增强：中间栏查看某条发言时，标题区新增“查看诊断结果”按钮，可直接读取并展示该 turn 对应的 `context/generation_diagnostics.jsonl` 记录；文件查看弹窗的“末尾”定位改为内容渲染完成后统一滚动，修复多次点击仍停在开头的问题
- 运行时可观测性增强：每轮生成现在会把 `requestedMaxTokens`、模型返回停止原因、原始正文长度、落库长度、是否被选举投票覆盖等信息写入 `context/generation_diagnostics.jsonl`，用于排查“正文像说到一半被截断”到底是平台截断、工具打断还是业务覆盖
- 运行时输出上限语义修正：workflow 中将单轮预算设为 `null` 时，不再简单省略 `max_tokens`，而是显式向模型请求一个极高上限，避免某些 OpenAI 兼容供应商在未传 `max_tokens` 时回退到过小默认值，导致正文像“说到一半被截断”
- 神作模式输出预算升级：workflow 现在支持把 `promptPolicies.outputBudget.discussionMaxTokens` / `writingMaxTokens` 设为 `null`，表示不再由 workflow 单轮预算硬卡输出；运行时会在这种模式下省略 `max_tokens`，`NOVEL_GODMODE_WORKFLOW.json` 与 docker seed 也同步切到“不设上限”
- 辩论页中间查看器：切换到新的发言或投票结果时会自动回到顶部，不再继承上一条内容的滚动位置，避免长内容看起来像被截断；只有“跟随最新”的实时输出继续自动贴底
- 辩论页文件查看修复：删除文件树“包含辩论文件（debate/*）与每席位文件（agents/*）”说明文案；点击文件后切换“开头 / 末尾”时，会按当前切片方向自动滚动到顶部或底部，避免查看末尾时仍停在显示片段开头
- Docker seed：修正小说策略的 IDEA 注入方式，`templates/debate_question.md` 不再保留误导性的 `<<<IDEAS>>>` 占位符，改为明确说明原始点子库位于 `ideas/raw-idea-bank.md`；同时在原始点子库顶部补充“7 位外来天才 / 本土天才 / 主线弧线 / 群像智斗史诗”框架边界，避免 AI 只看到散点而看不到故事骨架
- 辩论页直播修复：首轮首人发言时即使中途点击暂停，也会继续保留并显示当前 live 草稿，直到该条发言真正保存为 turn；暂停不再把正在生成但尚未落库的内容隐藏成“还没有发言记录”
- 投票与阶段显示修复：发言目录现在会为存在官方投票结果的轮次直接显示“有投票结果”标志，且投票结果索引不再只对 owner 刷新；平票重投期间，当前轮阶段会优先跟随 `votes/open.json` 显示为选举/投票阶段，不再按纯轮次阈值误显示为 Phase 3
- 辩论页：发言目录中“查看注入提示词”改为弹窗展示，不再在轮次详情里内联展开；参与者面板里“加入新的 AI”选择框补充裁剪容器与更稳的宽度约束，避免长选项再次撑出左侧栏
- 辩论页参与者面板：优化“加入 AI”区域布局，避免选择框溢出左栏；移除上移/下移按钮；上下文未统计时改为“未统计 / 等待首轮统计”而不是显示问号
- 点子库半自动筛选：workflow 新增原始点子库与派生结果文件路径配置；运行时在 Phase 3 自动注入只读原始点子库和筛选结果文件，在 Phase 4 只优先读取筛选结果；策略创建辩论时也会把 `debate/ideas/*` 文件复制进辩论共享文件
- 策略页：开局注入提示词和各阶段提示词改为默认折叠摘要，点击后通过弹窗查看/编辑，避免详情页被大段文本撑满
- Docker seed：`docker/seed_democratic_centralism_strategy.sql` 现在预置了强化版 `openingPrompt` 与 Phase 1~4 的 `injectedPrompt`，重新导入策略后可直接使用更细化的开局注入和阶段注入提示词，不再需要手工填写
- Workflow / 策略页：新增“开局注入提示词”配置，策略详情页可编辑，新建辩论页可预览；运行时会在第 1 轮自动注入该文本，不再只有 phase1~phase4 的阶段提示词
- 辩论页发言目录：新增当前阶段标志与每轮阶段 badge；若某轮开始进入带有 `injectedPrompt` 的新阶段，会显示“已注入提示词”标志，并可展开查看该阶段自动注入到运行时 Prompt 的文本
- 新增文档：`docs/NOVEL_GODMODE_INJECTION_ORDER.md`，明确神作模式下开局先注入哪份文档、每个阶段应注入哪类片段、何时追加角色职责与质量闸门，避免把多份文档一次性全塞给模型
- 新建辩论页：选中策略后会展示该策略各阶段的自动注入提示词摘要，并提供跳转到策略详情页编辑的入口，避免只在 `/strategies/[id]` 才能看见阶段注入配置
- 策略详情页：新增“阶段注入提示词”面板，可直接在界面上为 `workflow.json` 的每个阶段填写自动注入提示词；系统进入对应阶段后会自动把该提示词拼进当前轮运行时 Prompt
- Workflow：`phaseMachine.phases[]` 新增 `injectedPrompt`，并增加策略级 API `/api/strategies/[id]/workflow-phase-prompts` 统一读写阶段提示词，不再依赖手工编辑 `debate/workflow.json`
- 运行时：当前阶段若配置了 `injectedPrompt`，会自动注入到该阶段的 Workflow phase 提示中；辩论详情页 Workflow 规则摘要也会显示哪些阶段已配置阶段提示词
- 新增文档：`docs/NOVEL_GODMODE_SOLUTION.md`，系统化梳理“神作模式”当前 8 类核心问题，并给出母本 Prompt / 运行时 Prompt / Workflow Preset 三层控制架构、阶段子任务、质量审判、角色分工与预设分级的总解决方案
- 新增文档：`docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`，定义“神作模式”运行时精简 Prompt 的职责边界、标准结构、裁剪规则、模板与接线方式，用于把母本 Prompt 与实际每轮执行 Prompt 正式分层
- 新增文档：`docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`，将 1 到 9 阶段进一步拆成固定子任务序列，明确每个子任务的目标、产出、禁止事项、更新文件与运行时接线方式，用于降低阶段内跑题与中期低效总结问题
- 新增文档：`docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`，定义神作模式下 Host、结构设计、诡计设计、角色设计、世界观设计、伏笔审查等席位的写作职责、文件级分工、阶段级分工与后续 workflow 配置扩展方向，用于降低 Host 过载与多席位低效问题
- 新增文档：`docs/NOVEL_GODMODE_QUALITY_GATES.md`，将“高质量”拆成文件级、事件级、角色级、章节级、阶段级、终局级质量闸门，并给出后续 workflow 质量检查字段扩展方向，用于解决高字数低质量与伪强内容混过关的问题
- 新增文档：`docs/NOVEL_GODMODE_SNIPPET_ROUTING.md`，定义系统如何根据当前阶段、子任务、席位职责、审查状态自动从多份神作模式文档中抽取对应片段并注入，而不是让 AI 自己判断该读哪份 md

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
- 新增文档：`docs/NOVEL_GODMODE_PROMPT.md`，整理一版可直接用于当前辩论系统的“神作工厂 Prompt”，支持大点子/中点子/小点子分层与 AI 自主新增高质量点子
- workflow 扩展：新增阶段最少轮数与单轮输出预算，运行时会据此限制过早进入 finalization，并按讨论/写作阶段放宽模型输出上限
- 神作模式预设：民主集中制 seed 保持高强度长篇导向，另新增 `docs/NOVEL_GODMODE_WORKFLOW.json` 作为独立的创作圣经级 workflow 预设
- 默认 workflow 收口：默认新建辩论回归通用模板；`maxTurns` 默认值回到 10，但上限保留到 200，方便按项目自行切换强度
- 新增文档：`docs/NOVEL_GODMODE_MASTER_PROMPT.md`，把原始小说要求与 `NOVEL_GODMODE_PROMPT.md` 按“规则层优先、素材库并入”的方式整合成一份最终版 Prompt 文件
- Prompt 强化：在 `docs/NOVEL_GODMODE_MASTER_PROMPT.md` 里补充“阶段 / 轮 / 回合”的严格定义、阶段推进铁律，以及每轮必须先报当前坐标，降低模型混淆阶段与轮次的风险
- 修复 `debate_files_write` 覆盖危机：`final/*` 不再接受旧式静默覆盖写，新增 `debate_files_stat`、`replace/append/section_merge` 显式写入语义、`baseVersion/baseUpdatedAt` 乐观锁、交付文件缩短保护，并为 `final/*` 增加版本号与 `debate_file_versions` 历史快照，避免多轮补写时丢正文
- 辩论页左侧栏新增“文件记录”tab：从本次版本开始，runtime 会审计 AI 对 shared/seat 文件的显式读取与 shared 文件写入；页面可按“读取 / 写入”切换查看操作列表，并对每次写入展示前后版本的双栏 diff（绿色新增、红色删除、蓝色更新）
- 继续统一辩论页弹窗的响应式布局：补齐 `FileInfoDialog`、`DiagnosticsDialog`、`SaveSuccessDialog` 的 header/footer 样式，使小弹窗在窄窗口下也能自动换行、不再挤爆按钮区。
- 修正“文件记录”页的误导性空状态：默认切到 `写入`，并在接口返回 `read/write` 总数，按钮直接显示计数；当当前标签为空但另一类记录存在时，页面会自动切换并给出提示，不再看起来像“始终没有记录”。
- 扩展“文件记录”的读侧统计口径：`read + stat + search + list` 现在统一归入“读取”视图，并在列表里显示具体操作类型；同时修复 runtime 生成诊断里 `toolCallsCount` 长期显示 `0` 的问题，后续轮次会累计真实工具调用次数。
- 调整“文件记录”页交互：移除页内右侧详情栏，改为点击列表项后用弹窗查看详情；写入记录的 diff 也统一放进弹窗展示，读取记录同样走弹窗。
- 修正“文件记录”弹窗交互：切换 `读取 / 写入` 不再自动弹出第一条详情；同时给详情弹窗补上内部滚动容器和最大高度，长内容与 diff 会正常出现滚动条。
- 提升“文件记录”列表的可读性：刷新按钮移动到 `读取 / 写入` 切换按钮上方；列表项增加更清晰的层次、操作标签和时间/回合信息，写入摘要中的 `+` 变为绿色、`-` 变为红色、`~` 保持蓝色，便于快速扫读变化规模。
- 微调“文件记录”工具栏：将刷新按钮从右上角改到左上角，保持与阅读顺序一致。
- 区分左侧栏图标：将“文件记录”从普通文件图标改成更像“历史 / 记录”的时钟图标，避免和“文件管理”混淆。
- 继续补齐“文件记录”的读侧遗漏：凡是被隐式塞进 prompt 的文件（自动上下文注入、agent 文件内联、memory、shared facts、segment）现在都会记为读取；检索召回里真正命中的 `sourcePath` 也会同步落到“读取”视图，减少“AI 实际看过但页面没显示”的漏记。
- 收敛“文件记录”的写入口径与文案：写入页明确为“AI写入”，不再暗示系统内部写文件也会进入记录；现有 UI 不新增系统写入子 tab，直接保留 `读取 / AI写入` 两级结构。
- 修正选举投票轮的落盘兜底问题：保存发言时不再只依赖内存里的 `electionBallotSummary`，而是会优先从真实 `votes/open.json` 反查本席位已提交的 ballot；这样即使工具调用摘要在生成链路里丢失，也会稳定展示正式票型和投票理由，而不是退回“仅完成投票”的泛化文案。
- 修正“文件记录”tab 被自动切换的问题：移除列表加载后的自动跳转逻辑，`读取 / AI写入` 现在只响应用户手动点击，不会因为另一侧有数据就擅自切回去。
- 三类角色分工写入：`requiredFiles` 新增 `draftRole / reviewRole / finalRole`，旧的 `ownerRole=Host` 会自动归一化成 `Specialist 起草 / Supervisor 审查 / Host 定稿`；runtime 现在会按 `Host / Supervisor / Specialist` 注入不同写作职责与待补写清单，文件记录页也会显示当前写入者角色类型和轻量诊断标签，降低 Host 包办全部 final 文件的倾向。
- 清理一批旧 TypeScript 报错：修正辩论页的 phase 类型映射、上下文菜单空值收窄、viewer 分支收窄、Memory truncation 类型、策略页 phaseKind 推断，以及 runtime 里投票联合类型、空值收窄和阶段变量作用域问题；当前仓库已可通过 `npx tsc --noEmit --pretty false`。
