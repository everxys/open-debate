# Tech Stack

本文档只记录可复用的技术栈选择，不包含具体业务、领域模型、项目目录或产品功能说明，可直接复制给其他项目作为参考。

## 基础运行环境

- Node.js 22
- npm
- TypeScript 5.8
- tsx：运行 TypeScript 脚本、迁移脚本和后台任务

## Web 应用

- Next.js 15.5
- React 19
- React DOM 19
- Next.js App Router
- Next.js Route Handlers
- Next.js Middleware
- Server-Sent Events：用于服务端到浏览器的实时状态推送

## 样式与 UI

- 原生 CSS
- 自研基础 UI 组件
- Monaco Editor：代码、文本或文件编辑器场景
- react-arborist：树形结构、文件树或层级列表
- framer-motion：局部动效

## 后端与数据层

- PostgreSQL 18
- Kysely：类型安全 SQL 查询构建
- node-postgres `pg`：PostgreSQL 连接池、底层查询、通知监听和脚本访问
- SQL migrations：用独立 SQL 文件管理数据库结构变更
- PostgreSQL LISTEN/NOTIFY：用于数据库驱动的任务唤醒或事件通知

## 后台任务

- Node.js worker process
- tsx 运行 TypeScript worker
- 数据库表记录任务状态、重试次数、锁定信息和执行结果
- PostgreSQL 通知机制唤醒 worker

## AI Provider 集成

- OpenAI-compatible Chat Completions API
- Anthropic Messages API
- OpenRouter model catalog
- 流式输出处理
- Usage / token 用量统计
- Provider 请求限额与等待调度

## 认证、安全与校验

- jose：JWT 签发和校验
- Cookie-based session
- Node crypto / scrypt：密码哈希
- Zod：API 输入校验
- 邮件验证码：支持控制台调试模式和第三方邮件服务发送模式

## 测试与质量

- Node.js built-in test runner
- ESLint
- eslint-config-next
- TypeScript strict mode
- 构建阶段不忽略 TypeScript 或 ESLint 错误
- npm scripts 统一封装开发、构建、迁移、测试和校验命令

## 部署与本地环境

- Docker multi-stage build
- Docker 生产镜像只安装 production dependencies
- Docker 运行阶段使用非 root 用户
- docker-compose
- docker-compose 中的敏感应用密钥通过环境变量注入
- 应用服务 + PostgreSQL 服务
- 启动时执行必要的数据库迁移检查
