# codex-worker

运行在 Cloudflare Workers 上的 OpenAI 兼容 Codex API。Worker 通过 Caddy relay
访问 ChatGPT Codex 后端，并在 Workers KV 中保存上游 OAuth 与下游 API key。

```text
OpenAI client → Cloudflare Worker → Caddy → ChatGPT Codex
                         │
                         └── AUTH_KV
                             ├── oauth       AES-256-GCM 信封
                             └── API-<id>    客户端直接提交的 key，例如 sk-...
```

## 结构与边界

源码已按 `app / auth / codex / chat / completions / http / openai / shared` 的职责边界组织。
`src/index.ts` 只负责组合 Worker handlers；协议转换、OAuth、KV、网络 I/O 与通用原语
各自独立。完整目录、依赖方向、请求流与修改准则见
[架构说明](docs/architecture.md)。

## 凭据模型

`AUTH_KV` 只使用两种键：

- `oauth`：设备登录成功后，Worker 使用 `OAUTH_MASTER_KEY` 加密 access token、
  refresh token、账户信息和过期时间，再写入这个固定键。自动刷新时先解密，成功
  换取新 token 后使用新 IV 加密并覆盖；
- `API-<id>`：`<id>` 只是 Cloudflare 面板中便于识别的唯一标签，值是客户端
  请求时原样提交的 key，例如 `sk-...`。值不加密。

收到请求后，Worker 分页列出 `API-` 前缀的键，批量读取其值，并对提交值做
SHA-256 恒定时间比较。`<id>` 不属于客户端 key，也不会从客户端 key 中解析。

设备登录的短期 `state` 会加密后返回调用端，但不写入 KV，因此不会产生第三种
KV 数据。`OAUTH_MASTER_KEY` 必须是 32 个随机字节的 base64url 编码，只负责加密；
`DEVICE_AUTH_SECRET` 是独立、可轮换的设备管理口令，只通过同源表单的 POST body
提交。两者都不会进入 URL。

项目没有管理员 key、管理员角色、API key 管理接口或手动 OAuth 刷新接口。所有
`API-*` 的新增、修改和删除都只在 Cloudflare 面板完成。

## API

健康检查不需要凭据：

- `GET /healthz`：仅在已保存的 OAuth 凭据可解密且尚未过期时返回空正文
  `204`；不健康或检查失败时只在 Worker 日志记录安全错误码，对外返回空正文
  `404`。

浏览器设备登录不接受、也不需要 `API-*` 值：

- `GET /auth/device/start`：返回设备管理密钥表单；
- `POST /auth/device/start`：校验 POST body 中的 `DEVICE_AUTH_SECRET` 并开始登录；
- `GET /auth/device/poll?state=...`：页面内部使用短期加密 state 的检查地址。

`POST /auth/device/start` 缺少或提交错误 secret 时返回空正文 `404`。
生产环境建议再用 Cloudflare Access 限制 `/auth/device/*` 的访问主体。

用户只需访问 `start`。Worker 返回的页面只显示设备码和 OpenAI 验证链接，并通过
隐藏的状态 iframe 按服务端给出的间隔自动访问 `poll`；无需手动构造 `state` 或
调用 `poll`。所有 OAuth provider 请求最多等待 10 秒；登录成功后，设备登录页会
自动关闭。

需要任意一个 `API-*` 值：

- `GET /v1/models`
- 协议转换：`POST /v1/chat/completions`、`POST /v1/completions`；
- Codex 原生：`POST /v1/responses`、`POST /v1/responses/compact`、
  `/v1/images/*`、`POST /v1/alpha/search`；
- HTTP/WebSocket 传输：`/v1/videos/*`、`/v1/messages*`、`/v1/live*`、
  `/v1/realtime*`、`/v1beta/*`、`/openai/v1/videos/*`；
- Codex CLI 直连别名：`/backend-api/codex/*`。

客户端可使用 `Authorization: Bearer sk-...`、`X-Api-Key: sk-...`，Gemini SDK 也可
使用 `X-Goog-Api-Key: sk-...`。同时提供时按 Bearer、`X-Api-Key`、
`X-Goog-Api-Key` 排序选择，已选值校验失败后不会回退。Responses
直接返回 Codex SSE；Chat 与旧版 Completions 根据 `stream` 返回 JSON 或 SSE。
缺少或提交错误 API key 时返回空正文 `404`。API key 通过后，上游错误的状态与正文
保持透传；透明路径支持 multipart/二进制请求、Range 响应与 WebSocket Upgrade，
同时过滤 OAuth、cookie、内部边界和 hop-by-hop header。

“存在路由”不等于“单一 ChatGPT OAuth 实现了所有供应商协议”。哪些路径由 Worker
转换、哪些映射到 Codex 原生接口、哪些只保证传输，以及 relay 必须如何分流，见
[兼容矩阵与 Cloudflare 边界](docs/compatibility.md)。

JSON 请求的编码体以及 zstd 解压后的结果均不得超过 4 MiB。超过限制时返回
OpenAI error envelope 格式的 `413 request_too_large`。
Chat 转换还会把单个 SSE 事件与累计持久状态分别限制为 8,388,608 个 JavaScript
字符单元，并最多保留 128 个工具调用和 384 个工具 alias；超限视为上游流失败，
避免长连接无界占用 Worker 内存。
透明图片、视频、Messages、v1beta 与 Codex 别名路径不解析或缓冲完整正文，因此
不受这个应用层 4 MiB JSON 上限约束，但仍受 Cloudflare 套餐请求体、128 MB isolate
内存和 WebSocket 单消息上限影响。

所有已知 API 路径族的 `OPTIONS` 预检返回带 CORS 的空正文 `204`。除此之外的全部
路径与不支持的方法（包括 `/` 和未列出的 `/v1/*`）均返回空正文 `404`。Worker 自己
生成的 `404` 与健康检查 `204` 不附带 HTML、JSON 或说明文本。

设备登录只在 KV 中不存在 `oauth` 时开放，作为单会话部署的覆盖保护。KV 不支持
原子的 create-if-absent，因此不要并行启动多个设备登录会话。

## 部署与登录

`wrangler.jsonc` 声明了自动预配的 `AUTH_KV`、三个必需 secrets，以及每 10 分钟
执行一次的 Cron Trigger。若要绑定已有 namespace，可为 `kv_namespaces` 补充 `id`。

安装依赖并登录 Cloudflare：

```powershell
pnpm install
pnpm exec wrangler login
```

本地调试使用 Cloudflare 惯用的 `.dev.vars`。先复制不含值的示例，再填写仅供本地
使用的凭据：

```powershell
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

首次部署前，另行创建不会提交到 Git 的 `.env.production`，并填写生产 secrets。
这个文件只作为 Wrangler 的批量上传文件，不参与本地调试：

```dotenv
OAUTH_MASTER_KEY=<32 个随机字节的 base64url 编码>
DEVICE_AUTH_SECRET=<独立生成的高强度管理口令>
CODEX_RELAY_URL=https://<你控制并审计的 relay>/backend-api/codex/responses
```

`wrangler.jsonc` 将它们声明为 required secrets，因此首次部署应让 Wrangler 同时
上传代码与 secrets：

```powershell
pnpm exec wrangler deploy --secrets-file .env.production
```

已有这些 secrets 的后续部署可直接运行 `pnpm deploy`。然后在 Cloudflare 面板绑定的
KV namespace 中新增 `API-<id>`，值设为准备让客户端提交的 key，例如 `sk-...`。

不要提交 `.dev.vars` 或 `.env.production`；项目的 `.gitignore` 会忽略实际 secret
文件，仅允许提交不含值的 `.dev.vars.example`。

部署后直接在浏览器访问：

```text
https://your-worker.example.com/auth/device/start
```

输入设备管理密钥并提交后，点击页面显示的验证链接，在新标签页完成 OpenAI 验证，
同时保留设备登录页。浏览器会自动轮询，成功后自动关闭设备登录页。项目没有额外的
Node.js 登录脚本、前端构建步骤或本地凭据文件；OAuth token 由 Worker 直接加密写入
KV。

若需重新登录，先在 Cloudflare 面板删除 `oauth`，等待 KV 变更传播，再运行
上述浏览器地址。API key 的轮换或吊销同样只在面板修改对应的 `API-<id>`。

## 自动刷新

Cron Trigger 每 10 分钟读取并解密 `oauth`。access token 距离过期不足 15 分钟
时，Worker 使用 refresh token 请求 OpenAI token endpoint；遇到瞬时网络错误、
HTTP 429 或 5xx 时最多尝试三次，每次上游请求最长 10 秒。成功后保留必要账户字段，
使用新 IV 加密并覆盖 `oauth`。

请求路径不会刷新 token，也不存在手动刷新 API，避免多个边缘位置同时消费旋转式
refresh token。

## KV 最终一致性

API key 和 OAuth 的常规读取使用 `cacheTtl: 30`。Workers KV 是最终一致存储，
因此通过面板新增、修改或删除后，其他边缘位置可能需要一段时间才能看到变更：

- 新增 key 后等待传播再切换客户端；
- 吊销 key 后，旧值可能在短时间内继续有效；
- 重新登录前删除 `oauth` 后，等待变更传播再启动设备登录。

若需要严格的即时吊销语义，应改用强一致存储。

同理，设备登录的“检查后写入”不是原子事务；需要严格排他写入时，应把这段协调迁移
到 Durable Object 或 D1。API key 鉴权会扫描 `API-*`，适合少量人工管理的 key；应在
Cloudflare WAF/Rate Limiting 限制未认证流量。若 key 数量会持续增长，应迁移为以 key
摘要寻址的 O(1) 存储模型。

## 敏感信息处理

- Worker 没有模块级 OAuth 或 API key 缓存；
- 日志只记录刷新状态、固定错误 code 和计划时间；
- Worker 自己生成的错误响应不包含 OAuth token、API key、主密钥、IV 或密文；
- 已通过 API key 鉴权的请求会收到原始上游错误状态与正文，但只透传安全响应头；
- `.dev.vars*` 和 `.env*` 被 Git 忽略；
- 测试通过隔离的 Workers 测试环境覆盖为虚拟凭据，测试 Worker 不使用本地真实值。

## Caddy relay

`CODEX_RELAY_URL` 没有公共默认值，部署时必须显式指向你控制并审计的 HTTPS relay。
relay 会接收 OAuth Bearer、账户 ID、请求内容与响应内容，必须禁用 Authorization 与
内容日志，并限制只有该 Worker 可以访问；生产环境宜再使用 mTLS 或私网入口。

下面只展示移除 Cloudflare 注入 header 的最小反向代理规则，并不是可直接用于生产的
完整安全配置；relay 鉴权、网络访问控制与日志策略必须在其外层另行配置并验证。

```caddyfile
your-relay.example.com {
	reverse_proxy https://chatgpt.com {
		header_up -CF-Worker
	}
}
```

Cloudflare 会给 Worker 子请求添加 `CF-Worker`，而 ChatGPT 可能拒绝该请求；Caddy
通过建立新的上游连接解决这一问题。该示例只覆盖同一 ChatGPT Codex origin；若要
让 `/v1/videos/*`、`/openai/v1/videos/*`、`/v1/messages*`、`/v1/live*`、
`/v1/realtime*` 或 `/v1beta/*`
获得协议级可用性，relay 还必须按路径分流到实际供应商并提供适用凭据。Caddy 可
自动反代 WebSocket，但仍需验证 Upgrade、子协议、SSE 和二进制流没有被中间层缓冲。

## 检查

```powershell
pnpm check
```

平台行为参考：[KV 列举](https://developers.cloudflare.com/kv/api/list-keys/)、
[KV 读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、
[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 和
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
