# AI 辩论场 - 后台任务管理设计

## 概述

辩论执行属于长时任务，但在 `MVP` 阶段应优先选择简单、可恢复、可观测的执行模型，不提前绑定重型队列架构。

---

## 当前建议

### V1.0

采用“应用触发 + 数据库存储状态 + 详情页轮询”的简化模式：

```
Frontend
   │
   ▼
Next.js API / Server Action
   │
   ▼
Debate Runtime
   │
   ▼
Postgres (state + turns)
```

说明：

- 前端通过短轮询接收状态与发言更新
- 不再同时设计“轮询 + SSE/WebSocket”双通道
- 如果后续发现运行时阻塞或吞吐不足，再升级为独立队列

---

## 辩论状态

```typescript
type DebateStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed';
```

关键状态字段：

```typescript
interface DebateState {
  id: string;
  status: DebateStatus;
  currentTurn: number;
  tokenUsed: number;
  startedAt?: string;
  finishedAt?: string;
  lastErrorCode?: string;
}
```

---

## 执行流程

1. 用户创建辩论，状态为 `pending`
2. 用户点击开始，状态切到 `running`
3. 运行时按顺序执行单轮发言
4. 每轮写入 `debate_turns`，更新 `debates`
5. 前端通过 Realtime 看见变化
6. 满足结束条件后置为 `completed/stopped/failed`

---

## 恢复与超时

### 单轮超时

- 默认 60 秒
- 失败后最多重试 2 次

### 会话恢复

- 服务启动时扫描长期停留在 `running` 且超出心跳阈值的记录
- 标记为 `failed` 或重新进入继续执行逻辑

### 会话总时长上限

- 默认 24 小时
- 超时自动停止

---

## 何时升级为队列

满足以下任一条件时，再引入 `Bull/Redis` 一类任务队列：

- 同时运行中的辩论数明显增加
- Serverless 环境无法稳定承载长流程
- 需要更强的重试、延迟调度、优先级和死信队列

在此之前，不建议为 MVP 过早引入额外基础设施。

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 收敛为 MVP 简化后台任务模型，移除轮询 + SSE + 重队列前置设计 |
| 1.0 | 2026-03-06 | 初始设计 |
