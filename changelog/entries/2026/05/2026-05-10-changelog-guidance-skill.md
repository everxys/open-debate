---
date: 2026-05-10
type: Changed
title: 补充更新日志写作约定与技能
scope: changelog
order: 2000
---

`USER.md` 中的版本更新规则改为新增 `changelog/entries/YYYY/MM/*.md` 条目后运行 `npm run changelog:generate`，不再要求手写 `UPDATE.md`；同时新增本地 `open-debate-changelog` skill，后续 AI 写更新日志时会按条目源文件、生成物和校验脚本的流程执行。
