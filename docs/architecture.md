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
│   ├── device-handler.ts
│   └── scheduled-handler.ts
├── auth/                    下游 API key 与上游 OAuth
│   ├── api-key.ts
│   ├── constant-time.ts
│   ├── credentials.ts
│   ├── device-flow.ts
│   ├── envelope.ts
│   ├── oauth-provider.ts
│   └── refresh.ts
├── codex/                   Codex 请求策略与网络客户端
│   ├── request-policy.ts
│   ├── client.ts
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
├── http/                    HTTP/SSE 表示与设备登录 HTML
│   ├── body.ts
│   ├── device-page.ts
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
├── app/fetch-handler.spec.ts
├── auth/
│   ├── api-key.spec.ts
│   ├── device-flow.spec.ts
│   ├── envelope.spec.ts
│   └── refresh.spec.ts
├── chat/
│   ├── adaptation.spec.ts
│   └── response.spec.ts
├── codex/client.spec.ts
├── shared/limited-body.spec.ts
└── support/
    ├── auth-fixture.ts
    ├── fetch-mock.ts
    └── worker-fixture.ts
```

## 依赖方向

```text
index → app → auth / chat / codex / http / openai → shared
chat → codex event-stream / request-policy
chat → http SSE encoder
codex client → auth credentials
http device-page ── type only ─→ auth device-flow
```

- `index.ts` 只组合 Workers handlers，不放业务规则。
- `app/` 决定“何时调用什么”，不实现加密、协议转换或上游网络细节。
- `request-policy.ts` 和 Chat 适配器负责纯数据转换；`client.ts`、OAuth provider、
  KV credentials 负责 I/O。
- 功能模块直接引用 canonical 文件，不通过顶层 barrel 隐藏依赖。
- `shared/` 只收纳至少被两个能力复用、且不含领域策略的原语。
- `Env` 在边界处使用 `Pick` 收窄，避免函数隐式依赖全部 binding。

## 关键请求流

OpenAI API 请求：

```text
fetch-handler
  → 精确路由匹配
  → API-* 鉴权
  → api-handler
  → 有界 JSON 解码 / 请求策略转换
  → Codex client
  → OpenAI JSON、Responses SSE 或 Chat SSE 表示
```

OAuth 设备登录：

```text
device-handler
  → 设备管理口令恒定时间校验
  → device-flow
  → oauth-provider
  → AES-GCM state / credentials
  → KV
```

定时刷新：

```text
scheduled-handler → refresh → oauth-provider → credentials → KV
```

## 稳定契约

- 未匹配路由、错误方法、无效客户端 key 和无效设备 secret 均返回无正文、无 CORS
  的 `404`。
- 只有已确认的 API/设备路由响应会添加 CORS；四个 API 路径支持无鉴权的
  `OPTIONS` 预检，未知路径仍隐藏为 `404`。
- Worker 生成的错误使用统一 OpenAI error envelope；已鉴权请求的上游错误保持状态与
  正文，响应头经过最小 allowlist 后再透传。
- JSON 请求的编码体与 zstd 解码结果均限制为 4 MiB；OAuth 和模型目录使用更小的
  专用上限。
- OAuth credentials 与设备 state 的 AES-GCM purpose string 和 envelope schema 是
  持久化兼容契约，不可随意修改。
- `OAUTH_MASTER_KEY` 只用于加密，`DEVICE_AUTH_SECRET` 只在设备表单 POST body 中
  传输；任何长期 secret 都不得进入 URL。relay 是显式的高信任边界，不提供公共
  默认地址。
- 所有 OAuth provider 请求叠加固定 10 秒超时；`enable_request_signal` 让客户端
  断开也能沿显式 `AbortSignal` 取消对应的上游子请求。
- Chat JSON 与 SSE 共用同一事件 reducer，避免两种输出模式解释同一 Codex 事件时
  产生漂移；单个 SSE 事件和 Chat 持久状态都有字符预算，工具调用与 alias 也有数量
  上限；终态只提取必要的 model、usage 与 incomplete reason，不重复保留完整 response，
  避免长流无界或重复占用 Worker 内存。
- KV 的设备登录检查后写入不是原子事务，API key 鉴权也按设计扫描少量 `API-*`；
  需要并发排他或大量 key 时，分别迁移到 Durable Object/D1 与摘要寻址模型。

## 修改准则

新增行为时，优先把纯转换放入现有 feature，把外部 I/O 放入对应边界，并从
`app/` 编排。只有出现第二个真实实现或第二个使用方时才提取抽象。每次修改 bindings
后运行 `pnpm cf-typegen`，提交前运行 `pnpm check`。
