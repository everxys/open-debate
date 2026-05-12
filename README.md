# Open Debate

Open Debate 是一个基于 Next.js、PostgreSQL 和后台 worker 的多代理 AI 辩论应用。

## 环境要求

- Node.js 22
- npm
- PostgreSQL 18 或兼容版本
- Docker / Docker Compose：仅 Docker 部署需要

## 环境变量

复制示例文件后按实际环境修改：

```bash
cp .env.example .env
```

必填变量：

- `DATABASE_URL`：非 Docker 本地/生产启动时使用的 PostgreSQL 连接串。
- `APP_URL`：应用对外访问地址，本地通常是 `http://localhost:3000`，生产应是 `https://your-domain.com`。
- `SESSION_SECRET`：会话签名密钥，生产必须使用强随机值。
- `ENCRYPTION_KEY`：敏感信息加密密钥，生产必须使用强随机值。
- `POSTGRES_PASSWORD`：Docker Compose 部署时使用的数据库密码。
- `APP_DOMAIN`：Docker Compose + Caddy 自动 HTTPS 使用的域名。

生成随机密钥示例：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

如果服务器只有 Docker，也可以用：

```bash
docker run --rm node:22-bookworm-slim node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 本地开发启动

本地开发需要一个可连接的 PostgreSQL，并且 `.env` 中的 `DATABASE_URL` 指向它。

可选：用 Docker 临时启动本地 PostgreSQL：

```bash
docker run --name open-debate-postgres \
  -e POSTGRES_DB=open_debate \
  -e POSTGRES_USER=open_debate \
  -e POSTGRES_PASSWORD=open_debate \
  -p 5432:5432 \
  -d postgres:18-alpine
```

安装依赖并启动：

```bash
npm ci
npm run dev
```

`npm run dev` 会先执行数据库迁移，然后同时启动 Next.js dev server 和 summary worker。默认访问：

```text
http://localhost:3000
```

不要并行保留多套旧 dev 进程；本仓库统一用 `npm run dev` 拉起开发环境。

## 非 Docker 生产启动

适合已经有 Node.js 22、npm 和 PostgreSQL 的服务器。

1. 准备 `.env`：

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/open_debate
APP_URL=https://your-domain.com
SESSION_SECRET=replace-with-a-strong-random-secret
ENCRYPTION_KEY=replace-with-a-strong-random-secret
```

2. 安装依赖、构建并启动：

```bash
npm ci
npm run build
npm start
```

`npm start` 会检查 `.next` 构建产物，执行数据库迁移，然后运行 `next start`。

建议在生产环境用进程管理器或 systemd 管理 `npm start`，并在前面放置 Nginx、Caddy 或其他 HTTPS 反向代理。

## Docker Compose 生产部署

适合新服务器只有 Docker / Docker Compose 的单机部署。Compose 会启动：

- `caddy`：对外暴露 `80/443`，自动申请和续期 HTTPS 证书。
- `app`：运行 Open Debate，只在 Compose 内部网络暴露 `3000`。
- `postgres`：只在 Compose 内部网络访问，不映射宿主机端口。

部署前要求：

- 域名 A/AAAA 记录已经指向服务器公网 IP。
- 服务器防火墙允许 `80` 和 `443`。
- `.env` 中已设置生产变量。

示例 `.env`：

```env
APP_DOMAIN=your-domain.com
APP_URL=https://your-domain.com
POSTGRES_PASSWORD=replace-with-a-strong-random-password
SESSION_SECRET=replace-with-a-strong-random-secret
ENCRYPTION_KEY=replace-with-a-strong-random-secret
```

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f caddy
```

停止：

```bash
docker compose down
```

停止并删除数据库与 Caddy 持久化数据：

```bash
docker compose down -v
```

## 数据库维护

Docker Compose 部署中，PostgreSQL 不对宿主机暴露端口。进入数据库：

```bash
docker compose exec postgres psql -U open_debate -d open_debate
```

手动执行迁移：

```bash
npm run db:migrate
```

检查迁移状态：

```bash
npm run db:migrate:check
```

Docker Compose 部署时，应用启动会自动执行迁移。

## 常用检查

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

Docker Compose 静态配置检查：

```bash
docker compose config
```

当前 Compose 设计只应对外暴露 Caddy 的 `80/443`，不应暴露 PostgreSQL 的 `5432` 或应用的 `3000`。
