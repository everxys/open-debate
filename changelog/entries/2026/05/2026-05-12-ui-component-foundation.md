---
date: 2026-05-12
type: Internal
title: 抽取通用 UI 组件底座
scope: ui
order: 1100
---

将按钮、字段、面板、徽章、标签页、上下文菜单、提示和 toast 的通用样式迁入 `components/ui`，并新增可复用组件入口。业务页面继续保留自身布局和状态样式，后续模板化时可以直接复用这层 UI 基础组件。
