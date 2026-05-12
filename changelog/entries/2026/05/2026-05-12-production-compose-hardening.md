---
date: 2026-05-12
type: Changed
title: 加固单机生产 Docker 部署
scope: deploy
order: 1500
---

单机 Docker Compose 部署改为由 Caddy 对外提供自动 HTTPS，应用和 PostgreSQL 默认只在内部网络通信，数据库密码和应用密钥都改为环境变量注入。新增 `.dockerignore` 降低构建上下文泄漏风险，并收紧项目规则：部署、运维、技术栈、数据库和项目流程变更也必须补充 changelog 条目。
