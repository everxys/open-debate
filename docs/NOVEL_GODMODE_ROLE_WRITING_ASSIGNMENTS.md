# 小说神作模式角色分工写作方案

## 1. 目标

这份文档用于解决一个非常具体的问题：

- 当前神作模式里，Host 太容易承担大部分整合与最终写稿压力

如果不解决这个问题，后期就会出现：
- 前中期多人讨论
- 中后期主要变成 Host 一个人写
- 轮数很多，但多席位写作效率不高

所以这份文档的目标是：
- 明确每类写作任务由谁主责
- 明确谁写初稿，谁做整合，谁做审查
- 明确不同阶段如何分工

这份文档不是在定义人物设定，而是在定义“创作生产线中的写作职责”。

---

## 2. 总原则

### 2.1 Host 不再承担全部写作

Host 的核心职责应该是：
- 定义本轮结论
- 仲裁分歧
- 收敛版本
- 最终整合口径

Host 不应该承担：
- 所有角色档案初稿
- 所有事件细稿
- 所有伏笔台账初稿
- 所有章节扩写初稿

### 2.2 初稿、整合、审查必须分开

每个重要交付都应该区分三类责任：
- `主责席位`
  负责该文件或模块的初稿
- `整合席位`
  负责把多人意见统一成当前版本
- `审查席位`
  负责指出漏洞、空泛、重复、降智风险

如果三者全由同一角色承担，最后就会变成低效单点。

### 2.3 分工应以“能力倾向”而不是“权力地位”为基础

角色分工不是按“谁官大谁来写”，而是按任务性质分配。

例如：
- 结构型任务交给强结构感角色
- 事件型任务交给强诡计角色
- 角色弧线交给强人物理解角色
- 伏笔校验交给强逻辑校验角色

### 2.4 Host 负责最终统一，不负责包办

Host 的正确位置是“总编”，不是“全职代笔”。

---

## 3. 推荐的七席写作职责模型

以下不是硬编码人设，而是推荐的职责模板。
后续可以映射到 7 位外来天才的具体角色上。

### 3.1 Host：总编 / 收敛者

职责：
- 定义当前轮次结论
- 收敛冲突意见
- 决定当前版本保留什么、删除什么
- 统一文件口径

负责的不是“最多文字”，而是“最终定稿权”。

适合主抓：
- `final/01-core-premise.md`
- `final/07-main-plot-spine.md`
- `final/novel_outline_v2.md`

不适合独自包办：
- 所有角色档案
- 所有章节细纲
- 所有伏笔台账

### 3.2 Structure Lead：结构总设计

职责：
- 分卷结构
- 节奏曲线
- 卷级高潮
- 长线递进强度

适合主抓：
- `final/11-volume-architecture.md`
- `final/12-volume-1-outline.md`
- `final/13-volume-2-outline.md`
- `final/14-volume-3-outline.md`

### 3.3 Scheme Lead：诡计与事件总设计

职责：
- 五大核心事件
- 误导与反制链
- 大点子 / 中点子 / 小点子挂接

适合主抓：
- `final/08-five-major-events.md`
- `final/09-core-schemes.md`

### 3.4 Character Lead：角色与关系总设计

职责：
- 七位外来天才
- 人物软肋、执念、镜像关系
- 背叛线、纯爱线、宿敌线

适合主抓：
- `final/05-seven-summoned-geniuses.md`
- `final/10-relationships-and-betrayals.md`

### 3.5 World Lead：世界观与秩序设计

职责：
- 世界规则
- 胜负规则
- 时代历史
- 阵营秩序

适合主抓：
- `final/02-world-rules.md`
- `final/03-era-history.md`
- `final/04-factions-and-order.md`

### 3.6 Local Genius Lead：本土天才生态设计

职责：
- 18 位本土天才分层
- 本土与外来的压制关系
- 本土天才的出场价值和事件挂靠

适合主抓：
- `final/06-eighteen-local-geniuses.md`

### 3.7 Audit Lead：伏笔、逻辑与审判

职责：
- 伏笔台账
- 逻辑闭环
- 终局可复盘性
- 阶段最弱项审判

适合主抓：
- `final/15-foreshadowing-ledger.md`
- `final/16-key-scenes-and-lines.md`

它的职责不是“写得最多”，而是“防止作品自我欺骗”。

---

## 4. 文件级写作分工建议

推荐把当前重型 preset 中所有 `ownerRole=Host` 的文件拆成“主责 + 整合 + 审查”三段式。

### 4.1 Host 主责的文件

推荐由 Host 主责初稿或最终整合：
- `final/01-core-premise.md`
- `final/07-main-plot-spine.md`
- `final/novel_outline_v2.md`

原因：
- 这些文件决定全书统一口径
- 不适合多头并行直接写散

### 4.2 Structure Lead 主责的文件

- `final/11-volume-architecture.md`
- `final/12-volume-1-outline.md`
- `final/13-volume-2-outline.md`
- `final/14-volume-3-outline.md`

Host 负责整合，Audit Lead 负责节奏与空泛审查。

### 4.3 Scheme Lead 主责的文件

- `final/08-five-major-events.md`
- `final/09-core-schemes.md`

Host 负责版本收敛，Audit Lead 负责可复盘与逻辑校验。

### 4.4 Character Lead 主责的文件

- `final/05-seven-summoned-geniuses.md`
- `final/10-relationships-and-betrayals.md`

Host 负责统一人物口径，Audit Lead 负责防止人物降智或情感空泛。

### 4.5 World Lead 主责的文件

- `final/02-world-rules.md`
- `final/03-era-history.md`
- `final/04-factions-and-order.md`

Host 负责是否纳入主线，Scheme Lead 负责世界规则能否支撑智斗。

### 4.6 Local Genius Lead 主责的文件

- `final/06-eighteen-local-geniuses.md`

Host 负责纳入全书结构，Character Lead 负责人物辨识度校验。

### 4.7 Audit Lead 主责的文件

- `final/15-foreshadowing-ledger.md`
- `final/16-key-scenes-and-lines.md`

Host 负责最终纳入汇总稿，Scheme Lead 和 Character Lead 分别审查其与事件、人设的挂钩强度。

---

## 5. 阶段级分工建议

除了文件级分工，还需要阶段级分工，否则运行时仍然容易默认大家都在泛讨论。

### 第 1 阶段：核心命题与世界基底

主责：
- Host
- World Lead

重点发言席位：
- Host：定义作品核心命题
- World Lead：补底层规则
- Audit Lead：检查规则是否自洽

### 第 2 阶段：人物系统

主责：
- Character Lead
- Local Genius Lead

重点发言席位：
- Character Lead：七位外来天才
- Local Genius Lead：十八位本土天才
- Host：做裁决

### 第 3 阶段：点子筛选与重组

主责：
- Scheme Lead
- Audit Lead

重点发言席位：
- Scheme Lead：重组点子
- Audit Lead：删空泛、删伪强点子
- Host：决定保留与删除

### 第 4 阶段：主线骨架与终局真相

主责：
- Host
- Scheme Lead

重点发言席位：
- Host：确定全书主线
- Scheme Lead：保证骗局和结构成立
- Audit Lead：保证二刷可复盘

### 第 5 阶段：五大核心事件

主责：
- Scheme Lead

重点发言席位：
- Scheme Lead：事件骨架
- Character Lead：人物碰撞
- Audit Lead：误导与反制审查
- Host：收敛定稿

### 第 6 阶段：人物弧线、纯爱线、背叛线、宿敌线

主责：
- Character Lead

重点发言席位：
- Character Lead：人物主弧
- Host：决定取舍
- Audit Lead：删除廉价情感设计

### 第 7 阶段：终局布局链与伏笔回收

主责：
- Audit Lead
- Scheme Lead

重点发言席位：
- Audit Lead：检查闭环
- Scheme Lead：补足诡计结构
- Host：决定终局版本

### 第 8 阶段：长篇结构规划

主责：
- Structure Lead

重点发言席位：
- Structure Lead：分卷与节奏
- Host：统一方向
- Audit Lead：检查强度衰减风险

### 第 9 阶段：章节级细纲扩写

主责：
- Structure Lead
- Character Lead

重点发言席位：
- Structure Lead：章节结构
- Character Lead：章节人物推进
- Audit Lead：检查无效章节
- Host：最终整合

---

## 6. 每轮发言权重建议

不是每轮所有席位都必须同权重地说一样多。

更高效的方式是：
- 当前子任务的主责席位输出最长
- 整合席位次之
- 审查席位输出短但狠
- 其他席位只补关键不同意见

这样可以减少：
- 七个人都说差不多的话
- 每轮输出很多，但推进很少

---

## 7. 审查席位的特殊规则

Audit Lead 需要被单独定义，因为它不是普通“创作席位”，而是“质量破坏检测器”。

它每轮至少应优先检查：
- 有没有角色降智
- 有没有伪强反转
- 有没有低质量伏笔
- 有没有靠设定硬补
- 有没有空泛字数

它的价值不在于“提供最多创意”，而在于“不让系统自我催眠为神作”。

---

## 8. 对 workflow 的后续建议

当前重型 preset 的问题之一，是 `requiredFiles.ownerRole` 几乎都还是 `Host`。

后续应考虑引入新的通用能力，例如：
- `roleWritingAssignments`
- `deliverables.requiredFiles[].draftOwnerRole`
- `deliverables.requiredFiles[].reviewOwnerRole`
- `deliverables.requiredFiles[].finalOwnerRole`

这样才能把：
- 初稿责任
- 审查责任
- 最终整合责任

真正从配置层拆开，而不是继续在 prompt 里口头约定。

---

## 9. 验收标准

如果角色分工写作机制真正生效，应当看到这些变化：

### 9.1 Host 不再写最多

Host 输出应更偏收敛和整合，而不是单纯承担最多文本。

### 9.2 多席位持续产出文件

不同席位应在不同阶段持续为不同文件贡献初稿和修订，而不是后期全堆给 Host。

### 9.3 中后期效率提升

中后期不再大量出现“大家讨论，主持人整理确认”的低效回合。

### 9.4 文件质量更符合专业分工

角色档案更像角色专家写的，事件更像诡计专家写的，伏笔更像审校专家盯出来的。

---

## 10. 结论

神作模式如果不解决写作职责分配问题，最终一定会回到：
- 多人讨论
- 一人收尾

而真正高质量、长周期、重交付的创作流程必须做到：
- Host 负责收敛
- 各席位负责不同模块的初稿
- Audit Lead 负责持续否定平庸内容

只有这样，多席位辩论才会真正变成“并行创作系统”，而不是“多人陪一个主持人写稿”。
