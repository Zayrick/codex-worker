# codex-worker

运行在 Cloudflare Workers 上的 OpenAI 兼容 Codex API。Worker 通过受信任的 Caddy
relay 访问 ChatGPT Codex 后端，并在 Workers KV 中保存上游 OAuth 与下游 API Key。

```text
OpenAI client → Cloudflare Worker → Caddy → ChatGPT Codex
                         │
                         └── AUTH_KV
                             ├── oauth       AES-256-GCM 信封
                             └── API_KEYS    AES-256-GCM 信封
```

源码按 `app / auth / codex / chat / completions / http / openai / shared` 分层。
完整目录、依赖方向和请求流见[架构说明](docs/architecture.md)。

## 数据与密钥模型

`AUTH_KV` 只使用两个固定键：

- `oauth`：access token、refresh token、账户 ID、邮箱和过期时间；
- `API_KEYS`：API Key 数组，每项只包含 `name`、`key`、`enabled`。

两条记录都使用 `DATA_ENCRYPTION_KEY` 加密。该 secret 必须是 32 个随机字节的
base64url 编码；AES-GCM 每次写入都会生成新的 12 字节 IV，并用不同的 purpose string
隔离 OAuth、API Key、设备登录 state 和管理会话。

API 请求鉴权通过一次 KV `get` 读取并解密 `API_KEYS`，仅比较启用项。客户端提交值
会先做 SHA-256，再用恒定时间比较。API Key 必须符合
`sk-<64 位小写字母或数字>`；名称和 Key 值都必须唯一，最多保存 100 项。

## 管理面板

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

未登录管理会话时显示 `ADMIN_SECRET` 登录表单。登录后：

- 没有 Codex OAuth 时，页面自动申请并显示 OpenAI 设备登录码与验证网址，然后按
  provider 返回的间隔轮询；
- 已登录时，页面显示邮箱、OAuth 过期时间和退出 Codex 登录按钮；退出会删除
  `oauth` KV 记录；
- 下方可以查看、添加、修改、启停和删除 API Key；“自动生成”按钮使用浏览器
  Web Crypto 生成 `sk-` 加 64 位小写字母或数字，不使用 `Math.random()`。

同源管理端点位于 `/<ADMIN_PATH>/admin/*`：

- `POST /login`、`POST /logout`；
- `GET /state`；
- `POST /oauth/device`、`POST /oauth/device/poll`、`DELETE /oauth`；
- `GET|POST|PUT|DELETE /api-keys`。

## 对外 API

健康检查不需要凭据：

- `GET /healthz`：仅在 OAuth 凭据可解密且尚未过期时返回空正文 `204`；否则只记录
  安全错误码并返回空正文 `404`。

下列请求需要一个已启用的管理面板 API Key：

- `GET /v1/models`；
- 协议转换：`POST /v1/chat/completions`、`POST /v1/completions`；
- Codex 原生映射：`POST /v1/responses`、`POST /v1/responses/compact`、
  `GET /v1/responses` WebSocket、
  `/v1/images/*`、`POST /v1/alpha/search`；
- HTTP/WebSocket 传输：`/v1/videos/*`、`/v1/messages*`、`/v1/live*`、
  `/v1/realtime*`、`/v1beta/*`、`/openai/v1/videos/*`；
- Codex CLI 直连别名：`/backend-api/codex/*`。

客户端可使用 `Authorization: Bearer sk-...`、`X-Api-Key: sk-...` 或
`X-Goog-Api-Key: sk-...`。同时提供时按 Bearer、`X-Api-Key`、
`X-Goog-Api-Key` 的顺序选择，不会在首选值失败后回退。缺少、错误或已停用的 Key
均返回空正文 `404`。

Responses 与 compact 只检查顶层 `input`，把消息项的 `system` 角色改为 `developer`；
工具调用、续接 ID、缓存字段、未知字段和上游响应不作协议清洗。Responses WebSocket
识别客户端 `response.create` 与 `response.append` 文本帧，统一以 `response.create` 发往
Codex 并执行同一角色改写；其他帧保持不变。Chat 与旧版 Completions 根据 `stream`
返回 JSON 或 SSE；其他透明路径继续支持 multipart、二进制、Range 和 WebSocket 流式
传输，同时隔离 OAuth、Cookie、内部边界和 hop-by-hop header。
路径级兼容边界见[兼容矩阵](docs/compatibility.md)。

需要转换或检查角色的 Chat、Completions、Responses 与 compact JSON 请求及 zstd
解压结果最多 4 MiB。媒体、Messages、v1beta 和其他 Codex 别名路径不缓冲完整正文，
不受这个应用层上限约束，但仍受 Cloudflare 套餐与 runtime 限制。

## 部署

`wrangler.jsonc` 声明自动预配的 `AUTH_KV`、四个必需 secrets 和每 10 分钟执行一次
的 Cron Trigger。若要绑定已有 namespace，可为 `kv_namespaces` 补充 `id`。

安装依赖并登录 Cloudflare：

```powershell
pnpm install
pnpm exec wrangler login
```

本地调试先复制不含值的示例，然后填写 `.dev.vars`：

```powershell
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

所需值为：

```dotenv
ADMIN_PATH=<随机 URL 安全路径段>
ADMIN_SECRET=<独立生成的高强度管理密钥>
CODEX_RELAY_URL=https://<你控制并审计的 relay>/backend-api/codex/responses
DATA_ENCRYPTION_KEY=<32 个随机字节的 base64url 编码>
```

首次部署可把同样的值写入不会提交到 Git 的 `.env.production`，再让 Wrangler 同时
上传代码与 secrets：

```powershell
pnpm exec wrangler deploy --secrets-file .env.production
```

已有 secrets 的后续部署运行 `pnpm deploy`。不要提交 `.dev.vars` 或
`.env.production`；`.gitignore` 会忽略实际 secret 文件。

## OAuth 自动刷新

Cron Trigger 每 10 分钟读取并解密 `oauth`。access token 距离过期不足 15 分钟时，
Worker 使用 refresh token 请求 OpenAI token endpoint；瞬时网络错误、HTTP 429 或
5xx 最多尝试三次，每次上游请求最长 10 秒。成功后保留账户信息，用新 IV 覆盖
`oauth`。普通 API 请求不会主动刷新，避免多个边缘位置同时消费旋转式 refresh
token。

## KV 一致性

OAuth 与 API Key 常规读取使用最低的 `cacheTtl: 30`。Workers KV 是最终一致存储，
其他边缘位置可能在短时间内继续看到旧值，因此启停、轮换、删除 Key 和退出 OAuth
都不是全局瞬时生效。需要严格即时吊销时应改用强一致存储。

`API_KEYS` 是单条合并记录，管理端每次修改只写一次；遇到同键每秒写入限制时会进行
有限退避重试。并发管理员仍可能发生最后写入者覆盖，因而该面板面向低频、单管理员
配置。如果需要并发编辑或事务语义，应迁移到 Durable Object 或 D1。

## 敏感信息处理

- Worker 没有模块级 OAuth、API Key 或管理会话缓存；
- 日志只记录固定事件与错误 code；
- Worker 生成的错误不包含 token、API Key、主密钥、IV 或密文；
- 管理 HTML 使用每次响应生成的 CSP nonce，禁止跨站 framing；
- 测试在隔离的 Workers runtime 中使用虚拟凭据。

`CODEX_RELAY_URL` 必须指向你控制并审计的 HTTPS relay。relay 会接收 OAuth Bearer、
账户 ID、请求与响应内容，必须禁用敏感日志并限制入口。最小 Caddy 反代示例：

```caddyfile
your-relay.example.com {
	reverse_proxy https://chatgpt.com {
		header_up -CF-Worker
	}
}
```

## 检查

```powershell
pnpm check
```

平台行为参考：[KV 读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、
[KV 写入](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、
[KV 删除](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/)、
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 和
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
