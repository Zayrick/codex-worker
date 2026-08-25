# 架构设计

## 1. 设计目标

Codex Worker 将多种客户端协议收敛到 ChatGPT Codex 上游，同时保持以下边界：

- 协议转换和领域规则可在宿主 Rust 环境中独立测试；
- Cloudflare Request、KV、Fetch、Static Assets 和 WebSocket 类型仅存在于传输层；
- 需要检查或改写的正文有明确上限，其余正文保持流式；
- 管理面与公开 API 同源部署，但使用独立的路由、会话和 CORS 策略；
- 长期凭据只以加密形式写入持久化存储。

## 2. 系统拓扑

```text
                         ┌──────────────────────────────┐
API clients ────────────→│                              │
                         │ Cloudflare Worker            │──→ trusted relay ─→ chatgpt.com
                         │                              │──→ Bark HTTPS endpoint
Admin browser ──────────→│ Rust/Wasm backend            │──→ auth.openai.com
                         │                              │──→ api.openai.com
                         └──────────┬───────────┬───────┘
                                    │           │
                                    ↓           ↓
                                 AUTH_KV     Static Assets
                                    │           │
                              encrypted data  React admin UI
```

| 组件 | 职责 |
| --- | --- |
| React 管理端 | 管理会话登录、主/代理 OAuth 设备授权、订阅额度展示、API Key 与代理账户许可管理 |
| Rust/Wasm Worker | 路由、鉴权、协议转换、上游访问、流式传输和定时维护 |
| `AUTH_KV` | 保存加密后的 OAuth 凭据、下游 API Key、Backend API 代理账户和 Codex 用量状态 |
| Static Assets | 保存 Vite 构建的管理端资源；HTML 仅由隐藏管理路径读取 |
| ChatGPT relay | 代表 Worker 访问 `chatgpt.com` 的 Codex 与用量路径 |
| OpenAI 直连端点 | 承载 OAuth 设备流、token 刷新和 Realtime sideband |
| Bark endpoint | 接收用量百分比、剩余时间和消耗速度提醒 |

relay 是外部运维组件，不属于本仓库的构建产物。Worker 只接受一个精确的 HTTPS origin，
并自行追加上游路径。

## 3. 后端模块边界

`worker-rs` 是唯一后端实现。依赖关系由外向内收敛：

```text
lib.rs event exports
        │
        ↓
transport ──→ application ──→ protocol ──→ core
    │              └────────→ upstream ──→ core
    ├───────────────────────→ auth ──────→ core
    └───────────────────────→ http ──────→ core
```

| 模块 | 职责 | 约束 |
| --- | --- | --- |
| `core` | 通用错误和 JSON 基础类型 | 不依赖业务模块或 Cloudflare runtime |
| `http` | 有界正文、响应 DTO 和 SSE 编码 | 使用 runtime-neutral 类型 |
| `protocol` | OpenAI、Anthropic、Gemini 的请求与响应转换 | 不发起网络请求，不访问绑定 |
| `auth` | OAuth、API Key、会话、加密和存储抽象 | 通过窄接口访问时钟、HTTP 和持久化 |
| `upstream` | Codex 与 Backend API 代理的 URL、header、模型和订阅数据策略 | 保持纯策略逻辑，可独立测试 |
| `application` | 路由模型、adapter registry、tokenizer 与用量告警状态机 | 编排协议能力，不执行 Cloudflare I/O |
| `transport` | Workers Request/Response、KV、Fetch、Bark、Assets、流和 WebSocket | 唯一 Cloudflare I/O 边界 |

`lib.rs` 是事件组合入口。仅 `wasm32` 构建导出 `fetch` 和 `scheduled` 事件，因而内部模块可以
直接在宿主目标运行单元测试。

## 4. 前端边界

`src/` 是独立的 React 管理应用：

- `main.tsx`：浏览器入口；
- `App.tsx`：界面状态与交互编排；
- `admin-api.ts`：同源管理 API 客户端与响应校验；
- `App.css`、`index.css`：组件和全局样式。

前端不读取 Worker secret，不参与协议转换，也不直接访问 KV。Vite 在 HTML 中写入 CSP nonce
占位符；Worker 每次返回管理页时生成新 nonce 并替换该占位符。

## 5. 请求处理流程

### 5.1 协议转换请求

Chat Completions、Completions、Anthropic Messages 和 Gemini Content 使用同一主流程：

```text
fetch event
  → exact route match
  → downstream API Key authentication
  → bounded JSON/zstd decoding
  → request adapter
  → Codex Responses request
  → response presenter / SSE state machine
  → protocol-specific response
```

路由选择 adapter 和 presenter；传输层只负责请求生命周期、上游 I/O 和 Worker Response。

### 5.2 Codex 原生映射与透明代理

Responses、Images、Realtime 和 `/backend-api/codex/*` 路径进入 Codex proxy。Responses 与
compact 只执行明确规定的 JSON 策略；其他代理正文直接使用 `ReadableStream`。Responses
WebSocket 只处理客户端发往上游的 `response.create` 和 `response.append` 文本帧，其余文本、
二进制和反向帧保持不变。

`AUTH_PROXY_HOST` 上的 `/backend-api` 请求使用独立代理流程：

```text
request → account_id policy → credential selection → trusted relay
```

该流程保持路径、Query、端到端 header 和流式正文。未匹配或停用的代理账户保留原请求凭据；
匹配记录优先选择独立 OAuth，独立凭据不可用时选择主 OAuth。

### 5.3 管理请求

```text
hidden admin path
  ├─ GET page → ASSETS/index.html → inject CSP nonce
  └─ admin API
       → encrypted HttpOnly session
       → same-origin check for writes
       ├─ OAuth device flow
       ├─ subscription usage
       └─ encrypted API Key and proxy settings repository
```

管理路由不启用 CORS。页面只在精确的 `/<ADMIN_PATH>/admin` 路径返回，不配置全站 SPA
fallback。

### 5.4 定时维护

`scheduled` 事件每 5 分钟运行一次。每次运行会通过受信任 relay 获取 Codex 用量，计算每个
Codex 额度窗口的额度剩余百分比、剩余毫秒数和剩余时间百分比，然后把当前快照与告警状态加密
写入 KV。用量请求和 Bark 请求均限制为 10 秒，Bark 响应正文直接丢弃且不跟随重定向。

告警按单个 Codex 额度窗口判断，并把同一轮的多项提醒合并为一次 Bark 推送：

- 当前额度剩余百分比首次低于剩余时间百分比时推送；
- 上一轮处于上述状态且首次提醒已送达时，计算
  `上次剩余额度 × 实际采样间隔 ÷ 上次剩余时间`；本轮实际消耗严格大于该均匀消耗额度时再次
  推送。Cron 延迟或漏跑时使用实际采样间隔，而不是固定假定为 5 分钟。

同一轮随后直接读取 KV 中主 `oauth` 和每个代理 UUID 对应 OAuth 记录的 `expiresAt`。仅当
access token 将在三小时内过期时才调用 OpenAI token endpoint；代理凭据使用有限并发分别刷新。
普通 API 请求不会发起刷新，避免多个边缘位置同时使用旋转式 refresh token。

## 6. 持久化与状态

`AUTH_KV` 使用固定键与按代理 UUID 派生的动态键族：

| KV key | 内容 | 保护方式 |
| --- | --- | --- |
| `oauth` | access token、refresh token、账户信息和过期时间 | AES-256-GCM envelope |
| `oauth:auth-proxy:<uuid>` | 单个代理账户的独立 access token、refresh token、账户信息和过期时间 | 按 UUID 绑定 purpose 的 AES-256-GCM envelope |
| `API_KEYS` | 下游 API Key 和 Backend API 代理账户及其记录 ID | AES-256-GCM envelope |
| `CODEX_USAGE` | 最近一次用量快照、剩余时间和告警状态 | AES-256-GCM envelope |

设备授权 state 和管理会话不写入 KV，而是使用独立 purpose 加密后交由客户端保存。所有 envelope
由 `DATA_ENCRYPTION_KEY` 派生同一 AES-256-GCM 密钥，并通过不同的附加认证数据隔离用途。

KV 适合本项目的低频写入和高频读取，但其读取最终一致。API Key 集合以单条记录读改写，管理面
因此按低频、单管理员场景设计，不提供事务或并发编辑保证。相关安全影响见
[安全模型](security.md)。

API Key 与代理账户使用后端分配的 UUID 定位。缺少 `id` 的 `API_KEYS` 记录会在读取时补齐并
写回。

## 7. 传输原则

- Live/Realtime multipart bootstrap 限制为 16 MiB；
- 图片、实时媒体信令和其他透明代理正文保持流式；
- 上游重定向使用手动模式，避免 OAuth 自动发送到未知目标；
- 公开协议 API 应用凭据与响应 header 隔离；Backend API 凭据代理保留端到端 header，并由
  runtime 管理连接级 header；
- 公开协议 API 和管理面使用 `Cache-Control: no-store`；Backend API 凭据代理保持上游响应
  语义。

Cloudflare 账户与 runtime 的限制仍然适用，具体数值应查阅当前的
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。

## 8. 仓库结构

```text
.
├── src/                    React 管理端
├── worker-rs/              Rust/Wasm Worker
│   └── src/
│       ├── application/
│       ├── auth/
│       ├── core/
│       ├── http/
│       ├── protocol/
│       ├── transport/
│       └── upstream/
├── docs/                   项目文档
├── .github/workflows/      production 部署工作流
├── vite.config.ts          React、Rust watcher 与 Cloudflare Vite 集成
├── wrangler.jsonc          Worker、Assets、KV、secret 与 Cron 配置
└── package.json            项目脚本与 JavaScript 依赖
```

## 9. 架构不变量

- Cloudflare I/O 只能进入 `transport`；内部协议和领域模块保持 runtime-neutral。
- 新增协议需要同时定义精确路由、请求 adapter、响应 presenter 和传输组合。
- 未匹配路径、错误方法和无效下游凭据保持隐藏式响应，不暴露受保护能力。
- 不得为方便转换而无界收集代理正文；新增解析路径必须定义编码体和解码体上限。
- 不得在模块级缓存 OAuth、API Key、管理会话或请求状态。
- 配置、路由或协议语义变更必须同步更新 [API 文档](api.md)、
  [部署文档](deployment.md) 或 [安全文档](security.md)。
