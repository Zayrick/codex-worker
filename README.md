# codex-worker

运行在 Cloudflare Workers 上的 OpenAI 兼容 Codex API，并内置由 React + Vite 构建的
管理面板。后端由 `worker-rs` 中的 Rust 编译为 WebAssembly，Worker 通过受信任的
Caddy relay 访问 `chatgpt.com`，直接访问
`auth.openai.com` 与 `api.openai.com`，并在 Workers KV 中保存上游 OAuth 与下游
API Key。

```text
OpenAI client → Cloudflare Worker（Rust/Wasm）→ Caddy relay → ChatGPT Codex
                                  │
                                  └── AUTH_KV
                                      ├── oauth       AES-256-GCM 信封
                                      └── API_KEYS    AES-256-GCM 信封
```

React 管理端位于 `src/`，Rust 后端 crate 位于 `worker-rs/`。后端按
`application / auth / core / http / protocol / upstream / transport` 分层：协议与领域规则
不依赖 Cloudflare，只有 `transport` 接触 Workers、KV、Fetch、WebSocket 和 Static Assets。
完整目录、依赖方向、可插拔适配器与组合方式见[架构说明](docs/architecture.md)。

## 数据与密钥模型

`AUTH_KV` 只使用两个固定键：

- `oauth`：access token、refresh token、账户 ID、邮箱和过期时间；
- `API_KEYS`：API Key 数组，每项只包含 `name`、`key`、`enabled`。

两条记录都使用 `DATA_ENCRYPTION_KEY` 加密。该 secret 必须是 32 个随机字节的
base64url 编码；AES-GCM 每次写入都会生成新的 12 字节 IV，并用不同的 purpose string
隔离 OAuth、API Key、设备登录 state 和管理会话。

API 请求鉴权通过一次 KV `get` 读取并解密 `API_KEYS`，仅比较启用项。客户端提交值
会先做 SHA-256，再用恒定时间比较。API Key 总长度必须超过 10 位（最多 512 位），并同时包含字母、
数字和非空白符号；不强制特定前缀或固定长度。名称和 Key 值都必须唯一，最多保存 100 项。

## 管理面板

管理面板是独立的 React 单页应用。Vite 构建后的资源由 Cloudflare Static Assets 提供；
只有 Worker 精确匹配到 `/<ADMIN_PATH>/admin` 时才会读取并返回 React shell，因此不会把
管理入口变成公开的 SPA fallback。管理 JSON API 仍由 Worker 会话鉴权保护。

管理入口由两个 secret 保护：

- `ADMIN_PATH`：1–128 位 ASCII 字母、数字、`_` 或 `-`，组成
  `/<ADMIN_PATH>/admin`；生产环境建议使用至少 32 位随机值；
- `ADMIN_SECRET`：登录管理页的高强度密钥。

登录成功后，Worker 发放 12 小时有效的 AES-GCM 管理会话 Cookie，Cookie 使用
`Secure`、`HttpOnly`、`SameSite=Strict` 和 `__Host-` 前缀。会话会绑定当前
`ADMIN_SECRET`，轮换管理密钥后旧会话立即失效。所有管理写请求还必须通过同源
`Origin` 校验；管理响应不启用 CORS，并使用 `no-store`。

浏览器只需访问：

```text
https://your-worker.example.com/<ADMIN_PATH>/admin
```

未登录管理会话时，React 页面显示 `ADMIN_SECRET` 登录表单。登录后：

- 没有 Codex OAuth 时，页面自动申请并显示 OpenAI 设备登录码与验证网址，然后按
  provider 返回的间隔轮询；
- 已登录时，页面显示邮箱、OAuth 过期时间和退出 Codex 登录按钮；退出会删除
  `oauth` KV 记录；
- “订阅与额度”区域从 OAuth `id_token` 读取套餐及订阅起止时间，并通过受信任 relay
  实时请求 Codex 用量，显示 5 小时、周/月、代码审查及附加模型额度的已用/剩余比例、
  重置时间和额度重置积分；读取失败不会影响 OAuth 与 API Key 管理；
- 下方可以查看、添加、修改、启停和删除 API Key；“自动生成”按钮使用浏览器
  Web Crypto 规范生成 `sk-` 加 20 位小写字母或数字，并保证随机部分同时包含字母和
  数字，不使用 `Math.random()`；该格式不是后端的强制格式。

同源管理端点位于 `/<ADMIN_PATH>/admin/*`：

- `POST /login`、`POST /logout`；
- `GET /state`、`GET /subscription`；
- `POST /oauth/device`、`POST /oauth/device/poll`、`DELETE /oauth`；
- `GET|POST|PUT|DELETE /api-keys`。

## 对外 API

健康检查不需要凭据：

- `GET /healthz`：仅在 OAuth 凭据可解密且尚未过期时返回空正文 `204`；否则只记录
  安全错误码并返回空正文 `404`。

下列请求需要一个已启用的管理面板 API Key：

- `GET /v1/models`；
- 协议转换：`POST /v1/chat/completions`、`POST /v1/completions`、
  `POST /v1/messages`、`POST /v1/messages/count_tokens`，以及 Gemini 风格的
  `/v1beta/models*` 与三个标准 model action；
- Codex 原生映射：`POST /v1/responses`、`POST /v1/responses/compact`、
  `GET /v1/responses` WebSocket、
  `/v1/images/*`、`POST /v1/alpha/search`；
- HTTP/WebSocket 传输：`/v1/live*`、`/v1/realtime*`；
- Codex CLI 直连别名：`/backend-api/codex/*`。

客户端可使用 `Authorization: Bearer sk-...`、`X-Api-Key: sk-...` 或
`X-Goog-Api-Key: sk-...`。同时提供时按 Bearer、`X-Api-Key`、
`X-Goog-Api-Key` 的顺序选择，不会在首选值失败后回退。缺少、错误或已停用的 Key
均返回空正文 `404`。

Responses 创建请求会把字符串顶层 `input` 包装成用户 `input_text` 消息数组；Responses 与
compact 会检查数组 `input`，把消息项的 `system` 角色改为 `developer`。Responses 创建请求
还会固定 `store: false`，并移除 Codex 不支持的 `max_completion_tokens`、
`max_output_tokens`、`maxOutputTokens`、`max_tokens`、`context_management`、`temperature`、
`top_p`、`truncation` 与 `user`；`service_tier` 仅在值为 `priority` 时保留，其他未知字段保留。
Responses WebSocket 对 `response.create` 应用同一策略，`response.append` 只改写角色，其他帧
直接转交。Chat 与旧版 Completions 根据 `stream`
返回 JSON 或 SSE；其他透明路径继续支持 multipart、二进制、Range 和 WebSocket 流式
传输，同时隔离 OAuth、Cookie、内部边界和 hop-by-hop header。
Anthropic Messages 使用其原生 JSON/SSE/error envelope；Gemini 支持 models 列表与详情、
`generateContent`、`streamGenerateContent` 和 `countTokens`。这些请求都会转换成 Codex
Responses 并只发往 `/backend-api/codex/responses`，不会把供应商路径拼到
`chatgpt.com` 根目录。视频 API、`/v1beta/interactions` 和未知 Gemini action 没有可用的
Codex OAuth 对应物，返回隐藏式 `404`。路径级兼容边界见
[兼容矩阵](docs/compatibility.md)。

需要转换或检查角色的 Chat、Completions、Messages、Gemini、Responses 与 compact JSON
请求及 zstd 解压结果最多 4 MiB。图片、Realtime 和其他 Codex 原生别名路径复用
`ReadableStream` 直接转交正文，不受这个应用层上限约束，但仍受 Cloudflare 套餐与
runtime 限制。

Messages 与 Gemini 的 token-count 路径采用本地 `cl100k_base` tokenizer 对转换后的 Codex
输入估算，不调用供应商 token-count 服务。它包含文本、工具 schema 和工具结果，但不会
与 Anthropic/Gemini 自有 tokenizer 保证逐 token 相等；应把结果用于预检与预算估算，
不能用于账单核对。

## 部署

`wrangler.jsonc` 声明自动预配的 `AUTH_KV`、四个必需 secrets 和每小时执行一次
的 Cron Trigger。若要绑定已有 namespace，可为 `kv_namespaces` 补充 `id`。

安装 Rust/Wasm 构建工具、前端依赖并登录 Cloudflare：

```powershell
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
pnpm install
pnpm exec wrangler login
```

Cloudflare Vite 插件把 React、Rust/Wasm Worker、workerd 与 Static Assets 组合在同一个
开发服务器中。`pnpm dev` 会先执行一次 `worker-build --dev` 生成 Worker 入口，再启动
`http://localhost:8787`：修改 React 源码使用 Fast Refresh，修改 `worker-rs/src` 会重新
编译 Wasm 并重启 Worker runtime。管理页面、管理 API 与公开 API 始终保持同源。

生产构建先执行 `worker-build --release`，再由 Vite 同时输出浏览器资源和 Worker bundle；
生成的 Wrangler 配置会被后续 `vite preview` 与 `wrangler deploy` 自动使用。也可以单独
构建 release 后端：

```powershell
pnpm run build:worker
```

该脚本等价于在 `worker-rs/` 目录运行 `worker-build --release`；需要单独生成本地调试
入口时使用 `pnpm run build:worker:dev`。

本地调试先复制不含值的示例，然后填写 `.dev.vars`：

```powershell
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

浏览器访问 `http://localhost:8787/<ADMIN_PATH>/admin`。Worker DevTools 位于
`http://localhost:8787/__debug`。

所需值为：

```dotenv
ADMIN_PATH=<随机 URL 安全路径段>
ADMIN_SECRET=<独立生成的高强度管理密钥>
CHATGPT_RELAY_URL=https://chatgpt-relay.example.com
DATA_ENCRYPTION_KEY=<32 个随机字节的 base64url 编码>
```

`CHATGPT_RELAY_URL` 配置为 relay 的 HTTPS origin，Worker 会自动补齐上游路径。

这是一次不兼容的配置迁移：旧 `CODEX_RELAY_URL` 不再读取。升级部署前必须设置
`CHATGPT_RELAY_URL`；确认新版本正常后，可删除 Cloudflare 中残留的旧 secret。

首次部署可把同样的值写入不会提交到 Git 的 `.env.production`，再让 Wrangler 同时
上传 Rust/Wasm Worker、前端资源与 secrets：

```powershell
pnpm build
pnpm exec wrangler deploy --secrets-file .env.production
```

已有 secrets 的后续部署运行 `pnpm deploy`。不要提交 `.dev.vars` 或
`.env.production`；`.gitignore` 会忽略实际 secret 文件。

### GitHub Actions 自动部署

仓库现在会对所有 push 与 pull request 执行完整 CI；push 到默认分支 `master` 时，
GitHub Actions 会在同一个 job 中依次编译 Rust/Wasm、构建 React/Static Assets，并使用
Cloudflare 官方 Wrangler Action 部署生成的 bundle。也可以从 Actions 页面手动触发生产
部署。

启用前需要在 GitHub `production` environment 中配置 `CLOUDFLARE_API_TOKEN` 和
`CLOUDFLARE_ACCOUNT_ID`，并先完成上面的首次 secrets 引导部署。详细的权限、构建边界和
排错说明见 [Cloudflare Worker 自动构建与部署](docs/cloudflare-worker-deployment.md)。

## OAuth 自动刷新

Cron Trigger 每小时读取并解密 `oauth`。access token 将在 3 小时内过期时，
Worker 使用 refresh token 请求 OpenAI token endpoint；瞬时网络错误、HTTP 429 或
5xx 最多尝试三次，每次上游请求最长 10 秒。成功后保留账户信息，用新 IV 覆盖
`oauth`。普通 API 请求不会主动刷新，避免多个边缘位置同时消费旋转式 refresh
token。

## KV 一致性

OAuth 与 API Key 的常规读取显式使用 Workers KV 当前允许的最低
`cacheTtl: 30`，以缩短边缘缓存的陈旧窗口；未指定 `cacheTtl` 的读取仍使用平台默认的
60 秒。Workers KV 本身仍是最终一致存储，其他边缘位置可能在短时间内继续看到旧值，
因此启停、轮换、删除 Key 和退出 OAuth 都不是全局瞬时生效。需要严格即时吊销时应改用
强一致存储。

`API_KEYS` 是单条合并记录，管理端每次修改只写一次；遇到同键每秒写入限制时会进行
有限退避重试。并发管理员仍可能发生最后写入者覆盖，因而该面板面向低频、单管理员
配置。如果需要并发编辑或事务语义，应迁移到 Durable Object 或 D1。

## 敏感信息处理

- Worker 没有模块级 OAuth、API Key 或管理会话缓存；
- 日志只记录固定事件与错误 code；
- Worker 生成的错误不包含 token、API Key、主密钥、IV 或密文；
- Worker 在每次返回 React shell 时重新注入 CSP nonce，并禁止跨站 framing；
- 后端测试在宿主机直接运行 Rust 纯模块，并另做 Wasm 目标编译检查；测试固件不包含真实凭据。

`CHATGPT_RELAY_URL` 必须由你控制并审计。它会接收 OAuth Bearer、账户 ID 以及 Codex
请求与响应内容，必须禁用敏感日志并限制入口。反代只需把收到的原始路径交给
`chatgpt.com`，不需要额外改写路径；最小 Caddy 示例为：

```caddyfile
chatgpt-relay.example.com {
	reverse_proxy https://chatgpt.com {
		header_up Host chatgpt.com
		header_up -CF-Worker
	}
}
```

## 构建与检查

后端实现与后端测试全部使用 Rust；`#[cfg(test)]` 单元测试按模块与实现放在一起，
不需要跨语言测试驱动业务规则。常用命令：

```powershell
pnpm run test:rust
pnpm run check:rust
pnpm check
```

`test:rust` 在宿主目标运行纯领域、协议、URL/header policy、加密与应用组合测试；
`check:rust` 依次检查格式、Clippy，并编译 `wasm32-unknown-unknown`。`pnpm check` 还会
构建和检查前端、运行 Rust 测试，并执行 `wrangler deploy --dry-run` 验证最终上传入口。

平台行为参考：[KV 读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、
[KV 写入](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、
[KV 删除](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)、
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 和
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
