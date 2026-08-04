const CORS_ALLOWED_HEADERS = [
	"Authorization",
	"Content-Type",
	"Range",
	"X-Api-Key",
	"X-Goog-Api-Key",
	"X-Goog-Api-Client",
	"X-Goog-User-Project",
	"Idempotency-Key",
	"Version",
	"OpenAI-Alpha",
	"OpenAI-Beta",
	"OpenAI-Organization",
	"OpenAI-Project",
	"Anthropic-Version",
	"Anthropic-Beta",
	"Anthropic-Dangerous-Direct-Browser-Access",
	"Session-Id",
	"Thread-Id",
	"Last-Event-ID",
	"X-Client-Request-Id",
	"X-Codex-Beta-Features",
	"X-Codex-Turn-Metadata",
	"X-Codex-Turn-State",
	"X-Oai-Attestation",
	"X-Stainless-Arch",
	"X-Stainless-Helper-Method",
	"X-Stainless-Lang",
	"X-Stainless-OS",
	"X-Stainless-Package-Version",
	"X-Stainless-Retry-Count",
	"X-Stainless-Runtime",
	"X-Stainless-Runtime-Version",
	"X-Stainless-Timeout",
];

const CORS_EXPOSED_HEADERS = [
	"Accept-Ranges",
	"Anthropic-Ratelimit-Input-Tokens-Limit",
	"Anthropic-Ratelimit-Input-Tokens-Remaining",
	"Anthropic-Ratelimit-Input-Tokens-Reset",
	"Anthropic-Ratelimit-Output-Tokens-Limit",
	"Anthropic-Ratelimit-Output-Tokens-Remaining",
	"Anthropic-Ratelimit-Output-Tokens-Reset",
	"Anthropic-Ratelimit-Requests-Limit",
	"Anthropic-Ratelimit-Requests-Remaining",
	"Anthropic-Ratelimit-Requests-Reset",
	"Anthropic-Ratelimit-Tokens-Limit",
	"Anthropic-Ratelimit-Tokens-Remaining",
	"Anthropic-Ratelimit-Tokens-Reset",
	"Content-Disposition",
	"Content-Length",
	"Content-Range",
	"ETag",
	"Location",
	"OpenAI-Processing-Ms",
	"OpenAI-Request-Id",
	"OpenAI-Version",
	"Request-Id",
	"Retry-After",
	"X-Codex-Turn-State",
	"X-Goog-Request-Id",
	"X-Ratelimit-Limit-Requests",
	"X-Ratelimit-Limit-Tokens",
	"X-Ratelimit-Remaining-Requests",
	"X-Ratelimit-Remaining-Tokens",
	"X-Ratelimit-Reset-Requests",
	"X-Ratelimit-Reset-Tokens",
	"X-Request-Id",
];

export function emptyResponse(status: 204 | 404): Response {
	return new Response(null, { status });
}

export function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "SAMEORIGIN",
		},
	});
}

export function upstreamJsonResponse(response: Response): Response {
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

export function upstreamErrorResponse(response: Response): Response {
	const headers = new Headers({ "Cache-Control": "no-store" });
	for (const name of [
		"Content-Type",
		"Retry-After",
		"X-Request-Id",
		"OpenAI-Request-Id",
		"X-Codex-Turn-State",
	] as const) {
		const value = response.headers.get(name)?.trim();
		if (value) headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function upstreamProxyResponse(response: Response): Response {
	const headers = new Headers();
	for (const [name, value] of response.headers) {
		const normalized = name.toLowerCase();
		if (
			BLOCKED_PROXY_RESPONSE_HEADERS.has(normalized) ||
			normalized.startsWith("cf-")
		) {
			continue;
		}
		headers.append(name, value);
	}
	headers.set("Cache-Control", "no-store");
	return new Response(
		response.webSocket ? null : response.body,
		responseInit(response, headers),
	);
}

export function codexSseResponse(response: Response): Response {
	return new Response(response.body, {
		status: 200,
		headers: sseHeaders(response.headers),
	});
}

export function chatSseResponse(
	body: ReadableStream<Uint8Array>,
	source: Headers,
): Response {
	return new Response(body, {
		status: 200,
		headers: sseHeaders(source),
	});
}

export function withCors(response: Response, origin: string): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", origin || "*");
	headers.set(
		"Access-Control-Allow-Headers",
		CORS_ALLOWED_HEADERS.join(", "),
	);
	headers.set(
		"Access-Control-Allow-Methods",
		"GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
	);
	headers.set(
		"Access-Control-Expose-Headers",
		CORS_EXPOSED_HEADERS.join(", "),
	);
	headers.set("Access-Control-Max-Age", "86400");
	return new Response(
		response.webSocket ? null : response.body,
		responseInit(response, headers),
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

function responseInit(response: Response, headers: Headers): ResponseInit {
	const init: ResponseInit = {
		status: response.status,
		statusText: response.statusText,
		headers,
	};
	if (response.webSocket) init.webSocket = response.webSocket;
	if (headers.has("Content-Encoding")) init.encodeBody = "manual";
	return init;
}

const BLOCKED_PROXY_RESPONSE_HEADERS = new Set([
	"alt-svc",
	"clear-site-data",
	"connection",
	"keep-alive",
	"nel",
	"proxy-authenticate",
	"proxy-authorization",
	"report-to",
	"sec-websocket-accept",
	"sec-websocket-extensions",
	"server",
	"set-cookie",
	"set-cookie2",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
