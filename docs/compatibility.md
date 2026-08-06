# OpenAI、Codex 与 Cloudflare 兼容边界

本文档以 `.reference/codex` 的请求类型和传输实现为 Codex 协议依据，以
`.reference/CLIProxyAPI` 为扩展路由参考，并以当前 Cloudflare 官方文档为平台边界。
这里的“兼容”分为三种，不应混为一谈：

- **协议转换**：Worker 理解请求与响应结构，并生成目标 API 的输出；
- **Codex 原生映射**：Worker 把公开路径映射到 ChatGPT Codex 原生路径；Responses
  请求只执行明确列出的角色兼容改写；
- **传输透传**：Worker 提供鉴权、HTTP/WebSocket 和流式传输，但具体协议与模型是否
  可用取决于 ChatGPT relay 及 OpenAI 直连上游。

## 路由矩阵

除 `OPTIONS` 外，下表中的请求都需要 `API_KEYS` 加密记录中已启用的下游 Key。表中已写明
方法的路由只接受该方法；Realtime sideband 还必须是 WebSocket Upgrade。图片与明确的
Codex 直连别名可传输常规 HTTP 方法，`CONNECT` 一律不开放。

| 客户端路径 | 级别 | Worker 行为与边界 |
| --- | --- | --- |
| `GET /v1/models` | 协议转换 | 读取 Codex 模型目录并输出 OpenAI model list；带 `client_version` 查询参数时保留 Codex CLI 目录格式。 |
| `POST /v1/chat/completions` | 协议转换 | Chat 请求转换为 Responses；普通响应转换为 JSON，`stream: true` 转换为 Chat SSE。 |
| `POST /v1/completions` | 协议转换 | 旧版 prompt 转为 Responses，并输出 `text_completion` JSON/SSE。当前只支持字符串或单项字符串数组、`n=1`、`best_of=1`；不伪造多候选、token-id prompt 或完整 logprobs 语义。 |
| `POST /v1/responses`、`POST /v1/responses/compact` | Codex 原生映射 | 路径映射到 `/backend-api/codex/responses*`，并把顶层 `input` 数组中 `role: "system"` 的项改为 `developer`。Responses 创建请求还固定 `store: false`，移除 Codex 不支持的生成参数、`context_management` 与 `user`，并只保留 `service_tier: "priority"`；compact 不应用创建参数策略。 |
| `GET /v1/responses` + `Upgrade: websocket` | Codex 原生映射 | 建立双向 WebSocket 桥；`response.create` 应用 Responses 创建策略，`response.append` 只执行顶层 `input` 角色改写，其他帧保持不变。 |
| `/v1/images/generations`、`/v1/images/edits` | Codex 原生映射 | 映射到 `/backend-api/codex/images/*`。JSON、multipart 图片上传、SSE/JSON/二进制下载都按流处理；其他 `/v1/images/*` 动作是否存在由上游决定。 |
| `POST /v1/messages` | 协议转换 | Anthropic Messages 请求转换为 Codex Responses；非流式结果转换为 Message JSON，`stream: true` 转换为带命名事件的 Anthropic SSE。支持 system、文本、图片、文档、thinking signature、客户端工具、工具结果、Web Search 块、tool choice、thinking effort、usage、stop reason 和 Anthropic error envelope。 |
| `POST /v1/messages/count_tokens` | 本地转换 | 使用与创建请求相同的结构转换，再以本地 `cl100k_base` tokenizer 估算 `input_tokens`；不会访问 Anthropic token-count 服务，结果不保证与 Anthropic 自有 tokenizer 完全一致。 |
| `POST /v1/alpha/search` | Codex 原生映射 | 映射到 `/backend-api/codex/alpha/search`。 |
| `POST /v1/live` | Codex 原生映射 | 映射到 `/backend-api/codex/realtime/calls`；缺少时补 `intent=quicksilver` 与 `architecture=avas`。标准 multipart `sdp + session` 会转为 Codex JSON。 |
| `GET /v1/live/{call_id}` | Codex 专用传输 | Sideband WebSocket 依据本地 Codex/CLIProxyAPI 实现直连 `api.openai.com` 的对应 `/v1/live/*` 路径；事件帧不转换。 |
| `POST /v1/realtime/calls` | Codex 原生映射 | 与 `/v1/live` 使用同一 bootstrap 映射、multipart 适配和默认查询参数。 |
| `GET /v1/realtime?call_id=...`、`GET /v1/realtime/calls/{call_id}` | Codex 专用传输 | Sideband WebSocket 直连 `api.openai.com` 的 Realtime 路径；Worker 写入保存的 OAuth/账户头但不转换事件帧，并只保留经校验的 `call_id` 与规范化的 `intent` 查询参数。 |
| `GET /v1beta/models`、`GET /v1beta/models/{model}` | 协议转换 | Codex 模型目录转换为 Gemini Model 资源。 |
| `POST /v1beta/models/{model}:generateContent` | 协议转换 | Gemini Content、system instruction、内联/URI 媒体、function call/result、工具声明与 tool config 转为 Codex Responses；终态转为 Gemini candidates、parts、usageMetadata 和 finishReason。 |
| `POST /v1beta/models/{model}:streamGenerateContent` | 协议转换 | 与 generateContent 使用同一请求转换，Codex SSE 增量转换为 Gemini SSE `data` 事件；流内失败使用 Google 风格 error envelope。 |
| `POST /v1beta/models/{model}:countTokens` | 本地转换 | 支持顶层 `contents` 或嵌套 `generateContentRequest`，返回本地估算的 `totalTokens`。 |
| `/backend-api/codex/*` | Codex CLI 直连别名 | 原样传输路径和查询参数；其中 Responses、compact 和 Responses WebSocket 采用上面相同的角色规则，其他正文流不解析。 |

视频 API、`/openai/v1/videos/*`、`/v1beta/interactions`、未知 Gemini action 和其他未列出
的供应商路径不注册路由，返回空正文 `404`。`.reference/CLIProxyAPI` 的视频实现依赖
供应商专用执行器，Interactions 也有独立的供应商鉴权面；它们不能仅凭 ChatGPT Codex
OAuth 安全地映射到 Responses。低层 `/backend-api/codex/*` 别名仍只代表调用方明确选择
Codex 私有路径，不承诺该私有 action 一定存在。

Messages 字段与事件顺序以 Anthropic 的
[Messages API](https://platform.claude.com/docs/en/api/messages/create)、
[streaming events](https://platform.claude.com/docs/en/build-with-claude/streaming)、
[error schema](https://platform.claude.com/docs/en/api/errors) 和
[token counting](https://platform.claude.com/docs/en/api/messages/count_tokens) 为边界。
Gemini action 与 Content/Part 结构以 Google 的
[generateContent API](https://ai.google.dev/api/generate-content) 和
[countTokens API](https://ai.google.dev/api/tokens) 为边界。转换规则同时对照
`.reference/CLIProxyAPI`，Codex 请求与目标路径只依据 `.reference/codex`。

Responses 创建请求始终把 `store` 覆盖为 `false`，并在出站边界移除
`max_completion_tokens`、`max_output_tokens`、`maxOutputTokens`、`max_tokens` 和
`context_management`，同时移除 `temperature`、`top_p`、`truncation`、`user`；
`service_tier` 仅在严格等于 `priority` 时保留。其他未知字段不据此删除，也不会根据
`prompt_cache_key` 等正文字段推导请求头。Responses 与 compact 都会把顶层 `input`
消息项的 `system` 改为 `developer`。正文无需变化时会保留原始编码（包括
`Content-Encoding: zstd`）；需要改写时则重新编码为 JSON。

旧版 Completions 当前实际解释 `model`、`prompt`、`stream`、`echo`、`n`、`best_of`，
并传递 metadata、prompt cache、reasoning、service tier 和 stream usage 选项。
`max_tokens`、`temperature`、`top_p`、`stop`、`suffix`、penalty、`logit_bias`、`seed`、
`user` 与 logprobs 不会传入 Codex；输出中的 `logprobs` 为 `null`。依赖这些采样或
token 级语义的调用方不应把该路径视为完全等价的传统模型后端。

Messages 会校验必需的 `model`、`messages` 与 `max_tokens`，但 Codex OAuth Responses
不接受等价的 Anthropic token/sampling 控件，因此 `max_tokens`、`temperature`、`top_p`、
`top_k`、`stop_sequences` 和 metadata 不转发；`cache_control` 也不伪造 Anthropic prompt
cache 语义。Gemini 的 `generationConfig` 同样只转换 thinking level/budget，采样、候选数、
停止序列与输出 MIME/schema 不送入 Codex。两种协议都会保留可安全往返的 Codex
reasoning encrypted signature；其他供应商生成的签名不会冒充 Codex 签名重放。

## 正文与流式传输

Responses 与 compact 为执行角色改写而有界解析 JSON；Live/Realtime bootstrap 会解析
multipart `sdp + session`。其他透明路由不会调用 `request.json()`、`formData()` 或
`arrayBuffer()`，图片或实时音频正文直接作为 `ReadableStream` 交给 relay。以下信息
会保留：

- HTTP 方法、查询参数、`Content-Type`、multipart boundary、`Range`、幂等键和
  协议版本头；
- 上游的内容类型、内容长度/范围、下载文件名、ETag、请求 ID、重试时间和
  WebSocket 子协议；
- SSE、JSON、图片和其他二进制响应正文的背压与流式传输。

Worker 会删除客户端的 `Authorization`、`X-Api-Key`、`X-Goog-Api-Key`、Cookie、
Origin/Referer、客户端提交的 ChatGPT 账户 ID、转发/IP、hop-by-hop 和 Cloudflare
内部请求头，再写入保存的 OAuth Bearer 与账户 ID。响应侧会删除 Cookie、Server、
Cloudflare 内部头和 hop-by-hop 头，并强制 `Cache-Control: no-store`。
重定向使用 `manual`，避免 OAuth 在未知重定向目标上自动重放。

Live multipart 适配的正文上限为 16 MiB。需要解析或检查角色的 Chat、Completions、
Messages、Gemini、Responses 与 compact JSON 受项目自身 4 MiB 编码体/解压体上限
约束；图片、Realtime 和其他 Codex 原生别名路径不受这个应用层 JSON 上限约束，但仍受
Cloudflare 请求体与资源限制。

## WebSocket 行为

对 Responses 发起 WebSocket Upgrade 时，Worker 使用带 `Upgrade: websocket` 的上游
`fetch()`，再用一对本地 socket 桥接上下游。Codex 请求帧的边界如下：

- 客户端文本帧为有效的 `response.create` 或 `response.append` JSON 时视为 Responses
  请求；Worker 保留事件类型及其他字段，只将顶层 `input` 中的 `role: "system"`
  改为 `developer`；
- 其他客户端文本帧、所有二进制帧和全部上游帧保持原内容；
- close code、close reason 和协商出的 `Sec-WebSocket-Protocol` 在两端转交；
- 上游拒绝握手时，其 HTTP 状态与正文经安全响应头过滤后返回；
- `/v1/responses` 的普通 `GET` 不是 REST 操作，缺少 Upgrade 时继续隐藏为 `404`。

Realtime、Live sideband 等其他透明 WebSocket 路径仍直接交接专用上游
`Response.webSocket`，不进入 Responses 帧适配。

下游握手仍须提供本项目支持的 API-key header；服务端 SDK 和 Codex CLI 可以设置
`Authorization`。浏览器原生 `WebSocket` 构造器不能自定义该 header，本项目不会把
长期 key 放进 URL 或自定义子协议；浏览器实时音视频应先通过受控 HTTP bootstrap
取得会话，再使用 WebRTC/临时凭据，或由可信后端建立 sideband WebSocket。

Cloudflare 当前规定 Worker 收到的单条 WebSocket 消息最大为 32 MiB；更大的消息会
以 `1009` 关闭。HTTP 请求在客户端保持连接时没有固定 wall-time 上限，但连接仍受
客户端断开、上游关闭、CPU、内存与账户限制影响。参见
[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
与 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。

## Realtime 媒体面边界

`/v1/live` 和 `/v1/realtime/calls` 的 HTTP bootstrap，以及 sideband WebSocket，属于
信令/控制面，适合由 Worker 转交。参考项目可选的 Pion relay 还包含 UDP
RTP/RTCP 媒体面；它不能直接移植进普通 Worker：Workers 的公开协议面提供入站
HTTP/WebSocket 和出站 HTTP/TCP，没有通用 UDP socket API。

因此音视频媒体应继续由客户端直连供应商，或部署在外部 TURN/SFU/媒体 relay。若要
使用 Cloudflare 承载媒体面，应采用专门的
[Realtime TURN](https://developers.cloudflare.com/realtime/turn/) 或 Realtime SFU，
而不是在此 Worker 中缓冲媒体包。

## relay 路由要求

`CHATGPT_RELAY_URL` 配置 ChatGPT relay 的 HTTPS origin。Worker 自动附加
`/backend-api/codex/*` 与 `/backend-api/wham/usage`，反代服务不需要再识别或替换
`/responses`、`/models`、`/usage` 等路径。Messages 与 Gemini 的结构转换仍统一提交到
ChatGPT relay 的 `/backend-api/codex/responses`。

OAuth 设备登录、token 交换和刷新直接访问 `auth.openai.com`，管理页的验证网址也保持
`https://auth.openai.com/codex/device`。Realtime/Live sideband 直接访问
`api.openai.com`。这些直连请求与 ChatGPT relay 请求都只发送所需的上游 OAuth 与协议
头，不转发下游 API key、Cookie 或客户端账户头。Caddy 反向代理 ChatGPT WebSocket 时
须保留 Upgrade、子协议、流式正文与手动重定向语义。

## Cloudflare 平台限制

截至本文更新时，官方限制中与本代理最相关的是：

- 每个 isolate 128 MB 内存；每个请求最多 6 个同时等待的出站连接；
- URL 16 KB，请求与响应 header 各 128 KB；
- 请求体上限由 Cloudflare 账户套餐决定：Free/Pro 100 MB、Business 200 MB、
  Enterprise 默认 500 MB；
- Worker 响应正文无强制大小上限，但若经过 CDN 缓存仍有缓存对象上限；本项目的
  API 响应不应缓存；
- HTTP 请求 wall time 无固定上限，等待网络 I/O 不计入 CPU time，但转换工作与
  JavaScript 缓冲仍计入 CPU/内存。

实现因此优先使用
[Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) 透传大正文，
并遵循 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
与 [支持协议表](https://developers.cloudflare.com/workers/reference/protocols/)。部署账户
的 WAF、自定义 body-size、CPU 和并发策略还可能设置更低的实际边界。
