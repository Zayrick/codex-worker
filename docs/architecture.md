# 架构与目录约定

本项目由 Vite 构建的 React 管理端和 Cloudflare Worker 后端组成。后端采用按能力分组
的轻量分层，让业务规则保持纯粹，让 Workers、KV、HTTP 和上游 OAuth/Codex I/O
停留在明确边界；不引入单实现接口、基类、仓储层或依赖注入容器。

```text
src/
├── main.tsx                 React composition root
├── App.tsx                  管理面板状态与交互编排
├── admin-api.ts             同源管理 API 客户端与响应校验
├── App.css                  组件与响应式样式
└── index.css                全局设计 token 与基础样式

worker/
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
│   ├── event-stream.ts
│   ├── proxy.ts
│   ├── request-policy.ts
│   ├── request.ts
│   ├── stream-error.ts
│   ├── subscription.ts
│   └── websocket.ts
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
├── messages/                Anthropic Messages ↔ Codex Responses 适配
│   ├── request.ts
│   ├── response.ts
│   ├── stream.ts
│   ├── error.ts
│   ├── identifiers.ts
│   ├── token-count.ts
│   └── types.ts
├── gemini/                  Gemini generateContent ↔ Codex Responses 适配
│   ├── request.ts
│   ├── response.ts
│   ├── stream.ts
│   ├── error.ts
│   ├── models.ts
│   ├── path.ts
│   └── types.ts
├── live/                    Realtime bootstrap 的有限请求适配
│   └── request.ts
├── http/                    HTTP/SSE 表示与 React shell 交付
│   ├── body.ts
│   ├── cancellation.ts
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
├── messages/
├── gemini/
├── codex/client.spec.ts
├── shared/limited-body.spec.ts
└── support/
    ├── admin-assets/index.html
    ├── auth-fixture.ts
    ├── fetch-mock.ts
    └── worker-fixture.ts
```

## 依赖方向

```text
browser → React src → 同源管理 JSON API
index → app → auth / chat / completions / messages / gemini / live / codex / http / openai → shared
chat → codex event-stream
chat → http SSE encoder
completions → chat / http SSE encoder
messages / gemini → codex event-stream / http SSE encoder
gemini → messages identifiers / token count
codex proxy → live request adapter
codex client → auth credentials
codex subscription → auth credentials / codex client
app admin-handler → http admin-page → ASSETS
```

- `src/` 只负责管理界面的展示、交互和运行时响应校验，不持有服务端 secret。
- `worker/index.ts` 只组合 Workers handlers，不放业务规则。
- `app/` 决定“何时调用什么”，不实现加密、协议转换或上游网络细节。
- Chat、Completions、Messages 与 Gemini 适配器负责纯数据转换；`client.ts`、`proxy.ts`、
  OAuth provider、KV credentials 负责 I/O。
- 功能模块直接引用 canonical 文件，不通过顶层 barrel 隐藏依赖。
- `shared/` 只收纳至少被两个能力复用、且不含领域策略的原语。
- `Env` 在边界处使用 `Pick` 收窄，避免函数隐式依赖全部 binding。

## 关键请求流

需要协议转换的 Chat、Completions、Messages 与 Gemini 请求：

```text
fetch-handler
  → 精确路由匹配
  → API_KEYS 解密与启用 Key 鉴权
  → api-handler
  → 有界 JSON 解码 / 协议转换
  → Codex client
  → OpenAI、Anthropic 或 Gemini JSON/SSE 表示
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

图片、Realtime 与 Codex 直连别名不进入供应商协议适配，正文流或
`Response.webSocket` 直接交接。视频、Interactions 和未知供应商 action 不注册路由。

管理面板与 OAuth 设备登录：

```text
fetch-handler
  → ADMIN_PATH 精确路由
  ├── 页面请求 → ASSETS `/index.html` → HTMLRewriter 注入每请求 CSP nonce → React
  └── JSON API → ADMIN_SECRET / AES-GCM HttpOnly 会话 → 同源写请求校验
      → admin-handler
          ├── API_KEYS CRUD → AES-GCM → KV
          ├── device-flow → oauth-provider → AES-GCM state / credentials → KV
          └── subscription → id_token 元数据 + relay `/backend-api/wham/usage`
```

定时刷新：

```text
scheduled-handler → refresh → oauth-provider → credentials → KV
```

## 稳定契约

- 未匹配路由、不支持的方法和无效客户端 key 均返回无正文、无 CORS 的 `404`。
- 只有已确认的公开 API 响应会添加 CORS；已知 API 路径族支持无鉴权的 `OPTIONS`
  预检。管理路由不添加 CORS，并要求 Cookie 会话及同源写请求。
- Static Assets 不启用全站 SPA fallback；Worker 只在隐藏管理路径读取 `index.html`，其余
  未匹配路径继续保持隐藏式 `404`。React shell 每次响应都替换构建期 nonce 占位符。
- Worker 生成的错误按入口协议使用 OpenAI、Anthropic 或 Google envelope；Messages 与
  Gemini 还会把上游 HTML/非 JSON 错误收敛为安全 JSON。结构化 API 使用最小响应头
  allowlist；透明代理使用 denylist 删除 cookie、hop-by-hop、Cloudflare 和内部服务
  header，同时保留媒体/范围/WebSocket 所需 header。
- Chat、Completions、Messages、Gemini、Responses 与 compact 的 JSON 请求编码体及 zstd
  解码结果限制为 4 MiB；OAuth 和模型目录使用更小的专用上限。其他透明代理路径只流式
  转交正文。
- OAuth credentials、API_KEYS、设备 state 与管理会话分别使用独立 AES-GCM purpose
  string。`DATA_ENCRYPTION_KEY` 只负责加密；`ADMIN_SECRET` 只在登录表单 POST body 中
  传输。长期 secret 不得进入 URL；`ADMIN_PATH` 只是额外隐藏层，不能替代管理密钥。
- 所有 OAuth provider 请求叠加固定 10 秒超时；`enable_request_signal` 让客户端
  断开也能沿显式 `AbortSignal` 取消对应的上游子请求。
- 管理面板的 Codex 用量请求同样叠加 10 秒超时，经配置的 HTTPS relay 访问，JSON
  响应最多读取 256 KiB；上游错误正文会被丢弃，只记录固定错误 code。
- Chat JSON 与 SSE 共用同一事件 reducer，避免两种输出模式解释同一 Codex 事件时
  产生漂移；单个 SSE 事件和 Chat 持久状态都有字符预算，工具调用与 alias 也有数量
  上限；终态只提取必要的 model、usage 与 incomplete reason，不重复保留完整 response，
  避免长流无界或重复占用 Worker 内存。
- 旧版 Completions 复用 Chat → Responses 转换与 Chat 事件 reducer，只在最外层转换
  prompt、`text_completion` envelope 和 SSE chunk，避免维护第二套 Codex 事件解释器。
- Messages 与 Gemini 各自维护协议专属的命名事件/`data` SSE 表示，但共用取消传播、
  Codex SSE 解码、长工具名映射和本地 token 计数。流转换使用背压写入并限制保留字符、
  工具/输出项与 alias 数量；终止事件会按原始 output 顺序补齐缺失块。
- 透明代理的“传输兼容”不等于上游“协议兼容”；Codex 原生路径映射、供应商路径分流、
  Responses WebSocket 帧桥接和 Realtime 媒体面边界以 `docs/compatibility.md` 为准。
- KV 的设备登录检查后写入和 `API_KEYS` 读改写都不是原子事务；面板面向低频、单管理
  员配置。需要并发排他或事务语义时迁移到 Durable Object/D1。

## 修改准则

新增行为时，优先把纯转换放入现有 feature，把外部 I/O 放入对应边界，并从
`app/` 编排。只有出现第二个真实实现或第二个使用方时才提取抽象。每次修改 bindings
后运行 `pnpm cf-typegen`，提交前运行 `pnpm check`。
