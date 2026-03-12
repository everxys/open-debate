# AI 辩论场 - 用户流程图

## 概述

本文档使用 Mermaid 流程图描述用户与系统的交互流程，包括核心流程和分支流程。

---

## 1. 核心用户旅程

### 1.1 完整用户流程概览

```mermaid
flowchart TD
    A[访问网站] --> B{已登录？}
    B -->|否 | C[注册/登录]
    B -->|是 | D[进入 Dashboard]
    C --> D
    D --> E[创建/选择 AI 配置]
    E --> F[创建辩论]
    F --> G[开始辩论]
    G --> H[实时监控]
    H --> I{辩论结束？}
    I -->|否 | H
    I -->|是 | J[查看结果]
    J --> K[导出/分享]
    K --> L[返回 Dashboard]
```

---

## 2. 认证流程

### 2.1 注册流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant F as 前端
    participant A as API
    participant S as Supabase
    participant E as 邮件服务

    U->>F: 访问注册页面
    F->>U: 显示注册表单
    U->>F: 输入邮箱/密码
    F->>F: 前端验证
    F->>A: POST /api/auth/signup
    A->>S: 创建用户
    S->>E: 发送验证邮件
    S-->>A: 用户创建成功
    A-->>F: 返回用户信息
    F->>U: 显示验证邮件提示
    U->>E: 点击验证链接
    E->>S: 验证用户
    S->>F: 跳转到 Dashboard
```

### 2.2 登录流程

```mermaid
flowchart TD
    Start([开始]) --> Input[输入邮箱/密码]
    Input --> Validate{前端验证}
    Validate -->|失败 | ShowError[显示错误信息]
    ShowError --> Input
    Validate -->|成功 | API[调用登录 API]
    API --> Check{验证凭据}
    Check -->|失败 | APIError[显示登录失败]
    APIError --> Input
    Check -->|成功 | StoreToken[存储 JWT Token]
    StoreToken --> Redirect[跳转到 Dashboard]
    Redirect --> End([结束])
```

---

## 3. AI 配置管理流程

### 3.1 创建 AI 配置

```mermaid
flowchart TD
    Start([开始]) --> Click[点击新建配置]
    Click --> Form[显示配置表单]
    Form --> Fill[填写配置信息]
    Fill --> Test{测试连接？}
    Test -->|是 | TestAPI[调用测试 API]
    TestAPI --> TestResult{测试成功？}
    TestResult -->|否 | ShowTestError[显示测试错误]
    ShowTestError --> Fill
    TestResult -->|是 | Submit[提交配置]
    Test -->|否 | Submit
    Submit --> API[调用创建 API]
    API --> Result{创建成功？}
    Result -->|否 | ShowError[显示错误]
    ShowError --> Form
    Result -->|是 | Success[显示成功]
    Success --> List[返回配置列表]
    List --> End([结束])
```

### 3.2 AI 配置管理

```mermaid
flowchart LR
    A[配置列表] --> B{选择操作}
    B -->|编辑 | C[编辑配置]
    B -->|删除 | D[确认删除]
    B -->|复制 | E[创建副本]
    B -->|测试 | F[测试连接]
    C --> G[保存变更]
    D --> H{确认？}
    H -->|是 | I[删除配置]
    H -->|否 | A
    E --> J[编辑新配置]
    F --> K[显示结果]
    G --> A
    I --> A
    J --> C
    K --> A
```

---

## 4. 辩论创建与运行流程

### 4.1 创建辩论

```mermaid
sequenceDiagram
    participant U as 用户
    participant F as 前端
    participant A as API
    participant Q as 队列
    participant DB as 数据库

    U->>F: 点击新建辩论
    F->>U: 显示配置向导
    U->>F: 步骤 1: 输入问题
    F->>F: 验证问题长度
    U->>F: 步骤 2: 选择 AI
    F->>F: 验证 AI 数量≥2
    U->>F: 步骤 3: 配置参数
    F->>A: POST /api/debates
    A->>A: 验证配置
    A->>DB: 创建辩论记录
    A->>DB: 创建关联记录
    A->>Q: 加入待处理队列
    DB-->>A: 返回辩论 ID
    A-->>F: 返回辩论详情
    F->>U: 跳转到控制台
```

### 4.2 辩论运行流程

```mermaid
flowchart TD
    Start([辩论开始]) --> CheckQuota{检查配额}
    CheckQuota -->|不足 | StopError[停止并提示]
    CheckQuota -->|充足 | UpdateStatus[更新状态为 running]
    UpdateStatus --> Loop{循环开始}
    Loop --> GetNext{获取下一个 AI}
    GetNext -->|无更多 | CheckConsensus{检查共识}
    GetNext -->|有 | CallAI[调用 AI API]
    CallAI --> ParseResponse[解析响应]
    ParseResponse --> Success{解析成功？}
    Success -->|否 | Retry{重试次数<3?}
    Retry -->|是 | CallAI
    Retry -->|否 | SkipAI[跳过该 AI]
    SkipAI --> GetNext
    Success -->|是 | StoreTurn[存储发言记录]
    StoreTurn --> UpdateScore[更新方案得分]
    UpdateScore --> PushRealtime[推送实时更新]
    PushRealtime --> CheckMaxTurns{达到最大轮数？}
    CheckMaxTurns -->|是 | EndDebate[结束辩论]
    CheckMaxTurns -->|否 | Loop
    CheckConsensus -->|达成共识 | ConfirmConsensus[共识确认]
    CheckConsensus -->|未达成 | EndDebate
    ConfirmConsensus --> EndDebate
    EndDebate --> UpdateFinal[更新最终状态]
    UpdateFinal --> Notify[发送通知]
    Notify --> End([结束])
```

---

## 5. 实时监控流程

### 5.1 前端实时订阅

```mermaid
sequenceDiagram
    participant F as 前端
    participant S as Supabase Realtime
    participant DB as 数据库
    participant U as 用户

    F->>S: 订阅 debate_turns
    S->>DB: 建立监听
    DB-->>S: 新记录插入
    S->>F: 推送事件
    F->>F: 更新 UI 状态
    F->>U: 显示新发言
    F->>F: 自动滚动到底部
    F->>S: 心跳检测
    S-->>F: 连接状态
```

### 5.2 用户控制流程

```mermaid
flowchart TD
    A[辩论运行中] --> B{用户操作}
    B -->|暂停 | C[点击暂停按钮]
    B -->|停止 | D[点击停止按钮]
    B -->|加入 AI | E[点击添加 AI]
    B -->|干预 | F[打开干预面板]

    C --> G[发送暂停请求]
    G --> H[更新状态为 paused]
    H --> I[显示暂停界面]

    D --> J[发送停止请求]
    J --> K[更新状态为 stopped]
    K --> L[显示停止确认]

    E --> M[打开 AI 选择面板]
    M --> N[选择 AI 配置]
    N --> O[发送到队列]
    O --> P[显示加入动画]

    F --> Q[选择干预类型]
    Q --> R[执行干预]
    R --> S[显示干预结果]
```

---

## 6. 结果展示流程

### 6.1 辩论完成处理

```mermaid
flowchart TD
    Start([辩论完成]) --> DetermineWinner{确定获胜方案}
    DetermineWinner --> HasConsensus{有共识？}
    HasConsensus -->|是 | ShowConsensus[显示共识方案]
    HasConsensus -->|否 | ShowTopScore[显示最高分方案]
    ShowConsensus --> GenerateReport[生成结果报告]
    ShowTopScore --> GenerateReport
    GenerateReport --> UpdateUI[更新 UI 状态]
    UpdateUI --> ShowChart[渲染得分图表]
    ShowChart --> ShowHistory[渲染发言历史]
    ShowHistory --> EnableExport[启用导出功能]
    EnableExport --> End([结束])
```

### 6.2 导出流程

```mermaid
flowchart LR
    A[点击导出] --> B{选择格式}
    B -->|Markdown | C[生成 Markdown]
    B -->|JSON | D[生成 JSON]
    C --> E[下载文件]
    D --> E
    E --> F[导出完成]
```

---

## 7. 异常处理流程

### 7.1 错误处理流程

```mermaid
flowchart TD
    Error[错误发生] --> Classify{错误类型}
    Classify -->|网络错误 | NetworkError[显示网络错误提示]
    Classify -->|认证错误 | AuthError[跳转到登录页]
    Classify -->|配额错误 | QuotaError[显示配额不足]
    Classify -->|AI API 错误 | AIAPIError[显示 AI 服务不可用]
    Classify -->|未知错误 | UnknownError[显示通用错误]

    NetworkError --> Action{用户操作}
    AuthError --> Login[重新登录]
    QuotaError --> Upgrade[升级配额或等待]
    AIAPIError --> RetryAction{重试？}
    UnknownError --> ReportAction{报告问题？}

    RetryAction -->|是 | Retry[重试请求]
    RetryAction -->|否 | Cancel[取消操作]
    ReportAction -->|是 | Report[提交错误报告]
    ReportAction -->|否 | Dismiss[关闭提示]

    Retry --> CheckResult{成功？}
    CheckResult -->|是 | Success[恢复正常]
    CheckResult -->|否 | ShowPersistentError[显示持续错误]
```

### 7.2 断线重连流程

```mermaid
sequenceDiagram
    participant F as 前端
    participant S as Supabase Realtime
    participant B as 后端服务

    F->>S: 订阅频道
    S-->>F: 连接建立
    Note over F,S: 正常运行中
    S->>F: 连接断开事件
    F->>F: 标记为断开状态
    F->>F: 启动重连计时器
    Note over F: 指数退避
    F->>S: 尝试重连 (1)
    S-->>F: 失败
    F->>F: 等待 2 秒
    F->>S: 尝试重连 (2)
    S-->>F: 失败
    F->>F: 等待 4 秒
    F->>S: 尝试重连 (3)
    S-->>F: 成功
    F->>B: 同步错过的事件
    B-->>F: 返回错过的数据
    F->>F: 更新 UI
    Note over F,S: 恢复正常
```

---

## 8. 配额管理流程

### 8.1 配额检查流程

```mermaid
flowchart TD
    Start([操作请求]) --> GetQuota[获取用户配额]
    GetQuota --> CheckDaily{检查日配额}
    CheckDaily -->|超出 | DailyError[显示日配额不足]
    CheckDaily -->|充足 | CheckMonthly{检查月配额}
    CheckMonthly -->|超出 | MonthlyError[显示月配额不足]
    CheckMonthly -->|充足 | CheckConcurrent{检查并发数}
    CheckConcurrent -->|超出 | ConcurrentError[显示并发数不足]
    CheckConcurrent -->|充足 | Allow[允许操作]

    DailyError --> End([拒绝])
    MonthlyError --> End
    ConcurrentError --> End
    Allow --> Execute[执行操作]
    Execute --> UpdateQuota[更新配额使用]
    UpdateQuota --> End
```

---

## 9. 状态机图

### 9.1 辩论状态机

```mermaid
stateDiagram-v2
    [*] --> Pending: 创建辩论
    Pending --> Running: 开始辩论
    Pending --> Stopped: 用户取消
    Running --> Paused: 用户暂停
    Running --> Completed: 达成共识
    Running --> Completed: 达到最大轮数
    Running --> Stopped: 用户停止
    Running --> Failed: 发生错误
    Paused --> Running: 用户恢复
    Paused --> Stopped: 用户停止
    Failed --> Running: 重试成功
    Failed --> Stopped: 放弃重试
    Completed --> [*]
    Stopped --> [*]
    Failed --> [*]
```

### 9.2 用户会话状态机

```mermaid
stateDiagram-v2
    [*] --> Unauthenticated: 未登录
    Unauthenticated --> Authenticating: 开始登录
    Authenticating --> Authenticated: 登录成功
    Authenticating --> Unauthenticated: 登录失败
    Authenticated --> Unauthenticated: 登出
    Authenticated --> Unauthenticated: Token 过期
    Authenticated --> Authenticating: Token 刷新
```

---

## 10. 数据流图

### 10.1 核心数据流

```mermaid
flowchart TB
    subgraph 用户端
        U[用户操作]
        F[前端界面]
    end

    subgraph API 层
        API[API 路由]
        Auth[认证中间件]
        Val[验证中间件]
    end

    subgraph 业务层
        Engine[辩论引擎]
        Queue[队列处理器]
    end

    subgraph 数据层
        DB[(Supabase)]
        Redis[(Redis)]
    end

    U --> F
    F --> API
    API --> Auth
    Auth --> Val
    Val --> Engine
    Engine --> Queue
    Queue --> DB
    Queue --> Redis
    DB -.-> F
    Redis -.-> Queue
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-03-06 | 初始用户流程图 |
