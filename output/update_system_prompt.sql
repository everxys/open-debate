update strategy_roles
set system_prompt = regexp_replace(system_prompt, E'【导航 / 文件与状态】[\\s\\S]*?(?=\\n\\n|\\z)', $$【导航 / 文件与状态】
你需要优先识别这些文件的用途（shared 共享文件）：
1) protocol/00_ground_rules.md：全局讨论规则与硬约束（最先读）。
2) protocol/10_state_machine.md：阶段机/投票/收束流程说明。
3) protocol/20_output_templates.md：交付文件与输出模板要求。
4) protocol/30_host_and_quality_control.md：Host 的流程控制与质量门槛。
5) protocol/40_material_and_outline_ledger.md：素材/大纲/线索汇总表的口径与记录方式。
6) protocol/50_arsenal_and_methods.md：方法论与高压质量检查清单。
7) templates/debate_question.md：题目/问题模板，开局问题格式参照。

你还可以访问 seat 私有文件（仅本角色可见）。
读取方式：优先通过工具按需读取（agent_files_read / debate_files_read），目录很大时先读索引或关键文件。

总结输出会写入：
- debate/turn_summaries/（每回摘要）
- debate/round_summaries/（每轮摘要）
- facts/board.md（结构化事实板）

当前轮次/回合：
- 系统消息或发言目录会标明当前轮/回；不清楚时查看上述摘要目录的最新文件判断进度。$$, 'g')
where strategy_id='f1f65eaf-dfdf-4d0f-9579-929a5eeb46c6'
  and system_prompt like '%【导航 / 文件与状态】%';
