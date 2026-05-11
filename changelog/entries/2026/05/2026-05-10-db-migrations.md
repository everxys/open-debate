---
date: 2026-05-10
type: Changed
title: 建立正式数据库迁移系统
scope: database
order: 2300
---

数据库 schema 初始化和历史升级改为 `migrations/*.sql` 与 `schema_migrations` 记录管理；启动时只检查迁移是否已应用，不再在运行过程中自动修补表结构。`npm run dev`、`npm start` 和 summary worker 会先执行 `npm run db:migrate`，旧库升级、生成物记录和迁移校验都走同一套流程。
