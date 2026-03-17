# AI 辩论场 - API（当前实现）

本文档记录“代码中已实现”的 API 形态，避免与早期 MVP 设计文档产生偏差。

## 约定

- Base path：`/api`
- 认证：邮箱密码登录后写入 HttpOnly session cookie；服务端从 cookie 解析当前用户
- 成功响应：`{ "success": true, "data": ... }`
- 失败响应：`{ "success": false, "error": { "code": "...", "message": "..." } }`

### 常见错误码

- `AUTH_REQUIRED` / `AUTH_INVALID` / `FORBIDDEN` / `NOT_FOUND`
- `VALIDATION_ERROR` / `CONFLICT` / `RATE_LIMITED`
- `AI_API_ERROR` / `INTERNAL_ERROR`
- `MIGRATION_REQUIRED`：缺少数据库表/字段（需要执行 `docker/init.sql` 或升级已有数据卷）

## Auth

- `POST /api/auth/verification/send` 发送注册验证码
- `POST /api/auth/verification/verify`（如存在）校验验证码（当前注册流程主要在 signup 消费验证码）
- `POST /api/auth/signup` 注册（验证码必填）
- `POST /api/auth/login` 登录
- `POST /api/auth/logout` 登出
- `POST /api/auth/password` 修改密码（需登录）

## AI 配置（Agents）

- `GET /api/agents` 列表（当前用户）
- `POST /api/agents` 创建
- `GET /api/agents/{id}` 详情
- `PATCH /api/agents/{id}` 更新
- `DELETE /api/agents/{id}` 删除
- `POST /api/agents/test-config` 测试草稿配置
- `POST /api/agents/{id}/test` 测试已保存配置
- `POST /api/agents/{id}/duplicate` 复制 AI 配置（含文件）

### AI 文件管理（ai_agent_files）

- `GET /api/agents/{id}/files` 列表
- `POST /api/agents/{id}/files` 新建/保存（upsert）
- `PATCH /api/agents/{id}/files` 移动（rename/move path）
- `DELETE /api/agents/{id}/files` 删除

## 策略（Strategies）

- `GET /api/strategies?scope=mine|shared` 列表（我的/社区分享）
- `POST /api/strategies` 新建（含角色与初始文件）
- `GET /api/strategies/{id}` 详情（owner 或 shared 可见）
- `PATCH /api/strategies/{id}` 更新（仅 owner；支持保留 role id）
- `DELETE /api/strategies/{id}` 删除（仅 owner）

### 策略角色文件管理（strategy_role_files）

- `GET /api/strategies/{id}/roles/{roleId}/files` 列表
- `POST /api/strategies/{id}/roles/{roleId}/files` 新建/保存（upsert）
- `PATCH /api/strategies/{id}/roles/{roleId}/files` 移动
- `DELETE /api/strategies/{id}/roles/{roleId}/files` 删除

## 辩论（Debates）

- `GET /api/debates` 列表
- `POST /api/debates` 创建
- `GET /api/debates/{id}` 详情
- `GET /api/debates/{id}/turns` 发言列表
- `POST /api/debates/{id}/start` 开始
- `POST /api/debates/{id}/pause` 暂停
- `POST /api/debates/{id}/resume` 恢复
- `POST /api/debates/{id}/stop` 停止
- `POST /api/debates/{id}/agents` 追加参与者（运行中/暂停中）

### 创建辩论请求体（两种模式）

公共字段：

- `question: string`
- `maxTurns: number`（`0` 表示无限轮次，直到达成共识或用户停止）
- `enableSharedFacts?: boolean`（默认 `true`）

模式 1：直接选 AI（至少 2 个）

- `agentIds: string[]`

模式 2：使用策略（至少 2 个绑定）

```json
{
  "strategy": {
    "strategyId": "uuid",
    "bindings": [
      { "roleId": "uuid", "agentId": "uuid" }
    ]
  }
}
```
