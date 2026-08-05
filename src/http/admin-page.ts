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
	<title>Codex Worker 管理</title>
	<style nonce="${nonce}">
		body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 12vh auto; padding: 0 1rem; color: #1f2937; }
		form { display: grid; gap: .75rem; }
		input, button { box-sizing: border-box; width: 100%; padding: .7rem; font: inherit; }
		button { cursor: pointer; }
		.error { color: #b91c1c; }
	</style>
</head>
<body>
	<main>
		<h1>Codex Worker 管理</h1>
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
	<title>Codex Worker 管理</title>
	<style nonce="${nonce}">
		:root { color-scheme: light dark; }
		body { font: 15px/1.5 system-ui, sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem 3rem; }
		header, .row, .actions { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
		header { justify-content: space-between; }
		section { border: 1px solid #8886; border-radius: .5rem; padding: 1rem; margin-top: 1rem; }
		table { width: 100%; border-collapse: collapse; margin-top: .75rem; }
		th, td { text-align: left; border-bottom: 1px solid #8885; padding: .55rem; vertical-align: top; }
		code { overflow-wrap: anywhere; }
		button, input { font: inherit; padding: .45rem .65rem; }
		input[type="text"], input[type="password"] { min-width: 18rem; }
		label { display: grid; gap: .25rem; }
		.hidden { display: none; }
		.error { color: #dc2626; }
		.success { color: #15803d; }
		.muted { opacity: .72; }
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
		<h1>Codex Worker 管理</h1>
		<form method="post" action="${escapeHtml(basePath)}/logout"><button type="submit">退出管理</button></form>
	</header>
	<p id="message" class="muted" role="status"></p>

	<section aria-labelledby="oauth-title">
		<h2 id="oauth-title">Codex OAuth</h2>
		<div id="oauth-loading">正在读取登录状态…</div>
		<div id="oauth-active" class="hidden">
			<p>邮箱：<strong id="oauth-email"></strong></p>
			<p>过期时间：<time id="oauth-expiry"></time></p>
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
		const state = { oauth: null, apiKeys: [], deviceState: null, deviceStarting: false, pollTimer: null, editingName: null };
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
				state.deviceState = null;
				renderOAuth();
				showMessage("Codex 登录成功。", false);
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
				state.apiKeys = result.apiKeys;
				renderOAuth();
				renderKeys();
				if (!state.oauth) await beginDeviceLogin();
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
				state.deviceState = null;
				renderOAuth();
				showMessage("已退出 Codex 登录。", false);
				await beginDeviceLogin();
			} catch (error) {
				showMessage(error instanceof Error ? error.message : "退出失败。", true);
			}
		});
		element("device-retry").addEventListener("click", () => { state.deviceState = null; beginDeviceLogin(); });
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
