# Codex Worker

Codex Worker 是部署在 Cloudflare Workers 上的自托管 API 网关。项目使用 Rust/WebAssembly
实现 Worker 后端，使用 React 与 Vite 提供管理界面，并将 ChatGPT Codex 能力转换或映射为
OpenAI、Anthropic 和 Gemini 风格的接口。

本项目提供的是明确边界内的协议兼容能力，并非上述供应商 API 的完整替代实现。支持的路径、
字段差异和传输限制以 [API 与协议兼容性](docs/api.md) 为准。

## 核心能力

- 提供 Responses、Chat Completions、Completions、Anthropic Messages 和 Gemini Content 接口；
- 支持 JSON、SSE、WebSocket、multipart 与二进制流式传输；
- 通过管理界面完成 Codex 设备授权、订阅额度查看和下游 API Key 管理；
- 使用 Workers KV 保存 OAuth 凭据与 API Key，并以 AES-256-GCM 加密；
- 通过 Cron Trigger 定期刷新即将过期的 OAuth 凭据；
- 将 React 管理端与 Rust/Wasm Worker 构建为同一个 Cloudflare 部署单元。

## 系统组成

```text
API client ───────────────────────────────┐
                                          │
Browser ── hidden admin path ── React UI ─┼─→ Cloudflare Worker (Rust/Wasm)
                                          │          ├─→ AUTH_KV
                                          │          ├─→ Static Assets
                                          │          ├─→ auth.openai.com
                                          │          ├─→ api.openai.com
                                          │          └─→ trusted HTTPS relay ─→ chatgpt.com
                                          │
                                          └─ API Key authentication
```

`CHATGPT_RELAY_URL` 指向的 relay 不包含在本仓库中。它会接收上游 OAuth Bearer、账户标识以及
请求和响应内容，因此必须由部署者控制、审计并限制访问。完整信任边界见
[安全模型](docs/security.md)。

## 环境要求

- Node.js 22 或更高版本；
- pnpm 11.18.0；
- Rust 1.97 或更高版本；
- `wasm32-unknown-unknown` target；
- `worker-build` 0.8.5；
- Cloudflare 账户，以及可完成 Codex 设备授权的 OpenAI 账户；
- 一个受信任的 ChatGPT HTTPS relay。

## 本地启动

安装构建工具和依赖：

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
pnpm install --frozen-lockfile
```

创建本地配置：

```sh
cp .dev.vars.example .dev.vars
```

Windows PowerShell 可使用 `Copy-Item .dev.vars.example .dev.vars`。在 `.dev.vars` 中填写：

```dotenv
ADMIN_PATH=<随机 URL 安全路径段>
ADMIN_SECRET=<高强度管理密钥>
CHATGPT_RELAY_URL=https://relay.example.com
DATA_ENCRYPTION_KEY=<32 个随机字节的无填充 base64url 编码>
```

以下命令可生成符合格式的随机值。请分别执行，为 `ADMIN_PATH`、`ADMIN_SECRET` 和
`DATA_ENCRYPTION_KEY` 使用相互独立的值：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

启动开发服务器：

```sh
pnpm dev
```

默认地址为 `http://localhost:8787`。管理入口为：

```text
http://localhost:8787/<ADMIN_PATH>/admin
```

首次进入管理界面后，依次完成管理密钥登录、Codex 设备授权和下游 API Key 创建。随后可验证
公开 API：

```sh
curl https://worker.example.com/v1/models \
  -H 'Authorization: Bearer <client-api-key>'
```

生产环境配置、relay 示例和首次部署流程见 [部署与运维](docs/deployment.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 编译开发版 Rust Worker，并启动 Vite/workerd 开发服务器 |
| `pnpm build` | 构建 Rust/Wasm、React 资源和最终部署配置 |
| `pnpm preview` | 在本地预览生产构建 |
| `pnpm test` | 运行 Rust 后端测试 |
| `pnpm run check:rust` | 检查 Rust 格式、宿主 Clippy 与 Wasm Clippy |
| `pnpm check` | 执行 lint、测试、Rust 检查、生产构建和 Wrangler dry-run |
| `pnpm deploy` | 构建并部署到 Cloudflare |

## 文档

- [架构设计](docs/architecture.md)：系统拓扑、模块边界、请求流和持久化模型；
- [API 与协议兼容性](docs/api.md)：鉴权、路由、转换规则和应用级限制；
- [部署与运维](docs/deployment.md)：本地环境、首次部署、CI/CD 和部署验证；
- [安全模型](docs/security.md)：密钥、会话、relay、日志和 KV 一致性。

## 使用约束

- `DATA_ENCRYPTION_KEY` 是持久化数据的根密钥。没有迁移方案时不得更换，否则现有 OAuth
  凭据和 API Key 将无法解密。
- API Key 启停、删除和 OAuth 退出受 Workers KV 最终一致性影响，不保证全球即时生效。
- 管理路径只提供额外的入口隐藏，不替代 `ADMIN_SECRET`、会话校验和同源校验。
- 部署者应确认自身对相关账户、上游服务和网络基础设施的使用符合适用条款与政策。
