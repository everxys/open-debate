---
date: 2026-04-19
type: Changed
title: 2026-04-19 更新汇总
scope: project
---

- 修复 summary worker 在本地 Postgres 重启/恢复期的进程级崩溃：`pg Pool` 现在会显式监听并吞掉空闲连接上的 `error` 事件，避免 `ECONNRESET` / `57P03 the database system is in recovery mode` 直接作为未处理事件把 Node 进程打死；同时数据库单例会在这类连接级故障后自动失效并重建，`ensureDbReady()` 的 schema 初始化失败也不再把 rejected promise 永久缓存住，数据库恢复后后续请求与 summary worker tick 可以自行重连继续跑。
