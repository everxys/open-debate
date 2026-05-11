---
date: 2026-05-10
type: Changed
title: 改造更新日志为条目生成模式
scope: changelog
---

更新日志改为 `changelog/entries/YYYY/MM/*.md` 小条目维护，生成脚本统一输出 `public/changelog` 分页 JSON、当前版本 JSON 和归档 `UPDATE.md`；运行时顶部版本号和 `/changelog` 页面不再解析完整 Markdown，降低多年、多团队维护时的冲突和读取成本。
