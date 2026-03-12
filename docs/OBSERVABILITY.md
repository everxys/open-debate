# AI 辩论场 - 可观测性设计

## 概述

本文档定义系统的日志记录、性能监控、错误追踪和告警机制。

---

## 1. 日志系统

### 1.1 日志级别

| 级别 | 说明 | 示例 |
|------|------|------|
| DEBUG | 调试信息 | API 请求参数、DB 查询细节 |
| INFO | 正常操作 | 辩论开始、轮次完成 |
| WARN | 警告 | 配额即将用尽、API 响应慢 |
| ERROR | 错误 | API 调用失败、共识检测异常 |
| FATAL | 致命错误 | 数据库连接丢失、服务不可用 |

### 1.2 结构化日志格式

```typescript
interface LogEntry {
  timestamp: string;        // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;          // 服务名：api, engine, worker
  action: string;           // 操作名：debate.start, turn.complete
  correlationId: string;    // 关联 ID：debateId, userId
  duration?: number;        // 耗时 (ms)
  metadata: Record<string, any>;  // 附加元数据
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}
```

### 1.3 关键日志事件

| 事件 | 级别 | 记录内容 |
|------|------|----------|
| debate.start | INFO | debateId, userId, aiCount, maxTurns |
| debate.turn_start | INFO | debateId, turnNumber, agentId |
| debate.turn_complete | INFO | debateId, turnNumber, duration, tokens |
| debate.consensus | INFO | debateId, solutionId, score |
| debate.complete | INFO | debateId, totalTurns, reason |
| debate.error | ERROR | debateId, error, turnNumber |
| api.request | DEBUG | method, path, userId |
| api.response | DEBUG | status, duration |
| quota.exceeded | WARN | userId, limit, used |
| payment.success | INFO | userId, amount, plan |

### 1.4 日志实现示例

```typescript
// 使用 Pino 或 Winston
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// 使用示例
logger.info({
  action: 'debate.start',
  correlationId: debateId,
  userId,
  aiCount: agents.length,
  maxTurns,
}, 'Debate started');

// 错误日志
logger.error({
  action: 'debate.turn_failed',
  correlationId: debateId,
  error: {
    message: err.message,
    stack: err.stack,
    code: err.code,
  },
}, 'Debate turn failed');
```

---

## 2. 性能监控

### 2.1 核心指标

| 指标 | 类型 | 说明 |
|------|------|------|
| `api.request.duration` | Histogram | API 请求耗时 |
| `api.request.count` | Counter | API 请求数 |
| `debate.turn.duration` | Histogram | 单轮发言耗时 |
| `debate.total_duration` | Histogram | 辩论总时长 |
| `ai.api.duration` | Histogram | AI API 调用耗时 |
| `ai.token.usage` | Counter | Token 消耗量 |
| `db.query.duration` | Histogram | 数据库查询耗时 |
| `queue.job.duration` | Histogram | 队列任务耗时 |
| `quota.usage_percent` | Gauge | 配额使用率 |

### 2.2 指标采集

```typescript
// 使用 Prometheus 客户端
import { Counter, Histogram, Gauge } from 'prom-client';

// Token 消耗计数器
const tokenUsage = new Counter({
  name: 'ai_token_usage_total',
  help: 'Total tokens used',
  labelNames: ['provider', 'model', 'type'], // input/output
});

// 单轮耗时直方图
const turnDuration = new Histogram({
  name: 'debate_turn_duration_seconds',
  help: 'Time spent per debate turn',
  labelNames: ['provider'],
  buckets: [1, 5, 10, 30, 60],
});

// 配额使用率
const quotaUsage = new Gauge({
  name: 'quota_usage_percent',
  help: 'Quota usage percentage',
  labelNames: ['user_id', 'type'], // daily/monthly
});
```

### 2.3 性能基线

| 指标 | 目标值 | 告警阈值 |
|------|--------|----------|
| API P50 耗时 | < 200ms | > 500ms |
| API P99 耗时 | < 1s | > 3s |
| AI API 耗时 | < 5s | > 30s |
| 单轮耗时 | < 10s | > 60s |
| DB 查询耗时 | < 50ms | > 500ms |

---

## 3. 分布式追踪

### 3.1 追踪上下文

```typescript
interface TraceContext {
  traceId: string;        // 全局追踪 ID
  spanId: string;         // 当前 Span ID
  parentSpanId?: string;  // 父 Span ID
  baggage: Record<string, string>;  // 传递数据
}

// 辩论追踪示例
{
  traceId: "debate-abc123",
  spans: [
    { spanId: "span-1", name: "POST /api/debates", duration: 150 },
    { spanId: "span-2", parentSpanId: "span-1", name: "db.insert", duration: 25 },
    { spanId: "span-3", parentSpanId: "span-1", name: "queue.add", duration: 10 },
  ]
}
```

### 3.2 集成 OpenTelemetry

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new JaegerExporter({
    serviceName: 'ai-debate-platform',
  }))
);
provider.register();
```

---

## 4. 错误追踪

### 4.1 错误分类

| 类型 | 代码 | 处理方式 |
|------|------|----------|
| 用户错误 | USER_ERROR | 返回 4xx，不告警 |
| 业务错误 | BIZ_ERROR | 返回 4xx，记录日志 |
| 系统错误 | SYS_ERROR | 返回 5xx，告警 |
| 第三方错误 | EXTERNAL_ERROR | 重试或降级 |

### 4.2 错误上报

```typescript
// 集成 Sentry
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,  // 10% 采样
});

// 错误上报
try {
  await processDebateTurn(debateId);
} catch (error) {
  Sentry.captureException(error, {
    tags: { debateId, turnNumber },
    extra: { agentId, provider },
  });
  throw error;
}
```

### 4.3 错误聚合

| 聚合维度 | 说明 |
|----------|------|
| 错误类型 | TypeError, TimeoutError, APIError |
| 错误位置 | 文件：行号 |
| 影响用户 | 错误影响的用户数 |
| 发生频率 | 单位时间内发生次数 |

---

## 5. 告警系统

### 5.1 告警规则

```yaml
# Prometheus AlertManager 配置
groups:
  - name: debate-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(api_error_total[5m]) > 0.05
        for: 2m
        annotations:
          summary: "API 错误率超过 5%"

      - alert: HighLatency
        expr: histogram_quantile(0.99, rate(api_request_duration[5m])) > 3
        for: 5m
        annotations:
          summary: "P99 延迟超过 3 秒"

      - alert: QueueBacklog
        expr: bull_queue_size > 100
        for: 5m
        annotations:
          summary: "队列积压超过 100"

      - alert: DebatesStuck
        expr: debate_last_heartbeat_timestamp < time() - 300
        annotations:
          summary: "辩论任务停滞超过 5 分钟"
```

### 5.2 告警通知渠道

| 级别 | 渠道 | 响应时间 |
|------|------|----------|
| P0 (FATAL) | 电话 + Slack | 立即 |
| P1 (ERROR) | Slack + 邮件 | 30 分钟 |
| P2 (WARN) | Slack | 4 小时 |
| P3 (INFO) | 仪表板 | - |

### 5.3 告警收敛

```yaml
# 避免告警风暴
group_wait: 30s     # 等待 30 秒聚合告警
group_interval: 5m  # 每 5 分钟发送一次
repeat_interval: 4h # 4 小时后重复通知
```

---

## 6. 仪表板

### 6.1 运营仪表板

**业务指标**：
- 活跃辩论数（今日/本周/本月）
- 新增用户数
- Token 消耗趋势
- 平均辩论轮数
- 共识达成率

### 6.2 技术仪表板

**系统健康度**：
- API 可用性
- 队列积压情况
- 数据库连接池
- Redis 内存使用
- 错误率趋势

### 6.3 Grafana 面板示例

```json
{
  "dashboard": {
    "title": "AI Debate Platform",
    "panels": [
      {
        "title": "Requests per Second",
        "targets": [{"expr": "rate(api_request_total[1m])"}]
      },
      {
        "title": "Error Rate",
        "targets": [{"expr": "rate(api_error_total[1m]) / rate(api_request_total[1m])"}]
      },
      {
        "title": "Debate Turns",
        "targets": [{"expr": "rate(debate_turn_total[1m])"}]
      },
      {
        "title": "Token Usage by Provider",
        "targets": [{"expr": "sum by (provider) (rate(ai_token_usage_total[1h]))"}]
      }
    ]
  }
}
```

---

## 7. 健康检查

### 7.1 健康端点

```typescript
// GET /api/health
async function healthCheck() {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    aiProviders: await checkAIProviders(),
  };

  const status = Object.values(checks).every(c => c.ok) ? 'healthy' : 'unhealthy';

  return { status, timestamp: new Date(), checks };
}
```

### 7.2 深度检查

```typescript
// 定期执行深度健康检查
async function deepHealthCheck() {
  // 测试数据库写入
  await db.health_check.create({ data: { id: 'test' } });
  await db.health_check.delete({ where: { id: 'test' } });

  // 测试 AI API 连通性
  await Promise.all(
    providers.map(p => p.validateConnection())
  );

  // 测试 Redis
  await redis.ping();

  return { status: 'healthy' };
}
```

---

## 8. 推荐工具栈

| 类别 | 推荐工具 | 备选 |
|------|----------|------|
| 日志 | Pino + Loki | Winston + ELK |
| 指标 | Prometheus + Grafana | DataDog |
| 追踪 | Jaeger | Zipkin, Tempo |
| 错误 | Sentry | Bugsnag, Rollbar |
| 告警 | AlertManager | PagerDuty |
| 仪表板 | Grafana | Kibana |

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-03-06 | 初始可观测性设计 |
