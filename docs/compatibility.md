# OpenAI、Codex 与 Cloudflare 兼容边界

本文档以 `.reference/CLIProxyAPI` 的路由和执行器为行为参考，并以当前 Cloudflare
官方文档为平台边界。这里的“兼容”分为三种，不应混为一谈：

- **协议转换**：Worker 理解请求与响应结构，并生成目标 API 的输出；
- **Codex 原生映射**：Worker 不解释大正文，只把公开路径映射到 ChatGPT Codex
  原生路径并流式转交；
- **传输透传**：Worker 提供鉴权、HTTP/WebSocket 和流式传输，但具体协议、模型与
  OAuth 是否可用取决于 `CODEX_RELAY_URL` 所指向的 relay。

## 路由矩阵

除 `OPTIONS` 外，下表中的请求都需要有效的下游 `API-*` key。透明路由接受
`GET`、`HEAD`、`POST`、`PUT`、`PATCH` 和 `DELETE`；`CONNECT` 不开放。

| 客户端路径 | 级别 | Worker 行为与边界 |
| --- | --- | --- |
| `GET /v1/models` | 协议转换 | 读取 Codex 模型目录并输出 OpenAI model list；带 `client_version` 查询参数时保留 Codex CLI 目录格式。 |
| `POST /v1/chat/completions` | 协议转换 | Chat 请求转换为 Responses；普通响应转换为 JSON，`stream: true` 转换为 Chat SSE。 |
| `POST /v1/completions` | 协议转换 | 旧版 prompt 转为 Responses，并输出 `text_completion` JSON/SSE。当前只支持字符串或单项字符串数组、`n=1`、`best_of=1`；不伪造多候选、token-id prompt 或完整 logprobs 语义。 |
| `POST /v1/responses` | Codex 原生适配 | 应用 Codex 请求策略并返回原生 SSE。 |
| `POST /v1/responses/compact` | Codex 原生适配 | 映射到 Codex compact，并返回上游 JSON。 |
| `GET /v1/responses` + `Upgrade: websocket` | Codex 原生映射 | 将 Responses WebSocket 握手和后续帧直接交给上游；不做帧级协议转换。 |
| `/v1/images/generations`、`/v1/images/edits` | Codex 原生映射 | 映射到 `/backend-api/codex/images/*`。JSON、multipart 图片上传、SSE/JSON/二进制下载都按流处理；其他 `/v1/images/*` 动作是否存在由上游决定。 |
| `/v1/videos/*` | 传输透传 | 方法、查询参数、正文和流式响应转交同源 relay。参考项目中的视频执行器是供应商专用实现；本 Worker 不把 Codex Responses 翻译成视频 API。 |
| `/openai/v1/videos/*` | 传输透传 | 保留参考项目的 OpenAI Videos 别名，包括创建、轮询和 `/content` 下载。 |
| `/v1/messages`、`/v1/messages/count_tokens` | 传输透传 | 提供 Anthropic 风格路径和请求头传输，不进行 Messages ↔ Responses 的结构转换。relay 必须实现目标协议。 |
| `POST /v1/alpha/search` | Codex 原生映射 | 映射到 `/backend-api/codex/alpha/search`。 |
| `POST /v1/live` | Codex 原生映射 | 映射到 `/backend-api/codex/realtime/calls`；缺少时补 `intent=quicksilver` 与 `architecture=avas`。标准 multipart `sdp + session` 会转为 Codex JSON。 |
| `/v1/live/*` | 传输透传 | 用于 call 状态或 sideband WebSocket；relay 负责路由到实际实时服务。 |
| `POST /v1/realtime/calls` | Codex 原生映射 | 与 `/v1/live` 使用同一 bootstrap 映射、multipart 适配和默认查询参数。 |
| `/v1/realtime`、`/v1/realtime/*` | 传输透传 | 支持普通 HTTP 与 WebSocket Upgrade；Worker 不转换 Realtime 事件。 |
| `/v1beta/*` | 传输透传 | 覆盖 Gemini 风格 models、interactions 及其 action 路径；协议和 OAuth 语义由 relay 实现。 |
| `/backend-api/codex/*` | Codex CLI 直连别名 | 保留路径与查询参数。`responses`、`responses/compact` 仍走本项目已有的请求策略；其他子路径透明传输。 |

这张表表示 Worker 能做什么，不表示单一 ChatGPT OAuth 对所有供应商 API 都有权限。
尤其是 `/v1/videos/*`、`/v1/messages*` 和 `/v1beta/*`：路由存在且传输兼容，但若
relay 只反代 `chatgpt.com`，上游仍可能返回 `401`、`404` 或协议错误。

旧版 Completions 当前实际解释 `model`、`prompt`、`stream`、`echo`、`n`、`best_of`，
并传递 metadata、prompt cache、reasoning、service tier 和 stream usage 选项。
`max_tokens`、`temperature`、`top_p`、`stop`、`suffix`、penalty、`logit_bias`、`seed`、
`user` 与 logprobs 不会传入 Codex；输出中的 `logprobs` 为 `null`。依赖这些采样或
token 级语义的调用方不应把该路径视为完全等价的传统模型后端。

## 图片与其他非 JSON 请求

除 Live/Realtime bootstrap 的 multipart `sdp + session` 适配外，透明路由不会调用
`request.json()`、`formData()` 或 `arrayBuffer()`。图片、视频或音频正文直接作为
`ReadableStream` 交给 relay，因此不会把这些媒体完整放进 Worker 的 128 MB isolate
内存。以下信息会保留：

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

Live multipart 适配沿用参考实现的 16 MiB 上限。需要解析并转换的 Chat、
Completions、Responses 和 compact JSON 仍受项目自身 4 MiB 编码体/解压体上限约束；
透明图片、视频、Messages、v1beta 和别名路径不受这个
应用层 JSON 上限约束，但仍受 Cloudflare 请求体与资源限制。

## WebSocket 行为

对已知透明路径发起 WebSocket Upgrade 时，Worker 使用带 `Upgrade: websocket` 的
上游 `fetch()`，再把 `Response.webSocket` 直接放入客户端 `101` 响应。这种直接交接有
几个明确性质：

- 文本帧、二进制帧、close code 和协商出的 `Sec-WebSocket-Protocol` 不经 JSON
  序列化；
- Worker 不调用 `accept()`、不读取或重写帧，也不维护两套 socket，因此避免每条
  消息在 JavaScript 内存中再次缓冲；
- 上游拒绝握手时，其 HTTP 状态与正文经安全响应头过滤后返回；
- `/v1/responses` 的普通 `GET` 不是 REST 操作，缺少 Upgrade 时继续隐藏为 `404`。

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
信令/控制面，适合由 Worker 和 relay 转交。参考项目可选的 Pion relay 还包含 UDP
RTP/RTCP 媒体面；它不能直接移植进普通 Worker：Workers 的公开协议面提供入站
HTTP/WebSocket 和出站 HTTP/TCP，没有通用 UDP socket API。

因此音视频媒体应继续由客户端直连供应商，或部署在外部 TURN/SFU/媒体 relay。若要
使用 Cloudflare 承载媒体面，应采用专门的
[Realtime TURN](https://developers.cloudflare.com/realtime/turn/) 或 Realtime SFU，
而不是在此 Worker 中缓冲媒体包。

## relay 路由要求

`CODEX_RELAY_URL` 必须以 `/backend-api/codex/responses` 结尾。Worker 从它派生两类
目标：

1. Codex 原生路径使用同一 origin 下的 `/backend-api/codex/*`；
2. 传输透传路径使用同一 origin 下客户端提交的 `/v1/*`、`/v1beta/*` 或
   `/openai/v1/videos/*`。

因此 relay 需要按路径把 Codex、OpenAI Realtime、视频供应商、Messages 或 Gemini
协议送到各自真正的服务，并确保当前 OAuth/供应商凭据适用。README 中只指向
`chatgpt.com` 的最小 Caddy 示例，仅足以说明 Codex relay 的网络边界，不会自动获得
其他供应商的协议能力。Caddy 能反向代理 WebSocket，但仍须保留 Upgrade、子协议、
流式正文与手动重定向语义。

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
