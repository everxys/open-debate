# Merged Democratic Centralism Strategy

这是一份把“当前数据库里的民主集中制共识算法策略”和 `docs/restored_novel_godmode/` 中高价值旧内容合并后的策略源文件。

目标：
- 保留当前平台兼容的 workflow / 文件结构 / 固定 Host + 五类内容角色设计
- 恢复旧版中真正提升质量的总提示词精华、阶段内子任务推进、质量审判语言
- 作为当前数据库策略的可维护文本来源

当前推荐的部署配比：
- 12 席：`1 Host + 4 通用议员 + 2 反驳者 + 2 事件诡计工程师 + 2 终局闭环官 + 1 人物关系审判官`

说明：
- 本目录中的 `roles/*.system_prompt.md` 是固定 Host 与五类内容角色的来源模板
- 当数据库里的真实策略扩成多席时，会按推荐配比重复复用这些角色模板
- `role_order = 1` 始终作为固定 Host / owner role，独占 `debate/workflow.json`

本目录中的文件会用于覆盖数据库中的当前策略：
- `debate/workflow.json`
- `roles/00_host.system_prompt.md`
- `roles/01_general_councilor.system_prompt.md`
- `roles/02_rebutter.system_prompt.md`
- `roles/03_event_scheme_engineer.system_prompt.md`
- `roles/04_endgame_closure_guard.system_prompt.md`
- `roles/05_character_relationship_auditor.system_prompt.md`
- `protocol/00_ground_rules.md`
- `protocol/10_state_machine.md`
- `protocol/20_output_templates.md`
- `protocol/30_host_and_quality_control.md`
- `protocol/40_idea_ledger_and_outline.md`
- `protocol/50_arsenal_and_methods.md`
- `templates/debate_question.md`
