# codex-worker

Cloudflare Worker 上的 OpenAI 兼容 Codex API。它读取 Codex CLI 的
`auth.json`，通过 Caddy relay 请求 ChatGPT Codex 后端。

```text
OpenAI client → Cloudflare Worker → Caddy → ChatGPT Codex
```

## API

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /healthz`

Responses 始终直接返回 Codex SSE，不聚合为 JSON。Chat Completions 根据客户端
`stream` 返回 JSON 或 SSE，并兼容 system/developer 消息、函数工具、图片输入、
结构化输出和 usage。

`GET /v1/models` 会请求 relay 的 `/backend-api/codex/models`，并将上游
Codex 模型目录原样返回。查询参数会透传，但认证、会话、请求追踪和指纹类参数
会被丢弃。上游必需的 `client_version` 优先取查询参数，其次取 `Version` 请求头，
两者都没有时使用 CLIProxyAPI 的默认值 `0.144.1`。项目不再维护静态模型列表、
模型别名或单模型查询结果。

## 上游请求

- 只主动设置 `Authorization`、`Accept`、必要时的 `Content-Type`，以及认证文件
  中存在时的 `Chatgpt-Account-Id`；
- 可透传 `Version`、`X-Codex-Beta-Features` 和
  `X-Codex-Turn-Metadata`；
- 不生成或转发 `X-Request-Id`、`X-Client-Request-Id`、
  `Session_id`、`Conversation_id`、`prompt_cache_key`、`User-Agent`
  或 `Originator`；
- 不注入默认系统提示词。客户端提供的 `instructions` 会保留，Chat Completions
  中的 system 消息只做 Codex 必需的 `developer` 角色转换；
- Responses 请求默认透传其他字段，只删除 Codex 不支持或带身份/会话状态的字段。
  同时按上游要求固定 `stream: true`、`store: false`、
  `parallel_tool_calls: true` 和
  `include: ["reasoning.encrypted_content"]`。

## 本地运行

```powershell
pnpm install
node scripts/import-auth.mjs local
pnpm dev
```

该导入命令默认读取当前用户主目录下的 `.codex/auth.json`，将认证信息写入
被 Git 忽略的 `.dev.vars`，且不会打印 token。如需使用其他认证文件，可将其
路径作为最后一个参数传入。

Chat Completions 示例：

```powershell
$body = @{
  model = "gpt-5.6-luna"
  reasoning_effort = "low"
  messages = @(@{ role = "user"; content = "只回复：ok" })
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/v1/chat/completions" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Responses 示例：

```powershell
$body = @{
  model = "gpt-5.6-luna"
  input = "只回复：ok"
  reasoning = @{ effort = "low" }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/v1/responses" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

## 部署

```powershell
pnpm exec wrangler login
node scripts/import-auth.mjs remote
pnpm deploy
```

可选配置：

- `PROXY_API_KEY`：要求客户端发送 Bearer token 或 `X-Api-Key`；
- `CORS_ORIGIN`：浏览器允许的 Origin，默认 `*`。

生产环境建议配置 `PROXY_API_KEY`：

```powershell
pnpm exec wrangler secret put PROXY_API_KEY
```

## Caddy relay

`wrangler.jsonc` 已配置
`https://codex-relay.oxio.uno/backend-api/codex/responses`。

```caddyfile
codex-relay.oxio.uno {
	reverse_proxy https://chatgpt.com {
		header_up -CF-Worker
	}
}
```

Cloudflare 会给 Worker 子请求添加 `CF-Worker`，而 ChatGPT 会拒绝该请求；
Caddy 通过建立新的上游连接解决这一问题。

## 认证行为

- 只使用 `tokens.access_token` 和 `tokens.account_id`；
- 不执行 token 刷新；
- token 过期或被拒绝时，需要重新执行上面的本地或远程认证导入命令；
- `auth.json` 不会写入源码或日志。

## 限制

- 使用的是 ChatGPT 内部接口，其行为可能变化；
- 上游不接受 token limit、采样、截断、用户和上下文管理等兼容参数，这些字段会在
  转发前删除；
- 当前 Caddy relay 没有额外鉴权，是公开的固定目标反向代理。

## 检查

```powershell
pnpm exec tsc -p tsconfig.json
pnpm exec vitest run
```
