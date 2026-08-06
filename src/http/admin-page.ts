import { htmlResponse } from "./response";

export function adminLoginPage(
	basePath: string,
	invalidSecret = false,
	status = 200,
): Response {
	const nonce = pageNonce();
	const error = invalidSecret
		? '<p class="error" role="alert">管理密钥无效。</p>'
		: "";
	return htmlResponse(
		`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Codex Worker</title>
	<style nonce="${nonce}">
		body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1rem; color: #1f2937; }
		h1 { margin-bottom: 0; }
		.subtitle { margin: .15rem 0 1.5rem; font-size: .85rem; opacity: .72; }
		form { display: grid; gap: .75rem; }
		input, button { box-sizing: border-box; width: 100%; padding: .7rem; font: inherit; }
		button { cursor: pointer; }
		.error { color: #b91c1c; }
	</style>
</head>
<body>
	<main>
		<h1>Codex Worker</h1>
		<p class="subtitle">部署与Cloudflare的Codex反代API</p>
		${error}
		<form method="post" action="${escapeHtml(basePath)}/login">
			<label>管理密钥
				<input name="secret" type="password" maxlength="512" autocomplete="current-password" required autofocus>
			</label>
			<button type="submit">登录</button>
		</form>
	</main>
</body>
</html>`,
		status,
		nonce,
	);
}

export function adminDashboardPage(basePath: string): Response {
	const nonce = pageNonce();
	const serializedBasePath = JSON.stringify(basePath).replace(/</g, "\\u003c");
	return htmlResponse(
		`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Codex Worker</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		body { font: 15px/1.5 system-ui, sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem 3rem; }
		header, .row, .actions { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
		header { justify-content: space-between; }
		.brand h1 { margin: 0; }
		.brand p { margin: .15rem 0 0; font-size: .85rem; }
		section { border: 1px solid #8886; border-radius: .5rem; padding: 1rem; margin-top: 1rem; }
		table { width: 100%; border-collapse: collapse; margin-top: .75rem; }
		th, td { text-align: left; border-bottom: 1px solid #8885; padding: .55rem; vertical-align: top; }
		code { overflow-wrap: anywhere; }
		button, input { font: inherit; padding: .45rem .65rem; }
		button { cursor: pointer; }
		button:disabled { cursor: wait; opacity: .6; }
		.icon-button { display: inline-flex; align-items: center; justify-content: center; padding: .5rem; cursor: pointer; }
		.icon-button svg { width: 1.25rem; height: 1.25rem; }
		input[type="text"], input[type="password"] { min-width: 18rem; }
		label { display: grid; gap: .25rem; }
		.hidden { display: none; }
		.error { color: #dc2626; }
		.success { color: #15803d; }
		.muted { opacity: .72; }
		.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; margin: .75rem 0; }
		.summary-item { border: 1px solid #8885; border-radius: .45rem; padding: .7rem; }
		.summary-label { display: block; font-size: .8rem; opacity: .7; margin-bottom: .2rem; }
		.quota-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: .75rem; margin-top: .75rem; }
		.quota-card { --quota-color: #16a34a; border: 1px solid #8885; border-radius: .45rem; padding: .75rem; }
		.quota-card.quota-medium { --quota-color: #d97706; }
		.quota-card.quota-low { --quota-color: #dc2626; }
		.quota-card-header { display: flex; justify-content: space-between; gap: .75rem; align-items: baseline; }
		.quota-card p { margin: .35rem 0 0; }
		.quota-time-scale { display: flex; justify-content: flex-end; margin-top: .6rem; font-size: .82rem; }
		.quota-time-scale strong { font-variant-numeric: tabular-nums; text-align: right; }
		.quota-meter { position: relative; height: .72rem; margin-top: .4rem; border-radius: 999px; background: #8884; box-shadow: inset 0 0 0 1px #8884; }
		.quota-meter progress { appearance: none; display: block; width: 100%; height: 100%; border: 0; border-radius: inherit; overflow: hidden; background: transparent; }
		.quota-meter progress::-webkit-progress-bar { border-radius: inherit; background: transparent; }
		.quota-meter progress::-webkit-progress-value { border-radius: inherit; background: var(--quota-color); }
		.quota-meter progress::-moz-progress-bar { border-radius: inherit; background: var(--quota-color); }
		.quota-time-dot { appearance: none; position: absolute; z-index: 1; inset: 50% 0 auto; box-sizing: border-box; width: 100%; height: .72rem; margin: 0; padding: 0; border: 0; opacity: 1; background: transparent; pointer-events: none; transform: translateY(-50%); }
		.quota-time-dot::-webkit-slider-runnable-track { height: .72rem; background: transparent; }
		.quota-time-dot::-webkit-slider-thumb { appearance: none; width: .48rem; height: .48rem; margin-top: .12rem; border: 0; border-radius: 50%; background: rgb(37 99 235 / .65); }
		.quota-time-dot::-moz-range-track { height: .72rem; background: transparent; }
		.quota-time-dot::-moz-range-thumb { box-sizing: border-box; width: .48rem; height: .48rem; border: 0; border-radius: 50%; background: rgb(37 99 235 / .65); }
		.quota-legend { margin-bottom: 0; font-size: .8rem; }
		.quota-badge { border: 1px solid currentColor; border-radius: 999px; padding: .05rem .4rem; color: #dc2626; font-size: .75rem; white-space: nowrap; }
		#key-editor { display: grid; gap: .75rem; max-width: 48rem; margin-top: 1rem; }
		@media (max-width: 46rem) {
			table, thead, tbody, tr, th, td { display: block; }
			thead { display: none; }
			tr { border-bottom: 1px solid #8888; padding: .5rem 0; }
			td { border: 0; padding: .25rem 0; }
			input[type="text"], input[type="password"] { min-width: 0; width: 100%; }
		}
	</style>
</head>
<body>
	<header>
		<div class="brand">
			<h1>Codex Worker</h1>
			<p class="muted">部署与Cloudflare的Codex反代API</p>
		</div>
		<form method="post" action="${escapeHtml(basePath)}/logout">
			<button class="icon-button" type="submit" aria-label="退出管理" title="退出管理">
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="m16 17 5-5-5-5"></path>
					<path d="M21 12H9"></path>
					<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
				</svg>
			</button>
		</form>
	</header>
	<p id="message" class="muted" role="status"></p>

	<section aria-labelledby="oauth-title">
		<h2 id="oauth-title">Codex OAuth</h2>
		<div id="oauth-loading">正在读取登录状态…</div>
		<div id="oauth-active" class="hidden">
			<p>邮箱：<strong id="oauth-email"></strong></p>
			<p>OAuth 凭据过期时间：<time id="oauth-expiry"></time></p>
			<button id="oauth-remove" type="button">退出 Codex 登录</button>
		</div>
		<div id="oauth-device" class="hidden">
			<p id="device-status">正在创建设备登录码…</p>
			<div id="device-code-wrap" class="hidden">
				<p>登录码：<strong id="device-code"></strong></p>
				<p>登录网址：<a id="device-link" target="_blank" rel="noopener noreferrer"></a></p>
			</div>
			<button id="device-retry" type="button" class="hidden">重新获取登录码</button>
		</div>
	</section>

	<section aria-labelledby="subscription-title">
		<div class="row">
			<h2 id="subscription-title">订阅与额度</h2>
			<button id="subscription-refresh" type="button">刷新</button>
		</div>
		<p id="subscription-status" class="muted">正在读取订阅信息…</p>
		<p id="subscription-logged-out" class="muted hidden">完成 Codex 登录后可读取订阅与额度。</p>
		<div id="subscription-content" class="hidden">
			<div class="summary-grid">
				<div class="summary-item"><span class="summary-label">套餐</span><strong id="subscription-plan">未知</strong></div>
				<div id="subscription-start-item" class="summary-item hidden"><span class="summary-label">订阅开始时间</span><time id="subscription-start"></time></div>
				<div id="subscription-expiry-item" class="summary-item hidden"><span class="summary-label">订阅到期时间</span><time id="subscription-expiry"></time></div>
				<div id="subscription-credits-item" class="summary-item hidden"><span class="summary-label">额度重置积分</span><strong id="subscription-credits"></strong></div>
				<div id="subscription-updated-item" class="summary-item hidden"><span class="summary-label">用量更新时间</span><time id="subscription-updated"></time></div>
			</div>
			<p id="subscription-error" class="error hidden" role="alert"></p>
			<div id="quota-list" class="quota-list"></div>
			<p id="quota-legend" class="quota-legend muted hidden">条形表示剩余额度，半透明圆点表示剩余时间；两者越接近，用量越均衡。</p>
			<p id="quota-empty" class="muted hidden">上游没有返回可展示的额度窗口。</p>
		</div>
	</section>

	<section aria-labelledby="keys-title">
		<div class="row">
			<h2 id="keys-title">API Keys</h2>
			<button id="key-add" type="button">添加</button>
			<button id="key-reload" type="button">刷新</button>
		</div>
		<table>
			<thead><tr><th>名称</th><th>Key</th><th>状态</th><th>操作</th></tr></thead>
			<tbody id="key-list"></tbody>
		</table>
		<p id="key-empty" class="muted hidden">尚未配置 API Key。</p>
		<form id="key-editor" class="hidden">
			<h3 id="key-editor-title">添加 API Key</h3>
			<label>名称<input id="key-name" name="name" type="text" maxlength="100" required></label>
			<label>Key
				<span class="row"><input id="key-value" name="key" type="password" maxlength="67" pattern="sk-[a-z0-9]{64}" autocomplete="off" required><button id="key-generate" type="button">自动生成</button></span>
			</label>
			<label class="row"><input id="key-enabled" name="enabled" type="checkbox" checked> 启用</label>
			<div class="actions"><button type="submit">保存</button><button id="key-cancel" type="button">取消</button></div>
		</form>
	</section>

	<script nonce="${nonce}">
		const basePath = ${serializedBasePath};
		const state = { oauth: null, subscription: null, subscriptionLoading: false, subscriptionError: null, apiKeys: [], deviceState: null, deviceStarting: false, pollTimer: null, editingName: null };
		const element = (id) => document.getElementById(id);

		async function request(path, options) {
			const init = options || {};
			init.credentials = "same-origin";
			init.headers = new Headers(init.headers);
			init.headers.set("Accept", "application/json");
			if (init.body) init.headers.set("Content-Type", "application/json");
			const response = await fetch(basePath + path, init);
			let payload = null;
			try { payload = await response.json(); } catch { payload = null; }
			if (response.status === 401) {
				window.location.reload();
				throw new Error("管理会话已失效。");
			}
			if (!response.ok) {
				throw new Error(payload && payload.error && payload.error.message ? payload.error.message : "请求失败。");
			}
			return payload;
		}

		function showMessage(text, error) {
			const target = element("message");
			target.textContent = text || "";
			target.className = error ? "error" : text ? "success" : "muted";
		}

		function renderOAuth() {
			element("oauth-loading").classList.add("hidden");
			const active = element("oauth-active");
			const device = element("oauth-device");
			if (state.oauth) {
				active.classList.remove("hidden");
				device.classList.add("hidden");
				element("oauth-email").textContent = state.oauth.email || "未提供";
				const expiry = new Date(state.oauth.expiresAt);
				element("oauth-expiry").dateTime = expiry.toISOString();
				element("oauth-expiry").textContent = expiry.toLocaleString();
				return;
			}
			active.classList.add("hidden");
			device.classList.remove("hidden");
		}

		function formatPlanType(value) {
			const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
			if (normalized === "pro") return "Pro";
			if (normalized === "prolite" || normalized === "pro-lite" || normalized === "pro_lite") return "Pro Lite";
			if (normalized === "plus") return "Plus";
			if (normalized === "team") return "Team";
			if (normalized === "free") return "Free";
			return value || "未知";
		}

		function setTimeValue(id, value) {
			const target = element(id);
			const timestamp = Number(value);
			if (!Number.isFinite(timestamp) || timestamp <= 0) {
				target.removeAttribute("datetime");
				target.textContent = "";
				return false;
			}
			const date = new Date(timestamp);
			if (Number.isNaN(date.getTime())) return false;
			target.dateTime = date.toISOString();
			target.textContent = date.toLocaleString();
			return true;
		}

		function quotaWindowLabel(window) {
			const kindLabels = {
				five_hour: "5 小时额度",
				weekly: "7 天额度",
				monthly: "月度额度",
				primary: "主要额度",
				secondary: "次要额度"
			};
			const name = window.category === "code_review" ? "代码审查" : window.name || "Codex";
			return name + " · " + (kindLabels[window.kind] || "额度");
		}

		function formatRemainingDuration(milliseconds) {
			const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
			if (totalMinutes === 0) return "不足 1 分钟";
			const days = Math.floor(totalMinutes / 1440);
			const hours = Math.floor((totalMinutes % 1440) / 60);
			const minutes = totalMinutes % 60;
			if (days > 0) return days + " 天" + (hours > 0 ? " " + hours + " 小时" : "");
			if (hours > 0) return hours + " 小时" + (minutes > 0 ? " " + minutes + " 分钟" : "");
			return minutes + " 分钟";
		}

		function quotaTimeState(window, now) {
			const resetAt = Number(window.resetAt);
			const periodSeconds = Number(window.limitWindowSeconds);
			if (
				!Number.isFinite(resetAt) ||
				resetAt <= 0 ||
				!Number.isFinite(periodSeconds) ||
				periodSeconds <= 0
			) {
				return null;
			}
			const duration = periodSeconds * 1000;
			const remaining = Math.max(0, Math.min(duration, resetAt - now));
			const percent = remaining / duration * 100;
			const remainingLabel = resetAt <= now
				? "已到重置时间"
				: "剩余 " + formatRemainingDuration(remaining);
			return {
				percent,
				remainingLabel,
				title: "剩余时间 " + Math.round(percent) + "%（" + remainingLabel + "）"
			};
		}

		function renderQuotaWindows(windows) {
			const list = element("quota-list");
			list.replaceChildren();
			const entries = Array.isArray(windows) ? windows : [];
			const now = Date.now();
			let showsTimeRing = false;
			element("quota-empty").classList.toggle(
				"hidden",
				entries.length !== 0 || state.subscriptionLoading
			);
			for (const window of entries) {
				const card = document.createElement("article");
				card.className = "quota-card";
				const header = document.createElement("div");
				header.className = "quota-card-header";
				const title = document.createElement("strong");
				title.textContent = quotaWindowLabel(window);
				header.append(title);
				if (window.limitReached) {
					const badge = document.createElement("span");
					badge.className = "quota-badge";
					badge.textContent = "额度已用尽";
					header.append(badge);
				}
				card.append(header);

				const remaining = Number(window.remainingPercent);
				const used = Number(window.usedPercent);
				const hasPercent =
					window.remainingPercent !== null &&
					window.remainingPercent !== undefined &&
					window.usedPercent !== null &&
					window.usedPercent !== undefined &&
					Number.isFinite(remaining) &&
					Number.isFinite(used);
				const usage = document.createElement("p");
				usage.textContent = hasPercent
					? "剩余 " + Math.round(remaining) + "%（已用 " + Math.round(used) + "%）"
					: "用量未知";
				card.append(usage);
				card.classList.toggle("quota-low", hasPercent && remaining <= 10);
				card.classList.toggle(
					"quota-medium",
					hasPercent && remaining > 10 && remaining <= 30
				);

				const timeState = quotaTimeState(window, now);
				if (timeState) {
					showsTimeRing = true;
					const scale = document.createElement("div");
					scale.className = "quota-time-scale";
					const remainingTime = document.createElement("strong");
					remainingTime.textContent = timeState.remainingLabel;
					scale.append(remainingTime);
					card.append(scale);
				}

				if (hasPercent || timeState) {
					const meter = document.createElement("div");
					meter.className = "quota-meter";
					if (hasPercent) {
						meter.setAttribute("role", "progressbar");
						meter.setAttribute("aria-valuemin", "0");
						meter.setAttribute("aria-valuemax", "100");
						meter.setAttribute("aria-valuenow", String(Math.round(remaining)));
						meter.setAttribute(
							"aria-valuetext",
							quotaWindowLabel(window) + "剩余额度 " + Math.round(remaining) + "%"
						);
						const fill = document.createElement("progress");
						fill.max = 100;
						fill.value = Math.max(0, Math.min(100, remaining));
						fill.setAttribute("aria-hidden", "true");
						meter.append(fill);
					}
					if (timeState) {
						meter.title = timeState.title;
						const ring = document.createElement("input");
						ring.className = "quota-time-dot";
						ring.type = "range";
						ring.min = "0";
						ring.max = "100";
						ring.value = String(Math.max(0, Math.min(100, timeState.percent)));
						ring.disabled = true;
						ring.tabIndex = -1;
						ring.setAttribute("aria-hidden", "true");
						meter.append(ring);
					}
					card.append(meter);
				}

				const reset = document.createElement("p");
				reset.className = "muted";
				const resetAt = Number(window.resetAt);
				const resetDate = new Date(resetAt);
				if (Number.isFinite(resetAt) && resetAt > 0 && !Number.isNaN(resetDate.getTime())) {
					const time = document.createElement("time");
					time.dateTime = resetDate.toISOString();
					time.textContent = resetDate.toLocaleString();
					reset.append("重置时间：", time);
				} else {
					reset.textContent = "重置时间：未知";
				}
				card.append(reset);
				list.append(card);
			}
			element("quota-legend").classList.toggle("hidden", !showsTimeRing);
		}

		function renderSubscription() {
			const loggedIn = Boolean(state.oauth);
			element("subscription-refresh").disabled = !loggedIn || state.subscriptionLoading;
			element("subscription-logged-out").classList.toggle("hidden", loggedIn);
			const content = element("subscription-content");
			content.classList.toggle("hidden", !loggedIn);
			const status = element("subscription-status");
			status.textContent = !loggedIn
				? ""
				: state.subscriptionLoading
					? "正在获取最新订阅与用量…"
					: "";
			status.classList.toggle("hidden", !status.textContent);
			if (!loggedIn) return;

			const subscription = state.subscription || {};
			element("subscription-plan").textContent = formatPlanType(subscription.planType);
			element("subscription-start-item").classList.toggle(
				"hidden",
				!setTimeValue("subscription-start", subscription.subscriptionActiveStart)
			);
			const hasExpiry = setTimeValue("subscription-expiry", subscription.subscriptionActiveUntil);
			element("subscription-expiry-item").classList.toggle("hidden", !hasExpiry);
			element("subscription-expiry").className =
				hasExpiry && Number(subscription.subscriptionActiveUntil) <= Date.now() ? "error" : "";
			const credits = subscription.rateLimitResetCredits;
			const availableCredits =
				credits && credits.availableCount !== null && credits.availableCount !== undefined
					? Number(credits.availableCount)
					: Number.NaN;
			const hasCredits = Number.isFinite(availableCredits);
			element("subscription-credits-item").classList.toggle("hidden", !hasCredits);
			if (hasCredits) {
				const applicable =
					credits.applicableAvailableCount !== null &&
					credits.applicableAvailableCount !== undefined
						? Number(credits.applicableAvailableCount)
						: Number.NaN;
				element("subscription-credits").textContent = Number.isFinite(applicable)
					? Math.max(0, availableCredits) + "（当前可用 " + Math.max(0, applicable) + "）"
					: String(Math.max(0, availableCredits));
			}
			element("subscription-updated-item").classList.toggle(
				"hidden",
				!setTimeValue("subscription-updated", subscription.fetchedAt)
			);
			const error = element("subscription-error");
			error.textContent = state.subscriptionError || "";
			error.classList.toggle("hidden", !state.subscriptionError);
			renderQuotaWindows(subscription.windows);
		}

		async function loadSubscription() {
			if (!state.oauth || state.subscriptionLoading) {
				renderSubscription();
				return;
			}
			state.subscriptionLoading = true;
			state.subscriptionError = null;
			renderSubscription();
			try {
				const result = await request("/subscription");
				state.subscription = result.subscription;
			} catch (error) {
				state.subscriptionError = error instanceof Error ? error.message : "读取订阅与额度失败。";
			} finally {
				state.subscriptionLoading = false;
				renderSubscription();
			}
		}

		async function beginDeviceLogin() {
			if (state.oauth || state.deviceStarting) return;
			state.deviceStarting = true;
			if (state.pollTimer) clearTimeout(state.pollTimer);
			element("device-retry").classList.add("hidden");
			element("device-code-wrap").classList.add("hidden");
			element("device-status").textContent = "正在创建设备登录码…";
			try {
				const result = await request("/oauth/device", { method: "POST" });
				state.deviceState = result.state;
				element("device-code").textContent = result.userCode;
				const link = element("device-link");
				link.href = result.verificationUri;
				link.textContent = result.verificationUri;
				element("device-code-wrap").classList.remove("hidden");
				element("device-status").textContent = "请在登录网址输入登录码，页面会自动检查结果。";
				scheduleDevicePoll(result.interval);
			} catch (error) {
				element("device-status").textContent = error instanceof Error ? error.message : "无法创建设备登录码。";
				element("device-retry").classList.remove("hidden");
			} finally {
				state.deviceStarting = false;
			}
		}

		function scheduleDevicePoll(seconds) {
			if (state.pollTimer) clearTimeout(state.pollTimer);
			state.pollTimer = setTimeout(pollDeviceLogin, Math.max(1, seconds) * 1000);
		}

		async function pollDeviceLogin() {
			if (!state.deviceState || state.oauth) return;
			try {
				const result = await request("/oauth/device/poll", {
					method: "POST",
					body: JSON.stringify({ state: state.deviceState })
				});
				if (result.status === "pending") {
					element("device-status").textContent = "等待完成登录…";
					scheduleDevicePoll(result.retryAfter);
					return;
				}
				state.oauth = result.oauth;
				state.subscription = result.subscription || null;
				state.deviceState = null;
				renderOAuth();
				renderSubscription();
				showMessage("Codex 登录成功。", false);
				await loadSubscription();
			} catch (error) {
				element("device-status").textContent = error instanceof Error ? error.message : "检查登录状态失败。";
				element("device-retry").classList.remove("hidden");
			}
		}

		function button(label, handler) {
			const result = document.createElement("button");
			result.type = "button";
			result.textContent = label;
			result.addEventListener("click", handler);
			return result;
		}

		function renderKeys() {
			const list = element("key-list");
			list.replaceChildren();
			element("key-empty").classList.toggle("hidden", state.apiKeys.length !== 0);
			for (const entry of state.apiKeys) {
				const row = document.createElement("tr");
				const name = document.createElement("td");
				name.textContent = entry.name;
				const keyCell = document.createElement("td");
				const key = document.createElement("code");
				key.textContent = entry.key;
				keyCell.append(key, " ", button("复制", async () => {
					try { await navigator.clipboard.writeText(entry.key); showMessage("Key 已复制。", false); }
					catch { showMessage("无法访问剪贴板。", true); }
				}));
				const enabled = document.createElement("td");
				enabled.textContent = entry.enabled ? "已启用" : "已停用";
				const actions = document.createElement("td");
				actions.className = "actions";
				actions.append(
					button("编辑", () => openKeyEditor(entry)),
					button("删除", () => removeKey(entry.name))
				);
				row.append(name, keyCell, enabled, actions);
				list.append(row);
			}
		}

		function generateApiKey() {
			const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
			let value = "";
			const bytes = new Uint8Array(96);
			while (value.length < 64) {
				crypto.getRandomValues(bytes);
				for (const byte of bytes) {
					if (byte < 252) value += alphabet[byte % alphabet.length];
					if (value.length === 64) break;
				}
			}
			return "sk-" + value;
		}

		function openKeyEditor(entry) {
			state.editingName = entry ? entry.name : null;
			element("key-editor-title").textContent = entry ? "编辑 API Key" : "添加 API Key";
			element("key-name").value = entry ? entry.name : "";
			element("key-value").value = entry ? entry.key : generateApiKey();
			element("key-enabled").checked = entry ? entry.enabled : true;
			element("key-editor").classList.remove("hidden");
			element("key-name").focus();
		}

		function closeKeyEditor() {
			state.editingName = null;
			element("key-editor").classList.add("hidden");
		}

		async function removeKey(name) {
			if (!window.confirm("删除 API Key“" + name + "”？")) return;
			try {
				const result = await request("/api-keys", { method: "DELETE", body: JSON.stringify({ name }) });
				state.apiKeys = result.apiKeys;
				renderKeys();
				showMessage("API Key 已删除。", false);
			} catch (error) {
				showMessage(error instanceof Error ? error.message : "删除失败。", true);
			}
		}

		async function loadState() {
			try {
				const result = await request("/state");
				state.oauth = result.oauth;
				state.subscription = result.subscription;
				state.apiKeys = result.apiKeys;
				renderOAuth();
				renderSubscription();
				renderKeys();
				if (state.oauth) await loadSubscription();
				else await beginDeviceLogin();
			} catch (error) {
				element("oauth-loading").textContent = "读取失败。";
				showMessage(error instanceof Error ? error.message : "读取管理数据失败。", true);
			}
		}

		element("oauth-remove").addEventListener("click", async () => {
			if (!window.confirm("退出当前 Codex 登录？")) return;
			try {
				await request("/oauth", { method: "DELETE" });
				state.oauth = null;
				state.subscription = null;
				state.subscriptionError = null;
				state.deviceState = null;
				renderOAuth();
				renderSubscription();
				showMessage("已退出 Codex 登录。", false);
				await beginDeviceLogin();
			} catch (error) {
				showMessage(error instanceof Error ? error.message : "退出失败。", true);
			}
		});
		element("device-retry").addEventListener("click", () => { state.deviceState = null; beginDeviceLogin(); });
		element("subscription-refresh").addEventListener("click", loadSubscription);
		element("key-add").addEventListener("click", () => openKeyEditor(null));
		element("key-reload").addEventListener("click", loadState);
		element("key-cancel").addEventListener("click", closeKeyEditor);
		element("key-generate").addEventListener("click", () => { element("key-value").value = generateApiKey(); });
		element("key-editor").addEventListener("submit", async (event) => {
			event.preventDefault();
			const entry = {
				name: element("key-name").value,
				key: element("key-value").value,
				enabled: element("key-enabled").checked
			};
			const editingName = state.editingName;
			const body = editingName ? { originalName: editingName, ...entry } : entry;
			try {
				const result = await request("/api-keys", {
					method: editingName ? "PUT" : "POST",
					body: JSON.stringify(body)
				});
				state.apiKeys = result.apiKeys;
				renderKeys();
				closeKeyEditor();
				showMessage("API Key 已保存。", false);
			} catch (error) {
				showMessage(error instanceof Error ? error.message : "保存失败。", true);
			}
		});

		window.setInterval(() => {
			if (!document.hidden && state.oauth && state.subscription) renderSubscription();
		}, 60 * 1000);
		loadState();
	</script>
</body>
</html>`,
		200,
		nonce,
	);
}

function pageNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
