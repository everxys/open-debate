# AI 辩论场 - 部署指南

## 概述

本项目默认使用本地/容器内 PostgreSQL（Postgres 18），通过 `DATABASE_URL` 连接数据库；认证与会话由应用自身实现，不依赖 Supabase。

## 环境要求

- Node.js v18+
- PostgreSQL 18（推荐用 Docker Compose 启动）

## 本地开发（推荐：本地 Postgres 18）

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

```bash
cp .env.example .env.local
```

按需修改 `.env.local`（见下方“环境变量清单”）。

### 3) 启动数据库

```bash
docker compose up -d postgres
```

首次启动会自动执行 `docker/init.sql` 初始化表结构。

### 4) 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 本地部署（长期运行）

推荐直接用 Docker Compose 在一台机器上常驻运行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

更新代码后重新构建：

```bash
docker compose up -d --build
```

如果你需要公网访问，建议在前面加一层反向代理（Nginx/Caddy），并配置 HTTPS。

## 环境变量清单

### 必需变量

| 变量名 | 说明 | 示例 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgres://user:pass@host:5432/db` |
| `APP_URL` | 应用对外访问地址 | `http://localhost:3000` |
| `SESSION_SECRET` | Session 签名密钥 | 长随机字符串 |
| `ENCRYPTION_KEY` | 加密敏感字段（生产环境必填；开发环境未配置时才允许使用内置 fallback） | `0123...` |

### 可选变量

| 变量名 | 说明 |
|---|---|
| `OPENAI_API_KEY` | OpenAI API Key |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `LOG_LEVEL` | `info` / `debug` 等 |
| `SENTRY_DSN` | Sentry DSN |
| `NEXT_PUBLIC_SITE_URL` | 站点 URL |
| `MAX_CONCURRENT_DEBATES` | 最大并发辩论数 |
| `EMAIL_DELIVERY` | 验证码邮件投递方式：`console` / `sendcloud` |
| `SENDCLOUD_API_USER` | SendCloud API User（当 `EMAIL_DELIVERY=sendcloud`） |
| `SENDCLOUD_API_KEY` | SendCloud API Key（当 `EMAIL_DELIVERY=sendcloud`） |
| `SENDCLOUD_FROM` | 发信人地址（当 `EMAIL_DELIVERY=sendcloud`） |

## 故障排查

### AI 配置测试返回 502（/api/agents/test-config）

这通常表示服务端已收到请求，但在访问上游模型服务时失败（例如 Key/URL/模型名不对，或网络不可达）。

检查项：
- `Base URL`：建议填写到版本前缀，例如 OpenAI `https://api.openai.com/v1`、Anthropic `https://api.anthropic.com/v1`（如果只填到域名根路径，服务端会在 404 时自动重试追加 `/v1`）。
- `API Key`：确认是对应 Provider 的有效 Key，且没有多余空格/换行。
- `模型名`：连通性测试会实际发起一次请求（OpenAI 走 `POST /chat/completions`，Anthropic 走 `POST /messages`），模型名不正确会直接报错。

### 数据库连接失败

```bash
echo $DATABASE_URL
psql $DATABASE_URL -c "select 1;"
docker compose ps
```

常见原因：
- 数据库未启动或端口被占用
- `DATABASE_URL` 用户名/密码/host/端口错误
- 生产环境未放通入站连接

### 验证码邮件发不出去（SendCloud）

检查项：
- `.env.local` / 运行环境变量里是否已设置：`EMAIL_DELIVERY=sendcloud`、`SENDCLOUD_API_USER`、`SENDCLOUD_API_KEY`、`SENDCLOUD_FROM`
- 域名是否已按 SendCloud 要求完成 SPF/DKIM 等校验（DNS 生效可能需要一段时间）
