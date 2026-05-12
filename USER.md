## 偏好

1. 代码简洁高效，可维护性强
2. 每次完成面向用户、部署、运维、技术栈、数据库或项目流程的实际变更，都必须新增 `changelog/entries/YYYY/MM/*.md` 条目，再运行 `npm run changelog:generate` 生成 `UPDATE.md` 和 `public/changelog/*`；不要手写 `UPDATE.md`
3. Next.js 开发环境如果出现 `vendor-chunks/*`、`webpack-runtime.js`、`ChunkLoadError`、`Cannot find module './xxxx.js'` 这类错误，优先按 dev 构建缓存或旧进程污染处理，不先怀疑业务代码
4. 这个仓库统一用 `npm run dev` 拉起开发环境，不要并行保留多套旧 dev 进程
5. 如果样式存在问题，不要叠加各种样式来修补，直接重构对应结构，并清理掉旧样式和死规则
6. 如果完成了 `TODO.md` 里的某项待办，记得把对应待办从 `TODO.md` 里删掉
7. 所有按钮和输入框都不要直接使用浏览器默认外观，要使用项目内自定义控件样式
8. 如果让 AI 修改 SQL、数据库 schema、表结构、索引、约束或种子数据，必须同步新增或更新 `migrations/*.sql`，再运行 `npm run db:migrate` 和 `npm run db:migrate:check`；不要把 schema 修补写进应用启动逻辑
9. 如果修改了项目使用的技术栈、核心依赖、运行环境、数据库方案、测试工具或部署方式，必须同步更新 `TechStack.md`
10. 如果修改了本地、生产或 Docker 的启动方式、启动命令、环境变量要求或部署入口，必须同步更新 `README.md`
