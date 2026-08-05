# 架构与目录约定

本项目采用按能力分组的轻量分层。目标是让业务规则保持纯粹，让 Workers、KV、
HTTP 和上游 OAuth/Codex I/O 停留在明确边界；不引入单实现接口、基类、仓储层或
依赖注入容器。

```text
src/
├── index.ts                 Worker composition root
├── app/                     路由匹配与用例编排
│   ├── fetch-handler.ts
│   ├── api-handler.ts
│   ├── admin-handler.ts
│   └── scheduled-handler.ts
├── auth/                    下游 API key 与上游 OAuth
│   ├── admin-session.ts
│   ├── api-key.ts
│   ├── constant-time.ts
│   ├── credentials.ts
│   ├── device-flow.ts
│   ├── envelope.ts
│   ├── oauth-provider.ts
│   └── refresh.ts
├── codex/                   Codex 网络客户端与透明代理
│   ├── client.ts
│   ├── proxy.ts
│   ├── event-stream.ts
│   └── stream-error.ts
├── chat/                    Chat Completions ↔ Responses 适配
│   ├── request.ts
│   ├── content.ts
│   ├── input-parts.ts
│   ├── tools.ts
│   ├── reducer.ts
│   ├── tool-output.ts
│   ├── tool-state.ts
│   ├── terminal-output.ts
│   ├── state-budget.ts
│   ├── response.ts
│   ├── stream-presenter.ts
│   ├── stream.ts
│   └── types.ts
├── completions/             旧版 Completions ↔ Chat/Responses 适配
│   ├── request.ts
│   ├── response.ts
│   └── stream.ts
├── live/                    Realtime bootstrap 的有限请求适配
│   └── request.ts
├── http/                    HTTP/SSE 表示与管理面板 HTML
│   ├── body.ts
│   ├── admin-page.ts
│   ├── response.ts
│   └── sse-encoder.ts
├── openai/                  OpenAI 兼容输出表示
│   └── models.ts
└── shared/                  无业务归属的小型通用原语
    ├── api-error.ts
    ├── json.ts
    ├── limited-body.ts
    └── logging.ts
```

测试按相同能力边界镜像组织，`support/` 只放跨多个 spec 复用的最小固件：

```text
test/
├── app/admin-handler.spec.ts
├── app/fetch-handler.spec.ts
├── app/proxy-handler.spec.ts
├── auth/
│   ├── admin-session.spec.ts
│   ├── api-key.spec.ts
│   ├── envelope.spec.ts
│   └── refresh.spec.ts
├── chat/
│   ├── adaptation.spec.ts
│   └── response.spec.ts
├── completions/compatibility.spec.ts
├── codex/client.spec.ts
├── shared/limited-body.spec.ts
└── support/
    ├── auth-fixture.ts
    ├── fetch-mock.ts
    └── worker-fixture.ts
```

## 依赖方向

```text
index → app → auth / chat / completions / live / codex / http / openai → shared
chat → codex event-stream
chat → http SSE encoder
completions → chat / http SSE encoder
codex proxy → live request adapter
codex client → auth credentials
http admin-page → http response
```

- `index.ts` 只组合 Workers handlers，不放业务规则。
- `app/` 决定“何时调用什么”，不实现加密、协议转换或上游网络细节。
- Chat 与 Completions 适配器负责纯数据转换；`client.ts`、`proxy.ts`、OAuth provider、
  KV credentials 负责 I/O。
- 功能模块直接引用 canonical 文件，不通过顶层 barrel 隐藏依赖。
- `shared/` 只收纳至少被两个能力复用、且不含领域策略的原语。
- `Env` 在边界处使用 `Pick` 收窄，避免函数隐式依赖全部 binding。

## 关键请求流

需要协议转换的 Chat 与 Completions 请求：

```text
fetch-handler
  → 精确路由匹配
  → API_KEYS 解密与启用 Key 鉴权
  → api-handler
  → 有界 JSON 解码 / 协议转换
  → Codex client
  → OpenAI JSON、Responses SSE 或 Chat SSE 表示
```

Responses、compact 与 Responses WebSocket：

```text
fetch-handler
  → 路径族与方法匹配
  → API_KEYS 解密与启用 Key 鉴权
  → codex/proxy
  → codex/request（HTTP/WS 顶层 input 的 system → developer）
  → 清理客户端/边界 header、写入 OAuth
  → relay（HTTP 响应流或双向 WebSocket 帧桥接）
```

其他透明 HTTP/WebSocket 路径不进入角色适配，正文流或 `Response.webSocket` 直接交接。

管理面板与 OAuth 设备登录：

```text
fetch-handler
  → ADMIN_PATH 精确路由
  → ADMIN_SECRET / AES-GCM HttpOnly 会话
  → 同源写请求校验
  → admin-handler
      ├── API_KEYS CRUD → AES-GCM → KV
      └── device-flow → oauth-provider → AES-GCM state / credentials → KV
```

定时刷新：

```text
scheduled-handler → refresh → oauth-provider → credentials → KV
```

## 稳定契约

- 未匹配路由、不支持的方法和无效客户端 key 均返回无正文、无 CORS 的 `404`。
- 只有已确认的公开 API 响应会添加 CORS；已知 API 路径族支持无鉴权的 `OPTIONS`
  预检。管理路由不添加 CORS，并要求 Cookie 会话及同源写请求。
- Worker 生成的错误使用统一 OpenAI error envelope；已鉴权请求的上游错误保持状态与
  正文。结构化 API 使用最小响应头 allowlist；透明代理使用 denylist 删除 cookie、
  hop-by-hop、Cloudflare 和内部服务 header，同时保留媒体/范围/WebSocket 所需 header。
- Chat、Completions、Responses 与 compact 的 JSON 请求编码体及 zstd 解码结果限制为
  4 MiB；OAuth 和模型目录使用更小的专用上限。其他透明代理路径只流式转交正文。
- OAuth credentials、API_KEYS、设备 state 与管理会话分别使用独立 AES-GCM purpose
  string。`DATA_ENCRYPTION_KEY` 只负责加密；`ADMIN_SECRET` 只在登录表单 POST body 中
  传输。长期 secret 不得进入 URL；`ADMIN_PATH` 只是额外隐藏层，不能替代管理密钥。
- 所有 OAuth provider 请求叠加固定 10 秒超时；`enable_request_signal` 让客户端
  断开也能沿显式 `AbortSignal` 取消对应的上游子请求。
- Chat JSON 与 SSE 共用同一事件 reducer，避免两种输出模式解释同一 Codex 事件时
  产生漂移；单个 SSE 事件和 Chat 持久状态都有字符预算，工具调用与 alias 也有数量
  上限；终态只提取必要的 model、usage 与 incomplete reason，不重复保留完整 response，
  避免长流无界或重复占用 Worker 内存。
- 旧版 Completions 复用 Chat → Responses 转换与 Chat 事件 reducer，只在最外层转换
  prompt、`text_completion` envelope 和 SSE chunk，避免维护第二套 Codex 事件解释器。
- 透明代理的“传输兼容”不等于上游“协议兼容”；Codex 原生路径映射、供应商路径分流、
  Responses WebSocket 帧桥接和 Realtime 媒体面边界以 `docs/compatibility.md` 为准。
- KV 的设备登录检查后写入和 `API_KEYS` 读改写都不是原子事务；面板面向低频、单管理
  员配置。需要并发排他或事务语义时迁移到 Durable Object/D1。

## 修改准则

新增行为时，优先把纯转换放入现有 feature，把外部 I/O 放入对应边界，并从
`app/` 编排。只有出现第二个真实实现或第二个使用方时才提取抽象。每次修改 bindings
后运行 `pnpm cf-typegen`，提交前运行 `pnpm check`。
