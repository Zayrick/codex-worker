# 架构与目录约定

本项目由 Vite 构建的 React 管理端和 Rust/WebAssembly Cloudflare Worker 后端组成。
`worker-rs` 是唯一后端实现；Rust 中可在宿主机测试的领域与协议代码和仅在
`wasm32-unknown-unknown` 编译的 Cloudflare 传输边界明确分开。

```text
src/
├── main.tsx                 React composition root
├── App.tsx                  管理面板状态与交互编排
├── admin-api.ts             同源管理 API 客户端与响应校验
├── App.css                  组件与响应式样式
└── index.css                全局设计 token 与基础样式

worker-rs/
├── Cargo.toml               Rust 依赖、Wasm crate 与 release profile
├── Cargo.lock               可复现依赖解析
└── src/
    ├── lib.rs               fetch/scheduled Wasm 入口与顶层模块
    ├── application/         用例路由、AdapterRegistry 与 composition factories
    │   ├── adapters.rs
    │   ├── routes.rs
    │   └── tokenizer.rs
    ├── auth/                OAuth、API key、会话、加密与抽象 ports
    │   ├── oauth_ports.rs
    │   ├── oauth_provider.rs
    │   ├── credentials.rs
    │   ├── refresh.rs
    │   ├── device_flow.rs
    │   ├── api_keys.rs
    │   ├── admin_session.rs
    │   ├── crypto.rs
    │   └── store.rs
    ├── core/                provider-neutral error 与 JSON 基础类型
    ├── http/                runtime-neutral body、response DTO 与 SSE 编码
    ├── protocol/            纯协议转换与流状态机
    │   ├── openai/          Responses、Chat、Completions 与 SSE
    │   ├── anthropic/       Messages、token count、error 与 stream presenter
    │   └── gemini/          models、Content、token count、error 与 stream presenter
    ├── upstream/codex/      纯 Codex URL/header/model/subscription policy
    └── transport/           Cloudflare Workers 适配器
        ├── router.rs        fetch/scheduled 请求入口
        ├── api.rs           公开 API 用例组合
        ├── admin.rs         管理页面与管理 API
        ├── codex.rs         Codex Fetch、透明流与 WebSocket bridge
        ├── oauth.rs         OAuth HTTP/clock ports 的 Worker 实现
        ├── store.rs         Workers KV SecretStore 实现
        ├── body.rs          Worker stream 的有界收集
        ├── response.rs      Response DTO → Worker Response
        ├── stream.rs        Rust presenter → Worker streaming Response
        ├── provider_error.rs
        └── config.rs
```

后端测试与模块放在一起，使用 Rust `#[cfg(test)]`；复杂协议的 golden fixture 也由对应
Rust 模块读取或内嵌。仓库中的前端检查不承担 Rust 后端业务规则验证。

## 依赖方向

```text
Cloudflare event export
          ↓
transport ─────────────→ worker crate / Workers KV / Fetch / WebSocket / ASSETS
    ↓              ↓
application ───→ auth
    ↓              ↓
protocol       abstract ports
    ↓
http / upstream / core
```

更精确的约束如下：

- `core` 不依赖其他业务模块。
- `http`、`protocol`、`upstream` 与大部分 `auth` 都是 runtime-neutral Rust，不引用
  `worker::Request`、`worker::Response`、KV 或 WebSocket。
- `application` 选择路由、协议 adapter、tokenizer 和 response presenter，只编排用例，
  不实现 Cloudflare I/O。
- `transport` 是最外层 adapter；它可以依赖内部模块，内部模块不能反向依赖
  `transport`。
- `lib.rs` 是 Cloudflare event composition root。只有 `wasm32` 构建会导出
  `transport` 和 `#[worker::event]`，因此纯模块可直接在宿主目标运行测试。
- React `src/` 只负责管理界面的展示、交互与响应校验，不持有服务端 secret，也不参与
  Worker 协议转换。

这个方向让协议规则、加密 envelope、URL/header policy 和流状态机可独立测试，也避免
Cloudflare 类型沿调用链渗入领域模块。

## 可插拔 adapter、ports 与工厂组合

`application::AdapterRegistry` 是请求转换的可插拔边界。内置 factory 以稳定 ID 注册
Chat Completions、旧版 Completions、Anthropic Messages 和 Gemini Content 的
`RequestAdapter`。新增兼容协议时实现 trait 并在 composition root 注册即可，Codex
Fetch、KV 和路由传输不需要了解转换细节。Registry 还允许测试或部署组合替换某个实现。

外部能力使用窄 ports，而不是让纯逻辑读取全局环境：

- `OAuthHttpClient`、`OAuthClock` 与 `OAuthCredentialsStore` 隔离 provider Fetch、超时、
  定时器和持久化；`transport::oauth` 与 `OAuthRepository` 分别提供 Worker adapter。
- Anthropic 与 Gemini token count 依赖各自的 `TokenCounter` port；composition factory
  当前注入共享的 Rust `Cl100kTokenCounter`，以后可以替换为模型专用或远程实现。
- Gemini 请求计数依赖窄 `TokenCounter`，协议模块不需要知道 tokenizer crate。
- `CodexClient` 只承担 Cloudflare 上游 I/O；URL、header、模型与 subscription 归一化
  保留在 `upstream::codex` 纯函数中。
- `ResponseAdapter` 描述对应的输出 presenter，HTTP transport 只负责把 upstream 事件
  喂给选择出的 Rust 状态机。

工厂都在请求或事件 composition root 创建，不存在可变的模块级凭据、请求状态或服务
定位器。唯一共享的昂贵状态是不可变的 `cl100k_base` tokenizer vocabulary，由
`application::tokenizer` 的 `OnceLock` 在 isolate 内初始化一次。

## 关键请求流

需要协议转换的 Chat、Completions、Messages 与 Gemini 请求：

```text
worker::event(fetch)
  → transport::router 精确路由
  → API_KEYS repository 解密与启用 Key 鉴权
  → transport::api
  → 有界 JSON/zstd 解码
  → AdapterRegistry::adapt
  → CodexClient::send_converted_responses
  → Rust response presenter / SSE state machine
  → Worker Response
```

Responses、compact 与 Responses WebSocket：

```text
transport::router
  → transport::api
  → CodexClient::forward_proxy
  → protocol::openai Responses policy
  → upstream::codex URL/header policy
  → ChatGPT relay
  → HTTP ReadableStream 或双向 WebSocket bridge
```

只有 Responses/compact JSON 和 Live/Realtime multipart bootstrap 会按专用上限收集正文。
图片、Realtime sideband 与其他 Codex 原生别名把原始 `ReadableStream` 交给上游 Fetch；
Responses WebSocket 只转换客户端发往上游的受支持文本事件，其他帧透明转发。

管理面板与 OAuth 设备登录：

```text
transport::router
  → ADMIN_PATH 精确路由
  ├── 页面 → ASSETS `/index.html` → 替换构建期 CSP nonce 占位符 → React shell
  └── JSON API → AES-GCM HttpOnly 会话 → 同源写请求校验
      → transport::admin
          ├── API_KEYS repository → AES-GCM → KV
          ├── DeviceAuthorizationService → OAuth ports → KV
          └── subscription → CodexClient usage → 纯 subscription mapping
```

`GET /state` 只读取稳定的 OAuth metadata 和 API key；`GET /subscription` 才会发起带
客户端取消、10 秒超时和 256 KiB 响应上限的实时用量请求。

定时刷新：

```text
worker::event(scheduled)
  → OAuthRefreshService
  → CloudflareOAuthHttpClient / CloudflareClock / OAuthRepository
  → KV
```

## 正文、响应与状态机

- `http::LimitedBodyCollector` 统一执行编码体上限；JSON parser 对 zstd 解码结果再次限界。
- 无需改写的 Responses/compact 正文保留原编码字节；需要改写时才重新序列化 JSON 并
  清理 `Content-Encoding`/`Content-Length`。
- 透明代理直接复用 Worker `ReadableStream`，不复制图片、音频或其他大正文。
- Chat、Completions、Anthropic 与 Gemini 的流转换是 Rust 状态机；transport 逐块解码
  Codex SSE，并通过 `async-stream` 产生下游背压流。
- Responses WebSocket bridge 使用 `allowHalfOpen` 协调关闭；仅 client → upstream 的
  Responses 文本事件进入纯适配函数，二进制及反向帧保持不变。
- runtime-neutral `ResponseDto` 统一 CORS、header allow/deny policy、手动内容编码和
  provider error envelope，Worker adapter 只负责保留真实 body/socket handle。

## 稳定契约

- 未匹配路由、不支持的方法和无效客户端 key 均返回无正文、无 CORS 的 `404`。
- 只有已确认的公开 API 响应会添加 CORS；已知 API 路径支持无鉴权 `OPTIONS`。管理路由
  不添加 CORS，并要求 Cookie 会话及同源写请求。
- Static Assets 不启用全站 SPA fallback。Worker 只在隐藏管理路径读取 `index.html`，
  每次返回前替换 CSP nonce 占位符，其他未匹配路径保持隐藏式 `404`。
- Worker 生成的错误按入口协议使用 OpenAI、Anthropic 或 Google envelope；透明代理
  删除 cookie、hop-by-hop、Cloudflare 与内部服务 header，同时保留媒体、Range 与
  WebSocket 所需 header。
- Chat、Completions、Messages、Gemini、Responses 与 compact 的编码 JSON 和 zstd
  解码结果限制为 4 MiB；Live multipart 为 16 MiB；OAuth、用量和模型目录使用更小的
  专用上限。其余透明代理路径保持流式。
- OAuth credentials、`API_KEYS`、设备 state 与管理会话分别使用独立 AES-GCM purpose
  string。长期 secret 不进入 URL；`ADMIN_PATH` 只是额外隐藏层，不能替代管理密钥。
- OAuth provider 与 subscription usage 请求叠加固定超时，并把 incoming
  `AbortSignal` 传给上游；客户端取消、超时、网络、响应过大和 provider 状态使用不同的
  安全错误分类。
- `CloudflareSecretStore` 按平台当前最小值接受至少 30 秒的 `cache_ttl`；OAuth/API key
  常规读取显式使用 30 秒，未指定时保留 Workers KV 默认的 60 秒。
- KV 的设备登录检查后写入和 `API_KEYS` 读改写不是原子事务；面板面向低频、单管理员
  配置。需要并发排他或事务语义时迁移到 Durable Object 或 D1。
- 透明代理的传输兼容不代表上游协议兼容；实际路径与媒体面边界以
  [兼容矩阵](compatibility.md)为准。

## 构建与验证

`worker-build` 负责编译 Rust crate、运行 `wasm-bindgen` 并生成 Wrangler 可上传的
`worker-rs/build/index.js` 与 Wasm。Cloudflare Vite 插件负责把该入口、React client、
Static Assets binding 与本地 workerd 组合为同一个应用。

`pnpm dev` 先生成 dev Wasm，再启动单个 Vite 开发服务器。Vite 中的 Rust watcher 只监听
`worker-rs/src`、`Cargo.toml` 与 `Cargo.lock`：源码变化后串行运行 `worker-build --dev`，
生成的 Wasm 变化再触发 Worker runtime 重启；React 源码变化仍走 Fast Refresh。生产构建
先生成 release Wasm，再由 Vite 输出 client、Worker bundle 与供 Wrangler 使用的配置。

```powershell
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
pnpm install

pnpm dev
pnpm build
pnpm deploy
```

所有后端业务测试使用 Rust/Cargo；宿主测试不加载 Workers runtime，Wasm check 单独验证
Cloudflare adapter：

```powershell
cargo test --manifest-path worker-rs/Cargo.toml --all-targets
cargo fmt --manifest-path worker-rs/Cargo.toml -- --check
cargo clippy --manifest-path worker-rs/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path worker-rs/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
```

仓库脚本分别提供 `pnpm run test:rust`、`pnpm run check:rust` 和完整的 `pnpm check`。
修改 `wrangler.jsonc` bindings 后运行 `pnpm exec wrangler types`；部署前使用
`pnpm build` 生成 Vite 输出配置，再使用 `pnpm exec wrangler deploy --dry-run` 检查最终
Worker 入口与资源。

## 修改准则

- 新协议先实现纯 `RequestAdapter`/presenter，再由 `AdapterRegistry` factory 注册。
- 新 tokenizer、provider、clock 或 store 实现通过已有 port 注入，不让协议模块直接
  读取 `Env` 或发起 Fetch。
- 新 Codex 后端或路径策略放在 `upstream` 的纯 policy 与 `transport` I/O adapter 两侧，
  不把 URL/header 分支散落到协议转换器。
- 只有跨边界的真实替代实现才增加 trait；数据内部的小步骤优先使用普通函数和小模块，
  避免为单实现制造间接层。
- 每次变更同时运行宿主 Rust tests、Clippy、fmt、Wasm check；binding 变更再运行
  Wrangler type generation 与 dry-run。
