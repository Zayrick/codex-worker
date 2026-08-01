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
KV 数据。`OAUTH_MASTER_KEY` 是唯一的 Worker Secret，必须是 32 个随机字节的
base64url 编码。浏览器设备登录页通过查询参数 `secret` 校验这个值。

项目没有管理员 key、管理员角色、API key 管理接口或手动 OAuth 刷新接口。所有
`API-*` 的新增、修改和删除都只在 Cloudflare 面板完成。

## API

健康检查不需要凭据：

- `GET /healthz`：仅在已保存的 OAuth 凭据可解密且尚未过期时返回空正文
  `204`；不健康或检查失败时只在 Worker 日志记录安全错误码，对外返回空正文
  `404`。

浏览器设备登录不接受、也不需要 `API-*` 值：

- `GET /auth/device/start?secret=<OAUTH_MASTER_KEY>`：返回设备登录 HTML 页面；
- `GET /auth/device/poll?secret=...&state=...`：页面内部的状态检查地址。

这两个地址缺少 `secret` 或 `secret` 错误时均返回空正文 `404`。

用户只需访问 `start`。Worker 返回的页面只显示设备码和 OpenAI 验证链接，并通过
隐藏的状态 iframe 按服务端给出的间隔自动访问 `poll`；无需手动构造 `state` 或
调用 `poll`。登录成功后，设备登录页会自动关闭。

需要任意一个 `API-*` 值：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`

客户端可使用 `Authorization: Bearer sk-...` 或 `X-Api-Key: sk-...`。Responses
直接返回 Codex SSE；Chat Completions 根据 `stream` 返回 JSON 或 SSE。
缺少或提交错误 API key 时返回空正文 `404`。API key 通过后，上游的错误状态、
正文与响应头保持透传。

除此之外的全部路径与方法（包括 `/`、未列出的 `/v1/*`、错误方法和
`OPTIONS`）均返回空正文 `404`。Worker 自己生成的 `404` 与健康检查 `204` 不附带
HTML、JSON 或说明文本。

设备登录只在 KV 中不存在 `oauth` 时开放，防止请求覆盖已经配置的 OAuth。

## 部署与登录

`wrangler.jsonc` 声明了自动预配的 `AUTH_KV`、必需的
`OAUTH_MASTER_KEY` Secret，以及每 10 分钟执行一次的 Cron Trigger。若要绑定
已有 namespace，可为 `kv_namespaces` 补充 `id`。

安装依赖、登录 Cloudflare 并部署：

```powershell
pnpm install
pnpm exec wrangler login
pnpm deploy
```

然后在 Cloudflare 面板中完成以下配置：

1. 为 Worker 设置 Secret `OAUTH_MASTER_KEY`；
2. 在绑定的 KV namespace 中新增 `API-<id>`，值设为准备让客户端提交的 key，
   例如 `sk-...`。

部署后直接在浏览器访问：

```text
https://your-worker.example.com/auth/device/start?secret=<OAUTH_MASTER_KEY>
```

点击页面显示的验证链接，在新标签页完成 OpenAI 验证，同时保留设备登录页。
浏览器会自动轮询，成功后自动关闭设备登录页。项目没有额外的 Node.js 登录脚本、
前端构建步骤或本地凭据文件；OAuth token 由 Worker 直接加密写入 KV。

若需重新登录，先在 Cloudflare 面板删除 `oauth`，等待 KV 变更传播，再运行
上述浏览器地址。API key 的轮换或吊销同样只在面板修改对应的 `API-<id>`。

## 自动刷新

Cron Trigger 每 10 分钟读取并解密 `oauth`。access token 距离过期不足 15 分钟
时，Worker 使用 refresh token 请求 OpenAI token endpoint；瞬时网络错误、HTTP
429 和 5xx 最多重试三次。成功后保留必要账户字段，使用新 IV 加密并覆盖
`oauth`。

请求路径不会刷新 token，也不存在手动刷新 API，避免多个边缘位置同时消费旋转式
refresh token。

## KV 最终一致性

API key 和 OAuth 的常规读取使用 `cacheTtl: 30`。Workers KV 是最终一致存储，
因此通过面板新增、修改或删除后，其他边缘位置可能需要一段时间才能看到变更：

- 新增 key 后等待传播再切换客户端；
- 吊销 key 后，旧值可能在短时间内继续有效；
- 重新登录前删除 `oauth` 后，等待变更传播再启动设备登录。

若需要严格的即时吊销语义，应改用强一致存储。

## 敏感信息处理

- Worker 没有模块级 OAuth 或 API key 缓存；
- 日志只记录刷新状态、固定错误 code 和计划时间；
- Worker 自己生成的错误响应不包含 OAuth token、API key、主密钥、IV 或密文；
- 已通过 API key 鉴权的请求会按设计原样收到上游错误响应；
- `.dev.vars*` 和 `.env*` 被 Git 忽略；
- 测试通过隔离的 Workers 测试环境注入虚拟凭据，不读取真实用户凭据。

## Caddy relay

`wrangler.jsonc` 默认配置
`https://codex-relay.oxio.uno/backend-api/codex/responses`。

```caddyfile
codex-relay.oxio.uno {
	reverse_proxy https://chatgpt.com {
		header_up -CF-Worker
	}
}
```

Cloudflare 会给 Worker 子请求添加 `CF-Worker`，而 ChatGPT 可能拒绝该请求；Caddy
通过建立新的上游连接解决这一问题。

## 检查

```powershell
pnpm exec wrangler types --check
pnpm exec tsc -p tsconfig.json
pnpm exec vitest run
pnpm exec wrangler deploy --dry-run
```

平台行为参考：[KV 列举](https://developers.cloudflare.com/kv/api/list-keys/)、
[KV 读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、
[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、
[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 和
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
