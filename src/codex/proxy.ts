import { getCodexCredentials } from "../auth/credentials";
import { adaptLiveBootstrapRequest } from "../live/request";
import { ApiError, isAbortError } from "../shared/api-error";
import { resolveRelayUrl } from "./client";
import {
	adaptResponsesRequest,
	adaptResponsesWebSocketMessage,
	isResponsesWebSocketRequest,
} from "./request";

const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1";

const BLOCKED_REQUEST_HEADERS = new Set([
	"accept-encoding",
	"authorization",
	"cdn-loop",
	"chatgpt-account-id",
	"connection",
	"content-length",
	"cookie",
	"expect",
	"forwarded",
	"host",
	"keep-alive",
	"origin",
	"proxy-authorization",
	"proxy-connection",
	"referer",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-version",
	"te",
	"trailer",
	"transfer-encoding",
	"true-client-ip",
	"upgrade",
	"user-agent",
	"via",
	"x-api-key",
	"x-goog-api-key",
	"x-real-ip",
]);

type CodexProxyEnv = Pick<
	Env,
	"AUTH_KV" | "DATA_ENCRYPTION_KEY" | "CODEX_RELAY_URL"
>;

export function isCodexProxyPath(pathname: string): boolean {
	return (
		isPathFamily(pathname, "/v1/images") ||
		isPathFamily(pathname, "/v1/videos") ||
		isPathFamily(pathname, "/v1/messages") ||
		isPathFamily(pathname, "/v1/responses") ||
		pathname === "/v1/alpha/search" ||
		isPathFamily(pathname, "/v1/live") ||
		isPathFamily(pathname, "/v1/realtime") ||
		isPathFamily(pathname, "/v1beta") ||
		isPathFamily(pathname, "/openai/v1/videos") ||
		isPathFamily(pathname, "/backend-api/codex")
	);
}

export function isWebSocketUpgrade(request: Request): boolean {
	return request.headers.get("Upgrade")?.trim().toLowerCase() === "websocket";
}

export async function forwardCodexProxy(
	request: Request,
	clientUrl: URL,
	env: CodexProxyEnv,
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	const outgoingRequest = await adaptResponsesRequest(
		await adaptLiveBootstrapRequest(request),
	);
	const target = resolveCodexProxyUrl(
		env.CODEX_RELAY_URL,
		clientUrl,
		request.method,
	);
	const headers = proxyRequestHeaders(outgoingRequest, credentials, target);
	const init: RequestInit = {
		method: outgoingRequest.method,
		headers,
		redirect: "manual",
		signal: outgoingRequest.signal,
	};
	if (
		outgoingRequest.method !== "GET" &&
		outgoingRequest.method !== "HEAD" &&
		outgoingRequest.body
	) {
		init.body = outgoingRequest.body;
	}

	let response: Response;
	try {
		response = await fetch(target, init);
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw new ApiError(
			502,
			"Unable to reach the Codex relay.",
			"upstream_error",
			"codex_unavailable",
		);
	}
	return isResponsesWebSocketRequest(outgoingRequest) && response.webSocket
		? bridgeResponsesWebSocket(response)
		: response;
}

function bridgeResponsesWebSocket(response: Response): Response {
	const upstream = response.webSocket;
	if (!upstream) return response;

	const pair = new WebSocketPair();
	const downstream = pair[0];
	const proxy = pair[1];
	upstream.binaryType = "arraybuffer";
	proxy.binaryType = "arraybuffer";

	proxy.addEventListener("message", (event) => {
		forwardWebSocketMessage(
			upstream,
			typeof event.data === "string"
				? adaptResponsesWebSocketMessage(event.data)
				: event.data,
			proxy,
		);
	});
	upstream.addEventListener("message", (event) => {
		forwardWebSocketMessage(proxy, event.data, upstream);
	});
	proxy.addEventListener("close", (event) => {
		forwardWebSocketClose(proxy, upstream, event);
	});
	upstream.addEventListener("close", (event) => {
		forwardWebSocketClose(upstream, proxy, event);
	});
	proxy.addEventListener("error", () => closeWebSocketPair(proxy, upstream));
	upstream.addEventListener("error", () => closeWebSocketPair(upstream, proxy));

	proxy.accept({ allowHalfOpen: true });
	upstream.accept({ allowHalfOpen: true });
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		webSocket: downstream,
	});
}

function forwardWebSocketMessage(
	target: WebSocket,
	data: unknown,
	source: WebSocket,
): void {
	try {
		if (
			typeof data === "string" ||
			data instanceof ArrayBuffer ||
			ArrayBuffer.isView(data)
		) {
			target.send(data);
			return;
		}
	} catch {
		// Both peers are closed below.
	}
	closeWebSocketPair(source, target);
}

function forwardWebSocketClose(
	source: WebSocket,
	target: WebSocket,
	event: CloseEvent,
): void {
	const code = isForwardableCloseCode(event.code) ? event.code : 1011;
	closeWebSocket(target, code, event.reason);
	closeWebSocket(source, code, event.reason);
}

function closeWebSocketPair(first: WebSocket, second: WebSocket): void {
	closeWebSocket(first, 1011, "WebSocket proxy error");
	closeWebSocket(second, 1011, "WebSocket proxy error");
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
	if (socket.readyState === WebSocket.CLOSED) return;
	try {
		socket.close(code, reason);
	} catch {
		// The peer may already be closing.
	}
}

function isForwardableCloseCode(code: number): boolean {
	return (
		code >= 1000 &&
		code <= 4999 &&
		code !== 1004 &&
		code !== 1005 &&
		code !== 1006 &&
		code !== 1015
	);
}

export function resolveCodexProxyUrl(
	relayUrl: string,
	clientUrl: URL,
	method: string,
): URL {
	const target = resolveRelayUrl(relayUrl);
	const codexRoot = target.pathname.replace(/\/responses\/?$/, "");
	target.pathname = proxyPath(clientUrl.pathname, method, codexRoot);
	target.search = clientUrl.search;

	if (
		method === "POST" &&
		(clientUrl.pathname === "/v1/live" ||
			clientUrl.pathname === "/v1/realtime/calls")
	) {
		if (!target.searchParams.has("intent")) {
			target.searchParams.set("intent", "quicksilver");
		}
		if (!target.searchParams.has("architecture")) {
			target.searchParams.set("architecture", "avas");
		}
	}
	return target;
}

function proxyPath(pathname: string, method: string, codexRoot: string): string {
	if (isPathFamily(pathname, "/backend-api/codex")) return pathname;
	if (isPathFamily(pathname, "/v1/images")) {
		return `${codexRoot}${pathname.slice("/v1".length)}`;
	}
	if (isPathFamily(pathname, "/v1/responses")) {
		return `${codexRoot}${pathname.slice("/v1".length)}`;
	}
	if (pathname === "/v1/alpha/search") return `${codexRoot}/alpha/search`;
	if (
		method === "POST" &&
		(pathname === "/v1/live" || pathname === "/v1/realtime/calls")
	) {
		return `${codexRoot}/realtime/calls`;
	}
	return pathname;
}

function proxyRequestHeaders(
	request: Request,
	credentials: { token: string; accountId?: string },
	target: URL,
): Headers {
	const headers = new Headers();
	for (const [name, value] of request.headers) {
		const normalized = name.toLowerCase();
		if (
			BLOCKED_REQUEST_HEADERS.has(normalized) ||
			normalized.startsWith("cf-") ||
			normalized.startsWith("x-forwarded-") ||
			normalized.startsWith("x-envoy-")
		) {
			continue;
		}
		headers.append(name, value);
	}

	headers.set("Authorization", `Bearer ${credentials.token}`);
	if (credentials.accountId) {
		headers.set("Chatgpt-Account-Id", credentials.accountId);
	}
	if (isCodexNativeTarget(target.pathname)) {
		headers.set(
			"User-Agent",
			`codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION}`,
		);
		if (!headers.has("Version")) {
			headers.set("Version", DEFAULT_CODEX_CLIENT_VERSION);
		}
		if (!headers.has("Originator")) headers.set("Originator", "codex_cli_rs");
		if (
			isWebSocketUpgrade(request) &&
			/\/backend-api\/codex\/responses\/?$/.test(target.pathname) &&
			!headers.get("OpenAI-Beta")?.includes("responses_websockets=")
		) {
			headers.set("OpenAI-Beta", "responses_websockets=2026-02-06");
		}
	}
	if (isWebSocketUpgrade(request)) headers.set("Upgrade", "websocket");
	return headers;
}

function isPathFamily(pathname: string, root: string): boolean {
	return pathname === root || pathname.startsWith(`${root}/`);
}

function isCodexNativeTarget(pathname: string): boolean {
	return /\/backend-api\/codex(?:\/|$)/.test(pathname);
}
