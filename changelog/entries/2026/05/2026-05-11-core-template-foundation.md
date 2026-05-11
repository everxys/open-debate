---
date: 2026-05-11
type: Internal
title: 抽取模板底座 core 模块
scope: core
order: 1100
---

新增 `lib/core` 底座目录，把 API 错误响应、数据库迁移、日志、认证会话和更新日志生成逻辑整理成可复用入口；旧 `lib/*` 路径继续兼容，现有业务代码无需同步改动即可逐步迁移到通用模板结构。
