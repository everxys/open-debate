---
date: 2026-05-12
type: Internal
title: 抽取通用 FileWorkspace
scope: files
order: 1200
---

将 AI 文件、策略共享文件、策略角色文件、草稿角色文件和工作台文件的树、右键菜单、标签页、Monaco 编辑器、拖拽移动、保存与删除流程合并到通用 `FileWorkspace`。各业务入口现在只保留 adapter、路径徽章、额外菜单和只读状态配置，后续模板复用时可以替换文件接口而不用复制整套文件管理器。
