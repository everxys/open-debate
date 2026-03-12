# AI 辩论场 - 测试策略

## 概述

测试策略以 `V1.0 MVP` 为基线。测试重点是辩论主链路、权限边界、结构化降级和实时更新，不为尚未进入 MVP 的高级共识/动态加入/用户干预编写主测试面。

---

## 测试优先级

1. 创建并运行一场辩论
2. 辩论状态流转：`pending -> running -> paused -> running -> completed/stopped/failed`
3. AI 调用失败重试与最终失败处理
4. 结构化 JSON 解析失败后的降级保底
5. 用户数据隔离与 RLS
6. 实时订阅能看到新发言和状态更新

---

## 测试金字塔

```
        /\ 
       /  \      E2E (10%)
      /----\     关键主流程
     /      \
    /--------\  集成测试 (30%)
   /          \ API / 数据库 / 实时流
  /------------\
 /              \ 单元测试 (60%)
/----------------\ 校验 / 状态机 / 共识简化逻辑 / 解析逻辑
```

---

## 工具栈

| 类型 | 工具 |
|------|------|
| 单元测试 | Vitest |
| 组件测试 | React Testing Library |
| 集成测试 | Vitest |
| E2E | Playwright |
| Mock | MSW |

注：如果项目最终使用 Next.js Route Handlers，集成测试应围绕 handler 和 service 层，不再假定 Express + Supertest。

---

## 单元测试

### 必测模块

- 输入校验
- 辩论状态机
- 当前轮次/当前发言者选择逻辑
- AI 响应结构化解析
- 解析失败降级
- 简化共识计算
- token 预算判定

### 示例：配置校验

```typescript
import { describe, it, expect } from 'vitest';
import { validateDebateConfig } from '../validation';

describe('validateDebateConfig', () => {
  it('accepts a valid config', () => {
    const result = validateDebateConfig({
      question: '人工智能是否应该拥有法律人格？',
      agentIds: ['a1', 'a2'],
      maxTurns: 10,
    });

    expect(result.valid).toBe(true);
  });

  it('rejects fewer than 2 agents', () => {
    const result = validateDebateConfig({
      question: '测试问题，长度足够',
      agentIds: ['a1'],
      maxTurns: 10,
    });

    expect(result.valid).toBe(false);
  });
});
```

### 示例：结构化降级

```typescript
import { describe, it, expect } from 'vitest';
import { parseAgentResponse } from '../parser';

describe('parseAgentResponse', () => {
  it('falls back to raw content when JSON is invalid', () => {
    const result = parseAgentResponse('not-json');

    expect(result.parseStatus).toBe('fallback');
    expect(result.rawContent).toBe('not-json');
  });
});
```

---

## 组件测试

### 必测组件

- 创建辩论表单
- AI 配置表单
- 控制台状态区
- 发言卡片
- 连接状态提示

### 重点断言

- 根据状态显示正确按钮
- 发言流追加时 UI 能更新
- 解析失败时显示保底提示
- 用户不能在运行态编辑不允许变更的字段

---

## 集成测试

### 必测接口

- `POST /api/agents`
- `PATCH /api/agents/:id`
- `POST /api/debates`
- `POST /api/debates/:id/start`
- `POST /api/debates/:id/pause`
- `POST /api/debates/:id/resume`
- `POST /api/debates/:id/stop`
- `GET /api/debates/:id`
- `GET /api/debates/:id/turns`

### 必测场景

- 认证用户可操作自己的资源
- 不能访问别人的 agent / debate
- 创建辩论时校验 agent 数量与归属
- 开始辩论后正确创建首轮任务
- 单轮失败时重试不超过 2 次
- token 超预算时状态自动结束

---

## E2E

### 仅保留 3 个核心场景

1. 注册/登录后创建并启动一场辩论
2. 在控制台看到实时发言，并执行暂停/恢复
3. 辩论结束后进入结果页并导出 Markdown

### 不在 MVP E2E 中覆盖

- 动态加入 AI
- 用户投票
- 裁判 AI
- 方案融合

---

## 安全与权限测试

- 未认证访问受保护接口返回 `401`
- 越权访问他人资源返回 `403/404`
- RLS 阻止直接读取其他用户记录
- 响应中不返回明文 API Key
- 日志中不出现敏感字段

---

## 覆盖率目标

| 模块 | 行覆盖率 |
|------|----------|
| 核心辩论流程 | > 80% |
| 校验与解析 | > 85% |
| API 层 | > 70% |
| UI 关键组件 | > 60% |

覆盖率目标服务于 MVP 节奏，不单独为了数字增加低价值测试。

---

## CI 建议

- PR 必跑：lint、unit、integration
- 合并前必跑：build、核心 E2E
- 定时任务：依赖审计、安全扫描

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 调整为 MVP 测试基线，移除超前场景与错误技术假设 |
| 1.0 | 2026-03-06 | 初始测试策略 |
