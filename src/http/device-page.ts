import type { DeviceAuthorization } from "../auth/device-flow";
import { htmlResponse } from "./response";
import { ApiError } from "../shared/api-error";

export function deviceLoginPage(): Response {
	return htmlResponse(`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Codex 设备登录</title>
</head>
<body>
	<form method="post" action="/auth/device/start">
		<label>设备管理密钥：<input name="secret" type="password" maxlength="512" autocomplete="current-password" required></label>
		<button type="submit">开始登录</button>
	</form>
</body>
</html>`);
}

export function deviceStartPage(
	authorization: DeviceAuthorization,
	pollUrl: URL,
): Response {
	const verificationUri = escapeHtml(authorization.verificationUri);
	const userCode = escapeHtml(authorization.userCode);
	const pollHref = escapeHtml(pollUrl.toString());
	const initialStatus = deviceStatusDocument(
		`将在 ${authorization.interval} 秒后开始检查授权状态…`,
		pollUrl,
		authorization.interval,
	);

	return htmlResponse(`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Codex 设备登录</title>
</head>
<body>
	设备码：${userCode}<br>
	验证页面：<a href="${verificationUri}" target="_blank" rel="noopener">${verificationUri}</a>
	<iframe id="device-status" title="授权状态" data-poll-url="${pollHref}" srcdoc="${escapeHtml(initialStatus)}" hidden></iframe>
	<script>
		const statusFrame = document.getElementById("device-status");
		window.addEventListener("message", (event) => {
			if (
				event.origin === window.location.origin &&
				event.source === statusFrame.contentWindow &&
				event.data === "device-authorization-complete"
			) {
				window.close();
			}
		});
	</script>
</body>
</html>`);
}

export function devicePendingPage(pollUrl: URL, retryAfter: number): Response {
	return htmlResponse(
		deviceStatusDocument(
			`尚未完成验证，${retryAfter} 秒后再次检查…`,
			pollUrl,
			retryAfter,
		),
		202,
	);
}

export function deviceCompletePage(): Response {
	return htmlResponse(
		deviceStatusDocument("登录完成，OAuth 凭据已保存。", undefined, undefined, true),
	);
}

export function deviceErrorPage(error: ApiError): Response {
	const code = error.code ? `<p>${escapeHtml(error.code)}</p>` : "";
	return htmlResponse(
		`<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>设备登录失败</title>
</head>
<body>
	<p>设备登录失败：${escapeHtml(error.message)}</p>
	${code}
</body>
</html>`,
		error.status,
	);
}

function deviceStatusDocument(
	message: string,
	refreshUrl?: URL,
	refreshAfter?: number,
	complete = false,
): string {
	const refresh =
		refreshUrl && refreshAfter !== undefined
			? `<meta http-equiv="refresh" content="${refreshAfter};url=${escapeHtml(refreshUrl.toString())}">`
			: "";
	const completionSignal = complete
		? `<script>window.parent.postMessage("device-authorization-complete", window.location.origin);</script>`
		: "";
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	${refresh}
</head>
<body>${escapeHtml(message)}${completionSignal}</body>
</html>`;
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
