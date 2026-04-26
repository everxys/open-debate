## 偏好

1. 代码简洁高效，可维护性强
2. 每次版本更新，都更新一下 `UPDATE.md`
3. Next.js 开发环境如果出现 `vendor-chunks/*`、`webpack-runtime.js`、`ChunkLoadError`、`Cannot find module './xxxx.js'` 这类错误，优先按 dev 构建缓存或旧进程污染处理，不先怀疑业务代码
4. 这个仓库统一用 `npm run dev` 拉起开发环境，不要并行保留多套旧 dev 进程
5. 如果样式存在问题，不要叠加各种样式来修补，直接重构对应结构，并清理掉旧样式和死规则
