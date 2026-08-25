# API 与协议兼容性

## 1. 兼容范围

Codex Worker 通过协议转换、Codex 原生映射和透明传输提供多种客户端接口。本文描述的是当前
仓库代码与测试所保证的行为；具体模型、额度和私有 Codex action 是否可用，仍取决于 OpenAI
账户、ChatGPT relay 和上游服务。

兼容级别定义如下：

| 级别 | 含义 |
| --- | --- |
| 协议转换 | Worker 解析请求，转换为 Codex Responses，并生成目标协议的响应 |
| 原生映射 | Worker 将公开路径映射到 Codex 路径，并执行有限的请求规范化 |
| 透明传输 | Worker 负责鉴权、header 策略和流式传输，不承诺上游 action 可用 |
| 本地处理 | Worker 在本地完成计算，不访问协议供应商的对应服务 |

本项目不声明完整的 OpenAI、Anthropic 或 Gemini API 兼容性。未在本文列出的供应商路径不属于
公开契约。

## 2. 鉴权与通用行为

除健康检查、已知 API 的预检请求、管理入口和 Backend API 凭据代理外，所有公开 API 都要求一个
已启用的下游 API Key。支持以下 header，选择优先级固定：

1. `Authorization: Bearer <key>`；
2. `X-Api-Key: <key>`；
3. `X-Goog-Api-Key: <key>`。

同时提供多个 header 时，Worker 只验证优先级最高的值，不会在验证失败后回退。缺失、错误或
已停用的 Key 返回空正文 `404`。

已知公开路径的 `OPTIONS` 请求无需鉴权，返回 `204` 并应用 `CORS_ORIGIN`。管理路由不启用
CORS。

### 健康检查

| 方法与路径 | 鉴权 | 行为 |
| --- | --- | --- |
| `GET /healthz` | 无 | OAuth 可读取、可解密且未过期时返回空正文 `204`；其他情况返回空正文 `404` |

健康检查不验证 relay 可达性，也不发起上游请求。

## 3. OpenAI 与 Codex 路由

| 方法与路径 | 级别 | 行为 |
| --- | --- | --- |
| `GET /v1/models` | 协议转换 | 读取 Codex 模型目录并返回 OpenAI model list |
| `POST /v1/chat/completions` | 协议转换 | Chat 请求转换为 Responses；返回 Chat JSON 或 SSE |
| `POST /v1/completions` | 协议转换 | legacy prompt 转换为 Responses；返回 `text_completion` JSON 或 SSE |
| `POST /v1/responses` | 原生映射 | 映射到 `/backend-api/codex/responses` 并应用 Responses 创建策略 |
| `POST /v1/responses/compact` | 原生映射 | 映射到 Codex compact，仅应用 input 角色规范化 |
| `GET /v1/responses` + WebSocket Upgrade | 原生映射 | 建立 Responses 双向 WebSocket bridge |
| `/v1/responses/*` 其他子路径 | 透明传输 | 映射到同名 Codex 子路径；上游决定是否支持 |
| `/v1/images[/…]` | 透明传输 | 映射到 `/backend-api/codex/images[/…]`，支持流式 JSON、multipart 和二进制正文 |
| `/v1/alpha/search` | 透明传输 | 映射到 `/backend-api/codex/alpha/search` |
| `POST /v1/live` | 原生映射 | 映射到 Codex Realtime call bootstrap，并补充缺失的默认查询参数 |
| `POST /v1/realtime/calls` | 原生映射 | 与 `/v1/live` 使用相同的 bootstrap 逻辑 |
| `GET /v1/live/{call_id}` + WebSocket Upgrade | 透明传输 | 直连 `api.openai.com` 的 Live sideband |
| `GET /v1/realtime?call_id=…` + WebSocket Upgrade | 透明传输 | 校验 `call_id` 后直连 Realtime sideband |
| `GET /v1/realtime/calls/{call_id}` + WebSocket Upgrade | 透明传输 | 直连对应 Realtime sideband |
| `/backend-api/codex[/…]` | 透明传输 | Codex CLI 低层别名；Responses 根路径仍使用专用策略 |

一般透明代理路径拒绝 `CONNECT`；`OPTIONS` 由预检逻辑处理。除表中明确限制方法的路径外，
路由层允许其他 HTTP 方法，上游能力仍由目标 action 决定。

### Backend API 凭据代理

Host 与 `AUTH_PROXY_HOST` 匹配的 `/backend-api` 路径族使用 `CHATGPT_RELAY_URL` 作为上游，
保留请求方法、路径、Query、流式正文和端到端 header，并直接返回上游 HTTP、SSE 或 WebSocket
响应。该路由独立于公开 API Key 鉴权和协议转换。

管理端维护代理账户的名称、`account_id`、启用状态和独立 OAuth。请求中的
`ChatGPT-Account-ID` 精确匹配一条已启用记录时，Worker 优先使用该记录自己的有效 OAuth；
该记录尚未登录、Token 已过期或凭据缺少账户 ID 时自动回退到主 Codex OAuth。
两者都会替换请求中已有的 `Authorization` 和 `ChatGPT-Account-ID`。记录已停用或未匹配时按
原认证信息转发。

当 `/v1/models` 包含 `client_version` 查询参数时，Worker 保留 Codex CLI 模型目录格式，而
不转换为 OpenAI model list。

## 4. Anthropic 路由

| 方法与路径 | 级别 | 行为 |
| --- | --- | --- |
| `POST /v1/messages` | 协议转换 | Anthropic Messages 转换为 Codex Responses；返回 Message JSON 或命名 SSE 事件 |
| `POST /v1/messages/count_tokens` | 本地处理 | 对转换后的 Codex input 使用本地 tokenizer 估算 `input_tokens` |

Messages 支持 system、文本、图片、文档、thinking、客户端工具、工具结果、Web Search、
tool choice、usage 和 stop reason 等主要结构。请求必须包含 Anthropic 形式的 `max_tokens`，
但该值不会转发为 Codex 的输出上限。`temperature`、`top_p`、`top_k`、`stop_sequences`、
metadata 和 `cache_control` 也不提供等价的上游语义。

错误响应使用 Anthropic error envelope；流式错误使用对应的 SSE error 事件。

## 5. Gemini 路由

| 方法与路径 | 级别 | 行为 |
| --- | --- | --- |
| `GET /v1beta/models` | 协议转换 | 返回 Gemini Model 列表 |
| `GET /v1beta/models/{model}` | 协议转换 | 返回单个 Gemini Model 资源 |
| `POST /v1beta/models/{model}:generateContent` | 协议转换 | Gemini Content 转换为 Codex Responses，并返回 candidates |
| `POST /v1beta/models/{model}:streamGenerateContent` | 协议转换 | 将 Codex SSE 转换为 Gemini SSE 数据事件 |
| `POST /v1beta/models/{model}:countTokens` | 本地处理 | 估算顶层 `contents` 或嵌套 `generateContentRequest` 的 token 数 |

转换覆盖 system instruction、Content/Part、内联或 URI 媒体、function call/result、工具声明、
tool config、thinking 和 usage metadata。`generationConfig` 中仅 thinking level/budget 具有
对应转换；采样参数、候选数、停止序列以及输出 MIME/schema 不会转发为 Codex 语义。

错误响应使用 Google 风格 error envelope。

## 6. Responses 请求策略

`POST /v1/responses` 与 WebSocket `response.create` 应用以下共同规则：

- 字符串形式的顶层 `input` 包装为单个 `user` / `input_text` 消息；
- 数组 `input` 中消息项的 `role: "system"` 改为 `role: "developer"`；
- `store` 固定为 `false`；
- 删除 `max_completion_tokens`、`max_output_tokens`、`maxOutputTokens`、`max_tokens`、
  `context_management`、`temperature`、`top_p`、`truncation`、`user` 和
  `prompt_cache_options`；
- `service_tier` 仅在值严格等于 `priority` 时保留；
- 其他未知字段保持不变。

普通 HTTP `POST /v1/responses` 还会删除 `previous_response_id`、`generate`、
`prompt_cache_retention`、`safety_identifier` 和 `stream_options`。WebSocket
`response.create` 仅额外删除其中的 `prompt_cache_retention` 与 `safety_identifier`，保留
`previous_response_id`、`generate` 和 `stream_options` 的会话语义。Chat Completions、旧版
Completions、Anthropic Messages 与 Gemini Content 转换后发往 Codex Responses 的 HTTP
请求也应用上述 HTTP 删除规则。

compact 只应用数组 input 的角色规范化，不应用 Responses 创建参数策略。WebSocket
`response.append` 同样只规范化 input 角色；其他文本帧、所有二进制帧和全部上游帧保持原样。

正文不需要变更时保留原始编码；发生变更时重新编码为 JSON，并更新相关内容 header。

## 7. 其他协议差异

### Chat Completions

Chat 请求在内部始终通过流式 Codex Responses 执行，再根据下游 `stream` 选择聚合 JSON 或
转换为 Chat SSE。Codex 不接受的生成参数不会被伪造为等价能力。

### 旧版 Completions

当前支持字符串 prompt 或单项字符串数组，并要求 `n=1`、`best_of=1`。不支持 token ID
prompt、多候选结果或完整 logprobs 语义；响应中的 `logprobs` 为 `null`。采样、penalty、
suffix、seed、user 等传统 Completions 控件不会转发。

### token 估算

Anthropic 与 Gemini token-count 路径使用本地 `cl100k_base` tokenizer，对转换后的 Codex
input、工具 schema 和工具结果进行估算。结果适用于预检和预算，不保证与供应商 tokenizer
逐 token 一致，也不应用于账单核对。这两个路径仍要求下游 API Key，但不要求有效 OAuth 或
relay。

## 8. 正文、流与 WebSocket

- Live/Realtime multipart bootstrap 上限为 16 MiB；
- 图片、Realtime 和其他透明代理正文使用 `ReadableStream`；
- SSE 转换按事件增量处理，并保留下游背压；
- Responses WebSocket 转发 close code、close reason 和协商后的子协议；
- 上游拒绝 WebSocket 握手时，Worker 返回经过安全 header 过滤的 HTTP 响应。

浏览器原生 `WebSocket` API 不能设置本项目要求的 API-key header。浏览器场景应使用受控的
HTTP bootstrap 与临时凭据，或由可信后端建立 sideband WebSocket；不得把长期 API Key 写入
URL 或自定义子协议。

Cloudflare 的请求、连接和 WebSocket 限制可能变化，请以当前
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 和
[WebSockets 文档](https://developers.cloudflare.com/workers/runtime-apis/websockets/)为准。

## 9. 错误、CORS 与缓存

- 未匹配路径、错误方法和无效下游 API Key 返回空正文 `404`；
- Worker 生成的协议错误分别使用 OpenAI、Anthropic 或 Google envelope；
- 只有已确认的公开 API 响应添加 CORS header；管理响应不添加 CORS；
- 公开协议 API 和管理响应使用 `Cache-Control: no-store`；Backend API 凭据代理保留上游响应
  header；
- 公开协议 API 过滤客户端凭据、Cookie 和账户 ID；Backend API 凭据代理按许可配置处理认证
  header。

默认 `CORS_ORIGIN` 为 `*`，当前配置只支持一个原样的 origin 值，不实现动态 allowlist，也不
启用 credentialed CORS。

## 10. 明确不支持的能力

- `/v1/videos/*` 与 `/openai/v1/videos/*`；
- `/v1beta/interactions`；
- 未列出的 Gemini action；
- 供应商专用鉴权、计费或 token-count 服务；
- UDP RTP/RTCP 媒体 relay；
- 未注册的其他供应商路径。

`/backend-api/codex/*` 是调用方主动选择的低层透明路径。它可以传输私有 action，但不构成
对该 action 的稳定性、可用性或协议格式保证。

## 11. 用量状态

`GET /status/usage` 是无需管理会话或下游 API Key 的公开页面。页面只读取 Cron 每 5 分钟写入
`AUTH_KV` 的加密 `CODEX_USAGE` 快照，不在浏览器请求路径中访问 Codex 上游。页面每 5 分钟
重新读取快照，并使用浏览器时钟持续推进当前时刻线。

时间轴以所有有效额度窗口中最早的当前周期起点为起点，只绘制各额度的当前周期与后续周期，
不反推更早的历史周期。5 小时与 7 天窗口分别按固定的 5 小时和 7 天周期向未来一周投影；
其他窗口使用快照中的窗口秒数。顶部日期与各行使用同一个时间基准，因此重置时间可以直接横向比较。

`GET /status/usage/data` 返回页面所需的公开快照字段：采样时间、订阅类型，以及每个窗口的 ID、
类别、名称、周期类型、已用/剩余百分比、窗口秒数和重置时间。它不返回 OAuth、账户 ID、邮箱、
API Key、Cookie、管理信息或内部告警投递状态。尚未完成首次采样时返回空快照；读取失败时返回
`503`。两个路径均精确匹配，其他方法和尾部斜杠返回空 `404`。

## 12. 管理 API

管理页面与 JSON API 均位于 `/<ADMIN_PATH>/admin`。页面只接受精确的 `GET`；以下端点供同源
React 管理端使用：

| 方法与相对路径 | 用途 |
| --- | --- |
| `POST /login` | 使用 `ADMIN_SECRET` 创建管理会话 |
| `POST /logout` | 清除管理会话 |
| `GET /state` | 读取 OAuth 摘要、订阅摘要、API Key 列表和 Backend API 代理设置 |
| `GET /subscription` | 实时读取订阅与额度 |
| `POST /oauth/device` | 创建设备授权请求 |
| `POST /oauth/device/poll` | 轮询设备授权结果 |
| `DELETE /oauth` | 删除已保存的 OAuth 凭据 |
| `GET /api-keys` | 读取 API Key 列表 |
| `POST /api-keys` | 创建 API Key |
| `PUT /api-keys` | 更新名称、值或启用状态 |
| `DELETE /api-keys` | 删除 API Key |
| `POST /auth-proxy` | 创建代理账户 |
| `PUT /auth-proxy` | 更新代理账户的名称、`account_id` 或启用状态 |
| `DELETE /auth-proxy` | 删除代理账户 |
| `POST /auth-proxy/oauth/device` | 为指定代理账户创建设备授权请求 |
| `POST /auth-proxy/oauth/device/poll` | 轮询指定代理账户的设备授权结果 |
| `DELETE /auth-proxy/oauth` | 删除指定代理账户的独立 OAuth 凭据 |

`/state`、`/subscription`、OAuth、API Key 和 Backend API 代理端点需要有效的管理会话；登录、退出
以及所有受保护的管理写请求必须通过同源 `Origin` 校验。管理会话和凭据约束见
[安全模型](security.md)。

Worker 在创建 API Key 和代理账户时分配 UUID 格式的 `id`。更新、删除和代理账户 OAuth 请求
使用该 `id` 定位记录。
