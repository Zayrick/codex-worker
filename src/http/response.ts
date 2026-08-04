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
		"Authorization, Content-Type, X-Api-Key, Version, X-Codex-Beta-Features, X-Codex-Turn-Metadata, X-Codex-Turn-State",
	);
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	headers.set(
		"Access-Control-Expose-Headers",
		"OpenAI-Request-Id, Retry-After, X-Codex-Turn-State, X-Request-Id",
	);
	headers.set("Access-Control-Max-Age", "86400");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
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
