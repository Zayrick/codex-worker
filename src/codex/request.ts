import { parseJsonBody } from "../http/body";
import { isRecord, type JsonObject } from "../shared/json";

export async function adaptResponsesRequest(request: Request): Promise<Request> {
	if (request.method !== "POST" || !isResponsesJsonPath(new URL(request.url).pathname)) {
		return request;
	}

	const body = await parseJsonBody(request.clone());
	if (!rewriteSystemMessageRoles(body)) return request;

	const headers = new Headers(request.headers);
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Encoding");
	headers.delete("Content-Length");
	return new Request(request, {
		headers,
		body: JSON.stringify(body),
	});
}

export function adaptResponsesWebSocketMessage(message: string): string {
	let body: unknown;
	try {
		body = JSON.parse(message);
	} catch {
		return message;
	}
	if (!isRecord(body) || !isResponsesWebSocketRequestType(body.type)) {
		return message;
	}

	const normalizedType = body.type === "response.append";
	if (normalizedType) body.type = "response.create";
	const rewrittenRoles = rewriteSystemMessageRoles(body);
	if (!normalizedType && !rewrittenRoles) return message;
	return JSON.stringify(body);
}

export function toCodexMessageRole(role: string): string {
	return role === "system" ? "developer" : role;
}

export function isResponsesWebSocketRequest(request: Request): boolean {
	if (
		request.method !== "GET" ||
		request.headers.get("Upgrade")?.trim().toLowerCase() !== "websocket"
	) {
		return false;
	}
	switch (new URL(request.url).pathname) {
		case "/v1/responses":
		case "/v1/responses/":
		case "/backend-api/codex/responses":
		case "/backend-api/codex/responses/":
			return true;
		default:
			return false;
	}
}

function rewriteSystemMessageRoles(body: JsonObject): boolean {
	if (!Array.isArray(body.input)) return false;
	let rewritten = false;
	for (const item of body.input) {
		if (isRecord(item) && item.role === "system") {
			item.role = "developer";
			rewritten = true;
		}
	}
	return rewritten;
}

function isResponsesWebSocketRequestType(type: unknown): boolean {
	return type === "response.create" || type === "response.append";
}

function isResponsesJsonPath(pathname: string): boolean {
	switch (pathname) {
		case "/v1/responses":
		case "/v1/responses/":
		case "/v1/responses/compact":
		case "/v1/responses/compact/":
		case "/backend-api/codex/responses":
		case "/backend-api/codex/responses/":
		case "/backend-api/codex/responses/compact":
		case "/backend-api/codex/responses/compact/":
			return true;
		default:
			return false;
	}
}
