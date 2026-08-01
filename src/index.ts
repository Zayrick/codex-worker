import { zstdDecompressSync } from "node:zlib";
import { oauthRecordExists } from "./auth";
import {
	chatCompletionFromEvents,
	chatRequestToResponses,
	createChatCompletionStream,
} from "./chat";
import { authenticateClient, constantTimeEqual } from "./client-auth";
import {
	prepareCompactRequest,
	prepareResponsesRequest,
	requestCodex,
	requestCodexCompact,
	requestCodexModels,
} from "./codex";
import {
	ApiError,
	errorPayload,
	normalizeError,
	requireRecord,
	requireString,
} from "./errors";
import {
	pollDeviceAuthorization,
	refreshOAuthCredentials,
	startDeviceAuthorization,
	type DeviceAuthorization,
} from "./oauth";
import { collectSseEvents } from "./sse";
import {
	isRecord,
	numberField,
	stringField,
	type JsonObject,
} from "./types";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "OPTIONS") {
				return finalize(new Response(null, { status: 204 }), env);
			}

			if (request.method === "GET" && url.pathname === "/") {
				return finalize(
					json({
						name: "codex-worker",
						status: "ok",
						compatibility:
							"Codex Responses passthrough with an OpenAI Chat Completions adapter",
						endpoints: [
							"GET /v1/models",
							"POST /v1/responses",
							"POST /v1/responses/compact",
							"POST /v1/chat/completions",
							"GET /auth/device/start?secret=...",
							"GET /auth/device/poll?secret=...&state=...",
						],
						client_authentication: "required for /v1/*",
						device_authentication:
							"secret query parameter must equal OAUTH_MASTER_KEY",
						token_refresh: "scheduled",
					}),
					env,
				);
			}

			if (request.method === "GET" && url.pathname === "/healthz") {
				const configured = await oauthRecordExists(env);
				return finalize(
					json({
						status: "ok",
						oauth_configured: configured,
						token_refresh: true,
					}),
					env,
				);
			}

			if (
				request.method === "GET" &&
				url.pathname === "/auth/device/start"
			) {
				const secret = await requireDeviceSecret(
					url.searchParams.get("secret"),
					env.OAUTH_MASTER_KEY,
				);
				const authorization = await startDeviceAuthorization(
					env,
					request.signal,
				);
				const pollUrl = new URL("/auth/device/poll", url);
				pollUrl.searchParams.set("secret", secret);
				pollUrl.searchParams.set("state", authorization.state);
				return finalize(deviceStartPage(authorization, pollUrl), env);
			}

			if (
				request.method === "GET" &&
				url.pathname === "/auth/device/poll"
			) {
				await requireDeviceSecret(
					url.searchParams.get("secret"),
					env.OAUTH_MASTER_KEY,
				);
				const state = requireString(
					url.searchParams.get("state"),
					"state",
					"Missing device authorization state.",
				);
				const result = await pollDeviceAuthorization(
					env,
					state,
					request.signal,
				);
				return finalize(
					result.status === "pending"
						? devicePendingPage(url, result.retryAfter)
						: deviceCompletePage(),
					env,
				);
			}

			await authenticateClient(request, env);

			if (request.method === "GET" && url.pathname === "/v1/models") {
				const codexClient = url.searchParams.has("client_version");
				const upstream = await requestCodexModels(url, env, {
					headers: request.headers,
					signal: request.signal,
				});
				if (!upstream.ok) return finalize(upstream, env);
				return finalize(
					codexClient
						? upstreamJson(upstream)
						: json(await openAiModelList(upstream)),
					env,
				);
			}

			if (request.method === "POST" && url.pathname === "/v1/responses") {
				const input = await parseJsonBody(request);
				const body = prepareResponsesRequest(input);
				const upstream = await requestCodex(
					body,
					env,
					{
						headers: request.headers,
						signal: request.signal,
					},
				);
				if (!upstream.ok) return finalize(upstream, env);
				return finalize(
					new Response(upstream.body, {
						status: 200,
						headers: sseHeaders(upstream.headers),
					}),
					env,
				);
			}

			if (
				request.method === "POST" &&
				url.pathname === "/v1/responses/compact"
			) {
				const input = await parseJsonBody(request);
				const body = prepareCompactRequest(input);
				const upstream = await requestCodexCompact(body, env, {
					headers: request.headers,
					signal: request.signal,
				});
				if (!upstream.ok) return finalize(upstream, env);
				return finalize(upstreamJson(upstream), env);
			}

			if (
				request.method === "POST" &&
				url.pathname === "/v1/chat/completions"
			) {
				const input = await parseJsonBody(request);
				const adapted = chatRequestToResponses(input);
				const upstream = await requestCodex(
					adapted.body,
					env,
					{
						headers: request.headers,
						signal: request.signal,
					},
				);
				if (!upstream.ok) return finalize(upstream, env);
				if (adapted.stream) {
					return finalize(
						new Response(
							createChatCompletionStream(
								upstream.body!,
								{
									model: adapted.model,
									includeUsage: adapted.includeUsage,
								},
								ctx,
							),
							{
								status: 200,
								headers: sseHeaders(upstream.headers),
							},
						),
						env,
					);
				}

				const events = await collectSseEvents(upstream.body!);
				return finalize(
					json(chatCompletionFromEvents(events, adapted.model)),
					env,
				);
			}

			throw new ApiError(
				404,
				"No route matches this request.",
				"invalid_request_error",
				"not_found",
			);
		} catch (error) {
			const apiError = normalizeError(error);
			if (
				request.method === "GET" &&
				(url.pathname === "/auth/device/start" ||
					url.pathname === "/auth/device/poll")
			) {
				return finalize(deviceErrorPage(apiError), env);
			}
			return finalize(
				json(errorPayload(apiError), apiError.status),
				env,
			);
		}
	},
	async scheduled(controller, env, _ctx): Promise<void> {
		try {
			const status = await refreshOAuthCredentials(env);
			console.log(
				JSON.stringify({
					event: "oauth_refresh",
					status,
					scheduled_time: controller.scheduledTime,
				}),
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "oauth_refresh",
					status: "failed",
					code: safeErrorCode(error),
				}),
			);
		}
	},
} satisfies ExportedHandler<Env>;

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		const contentEncodings = (request.headers.get("Content-Encoding") ?? "")
			.split(",")
			.map((value) => value.trim().toLowerCase());
		if (contentEncodings.includes("zstd")) {
			const encoded = new Uint8Array(await request.arrayBuffer());
			let decoded: Uint8Array;
			try {
				decoded = zstdDecompressSync(encoded);
			} catch {
				// Some HTTP stacks transparently decode the body while retaining the
				// original Content-Encoding header.
				decoded = encoded;
			}
			value = JSON.parse(new TextDecoder().decode(decoded));
		} else {
			value = await request.json();
		}
	} catch {
		throw new ApiError(
			400,
			"The request body is not valid JSON.",
			"invalid_request_error",
			"invalid_json",
		);
	}
	return requireRecord(value);
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function deviceStartPage(
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

function devicePendingPage(pollUrl: URL, retryAfter: number): Response {
	return htmlResponse(
		deviceStatusDocument(
			`尚未完成验证，${retryAfter} 秒后再次检查…`,
			pollUrl,
			retryAfter,
		),
		202,
	);
}

function deviceCompletePage(): Response {
	return htmlResponse(
		deviceStatusDocument("登录完成，OAuth 凭据已保存。", undefined, undefined, true),
	);
}

function deviceErrorPage(error: ApiError): Response {
	const code = error.code
		? `<p>${escapeHtml(error.code)}</p>`
		: "";
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

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
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

function upstreamJson(response: Response): Response {
	const headers = new Headers({
		"Content-Type":
			response.headers.get("Content-Type") ??
			"application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	copyCodexResponseHeaders(response.headers, headers);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function openAiModelList(response: Response): Promise<JsonObject> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw invalidModelCatalog();
	}
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw invalidModelCatalog();
	}

	const data: JsonObject[] = [];
	for (const value of payload.models) {
		if (!isRecord(value)) continue;
		const id = stringField(value, "id") ?? stringField(value, "slug");
		if (!id) continue;

		const model: JsonObject = { id, object: "model" };
		const created = numberField(value, "created");
		if (created !== undefined) model.created = created;
		const ownedBy = stringField(value, "owned_by");
		if (ownedBy) model.owned_by = ownedBy;
		data.push(model);
	}
	return { object: "list", data };
}

function invalidModelCatalog(): ApiError {
	return new ApiError(
		502,
		"The Codex backend returned an invalid model catalog.",
		"upstream_error",
		"invalid_codex_model_catalog",
	);
}

function sseHeaders(source?: Headers): Headers {
	const headers = new Headers({
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
	});
	if (source) copyCodexResponseHeaders(source, headers);
	return headers;
}

function copyCodexResponseHeaders(source: Headers, target: Headers): void {
	const turnState = source.get("X-Codex-Turn-State")?.trim();
	if (turnState) target.set("X-Codex-Turn-State", turnState);
}

function finalize(
	response: Response,
	env: Env,
): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
	headers.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, X-Api-Key, Version, X-Codex-Beta-Features, X-Codex-Turn-Metadata, X-Codex-Turn-State",
	);
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function safeErrorCode(error: unknown): string {
	return error instanceof ApiError && error.code
		? error.code
		: "internal_error";
}

async function requireDeviceSecret(
	provided: unknown,
	expected: string,
): Promise<string> {
	if (
		typeof provided !== "string" ||
		provided.length === 0 ||
		provided.length > 512
	) {
		throw invalidDeviceSecret();
	}
	if (!(await constantTimeEqual(provided, expected))) {
		throw invalidDeviceSecret();
	}
	return provided;
}

function invalidDeviceSecret(): ApiError {
	return new ApiError(
		401,
		"Invalid OAuth device authorization secret.",
		"authentication_error",
		"invalid_oauth_device_secret",
	);
}
