import { parseJsonBodyWithSource } from "../http/body";
import { isRecord, type JsonObject } from "../shared/json";
import {
	applyResponseCreateEgressPolicy,
	composeRequestBodyPolicies,
	type RequestBodyPolicy,
} from "./request-policy";

const adaptResponseCreateBody = composeRequestBodyPolicies(
	rewriteSystemMessageRoles,
	applyResponseCreateEgressPolicy,
);

const webSocketRequestPolicies = {
	"response.create": adaptResponseCreateBody,
	"response.append": rewriteSystemMessageRoles,
} satisfies Record<string, RequestBodyPolicy>;

export function adaptResponsesRequest(request: Request): Promise<Request> {
	return adaptJsonRequest(request, adaptResponseCreateBody);
}

export function adaptCompactRequest(request: Request): Promise<Request> {
	return adaptJsonRequest(request, rewriteSystemMessageRoles);
}

async function adaptJsonRequest(
	request: Request,
	policy: RequestBodyPolicy,
): Promise<Request> {
	if (request.method !== "POST") return request;

	const { body, encodedBody } = await parseJsonBodyWithSource(request);
	const adaptedBody = policy(body);
	if (adaptedBody === body) {
		return new Request(request, { body: encodedBody });
	}

	const headers = new Headers(request.headers);
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Encoding");
	headers.delete("Content-Length");
	return new Request(request, {
		headers,
		body: JSON.stringify(adaptedBody),
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

	const adaptedBody = webSocketRequestPolicies[body.type](body);
	return adaptedBody === body ? message : JSON.stringify(adaptedBody);
}

export function toCodexMessageRole(role: string): string {
	return role === "system" ? "developer" : role;
}

function rewriteSystemMessageRoles(body: JsonObject): JsonObject {
	const input = body.input;
	if (!Array.isArray(input)) return body;
	let adaptedInput: unknown[] | undefined;
	for (let index = 0; index < input.length; index++) {
		const item: unknown = input[index];
		if (isRecord(item) && item.role === "system") {
			adaptedInput ??= input.slice();
			adaptedInput[index] = { ...item, role: "developer" };
		}
	}
	return adaptedInput ? { ...body, input: adaptedInput } : body;
}

function isResponsesWebSocketRequestType(
	type: unknown,
): type is keyof typeof webSocketRequestPolicies {
	return typeof type === "string" && Object.hasOwn(webSocketRequestPolicies, type);
}
