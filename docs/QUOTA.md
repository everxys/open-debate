# AI 辩论场 - 配额与计费设计

## 概述

本文档定义多用户场景下的配额管理、成本控制和费用统计机制。

---

## 1. 配额模型

### 1.1 配额维度

| 维度 | 说明 | 默认值 |
|------|------|--------|
| 并发辩论数 | 用户同时可运行的辩论数 | 2 |
| 日 Token 限额 | 用户每日消耗的 Token 上限 | 100,000 |
| 月 Token 限额 | 用户每月消耗的 Token 上限 | 2,000,000 |
| 单辩论轮数上限 | 单个辩论的最大轮数 | 50 |
| AI 配置数量 | 用户可保存的 AI 配置数 | 20 |

### 1.2 用户等级

| 等级 | 日 Token | 月 Token | 并发数 | 说明 |
|------|----------|----------|--------|------|
| Free | 10,000 | 100,000 | 1 | 免费用户 |
| Pro | 100,000 | 2,000,000 | 3 | 付费用户 |
| Enterprise | 自定义 | 自定义 | 自定义 | 企业用户 |

---

## 2. 成本估算

### 2.1 Token 估算模型

```typescript
// 单轮发言 Token 估算
interface TurnTokenEstimate {
  // 输入 Token
  promptTokens: number;       // 系统提示词 + 上下文 + 用户问题
  // 输出 Token
  completionTokens: number;   // AI 发言内容

  // 估算公式
  static estimate(contextTurns: number): number {
    const BASE_PROMPT = 200;           // 基础提示词
    const CONTEXT_PER_TURN = 150;      // 每轮上下文
    const AVG_OUTPUT = 300;            // 平均输出

    return BASE_PROMPT + (contextTurns * CONTEXT_PER_TURN) + AVG_OUTPUT;
  }
}

// 示例：10 轮辩论，5 个 AI
// 单轮 ≈ 200 + (10 * 150) + 300 = 2000 tokens
// 总计 ≈ 2000 * 10 * 5 = 100,000 tokens
```

### 2.2 费用预览

在开始辩论前，向用户展示预估费用：

```
辩论配置预览：
- 问题：人工智能是否应该拥有法律人格？
- AI 数量：5
- 预计轮数：10
- 预估 Token 消耗：~100,000
- 预估费用：$0.50 (按 $5/1M tokens 计算)

您的剩余配额：
- 今日剩余：80,000 / 100,000
- 本月剩余：1,500,000 / 2,000,000
```

---

## 3. 配额检查

### 3.1 检查逻辑

```typescript
async function checkQuota(userId: string, estimatedTokens: number) {
  const quota = await getUserQuota(userId);

  // 检查日配额
  if (quota.dailyUsed + estimatedTokens > quota.dailyLimit) {
    throw new QuotaExceededError('日配额不足');
  }

  // 检查月配额
  if (quota.monthlyUsed + estimatedTokens > quota.monthlyLimit) {
    throw new QuotaExceededError('月配额不足');
  }

  // 检查并发数
  const activeDebates = await getActiveDebateCount(userId);
  if (activeDebates >= quota.maxConcurrent) {
    throw new QuotaExceededError('并发辩论数已达上限');
  }

  return { allowed: true, remaining: quota };
}
```

### 3.2 配额扣减

```typescript
async function consumeQuota(userId: string, tokensUsed: number) {
  await db.user_quotas.upsert({
    where: { userId },
    update: {
      dailyUsed: { increment: tokensUsed },
      monthlyUsed: { increment: tokensUsed },
      lastUsedAt: new Date()
    },
    create: {
      userId,
      dailyUsed: tokensUsed,
      monthlyUsed: tokensUsed,
      lastUsedAt: new Date()
    }
  });
}
```

### 3.3 配额重置

```typescript
// 每日重置（UTC 0 点）
async function resetDailyQuota() {
  await db.user_quotas.updateMany({
    where: {},
    data: { dailyUsed: 0 }
  });
}

// 每月重置（每月 1 号）
async function resetMonthlyQuota() {
  await db.user_quotas.updateMany({
    where: {},
    data: { monthlyUsed: 0 }
  });
}
```

---

## 4. 成本控制

### 4.1 费用上限

用户可设置自定义费用上限：

```typescript
interface CostLimit {
  userId: string;
  dailyLimit?: number;      // 每日费用上限（美元）
  perDebateLimit?: number;  // 单辩论费用上限
  hardStop: boolean;        // 达到上限后是否硬停止
}
```

### 4.2 实时成本追踪

```typescript
// 每次 API 调用后更新成本
async function trackCost(debateId: string, usage: TokenUsage) {
  const cost = calculateCost(usage);

  await db.debates.update(debateId, {
    tokenUsed: { increment: usage.totalTokens },
    costUsd: { increment: cost }
  });

  // 检查是否超出限制
  const debate = await db.debates.find(debateId);
  if (debate.costUsd >= debate.costLimit) {
    await stopDebate(debateId, 'cost_limit_reached');
  }
}

// Token 到美元的转换（按提供商）
function calculateCost(usage: TokenUsage, provider: string): number {
  const rates = {
    'openai-gpt-4': { input: 0.03, output: 0.06 },  // $/1K tokens
    'anthropic-opus': { input: 0.015, output: 0.075 },
    'google-ultra': { input: 0.005, output: 0.015 }
  };

  const rate = rates[provider];
  return (usage.promptTokens * rate.input + usage.completionTokens * rate.output) / 1000;
}
```

---

## 5. 费用报表

### 5.1 数据结构

```typescript
interface CostReport {
  userId: string;
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalTokens: number;
    totalCostUsd: number;
    debateCount: number;
    turnCount: number;
  };
  byProvider: Array<{
    provider: string;
    tokens: number;
    costUsd: number;
  }>;
  byDebate: Array<{
    debateId: string;
    question: string;
    tokens: number;
    costUsd: number;
    turns: number;
  }>;
  dailyTrend: Array<{
    date: string;
    tokens: number;
    costUsd: number;
  }>;
}
```

### 5.2 报表 API

```typescript
// GET /api/reports/cost?period=month
async function getCostReport(userId: string, period: 'day' | 'week' | 'month') {
  const report = await generateCostReport(userId, period);
  return {
    period,
    summary: report.summary,
    byProvider: report.byProvider,
    topDebates: report.byDebate.slice(0, 10),
    dailyTrend: report.dailyTrend
  };
}
```

---

## 6. 数据库设计

### 6.1 user_quotas 表

| 字段 | 类型 | 描述 |
|------|------|------|
| user_id | UUID | 用户 ID |
| tier | TEXT | 用户等级：free, pro, enterprise |
| daily_limit | INTEGER | 日 Token 限额 |
| monthly_limit | INTEGER | 月 Token 限额 |
| daily_used | INTEGER | 今日已用 |
| monthly_used | INTEGER | 本月已用 |
| max_concurrent | INTEGER | 最大并发数 |
| reset_at | TIMESTAMPTZ | 下次重置时间 |
| updated_at | TIMESTAMPTZ | 更新时间 |

### 6.2 cost_limits 表

| 字段 | 类型 | 描述 |
|------|------|------|
| user_id | UUID | 用户 ID |
| daily_cost_limit | FLOAT | 每日费用上限 |
| per_debate_limit | FLOAT | 单辩论费用上限 |
| hard_stop | BOOLEAN | 是否硬停止 |

### 6.3 usage_logs 表

| 字段 | 类型 | 描述 |
|------|------|------|
| id | UUID | 日志 ID |
| user_id | UUID | 用户 ID |
| debate_id | UUID | 辩论 ID |
| turn_id | UUID | 轮次 ID |
| provider | TEXT | AI 提供商 |
| model | TEXT | 模型名称 |
| prompt_tokens | INTEGER | 输入 Token |
| completion_tokens | INTEGER | 输出 Token |
| cost_usd | FLOAT | 费用 |
| created_at | TIMESTAMPTZ | 时间 |

---

## 7. 超额处理

### 7.1 软限制 vs 硬限制

| 类型 | 行为 |
|------|------|
| 软限制 | 达到后警告用户，但允许继续（可能产生超额费用） |
| 硬限制 | 达到后自动停止，禁止继续 |

### 7.2 超额通知

```typescript
// 配额使用达到阈值时通知
const WARNING_THRESHOLDS = [0.5, 0.8, 0.9, 1.0];

async function checkQuotaUsage(userId: string) {
  const quota = await getUserQuota(userId);
  const usageRate = quota.dailyUsed / quota.dailyLimit;

  for (const threshold of WARNING_THRESHOLDS) {
    if (Math.abs(usageRate - threshold) < 0.01) {
      await sendNotification(userId, {
        type: 'quota_warning',
        message: `您的日配额已使用 ${Math.round(usageRate * 100)}%`,
        level: threshold >= 1.0 ? 'error' : 'warning'
      });
      break;
    }
  }
}
```

---

## 8. 付费集成（可选）

### 8.1 支付 Provider

- Stripe（推荐）
- Lemon Squeezy
- Paddle

### 8.2 订阅流程

```
用户选择套餐 → 创建订阅 → 更新配额 → 定期扣款
```

### 8.3 订阅状态同步

```typescript
interface Subscription {
  userId: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'canceled' | 'past_due';
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-03-06 | 初始配额设计 |
