# 安全模型

## 1. 安全边界

Codex Worker 涉及四类主体：

1. 下游 API 客户端；
2. 同源管理浏览器；
3. Cloudflare Worker、Static Assets 与 KV；
4. OpenAI 端点和部署者提供的 ChatGPT relay。

Worker 负责下游鉴权、凭据加密、路由隔离和 header 过滤。Cloudflare 账户、GitHub 部署凭据、
relay 主机及 OpenAI 账户的安全由部署者负责。

最重要的外部信任边界是 `CHATGPT_RELAY_URL`：relay 会接收 OAuth Bearer、ChatGPT 账户 ID、
提示、工具输入、上传内容和模型输出。仅可使用由部署者控制并完成安全审计的 relay。

## 2. Secret 分类

| Secret | 安全作用 | 轮换影响 |
| --- | --- | --- |
| `ADMIN_PATH` | 隐藏管理入口，降低无目标扫描 | 旧管理 URL 失效 |
| `ADMIN_SECRET` | 验证管理登录，并参与会话绑定 | 所有现有管理会话失效 |
| `AUTH_PROXY_HOST` | 指定 Backend API 凭据代理的入站 Host | 后续请求按新 Host 分流 |
| `BARK_PUSH_URL` | 指定包含设备 key 的 Bark HTTPS 推送端点 | 后续用量提醒切换到新设备或服务 |
| `CHATGPT_RELAY_URL` | 指定受信任上游 relay | 后续流量切换到新信任主体 |
| `DATA_ENCRYPTION_KEY` | 加密持久化凭据、用量、设备 state 与管理会话 | 现有加密数据和会话无法读取 |

`ADMIN_PATH` 是纵深防御措施，不是认证因子。`BARK_PUSH_URL` 的路径包含设备 key，必须按凭据
保护。`DATA_ENCRYPTION_KEY` 必须是 32 个随机字节的无填充 base64url 编码，并与其他 secret
独立生成。

secret 只应存放于 Cloudflare secret、开发机 `.dev.vars` 或一次性部署使用的
`.env.production`。不得写入 `wrangler.jsonc` 的 `vars`、源码、测试 fixture、日志、Issue 或
CI 输出。

## 3. 持久化加密

`AUTH_KV` 中有三个长期记录：

| KV key | 明文内容 | 存储形式 |
| --- | --- | --- |
| `oauth` | access token、refresh token、账户 ID、邮箱和过期时间 | AES-256-GCM envelope |
| `API_KEYS` | API Key 名称、值和启用状态，以及凭据替换启用状态和许可 `account_id` 列表 | AES-256-GCM envelope |
| `CODEX_USAGE` | 订阅类型、用量百分比、额度重置时间和告警状态 | AES-256-GCM envelope |

每次写入生成新的 12 字节 IV。OAuth、API Key 与代理设置、Codex 用量、设备授权 state 和管理
会话使用不同的 purpose 作为 AES-GCM 附加认证数据，防止一种用途的密文被重放到另一用途。

API Key 在 KV 中是可恢复的加密值，以便管理端显示和编辑；它不是不可逆哈希。公开请求鉴权会
先对输入和候选 Key 计算 SHA-256，再进行恒定时间比较。

没有迁移程序时不得更换 `DATA_ENCRYPTION_KEY`。更换根密钥不会“重新加密”现有 KV，而会让
现有记录无法解密。

## 4. 下游 API Key

每个 API Key 必须满足：

- 长度为 11–512 个 UTF-16 code unit；
- 同时包含字母、数字和非空白符号；
- Key 值唯一；
- 名称去除首尾空白后长度为 1–100，且不包含控制字符；
- 名称唯一；
- 最多保存 100 项。

只有启用的 Key 参与鉴权。凭据 header 的选择顺序为 Bearer、`X-Api-Key`、
`X-Goog-Api-Key`，不会在首选值错误时回退。认证失败使用空正文 `404`，避免区分路径存在、
缺少凭据和凭据错误。

长期 API Key 不得放入 URL、查询参数或 WebSocket 子协议。

## 5. 管理面保护

管理页面只在精确的 `/<ADMIN_PATH>/admin` 路径返回。Static Assets 未启用 HTML fallback，
直接访问 `/index.html` 不构成公开管理入口。

登录成功后，Worker 创建 12 小时有效的 `__Host-codex-admin` Cookie，属性包括：

- `Secure`；
- `HttpOnly`；
- `SameSite=Strict`；
- `Path=/`。

会话使用 `DATA_ENCRYPTION_KEY` 加密，并绑定当前 `ADMIN_SECRET`。更换管理密钥后旧会话立即
失效。登录、退出以及所有管理写请求必须带有与当前请求 origin 完全一致的 `Origin`；管理 API
不启用 CORS。

每次返回管理 HTML 时，Worker 生成新的 CSP nonce。页面同时设置禁止 framing、限制资源来源、
禁用摄像头/麦克风/定位、`nosniff` 和 `no-store` 等安全 header。

## 6. 上游请求隔离

普通公开 API 发送上游请求前，Worker 删除或重建以下类型的 header：

- 下游 `Authorization`、`X-Api-Key` 和 `X-Goog-Api-Key`；
- Cookie、Origin、Referer 和客户端提交的 ChatGPT 账户 ID；
- Host、连接管理和其他 hop-by-hop header；
- 客户端 IP、转发链、Cloudflare 与常见代理内部 header；
- WebSocket 握手中必须由 runtime 重新生成的 header。

随后只注入已保存的 OAuth Bearer、可信账户 ID 和 Codex 所需协议 header。上游响应侧删除
Cookie、Server、Cloudflare 内部 header 和 hop-by-hop header，并强制 `Cache-Control:
no-store`。重定向使用手动模式，避免 OAuth 自动重放到未知 origin。

OAuth 设备授权与刷新直连 `auth.openai.com`；Realtime sideband 直连 `api.openai.com`；
ChatGPT Codex 与订阅用量请求发送到配置的 relay。relay origin 必须通过 HTTPS 精确匹配校验。

Bark 推送只包含额度窗口名称、额度剩余百分比、剩余时间百分比、采样间隔和消耗速度，不包含
OAuth、账户 ID、邮箱、API Key 或模型请求内容。`BARK_PUSH_URL` 必须是无 userinfo、query、
fragment 和尾部斜杠的精确 HTTPS 端点；Worker 对 Bark 响应使用手动重定向策略，避免把设备
key 重放到其他 origin。使用公共 Bark 服务时，部署者必须接受该服务能够看到上述用量元数据；
否则应使用受信任的自托管 Bark 服务。

### Backend API 凭据代理

`AUTH_PROXY_HOST` 上的 `/backend-api` 请求将端到端 header 和正文发送到
`CHATGPT_RELAY_URL`。许可 `account_id` 使用已保存的 Codex OAuth 凭据；其他请求保留原
Authorization、账户 ID 和 Cookie。该 Host 与 relay 都必须处于部署者控制的信任边界内。

## 7. KV 一致性与撤销语义

Workers KV 是最终一致存储。本项目对 OAuth 和 API Key 常规读取显式使用 30 秒
`cacheTtl`，但其他边缘位置仍可能暂时读取旧值。因此：

- 停用、删除或轮换 API Key 不保证全球即时生效；
- 删除 OAuth 不保证所有边缘位置立即停止看到旧记录；
- `API_KEYS` 的并发读改写可能发生最后写入者覆盖；
- `CODEX_USAGE` 的连续快照可能短暂读取到上一轮状态，从而延迟或重复一次 Bark 提醒；
- 该管理面适用于低频、单管理员操作，不提供事务保证。

当前平台语义见 [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
和 [KV read API](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)。需要强一致即时撤销
时，必须改变存储架构，而不能依赖缩短 KV cache TTL 获得保证。

## 8. OAuth 生命周期

普通 API 请求只接受尚未过期的 OAuth 凭据，不在请求路径中刷新 token。Cron Trigger 每 5 分钟
直接检查 KV 中 OAuth 凭据的 `expiresAt`；凭据将在三小时内过期时执行刷新。刷新请求最长等待
10 秒，对网络错误、HTTP 429 和 5xx 最多尝试三次。

这种设计降低了多个边缘 isolate 同时消费旋转式 refresh token 的风险，但不提供全局锁。
部署者应监控定时刷新失败的固定错误 code，并通过管理界面在必要时重新授权。

## 9. CORS 与错误暴露

公开 API 的 `CORS_ORIGIN` 默认是 `*`。它是单个静态值，不是动态 allowlist，且不启用
credentialed CORS。若服务仅供固定前端使用，应在部署配置中设置精确 origin。

管理端不使用公开 API 的 CORS 策略。未知路径、错误方法、无效 API Key 以及关键鉴权配置缺失
通常返回空正文 `404`。协议层可公开的错误使用对应供应商 envelope，但不得包含 OAuth、API
Key、管理密钥、加密根密钥、IV 或密文。

## 10. 日志与运维要求

Worker 日志只应包含固定事件名、状态和安全错误 code。禁止记录：

- 请求或响应正文；
- OAuth token、refresh token 或账户凭据；
- 下游 API Key 或管理密钥；
- Bark 设备 URL 或设备 key；
- 管理 Cookie、设备 state、IV 或密文；
- `.dev.vars`、`.env.production` 或 Cloudflare/GitHub 部署凭据。

生产运维应至少保证：

- Cloudflare API token 按目标 account 和必要权限最小化；
- GitHub `production` environment 和默认分支受到保护；
- relay 禁止敏感日志并具备访问控制；
- `.wrangler/`、构建目录和本地 secret 文件不进入版本控制或制品；
- 修改 secret、KV binding 或 relay 前完成影响评估和回滚准备；
- 平台限制、配置字段和安全建议以当前 Cloudflare 官方文档为准。
