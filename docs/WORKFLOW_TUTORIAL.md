# Workflow Tutorial

当前平台的 workflow 已经收口成固定席位模型：

- Host 是固定席位，负责主持流程，不负责内容创作
- 官方投票只保留：
  - `finalization`
  - `custom`

## 1. 最小可用 workflow

```json
{
  "workflowVersion": 1,
  "enabled": true,
  "phaseMachine": {
    "phases": [
      {
        "id": "phase-1",
        "title": "Phase 1",
        "kind": "analysis"
      },
      {
        "id": "phase-2",
        "title": "Phase 2",
        "kind": "deliberation"
      },
      {
        "id": "phase-3",
        "title": "Phase 3",
        "kind": "finalization"
      }
    ],
    "transitionRules": {
      "finalization": {
        "autoOpenVote": true,
        "requireUnanimousVote": true,
        "reopenUntilPassed": true,
        "discussionRoundsBetweenVotes": 1,
        "requirePhaseForCompletion": true
      }
    }
  },
  "completion": {
    "mode": "workflow_gate"
  }
}
```

## 2. 角色心智

平台层只认固定基础角色。

推荐做法：
- `Host`
  - 固定主持席位
  - 负责限定当前轮唯一问题、提醒阶段目标、开关官方投票、推动讨论继续
- 其他角色
  - 通过固定角色名、对应 system prompt 和 `protocol/*` 定义稳定职责

## 3. 阶段

当前推荐只使用这 4 类阶段：

- `analysis`
  - 定命题、边界、风险、优先级
- `deliberation`
  - 按子任务分块推进内容
- `finalization_vote`
  - 判断是否成熟到可以整体收束
- `finalization`
  - 补洞、回收、交付

## 4. 官方投票

当前只保留两类官方投票：

### 4.1 finalization

用于进入最终收束前的正式表决。

开票：

```json
{ "kind": "finalization", "title": "进入最终收束表决" }
```

投票：

```json
{ "choice": "同意进入收束阶段", "reason": "关键文件已基本成熟，但还需在收束阶段统一补洞。" }
```

### 4.2 custom

用于普通的多选项官方投票。

开票：

```json
{
  "kind": "custom",
  "title": "当前主线骨架二选一",
  "options": ["方案 A", "方案 B"],
  "prompt": "请选择当前轮更值得继续推进的一案。"
}
```

投票：

```json
{ "choice": "方案 A", "reason": "它和终局布局链的咬合更稳。" }
```

## 5. 文件职责

workflow 继续负责：
- phase 结构
- completion mode
- deliverables
- summarizer
- contextAccess

角色职责直接绑定到：
- 固定角色名
- 对应 system prompt
- `protocol/*`

## 6. Host 的边界

Host 是固定席位，但不是内容主创。

Host 应该做：
- 明确当前轮唯一问题
- 控制跑题
- 推动卡住的讨论继续向前
- 在 finalization 阶段催促缺失文件补齐

Host 不应该做：
- 抢写世界观 / 人物 / 事件内容
- 借主持名义替别人完成创作
- 每轮抛出过多问题导致再次发散

## 7. 固定质检角色

如果需要质量审判，请使用固定基础角色承接，例如：
- `反驳者`
- `终局闭环官`
- `人物关系审判官`
