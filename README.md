# Open Debate V1

V1 MVP scaffold for a multi-agent AI debate app built with Next.js.

## Included

- Agent management
- Debate creation
- Start / pause / resume / stop
- Turn-by-turn runtime
- Simple consensus shortcut
- Docker Compose deployment
- Local session auth
- Dockerized Postgres

## Run

```bash
docker compose up --build
```

Open `http://localhost:3000`.

## Environment

For local non-Docker development, copy `.env.example` to `.env.local`.

Required:

- `DATABASE_URL`
- `APP_URL`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`

## Database

Docker Compose will initialize Postgres with [docker/init.sql](/c:/Users/Administrator/dev/open-debate/docker/init.sql).

Services:

- `app`
- `postgres`

## Agent fields

The V1 agent config now requires:

- `model`
- `baseUrl`
- `apiKey`

`temperature` and `maxTokens` were removed.
