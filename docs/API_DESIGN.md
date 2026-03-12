# AI 辩论场 - API 详细设计

## 概述

本文档定义 `V1.0 MVP` 需要实现的 API。所有接口均围绕“认证、AI 配置、辩论创建、辩论运行、结果查看”五条主链路，不提前引入 V2 功能接口。

---

## 基础约定

### 基础路径

```
/api
```

### 认证

- 使用应用自己的邮箱密码认证
- 登录成功后写入 HttpOnly session cookie
- 服务端从 session cookie 解析当前用户

### 统一响应

```json
{
  "success": true,
  "data": {}
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "参数校验失败"
  }
}
```

---

## 错误码

| 错误码 | HTTP | 说明 |
|--------|------|------|
| `AUTH_REQUIRED` | 401 | 未登录 |
| `AUTH_INVALID` | 401 | 账号或密码错误 |
| `FORBIDDEN` | 403 | 无权访问 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION_ERROR` | 400 | 参数错误 |
| `CONFLICT` | 409 | 状态冲突 |
| `RATE_LIMITED` | 429 | 请求过频 |
| `QUOTA_EXCEEDED` | 429 | 配额超限 |
| `AI_API_ERROR` | 502 | 上游 AI 失败 |
| `INTERNAL_ERROR` | 500 | 未知错误 |

---

## AI 配置接口

### POST /api/auth/signup

注册账号并写入 session。

### POST /api/auth/login

登录并写入 session。

### POST /api/auth/logout

退出登录并清理 session。

### GET /api/agents

返回当前用户的 AI 配置列表。

查询参数：

- `provider?`
- `search?`
- `page?`
- `pageSize?`

### POST /api/agents

创建 AI 配置。

请求体：

```json
{
  "name": "GPT-4 Analyst",
  "provider": "openai",
  "model": "gpt-4.1",
  "baseUrl": "https://api.openai.com/v1",
  "systemPrompt": "你是一个严谨的分析者",
  "apiKey": "sk-xxx"
}
```

规则：

- `provider` 仅支持 `openai | anthropic`
- `model` 必填
- `baseUrl` 必填且必须是有效 URL
- `apiKey` 必填

### PATCH /api/agents/:id

更新 AI 配置。`apiKey` 为可选，仅用户输入新值时更新。

### DELETE /api/agents/:id

删除 AI 配置。

### POST /api/agents/:id/test

测试该配置能否成功调用 provider。

---

## 辩论接口

### GET /api/debates

返回当前用户的辩论列表。

### POST /api/debates

创建辩论。

请求体：

```json
{
  "question": "人工智能是否应该拥有法律人格？",
  "agentIds": ["a1", "a2", "a3"],
  "maxTurns": 10,
  "tokenBudget": 30000
}
```

规则：

- `question`: 10-5000 字符
- `agentIds`: 2-5 个，且都属于当前用户
- `maxTurns`: 1-50

响应：

```json
{
  "success": true,
  "data": {
    "id": "debate_123",
    "status": "pending"
  }
}
```

### GET /api/debates/:id

返回辩论详情、参与者、统计信息。

### GET /api/debates/:id/turns

返回发言记录，支持分页。

查询参数：

- `page?`
- `pageSize?`
- `agentId?`

### POST /api/debates/:id/start

把辩论从 `pending` 置为 `running`，并触发执行。

### POST /api/debates/:id/pause

把辩论从 `running` 置为 `paused`。

### POST /api/debates/:id/resume

把辩论从 `paused` 置为 `running`。

### POST /api/debates/:id/stop

手动停止辩论。

---

## 实时更新

当前版本使用前端短轮询刷新辩论详情和发言记录，不依赖外部实时基础设施。

后续如果需要真正的实时推送，再引入 SSE 或 WebSocket。

---

## 明确不在 MVP 的接口

以下接口暂不设计，也不应出现在前端调用中：

- `/api/debates/:id/join`
- `/api/debates/:id/fuse`
- `/api/debates/:id/vote`
- `/api/debates/:id/weights`
- `/api/debates/:id/judge`
- `/api/quota`
- `/api/reports/cost`

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 收敛为 MVP API，去除 V2/V3 接口与 SSE 假设 |
| 1.0 | 2026-03-06 | 初始 API 设计 |
