# 小说神作模式文档注入顺序说明

## 1. 目标

这份文档只回答一个问题：

- 神作模式拆成了多份文档后，系统到底应该按什么顺序注入哪一份内容

它不是新的 Prompt，也不是新的 workflow。

它是“喂给 AI 的顺序说明书”。

---

## 2. 核心原则

### 2.1 不要把所有文档一次性塞进去

神作模式的多份文档不能在开局一次性全部注入。

原因很简单：
- 太长
- 太散
- 模型会混淆阶段、轮次、子任务
- 后期文档会稀释当前阶段真正需要执行的内容

所以正确做法是：
- 开局注入“总控母本”
- 运行时按阶段、按子任务、按审查节点动态注入片段

### 2.2 系统负责路由，不让 AI 自己选文档

不是让 AI 自己去判断现在该看哪份 md。

而是系统根据：
- 当前阶段
- 当前子任务
- 当前轮次
- 当前席位职责
- 当前是否处于审查轮

自动抽取对应片段，再注入给 AI。

### 2.3 固定职责

这几份文档的职责固定如下：

- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  只负责总控母本。定义作品目标、创作哲学、阶段总框架、原始素材库。
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  只负责运行时 Prompt 的结构模板。
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  只负责定义每个阶段内部有哪些固定子任务。
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  只负责按席位分配写作职责。
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  只负责审查当前阶段是否过关。
- `docs/NOVEL_GODMODE_WORKFLOW.json`
  只负责机器规则：最少轮数、输出预算、阶段切换、交付门槛、完成条件。

---

## 3. 开局先注入什么

### 3.1 开局必须先用的文档

开局只注入以下两类内容：

1. `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
   作用：给整场辩论建立共同目标、气质、题材、硬性原则、阶段总任务和点子素材库。

2. `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md` 的开局运行铁律摘要
   作用：告诉模型后续所有轮次都必须：
   - 先报当前坐标
   - 只解决当前阶段 / 当前子任务
   - 不得提前推进下一阶段
   - 不得把局部共识误判为阶段完成

### 3.2 开局不要直接注入的文档

以下文档不要在开局整份注入：

- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`

原因：
- 这些文档是过程控制文档
- 它们只有在具体阶段、具体子任务、具体席位或具体审查节点才有意义

### 3.3 开局机器配置

开局同时启用：

- `docs/NOVEL_GODMODE_WORKFLOW.json`

它不直接注入给模型，而是由系统读取，用来控制：
- 当前阶段
- 最少轮数
- 输出预算
- 是否允许切阶段
- 是否允许进入 finalization
- 最低交付门槛

---

## 4. 每个阶段该注入什么

下面的“注入”指的是：系统在进入对应阶段后，自动抽取这些文档里的对应片段，拼到运行时 Prompt 里。

### 4.1 第 1 阶段：核心命题与世界基底

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入与作品目标、故事总前提、硬性原则、世界观方向相关的片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 1 阶段片段：
  - `1.1 终极命题`
  - `1.2 故事承诺与核心冲突`
  - `1.3 世界规则`
  - `1.4 底层限制与破局条件`
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

这一阶段不要注入：
- 角色分工文档的细节职责
- 质量闸门的终局级检查
- 长篇结构和章节扩写要求

### 4.2 第 2 阶段：7 位外来天才与本土天才生态

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入角色方向和群像要求的相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 2 阶段片段：
  - `2.1 七位外来天才的功能分工`
  - `2.2 七位外来天才的软肋与执念`
  - `2.3 七位外来天才的镜像关系`
  - `2.4 本土十八天才的分层`
  - `2.5 本土天才与外来天才的结构关系`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入角色设计相关席位职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

### 4.3 第 3 阶段：原始点子筛选与重组

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入点子分层规则、允许新增原创点子的相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 3 阶段片段：
  - `3.1 大点子筛选`
  - `3.2 中点子重组`
  - `3.3 小点子密度设计`
  - `3.4 新增原创点子吸收`
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入点子层面的筛选和密度要求

### 4.4 第 4 阶段：主线骨架与终局真相

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入主线因果链、终局震撼、骗局、真 boss 相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 4 阶段片段：
  - `4.1 真主角与叙事核心`
  - `4.2 假 boss、真 boss、终局布局者`
  - `4.3 最大骗局`
  - `4.4 死者回归与内鬼结构`
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

### 4.5 第 5 阶段：五大核心事件

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入事件密度、点子互锁、诡计必须可复盘的相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 5 阶段片段：
  - `5.1 事件主题与目标`
  - `5.2 对立双方与局势图`
  - `5.3 大点子 / 中点子 / 小点子挂接`
  - `5.4 误导与反制`
  - `5.5 代价与余波`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入诡计设计、结构设计、伏笔审查席位职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入事件级质量闸门

### 4.6 第 6 阶段：人物弧线、纯爱线、背叛线、宿敌线

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入人物魅力、感情爆发、群像辨识度相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 6 阶段片段：
  - `6.1 核心人物弧线`
  - `6.2 纯爱线`
  - `6.3 背叛线`
  - `6.4 宿敌线与镜像关系`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入角色设计席位和关系设计职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入角色级质量闸门

### 4.7 第 7 阶段：终局布局链与伏笔回收

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入终局震撼、二刷快感、伏笔闭环相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 7 阶段片段：
  - `7.1 终局布局起点`
  - `7.2 骗过所有人的机制`
  - `7.3 死者回归翻盘链`
  - `7.4 伏笔台账闭环`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入伏笔审查、终局整合职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入终局级和伏笔级质量闸门

### 4.8 第 8 阶段：长篇结构规划

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入“百万字创作圣经”“不是短纲而是长篇规划”的相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 8 阶段片段：
  - `8.1 分卷策略`
  - `8.2 每卷主题与核心冲突`
  - `8.3 每卷高潮与卷末悬念`
  - `8.4 强度递增曲线`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入结构设计席位职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入结构级质量闸门

### 4.9 第 9 阶段：章节级细纲扩写

应注入：
- `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
  注入章节密度、每章都必须推进剧情与人物的相关片段
- `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md`
  注入第 9 阶段片段：
  - `9.1 章节骨架`
  - `9.2 章节结果与钩子`
  - `9.3 章节伏笔与人物推进`
  - `9.4 卷内节奏校验`
- `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`
  注入章节扩写、结构校验、伏笔校验职责
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md`
  注入当前轮模板结构

审查轮额外注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md`
  注入章节级和文件级质量闸门

---

## 5. 审查轮该注入什么

不是每一轮都要注入质量闸门。

质量闸门最适合在以下时机注入：
- 一个子任务准备结束时
- 一个阶段准备切换时
- 一个关键文件准备视为“完成”时
- Host 发起审查轮时

审查轮必须注入：
- `docs/NOVEL_GODMODE_QUALITY_GATES.md` 的对应片段
- `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md` 中“本轮禁止收尾偷跑”的模板片段

审查轮不应该重新全量注入：
- 整份母本 Prompt
- 其他阶段的子任务

---

## 6. 席位分工时该注入什么

如果系统支持按席位裁剪 Prompt，那么在同一阶段中，不同席位应额外注入不同内容。

例如：

- Host
  注入 `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md` 里 Host 的仲裁、整合、定稿职责
- 结构设计席位
  注入分卷结构、章节节奏、高潮曲线相关职责
- 诡计设计席位
  注入事件设计、误导与反制、可复盘性相关职责
- 角色设计席位
  注入人物弧线、关系线、宿敌线相关职责
- 伏笔审查席位
  注入伏笔回收、二刷线索、逻辑闭环相关职责

也就是说：
- 阶段决定大方向
- 子任务决定当前问题
- 席位职责决定“这个人这轮主要负责哪块输出”

---

## 7. 推荐的实际顺序

最推荐的整体顺序如下：

1. 开局
   - 注入 `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
   - 注入 `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md` 的开局铁律摘要
   - 启用 `docs/NOVEL_GODMODE_WORKFLOW.json`

2. 进入阶段时
   - 注入 `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md` 中该阶段的总片段

3. 每轮开始时
   - 注入 `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md` 的当前轮模板
   - 注入当前子任务片段
   - 注入当前席位职责片段

4. 子任务结束前
   - 注入 `docs/NOVEL_GODMODE_QUALITY_GATES.md` 的对应检查项

5. 阶段切换前
   - 再注入一次阶段级质量闸门
   - 未通过则继续停留当前阶段

---

## 8. 最简版答案

如果你只想记最核心的顺序，就记这 4 句：

1. 开局先用 `docs/NOVEL_GODMODE_MASTER_PROMPT.md`
2. 每到一个阶段，就注入 `docs/NOVEL_GODMODE_PHASE_SUBTASKS.md` 里对应阶段的片段
3. 每一轮都用 `docs/NOVEL_GODMODE_RUNTIME_PROMPT.md` 组织成当前轮 Prompt
4. 需要审查时，再注入 `docs/NOVEL_GODMODE_QUALITY_GATES.md`；按席位写作时，再注入 `docs/NOVEL_GODMODE_ROLE_WRITING_ASSIGNMENTS.md`

---

## 9. 结论

神作模式不是“把所有文档都塞进去”。

正确顺序是：
- 母本先定天花板
- 阶段文档控制当前范围
- 运行时文档控制每轮格式
- 角色文档控制分工
- 质量文档控制放行

只有这样，系统才能既保留巨大野心，又不至于把阶段、轮次、子任务全部搅乱。
