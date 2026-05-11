---
date: 2026-04-13
type: Changed
title: 2026-04-13 更新汇总
scope: project
---

- 辩论列表页的“清空已停止辩论”现在会同时纳入 `failed` 状态：后端清理条件已扩展为 `status in ('stopped', 'failed')`，前端统计与确认文案也同步改成“已停止/失败辩论”，避免失败辩论留在批量清理之外。
- 移除运行时所有 demo fallback：OpenAI / Anthropic provider 在空正文、伪工具调用补救失败、无工具降级仍无正文时不再伪造正常发言，而是统一抛出 `AI_EMPTY_RESPONSE`；开发环境中的 `demo-*` key 也不再返回模板内容，改为直接报配置错误。
- 辩论主循环的 provider 重试文案改为显式失败提示；当单席位连续 3 次调用都失败时，现在会追加一条 `context/generation_diagnostics.jsonl` 失败诊断记录，但不会写入 `debate_turns`、检索索引、memory 或 summary，避免假成功内容污染后续上下文。
- 新增最小 provider 守门测试：补上 `node:test + tsx` 的 `npm test` 脚本，并为“空输出必须失败 / demo key 禁用”添加单测，确保后续不会把伪成功 fallback 悄悄加回来。
