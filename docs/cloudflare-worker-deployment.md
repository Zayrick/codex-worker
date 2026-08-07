# Cloudflare Worker 自动构建与部署

本项目使用 GitHub Actions 在 GitHub runner 中完成 Rust/Wasm 与 React/Vite 构建，
再由 Wrangler 上传同一个 job 生成的 Worker bundle。Cloudflare 只接收产物，不负责
编译 Rust。

## 工作流

- `.github/workflows/ci.yml` 在每次 push 和 pull request 时运行 `pnpm check`，覆盖前端
  lint、Rust 测试、Rustfmt、宿主与 Wasm Clippy、完整生产构建和 Wrangler dry-run。
- `.github/workflows/deploy.yml` 在 push 到 `master` 或手动触发时构建并部署生产 Worker。
  `production` concurrency group 会阻止两个生产部署同时运行。

部署 job 必须先执行 `pnpm build`：`worker-build --release` 先生成
`worker-rs/build/index.js` 与 Wasm，随后 Vite 输出 `dist/client`、
`dist/codex_worker` 和 `.wrangler/deploy/config.json`。最后一个文件会让根目录执行的
`wrangler deploy` 自动使用 Vite 生成的部署配置。构建和部署因此不能拆到两个没有传递
完整产物的 job，也不应在 `wrangler.jsonc` 中再添加重复的 `build.command`。

## GitHub production environment

在 GitHub 仓库的 `Settings → Environments → production` 中添加：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 调用 Cloudflare API 的生产部署凭据 |
| `CLOUDFLARE_ACCOUNT_ID` | `codex-worker` 所在的 Cloudflare account ID |

使用 Cloudflare 的 `Edit Cloudflare Workers` token 模板，并把 token 限制到唯一目标
account。由于 `AUTH_KV` 使用 Wrangler 自动预配，自定义权限时还要允许管理 Workers KV；
使用自定义域名时还需对应 zone 的 Workers Routes 权限。不要把 token 或 account ID
硬编码到 workflow、Wrangler 配置或源码。

建议保护 `master`、把 CI 的 `verify` job 设为 required status check，并为 GitHub 的
`production` environment 配置受保护分支和必要的 reviewer。生产凭据只会进入部署 job，
不会提供给 pull request 的 CI job。

## 首次部署与 Worker secrets

GitHub 的两个部署 secrets 与 Worker 运行时的四个 secrets 不同。首次运行自动部署前，
必须先按项目根目录 `.env.production` 写入以下值：

```dotenv
ADMIN_PATH=<随机 URL 安全路径段>
ADMIN_SECRET=<独立生成的高强度管理密钥>
CHATGPT_RELAY_URL=https://chatgpt-relay.example.com
DATA_ENCRYPTION_KEY=<32 个随机字节的 base64url 编码>
```

然后完成一次带 secrets 的引导部署：

```sh
pnpm build
pnpm exec wrangler deploy --secrets-file .env.production
```

`wrangler.jsonc` 的 `secrets.required` 会阻止缺少任一运行时 secret 的部署。引导完成后，
GitHub Actions 只更新代码、Static Assets、Cron 和声明式配置；Wrangler 会继承已有加密
secrets，不会在普通部署中删除它们。尤其不要重新生成 `DATA_ENCRYPTION_KEY`，否则 KV 中
已有的 OAuth 和 API Key 密文将无法解密。

`.env.production`、`.dev.vars` 和构建产物均已由 `.gitignore` 排除，不能提交到 Git。

## 手动验证

本地重现 CI 和生产构建：

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.5 --locked
pnpm install --frozen-lockfile
pnpm check
```

已有 Worker secrets 时可手动部署：

```sh
pnpm deploy
```

相关官方文档：

- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare Wrangler Action](https://github.com/cloudflare/wrangler-action)
- [Wrangler 生成的部署配置](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
