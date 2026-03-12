# AI 辩论场 - UI 生成提示词模板

## 概述

本文档只覆盖 `V1.0 MVP` 的页面和组件提示词，避免把 V2.0 的动态加入、方案融合、用户干预等功能提前生成进界面。

---

## 基础约定

### 技术栈

```
- 框架：Next.js 14+ (App Router)
- 语言：TypeScript
- UI：shadcn/ui + Tailwind CSS
- 图标：lucide-react
- 状态管理：React Query + Zustand
- 实时更新：Supabase Realtime
```

### 设计方向

```
- 视觉：冷静、信息密度适中、偏工作台而非营销页
- 主色：blue / slate
- 圆角：rounded-lg
- 字体：遵循项目现有字体方案，不强绑定 Inter
- 暗色模式：V1 可不做，除非项目已经全局支持
```

---

## 页面生成提示词

### 1. 创建辩论页面

```
创建一个 AI 辩论配置页面，采用分步式向导，但不要过度复杂。

步骤 1：输入问题
- textarea
- placeholder：请输入要辩论的问题
- 显示字符计数
- 校验长度 10-5000

步骤 2：选择 AI
- 展示用户已保存的 AI 配置卡片
- 支持多选
- 至少选择 2 个，最多 5 个
- 支持拖拽或上下移动调整顺序

步骤 3：辩论参数
- 最大轮数输入或滑块，范围 1-50，默认 10
- token 预算输入框，可选
- 开始辩论按钮

UI 要求
- 桌面端为单页分区布局，移动端为分步堆叠
- 明确显示上一步 / 下一步 / 开始辩论
- 使用 shadcn/ui 组件
- 不出现 V2 功能字段，如共识阈值、投票、裁判 AI
```

---

### 2. 辩论控制台页面

```
创建辩论实时控制台页面。

布局：
- 左侧信息栏
  - 问题
  - 状态徽章
  - 当前轮次 / 最大轮数
  - token 已使用 / 预算
  - 参与者列表和当前发言者高亮
  - 操作按钮：暂停 / 恢复 / 停止

- 右侧主区域
  - 发言历史流
  - 每条发言显示 AI 名称、提供商、轮次、时间、内容
  - 支持 Markdown 渲染
  - 如果是流式中，显示进行中状态
  - 底部显示连接状态和自动滚动开关

实时功能：
- 使用 Supabase Realtime 订阅状态与发言
- 新发言自动滚动到底部
- 断线时显示明显提示

限制：
- 不要加入用户输入消息框
- 不要加入“添加 AI”“融合方案”“干预面板”等 V2 功能入口
```

---

### 3. 结果页

```
创建辩论结果页。

内容：
- 顶部显示问题标题
- 结果摘要卡片
  - 最终状态
  - 是否达成共识
  - 总轮数
  - 总耗时
  - 总 token

- 发言记录区
  - 按轮次显示
  - 支持按 AI 筛选
  - 支持关键词搜索

- 导出区
  - 导出 Markdown 按钮

可选轻量可视化：
- 只显示简单统计卡片或小型趋势图
- 不要求力导向图、复杂观点演化图、融合流程图
```

---

### 4. AI 配置管理页面

```
创建 AI 配置管理页面。

列表区：
- 卡片或表格展示 AI 配置
- 字段：名称、provider、model、baseUrl、最后更新时间
- 搜索与 provider 筛选
- 新建按钮

新建/编辑表单：
- 名称
- provider
- model
- baseUrl
- systemPrompt
- apiKey
- 测试连接按钮
- 保存按钮

限制：
- 不生成模板库
- 不生成批量导入导出
- 不生成角色预设库，除非只是一个普通文本 systemPrompt 示例
```

---

## 组件生成提示词

### 1. 发言卡片

```
创建一个辩论发言卡片组件。

Props
- agent: { name: string; provider: string }
- content: string
- structured?: {
    proposedSolution?: string
    arguments?: Array<{ type: 'support' | 'rebuttal'; content: string }>
  }
- turnNumber: number
- timestamp: string
- isStreaming?: boolean
- parseStatus?: 'ok' | 'fallback'

UI 要求
- 头部显示 AI 名称、provider、轮次、时间
- 内容区显示 Markdown
- 如果有结构化论据，单独展示 support / rebuttal 标签
- parseStatus=fallback 时显示“结构化解析失败，已保留原文”
```

---

### 2. 辩论状态徽章

```
创建辩论状态徽章组件。

Props
- status: 'pending' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed'

要求
- 每种状态都有清晰颜色与图标
- running 可有轻微脉冲动画
- 不要加入“点击复制状态文本”这类低价值交互
```

---

### 3. 参与者列表

```
创建控制台左侧的参与者列表组件。

Props
- agents: Array<{ id: string; name: string; provider: string; turnOrder: number; turnCount: number }>
- activeAgentId?: string

要求
- 当前发言者高亮
- 显示发言顺序
- 显示累计发言次数
```

---

## 响应式要求

```
sm: 640px
md: 768px
lg: 1024px
xl: 1280px
```

移动端优先保证：
- 可以完整创建辩论
- 可以查看实时发言
- 可以执行暂停 / 恢复 / 停止

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 收敛为 MVP UI 范围，移除 V2 界面 |
| 1.0 | 2026-03-06 | 初始 UI 提示词模板 |
