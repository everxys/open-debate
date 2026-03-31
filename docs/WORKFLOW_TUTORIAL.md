# Workflow 教程：把“投票/角色/发言顺序”变成可配置（超详细）

本教程解释本项目的 **workflow 驱动官方投票** 的完整用法：从「策略怎么写」到「辩论里怎么投」再到「结果怎么影响下一轮发言顺序」。

如果你只想 5 分钟跑起来：直接看 **第 1～3 节**，复制模板即可。

> 说明：
> - 平台默认 workflow 已经改为“中立协作模式”，没有 `debate/workflow.json` 时，辩论依然可以运行。
> - 系统没有内置任务分类，也没有内置“小说模式 / 文档模式 / 方案模式”。
> - 任何场景差异都只通过 `debate/workflow.json` 和提示词表达。

---

## 0. 你到底在配置什么？

你在配置的是 **本场辩论的玩法规则**，包括：

- 是否启用官方投票（默认关闭）
- 从第几轮开始允许开票/投票/封票
- 这次“选举”要选哪些角色（角色名是任意字符串）
- （可选）选举结束后，下一轮开始时自动调整席位发言顺序（例如某角色必须首位、某角色必须末位）

核心理念：

- **程序只提供能力**：开票 / 投票 / 封票 / 保存结果 / 自动调整发言顺序（在下一轮边界生效）
- **策略提供规则**：投不投、何时投、投哪些角色、顺序约束是什么

---

## 1. 文件放哪里？（最重要）

要启用 workflow，你必须把配置文件放在 **策略角色文件** 的固定路径：

`debate/workflow.json`

也就是说：在“策略编辑器”的文件树里，为某个角色新增文件：

- 路径：`debate/workflow.json`
- 内容：一个 JSON

创建辩论时，系统会做一件事：

- 如果策略里存在 `debate/workflow.json`：复制到该辩论的共享文件 `workflow.json`
- 如果不存在：该辩论会使用平台默认的中立 workflow，不会自动注入小说式角色或交付要求

提示：你只需要在策略的任意一个角色里放这份文件即可；系统会选到一份并复制。

### 1.1 在 UI 里怎么创建这个文件？（一步步）

1. 进入「策略」页面，打开你的策略
2. 在左侧选择任意一个角色（Role）
3. 在该角色的文件树里 **新建文件**
4. 路径输入：`debate/workflow.json`
5. 在编辑区粘贴本教程第 3 节的模板（或你自己的 JSON）
6. 保存策略

### 1.2 我放在哪个角色里最合适？

放哪个角色都可以，但为了团队协作更清晰，建议约定：

- 放在「Seat-1 / 控场者」对应的策略角色里
- 或者专门创建一个 “Debate Config” 角色，只存 `debate/*` 这类“辩论级规则文件”

---

## 2. workflow.json 的字段解释（逐字段）

下面是推荐的 v1 完整字段结构（你不必全用）：

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "election": {
    "startRound": 3,
    "roles": ["Host", "Supervisor"],
    "speakingOrder": { "firstRole": "Host", "lastRole": "Supervisor" }
  },
  "seatOrderRules": [{ "afterRound": 1, "policy": { "type": "rotate", "offset": 1 } }]
}
```

### 2.1 workflowVersion

- 类型：number（目前只支持 1）
- 默认：1

用途：用于未来升级配置结构时的兼容与校验。

### 2.2 enabled

- 类型：boolean
- 默认：false

`enabled=false` 或缺失时：**整套官方投票能力关闭**，模型也拿不到投票工具。

### 2.3 election.startRound

- 类型：number（>=1 的整数）
- 默认：1

含义：从第几轮开始才允许“官方投票工具”被使用。

例子：

- `startRound=3`：第 1～2 轮只能讨论，**第 3 轮起**才允许开票/投票/封票

### 2.4 election.roles

- 类型：string[]
- 默认：[]

含义：当你开启 `kind="election"` 的官方投票时，需要选出的“角色列表”。

关键点：

- 角色名是任意字符串，不限定 Host/Supervisor
- `roles=[]` 表示 **不允许进行 election**（但仍可做 custom vote）

### 2.5 election.speakingOrder（可选）

- 类型：object（可省略）
- 字段：
  - `firstRole`: string | null
  - `lastRole`: string | null

含义：选举结束后，如果某个角色被任命了席位，则自动生成「下一轮开始时生效」的席位顺序调整。

注意事项：

- 只在 **election** 封票后起作用
- 生效时机是「下一轮边界」，不会在本轮中途改顺序
- 如果某个角色最终未能选出（winner=null），则对应约束无法应用

### 2.6 seatOrderRules（可选，最佳实践补强）

用途：在 **不依赖选举** 的情况下，也能在轮次边界自动生成「下一轮席位顺序」。

规则触发：

- `afterRound: N` 表示 “第 N 轮结束后”（也就是第 N+1 轮开始前）生效
- 生效时会生成 `seats/pending_reorder.json`，并在下一轮边界应用

目前支持的 policy（受限版本，确保可控、可预测）：

1) 轮换：`{ "type": "rotate", "offset": 1 }`

- offset=1 表示把原来的第 2 位提到第 1 位（原第 1 位挪到最后）
- offset=-1 表示把最后一位提到最前

2) 反转：`{ "type": "reverse" }`

示例（你的需求：第一轮结束后先轮换一下顺序，再进入第二轮）：

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "election": { "startRound": 3, "roles": ["Host", "Supervisor"] },
  "seatOrderRules": [{ "afterRound": 1, "policy": { "type": "rotate", "offset": 1 } }]
}
```

---

## 3. 常见 workflow 片段

### 片段 A：只做“自定义投票”（不选角色）

适合：你只想每隔几轮对某个提案做表决，不关心主持人/监管员。

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "election": { "startRound": 1, "roles": [] }
}
```

说明：

- 可以发起 `kind="custom"` 的投票
- 不能发起 `kind="election"`（因为 roles 为空）
- 如果你后面开始要求输出文件，建议同时给 `requiredFiles[].qualityChecks`，不要只靠字数门槛

### 片段 B：角色选举 + 顺序约束

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "election": {
    "startRound": 3,
    "roles": ["Host", "Supervisor"],
    "speakingOrder": { "firstRole": "Host", "lastRole": "Supervisor" }
  }
}
```

说明：

- 第 1～2 轮讨论
- 第 3 轮起可以开票做角色选举
- 封票后会生成下一轮的席位顺序（Host 置顶，Supervisor 置底）

### 片段 C：输出文件 + 质量检查

适合：任何需要结构化输出的讨论场景。

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "completion": { "mode": "consensus_plus_outputs" },
  "deliverables": {
    "allowedPaths": ["final/", "outputs/"],
    "requiredFiles": [
      {
        "path": "final/summary.md",
        "description": "最终结论、依据与建议",
        "minChars": 800,
        "minMarkdownHeadings": 3,
        "requiredSnippets": ["结论", "依据", "建议"],
        "qualityChecks": {
          "requiredSections": ["结论", "依据", "建议"],
          "requiredTerms": ["风险", "权衡"],
          "minBulletItems": 6,
          "counters": [
            { "label": "options", "patterns": ["方案"], "minCount": 2 }
          ]
        }
      }
    ]
  }
}
```

这套 `qualityChecks` 的意思是：

- 必须真的有这些章节
- 必须覆盖这些关键术语
- 至少列出一定数量的要点
- 某类内容至少出现多少次

这些只是字段组合示例，不是系统内置模板。

---

## 4. 辩论里怎么“官方投票”？（开票/投票/封票）

官方投票由 3 个工具组成：

1. `debate_vote_open`：开票
2. `debate_vote_cast`：投票
3. `debate_vote_close`：封票并生成结果/指令

### 4.1 开票：debate_vote_open

#### 4.1.1 election（角色选举）

调用参数：

```json
{ "kind": "election", "title": "第 3 轮角色选举" }
```

系统会自动把候选人设置为本场所有席位（Seat-1...Seat-N）。

注意：

- 只有当 `workflow.enabled=true` 且 `当前轮次 >= startRound` 且 `roles 非空` 时才能开 election

#### 4.1.2 custom（自定义表决）

调用参数：

```json
{
  "kind": "custom",
  "title": "是否采用方案 A？",
  "prompt": "请在 A / B 中二选一，并给出一句理由。",
  "options": ["A", "B"]
}
```

注意：

- custom 不依赖 roles
- 仍然受 `enabled/startRound` 约束

### 4.2 投票：debate_vote_cast

#### 4.2.1 election 的投票格式（重点）

从现在开始，election 的投票不再是 `host/supervisor` 两个字段，而是一个通用结构：

`selections: { 角色名: Seat-? }`

假设 workflow.roles 是：

```json
["Host", "Supervisor"]
```

那么每个席位投票必须满足：

- selections 里必须同时包含 Host 和 Supervisor
- 每个角色对应一个 seat（Seat-1/Seat-2/...）

示例：

```json
{
  "selections": { "Host": "Seat-2", "Supervisor": "Seat-5" },
  "reason": "Seat-2 控场更稳，Seat-5 更适合做合规检查。"
}
```

#### 4.2.2 custom 的投票格式

示例：

```json
{ "choice": "A", "reason": "A 的成本更低。" }
```

### 4.3 封票：debate_vote_close

封票不需要参数：

```json
{}
```

封票后系统会写入文件：

- `votes/round-{N}.json`：机器可读的结果（UI 用）
- `votes/round-{N}.md`：人类可读的结果（方便快速浏览）
- `votes/directive.json`：官方角色任命/指令（如果是 election）
- `votes/directive.md`：官方指令（如果是 election）
- `seats/pending_reorder.json`：下一轮边界自动应用的新顺序（如果 speakingOrder 生效）

---

## 5. UI 上你能看到什么？（结果在哪里）

在辩论详情页：

- 右侧目录会出现「投票结果」入口（读取 `votes/round-*.json`）
- 「刷新角色」会读取 `votes/directive.json`
- 「应用官方顺序」会优先使用 `votes/directive.json` 里的 `seatOrder`，否则按 `speakingOrder.firstRole/lastRole` 计算顺序

---

## 6. 常见问题（FAQ）

### Q1：为什么我看不到投票工具/投票环节？

检查：

1. 策略里是否存在 `debate/workflow.json`
2. 里面是否 `enabled=true`
3. 当前轮次是否已经到达 `startRound`

只要缺一项，系统会认为“官方投票关闭”，模型也不会拿到投票工具。

### Q1.1：我旧版 workflow 是扁平字段（startRound/roles/speakingOrder），还支持吗？

支持（兼容模式）。系统会把它自动当作 v1 的 `election.*` 来解析。

但推荐你尽快迁移到 v1 结构，并显式写上 `workflowVersion: 1`，这样更清晰也更利于后续升级。

### Q2：我想选 3 个角色甚至 5 个角色可以吗？

可以。把 `roles` 写成任意长度即可，例如：

```json
{ "enabled": true, "startRound": 2, "roles": ["Moderator", "Timekeeper", "Judge"] }
```

投票时每个席位的 `selections` 必须把这 3 个键都填满。

### Q3：顺序约束会不会把当前轮打乱？

不会。顺序调整写入 `seats/pending_reorder.json`，只会在「下一轮边界」自动应用。

### Q4：我只想要“顺序约束”，不想选角色可以吗？

不建议。

原因：顺序约束依赖 “选举结果 -> 角色任命 -> 对应 seat 的 debateAgentId”，如果你不选角色，就没有一个可靠的“谁是 firstRole/lastRole”来源。

替代方案（推荐）：

1. 仍然使用 election，但只选 1～2 个“流程角色”，例如：

```json
{
  "enabled": true,
  "startRound": 1,
  "roles": ["Moderator"],
  "speakingOrder": { "firstRole": "Moderator", "lastRole": null }
}
```

2. 如果你真的只想固定顺序（不靠投票），那就不要用 workflow 的 speakingOrder；直接在创建辩论后手动调整席位顺序（UI 支持上移/下移/重排）。

### Q5：平票怎么办？

系统的 winner 选择策略是：

- 对每个 role，统计 `roleCounts[role][seat]` 的票数
- 取票数最高者
- 若出现平票：按 Seat 编号从小到大取最小的 Seat（例如 Seat-2 与 Seat-5 平票，则 winner=Seat-2）
- 另外，为避免同一席位拿到多个角色：后续角色会排除已被选中的 Seat（按 roles 的顺序依次选 winner）

如果你希望有“重新投票/加赛”的规则：把它写进策略的 system prompt（流程规则属于策略，不属于程序）。

### Q6：我能让同一个人同时担任多个角色吗？

默认不行（系统会尽量避免一个 Seat 同时当选多个角色）。

如果你确实需要允许兼任：

- 最简单的办法：把 roles 缩减成你真正需要“唯一”的角色
- 或者：把“兼任”改成职责描述（写在 prompt 里），不要强制建模为多个角色

### Q7：我怎么确认 workflow.json 真的被复制进辩论了？

你可以通过 API 读取辩论文件：

- 路径：`workflow.json`
- 接口：`GET /api/debates/{id}/files?path=workflow.json`

如果返回 404/空，则说明该辩论未启用 workflow（通常是策略里没有 `debate/workflow.json` 或未正确保存）。

---

## 7. 输出文件格式（给想做二次开发/调试的人）

### 7.1 votes/directive.json（election 封票后）

示例结构（字段可能会扩展，但核心是 roles/appointments/speakingOrder/seatOrder）：

```json
{
  "kind": "election",
  "at": "2026-03-16T12:34:56.000Z",
  "roundNumber": 3,
  "title": "第 3 轮角色选举",
  "roles": ["Host", "Supervisor"],
  "appointments": {
    "Host": { "role": "Host", "seat": "Seat-2", "debateAgentId": "uuid...", "aiAgentId": "uuid...", "name": "Alice" },
    "Supervisor": { "role": "Supervisor", "seat": "Seat-5", "debateAgentId": "uuid...", "aiAgentId": "uuid...", "name": "Bob" }
  },
  "speakingOrder": { "firstRole": "Host", "lastRole": "Supervisor" },
  "seatOrder": ["debateAgentId-of-Seat-2", "...middle...", "debateAgentId-of-Seat-5"]
}
```

### 7.2 votes/round-{N}.json（每轮投票结果）

election 的关键字段：

- `result.roles`
- `result.roleCounts`：每个角色的票数分布
- `result.winners`：每个角色的 winner（Seat-? 或 null）
- `result.ballots[*].selections`：每票的 selections

custom 的关键字段：

- `result.counts`：每个选项的票数
- `result.winner`：winner（字符串或 null）

---

## 8. 推荐“主持人/流程控制者”提示词（可直接复制）

把这段贴给负责控场的席位（通常是 Seat-1 或你策略里指定的控场角色），能显著降低“不会用工具”的概率：

```text
你负责在允许的轮次发起并完成官方投票（以 workflow.json 为准）。

当且仅当满足：当前轮次 >= startRound，且当前不存在 open vote 时，你可以发起一次官方投票：
- 若 workflow.roles 非空：优先发起 election（角色选举）
- 否则：使用 custom vote（自定义表决）

开票（election）：
- 调用 debate_vote_open: { kind: "election", title: "第{轮次}轮角色选举" }

投票阶段（election）：
- 要求每个席位都调用 debate_vote_cast，并且 selections 必须覆盖 workflow.roles 的每个角色：
  { selections: { "<Role1>": "Seat-?", "<Role2>": "Seat-?" }, reason: "..." }

封票：
- 当所有席位都已投票（或你判断可以结束）时，调用 debate_vote_close。
- 封票后宣布每个角色的当选 Seat，并提醒：若 workflow.speakingOrder 配置了 firstRole/lastRole，则下一轮边界会自动应用顺序。
```
