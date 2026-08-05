import { parseJsonBodyWithSource } from "../http/body";
import { isRecord, type JsonObject } from "../shared/json";

export async function adaptResponsesRequest(request: Request): Promise<Request> {
	if (request.method !== "POST") return request;

	const { body, encodedBody } = await parseJsonBodyWithSource(request);
	if (!rewriteSystemMessageRoles(body)) {
		return new Request(request, { body: encodedBody });
	}

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

	return rewriteSystemMessageRoles(body) ? JSON.stringify(body) : message;
}

export function toCodexMessageRole(role: string): string {
	return role === "system" ? "developer" : role;
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
