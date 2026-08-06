import { ApiError } from "../shared/api-error";
import { isRecord, stringField, type JsonObject } from "../shared/json";
import { BodySizeLimitError, readLimitedBody } from "../shared/limited-body";
import { jsonResponse } from "../http/response";

const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
const ANTHROPIC_ERROR_TYPES = new Set([
	"api_error",
	"authentication_error",
	"billing_error",
	"conflict_error",
	"invalid_request_error",
	"not_found_error",
	"overloaded_error",
	"permission_error",
	"rate_limit_error",
	"request_too_large",
]);

export function anthropicErrorPayload(
	error: ApiError,
	requestId?: string,
): JsonObject {
	return {
		type: "error",
		error: {
			type: anthropicErrorType(error.status, error.type),
			message: error.message,
		},
		...(requestId ? { request_id: requestId } : {}),
	};
}

export async function anthropicUpstreamErrorResponse(
	response: Response,
): Promise<Response> {
	const requestId = upstreamRequestId(response.headers);
	const message = await upstreamErrorMessage(response);
	const error = new ApiError(
		response.status,
		message,
		anthropicErrorType(response.status),
	);
	const converted = jsonResponse(
		anthropicErrorPayload(error, requestId),
		response.status,
	);
	const headers = new Headers(converted.headers);
	const retryAfter = response.headers.get("Retry-After")?.trim();
	if (retryAfter) headers.set("Retry-After", retryAfter);
	if (requestId) {
		headers.set("Request-Id", requestId);
		headers.set("X-Request-Id", requestId);
	}
	return new Response(converted.body, {
		status: converted.status,
		headers,
	});
}

export function codexEventError(event: JsonObject): ApiError {
	const detail = isRecord(event.error) ? event.error : undefined;
	const sourceType =
		stringField(detail, "type") ?? stringField(event, "error_type") ?? "";
	const code = stringField(detail, "code") ?? stringField(event, "code") ?? "";
	const message =
		(stringField(detail, "message") ??
			stringField(event, "message") ??
			code) ||
		"The Codex response stream failed.";
	const status = codexErrorStatus(sourceType, code);
	return new ApiError(status, message, anthropicErrorType(status, sourceType), code || null);
}

export function anthropicErrorType(status: number, sourceType = ""): string {
	if (ANTHROPIC_ERROR_TYPES.has(sourceType)) return sourceType;
	switch (status) {
		case 400:
			return "invalid_request_error";
		case 401:
			return "authentication_error";
		case 402:
			return "billing_error";
		case 403:
			return "permission_error";
		case 404:
			return "not_found_error";
		case 409:
			return "conflict_error";
		case 413:
			return "request_too_large";
		case 429:
			return "rate_limit_error";
		case 529:
			return "overloaded_error";
		default:
			return "api_error";
	}
}

function codexErrorStatus(type: string, code: string): number {
	const normalized = `${type} ${code}`.toLowerCase();
	if (normalized.includes("rate_limit")) return 429;
	if (normalized.includes("overload")) return 529;
	if (
		normalized.includes("invalid_request") ||
		normalized.includes("context_length") ||
		normalized.includes("cyber_policy")
	) {
		return 400;
	}
	if (normalized.includes("auth")) return 401;
	if (normalized.includes("permission")) return 403;
	return 502;
}

async function upstreamErrorMessage(response: Response): Promise<string> {
	try {
		const bytes = await readLimitedBody(response, MAX_UPSTREAM_ERROR_BYTES);
		if (!bytes || bytes.byteLength === 0) return fallbackMessage(response.status);
		const text = new TextDecoder().decode(bytes);
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) return fallbackMessage(response.status);
		const detail = isRecord(value.error) ? value.error : undefined;
		return (
			stringField(detail, "message") ??
			stringField(value, "message") ??
			fallbackMessage(response.status)
		);
	} catch (error) {
		if (error instanceof BodySizeLimitError) {
			return fallbackMessage(response.status);
		}
		return fallbackMessage(response.status);
	}
}

function fallbackMessage(status: number): string {
	return `The ChatGPT Codex backend returned HTTP ${status}.`;
}

function upstreamRequestId(headers: Headers): string | undefined {
	return (
		headers.get("Request-Id")?.trim() ||
		headers.get("X-Request-Id")?.trim() ||
		headers.get("OpenAI-Request-Id")?.trim() ||
		undefined
	);
}
