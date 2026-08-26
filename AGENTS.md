# codex-worker 工作约定

## 项目边界

- `worker-rs/` 是唯一后端：Rust 1.97 编译为 Cloudflare Worker Wasm；`src/` 是 React/Vite 管理端。
- Cloudflare I/O 只允许出现在 `worker-rs/src/transport/`；`application`、`auth`、`core`、`http`、
  `protocol`、`upstream` 保持 runtime-neutral。
- `.reference/` 仅供研究对照，不是构建输入或产品规范；除非任务明确要求，不要修改。

## 必须保持的契约

- 本地、管理和公开协议路由精确匹配；已知路径的错误方法和无效下游 Key 保持隐藏式空 `404`；
  `/backend-api` 路径族按代理账户许可策略透明转发，其他未注册路径透明转发到受信任 relay。
- 图片、媒体和透明代理正文保持流式，不得无界缓冲。
- 不记录、回显或向错误上游转发 OAuth、API Key、Cookie、管理密钥或请求正文。
- `AUTH_KV` 只保存加密的主/代理 OAuth、API Key 与代理设置、Codex 用量状态；无迁移方案不得
  轮换 `DATA_ENCRYPTION_KEY`。
- 管理面只在 `/<ADMIN_PATH>/admin` 暴露，依赖管理会话和写请求同源校验；路径隐藏不能替代认证。
- `CHATGPT_RELAY_URL` 必须是受控、经审计的精确 HTTPS origin；它能看到 OAuth、账户和内容。

## 配置与工具链

- 使用 pnpm 11、Node.js >=22、Rust >=1.97、`wasm32-unknown-unknown` 和 `worker-build` 0.8.5。
- 固定绑定为 `ASSETS`、`AUTH_KV`；固定 secrets 为 `ADMIN_PATH`、`ADMIN_SECRET`、
  `BARK_PUSH_URL`、`DINGTALK_SECRET`、`DINGTALK_WEBHOOK_URL`、`CHATGPT_RELAY_URL`、
  `DATA_ENCRYPTION_KEY`；非 secret 为 `CORS_ORIGIN`；Cron 每 5 分钟执行。
- 涉及 Workers、KV、Wrangler 配置或平台限制时，先查当前 Cloudflare 官方文档。
- 不编辑或提交 `worker-rs/build/`、`worker-rs/target/`、`dist/`、`.wrangler/`、`.dev.vars`、
  `.env.production`。

## 工作流

- 开发使用 `pnpm dev`，不要以裸 `wrangler dev` 绕过 Rust 与 Vite 构建链。
- 后端行为变更需在对应 Rust 模块补测试；快速验证用 `pnpm test` 或 `pnpm run check:rust`。
- 代码或配置交付前运行 `pnpm check`；它覆盖 lint、Rust 测试/格式/Clippy、Wasm、构建和 dry-run。
- 路由、配置、安全或部署语义变更时，同步更新 `README.md` 与 `docs/`。常驻文档只以项目
  当前状态为基准自然陈述，不写本次工作、变更过程、新旧对比或交付总结；历史变化写入
  changelog、commit 或 PR。

## 生产安全

- `pnpm deploy`、Wrangler secret/KV 操作、切换 `AUTH_KV`、轮换加密键和 push `master` 都是生产
  变更，必须获得明确授权。
- 当前没有 staging 环境；push `master` 或手动触发 deploy workflow 会直接部署 production。
