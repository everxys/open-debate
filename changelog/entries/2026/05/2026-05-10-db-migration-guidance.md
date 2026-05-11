---
date: 2026-05-10
type: Changed
title: 补充数据库迁移协作约定
scope: database
order: 2400
---

`USER.md` 新增数据库变更规则：AI 修改 SQL、schema、表结构、索引、约束或种子数据时，必须同步维护 `migrations/*.sql` 并运行迁移与检查命令，避免重新把 schema 修补写回应用启动逻辑。
