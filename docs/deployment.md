# 部署与运维

## 1. 前置条件

| 组件 | 要求 |
| --- | --- |
| Node.js | 22 或更高版本；GitHub Actions 使用 Node.js 24 |
| pnpm | 11.18.0 |
| Rust | 1.97 或更高版本；GitHub Actions 使用 1.97.1 |
| WebAssembly target | `wasm32-unknown-unknown` |
| Worker 构建器 | `worker-build` 0.8.5 |
| Cloudflare | 可部署 Workers、Static Assets、KV 和 Cron Trigger 的账户 |
| OpenAI | 可完成 Codex 设备授权的账户 |
| relay | 由部署者控制的 ChatGPT HTTPS reverse proxy |
| Bark | Bark App 提供的设备端点，或兼容的自托管 HTTPS 服务 |

安装工具和依赖：

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
pnpm install --frozen-lockfile
```

## 2. Cloudflare 配置

`wrangler.jsonc` 是输入配置，Cloudflare Vite 插件在生产构建时生成实际部署配置。当前资源如下：

| 类型 | 名称或配置 | 用途 |
| --- | --- | --- |
| Worker entry | `worker-rs/build/index.js` | `worker-build` 生成的 Rust/Wasm 入口 |
| Static Assets binding | `ASSETS` | React 管理端资源 |
| KV binding | `AUTH_KV` | 加密的主/代理 OAuth、API Key、Backend API 代理设置与 Codex 用量状态 |
| Variable | `CORS_ORIGIN=*` | 公开 API 的单一 CORS origin |
| Cron Trigger | `*/5 * * * *` | 每 5 分钟采集用量、执行 Bark 告警并检查主账户与代理账户 OAuth 刷新 |
| Observability | enabled | 结构化 Worker 日志与 source map |

`AUTH_KV` 未声明 namespace ID，因此 Wrangler 当前会使用
[自动资源预配](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。
若必须复用现有 namespace，应在 `kv_namespaces` 条目中明确填写 `id`，并在部署前确认该
namespace 中的数据由当前 `DATA_ENCRYPTION_KEY` 加密。

公开用量页位于 `/status/usage`。它依赖 Cron 已成功写入至少一次 `CODEX_USAGE`；首次采样前页面
保持空状态，之后浏览器每 5 分钟读取一次 KV 快照。

## 3. 运行时 secret

| Secret | 格式 | 作用 |
| --- | --- | --- |
| `ADMIN_PATH` | 1–128 个 ASCII 字母、数字、`_` 或 `-` | 构成隐藏管理路径 |
| `ADMIN_SECRET` | 独立生成的高强度随机值 | 验证管理登录并绑定会话 |
| `AUTH_PROXY_HOST` | 不含 scheme、端口和路径的主机名 | Backend API 凭据代理的入站 Host |
| `BARK_PUSH_URL` | `https://<host>/<device-key>` | 接收 Codex 用量和消耗速度提醒 |
| `CHATGPT_RELAY_URL` | 精确 HTTPS origin | ChatGPT Codex 与用量请求的 relay |
| `DATA_ENCRYPTION_KEY` | 32 个随机字节的无填充 base64url | 加密持久化凭据和会话状态 |

`CHATGPT_RELAY_URL` 必须类似 `https://relay.example.com`，不能包含路径、查询参数、fragment、
userinfo 或尾部 `/`。Worker 会自行追加所有上游路径。

`BARK_PUSH_URL` 必须是 Bark 设备端点，例如 `https://api.day.app/<device-key>`。它必须使用
HTTPS，不能包含 userinfo、query、fragment 或尾部 `/`。自托管 Bark 可使用带路径前缀的端点，
只要最后一段仍是设备 key。

可使用以下命令生成随机值；每个 secret 必须单独生成：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`wrangler.jsonc` 中的 `secrets.required` 会在本地开发和部署时校验 secret 名称。生产 secret
的值保存在 Cloudflare，不应写入 Wrangler 配置或源码。

现有部署需要先以交互方式补充 Bark secret，再执行普通部署：

```sh
pnpm exec wrangler secret put BARK_PUSH_URL
```

## 4. relay 配置

relay 必须：

- 接受 HTTPS；
- 将收到的原始路径代理到 `https://chatgpt.com`；
- 支持流式请求、流式响应和 WebSocket Upgrade；
- 不记录 OAuth、账户 header、请求正文或响应正文；
- 通过网络策略限制为预期调用方可访问。

最小 Caddy 示例：

```caddyfile
relay.example.com {
	reverse_proxy https://chatgpt.com {
		header_up Host chatgpt.com
		header_up -CF-Worker
	}
}
```

该示例只说明路径转发要求，不包含访问控制、审计、速率限制或高可用配置。生产 relay 的安全与
可用性由部署者负责。

## 5. 本地开发

复制示例配置：

```sh
cp .dev.vars.example .dev.vars
```

Windows PowerShell 使用：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

填写六个 secret 后启动：

```sh
pnpm dev
```

该命令先运行 `worker-build --dev`，再启动 Vite 与 workerd。Vite 监听 React 源码；项目插件
监听 `worker-rs/src`、`Cargo.toml` 和 `Cargo.lock`，Rust 变化会触发串行 Wasm 重编译。

默认服务地址为 `http://localhost:8787`，管理地址为
`http://localhost:8787/<ADMIN_PATH>/admin`。本地 KV 数据由 Wrangler 开发环境管理，不会写入
生产 namespace。

不要以裸 `wrangler dev` 代替 `pnpm dev`：它不会先生成 Rust 入口，也不会提供本项目的
React/Vite 与 Rust watcher 构建链。

## 6. 首次生产部署

先登录 Cloudflare：

```sh
pnpm exec wrangler login
```

在仓库根目录创建不会提交到 Git 的 `.env.production`：

```dotenv
ADMIN_PATH=<random-path-segment>
ADMIN_SECRET=<independent-random-secret>
AUTH_PROXY_HOST=proxy.example.com
BARK_PUSH_URL=https://api.day.app/<device-key>
CHATGPT_RELAY_URL=https://relay.example.com
DATA_ENCRYPTION_KEY=<32-byte-base64url-key>
```

构建并引导上传 secret：

```sh
pnpm build
pnpm exec wrangler deploy --secrets-file .env.production
```

必须先运行 `pnpm build`。Vite 会把 React、Rust/Wasm 和 Wrangler 输入配置解析为一个生产部署
目录，并生成 `.wrangler/deploy/config.json`，后续 `wrangler deploy` 会自动使用该输出配置。

首次部署完成后：

1. 打开 `https://<worker-host>/<ADMIN_PATH>/admin`；
2. 使用 `ADMIN_SECRET` 登录；
3. 完成 Codex 设备授权；
4. 创建并启用至少一个下游 API Key；
5. 等待下一次 5 分钟定时任务，确认 `CODEX_USAGE` 已写入绑定的 KV；
6. 验证健康检查和模型接口。

不要提交 `.env.production`、`.dev.vars`、`.wrangler/` 或任何构建产物。

## 7. 常规部署

运行完整检查：

```sh
pnpm check
```

已有生产 secret 时部署：

```sh
pnpm deploy
```

`pnpm deploy` 依次执行生产构建和 `wrangler deploy`。普通部署会保留 Cloudflare 中已有、但未
包含在本次命令中的 secret。

如果修改了 binding、Cron、compatibility flag 或 Static Assets 配置，应检查当前
[Wrangler 配置文档](https://developers.cloudflare.com/workers/wrangler/configuration/)，再运行
`pnpm check` 验证生成配置与 dry-run。

## 8. GitHub Actions

`.github/workflows/deploy.yml` 负责 production 部署。push 到 `master` 或手动触发
workflow 时，`deploy` job 会安装固定版本的工具链并执行 `pnpm deploy`。

部署工作流使用 GitHub `production` environment，并要求：

| GitHub secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 非交互 Wrangler 部署凭据 |
| `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare account |

API token 应限制到唯一目标 account，并只授予部署 Worker 及管理项目所用资源所需的权限。六个
Worker runtime secret 不应复制到 GitHub；它们应在首次部署时写入 Cloudflare。

`deploy` job 在同一个 runner 中完成 Rust/Wasm 构建、Vite 构建和 Wrangler 部署，确保生成
配置与产物属于同一次构建。生产仓库应按需要为 `production` environment 配置
reviewer，并通过 branch protection 要求 PR 在合并前通过必要检查。

Cloudflare 的 CI 鉴权要求见
[GitHub Actions 文档](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

## 9. 部署验证

验证 OAuth 健康状态：

```sh
curl -i https://worker.example.com/healthz
```

有效 OAuth 应返回 `204 No Content`。验证公开 API：

```sh
curl -i https://worker.example.com/v1/models \
  -H 'Authorization: Bearer <client-api-key>'
```

同时确认：

- 管理页只在配置的精确路径可访问；
- 管理登录、订阅读取和 API Key 编辑正常；
- relay 支持 SSE 与 WebSocket，而非只支持普通 JSON；
- 下一次定时任务写入 `CODEX_USAGE`，满足条件时 Bark 能收到提醒；
- Worker 日志不包含 token、API Key、Bark 设备 URL、管理密钥或请求正文。

## 10. Secret 与数据变更

| 变更 | 影响 |
| --- | --- |
| 更换 `ADMIN_PATH` | 管理入口立即变更；旧 URL 不再匹配 |
| 更换 `ADMIN_SECRET` | 旧管理会话立即失效 |
| 更换 `BARK_PUSH_URL` | 后续提醒发送到新 Bark 设备或服务 |
| 更换 `CHATGPT_RELAY_URL` | 后续 ChatGPT Codex 与用量请求切换到新 relay |
| 更换 `DATA_ENCRYPTION_KEY` | 现有 OAuth、API Key、代理许可、Codex 用量、管理会话和未完成设备 state 无法解密 |
| 更换 `AUTH_KV` namespace | 新 Worker 看不到原 namespace 中的凭据 |

没有显式数据迁移方案时，不得轮换 `DATA_ENCRYPTION_KEY` 或切换 `AUTH_KV`。代码回滚也应保留
当前 secret 与 KV binding，避免把应用回滚误变为凭据丢失。

## 11. 常见故障

| 现象 | 检查项 |
| --- | --- |
| 部署提示缺少 secret | 确认六个 required secret 已上传到目标 Worker |
| `/healthz` 返回 `404` | 检查 OAuth 是否存在、可解密且未过期 |
| API 返回空 `404` | 检查路径、方法、API Key 状态、KV binding 和加密密钥 |
| 上游接口返回错误 | 检查 relay origin、relay 日志策略、OAuth 状态和账户能力 |
| 没有收到 Bark 提醒 | 检查 `BARK_PUSH_URL`、Cron 日志和当前额度是否满足告警条件 |
| API Key 变更未立即生效 | 考虑 Workers KV 的跨区域最终一致性 |
| 部署使用旧产物 | 重新执行 `pnpm build`，再从仓库根目录运行 Wrangler |

平台参考：

- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Generated Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers KV](https://developers.cloudflare.com/kv/)
- [Bark push API](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)
