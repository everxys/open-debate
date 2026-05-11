---
date: 2026-05-09
type: Changed
title: 2026-05-09 更新汇总
scope: project
---

- `USER.md` 新增控件约定：按钮和输入框不能直接使用浏览器默认外观，需要走项目内自定义控件样式；AI 配置页同步把输入框、下拉、按钮、文件选择和配置勾选框收口到自定义视觉层，保留原有导入导出、拖拽归类、多选移动和配置编辑逻辑不变。
- AI 配置页的多选整理继续增强：配置列表工具条新增“全选当前结果 / 取消全选”，卡片标题区域也可作为大命中区直接切换选中状态；拖动 AI 配置时不再使用浏览器默认的大卡片拖拽虚影，避免遮挡左侧分类投放目标。
- AI 配置页分类栏继续简化：自定义分类行不再显示单独的“改 / 删”小按钮，点击分类行会直接把名称带到上方输入框进入编辑；删除按钮移动到上方“保存”旁边，只在编辑现有分类时出现。
- 修正 AI 配置页分类切换残留编辑态的问题：从某个自定义分类切到“全部分类”或“未分类”时会退出分类编辑并清空上方输入框，不再继续显示上一次分类名。
- 修正 AI 配置页全选在筛选后混入隐藏选中项的问题：切换分类、搜索或启用状态后会把选择范围收紧到当前结果；“全选当前结果”、拖拽移动和工具条移动也只处理当前结果内的配置，不再出现“已选 7（当前结果 2）”这类残留状态。
- 优化 AI 配置分类 SQL 链路：批量移动分类新增单次 `PATCH /api/agents/category-move`，不再对每个 AI 配置逐个请求 `PATCH /api/agents/[id]`；创建分类返回固定 `referencedAgentCount: 0`，避免为了新分类计数扫描全部 `ai_agents`；同时补上 `ai_agents(user_id, created_at desc) where deleted_at is null` 和 `ai_agents(user_id, category_id) where deleted_at is null` 组合索引，改善列表、分类计数、删除分类和批量移动校验路径。
- 扫描项目 SQL 后补齐一批低风险索引：`debates(user_id, created_at desc)` 覆盖个人辩论列表，`debates(updated_at, created_at) where status='running'` 覆盖运行中恢复扫描；文件树/文件夹删除/运行时上下文读取常用的 `path like 'prefix%'` 增加 `text_pattern_ops` 前缀索引；`debate_file_activity_logs` 增加按文件查看活动明细/最近事件的组合索引；`docker/init.sql` 同步补齐 summary queue 运行时已有的队列索引和 worker 表。
- 继续优化文件状态页 SQL：`debate_file_activity_logs` 的读取次数、写入次数、最近读取、最近写入、最近事件从 4 条查询合并为 1 条聚合查询；基础文件列表也改为单条 `union all` 查询，并且状态页不再读取文件正文 `content`，只在文件详情页按需加载正文。
- 删除应用内 Docs 页面：移除顶部导航里的 `Docs` 入口、`/docs` 与 `/docs/[slug]` 路由，以及只服务该页面的 `lib/docs*` 读取/注册代码；仓库内 Markdown 文档文件本身保留。
- 删除“检索配置”功能：移除用户菜单入口、设置页、`/api/retrieval-config` API、`lib/retrieval.ts`、运行时长历史召回和 embedding 索引写入；数据库初始化、类型和校验也不再创建或引用 `retrieval_configs`、`debate_context_chunks`、`debate_context_embeddings`。现有数据库里的旧表不在本次自动 drop，避免误删历史数据。
