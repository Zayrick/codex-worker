import { jsonResponse } from "../http/response";
import { ApiError } from "../shared/api-error";
import { isRecord, stringField, type JsonObject } from "../shared/json";
import { BodySizeLimitError, readLimitedBody } from "../shared/limited-body";

const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;

export function geminiErrorPayload(error: ApiError): JsonObject {
	return {
		error: {
			code: error.status,
			message: error.message,
			status: googleStatus(error.status, error.code ?? ""),
		},
	};
}

export async function geminiUpstreamErrorResponse(
	response: Response,
): Promise<Response> {
	const error = new ApiError(
		response.status,
		await upstreamErrorMessage(response),
		"upstream_error",
		googleStatus(response.status),
	);
	const converted = jsonResponse(geminiErrorPayload(error), response.status);
	const headers = new Headers(converted.headers);
	for (const name of ["Retry-After", "X-Request-Id", "X-Goog-Request-Id"] as const) {
		const value = response.headers.get(name)?.trim();
		if (value) headers.set(name, value);
	}
	return new Response(converted.body, { status: converted.status, headers });
}

export function geminiCodexEventError(event: JsonObject): ApiError {
	const detail = isRecord(event.error) ? event.error : undefined;
	const source = `${stringField(detail, "type") ?? ""} ${stringField(detail, "code") ?? ""}`.toLowerCase();
	let status = 502;
	if (source.includes("rate_limit")) status = 429;
	else if (source.includes("overload")) status = 503;
	else if (source.includes("invalid_request") || source.includes("context_length")) status = 400;
	else if (source.includes("auth")) status = 401;
	else if (source.includes("permission")) status = 403;
	return new ApiError(
		status,
		stringField(detail, "message") ??
			stringField(event, "message") ??
			"The Codex response stream failed.",
		"upstream_error",
		googleStatus(status),
	);
}

function googleStatus(status: number, source = ""): string {
	if (/^[A-Z][A-Z_]+$/.test(source)) return source;
	switch (status) {
		case 400:
			return "INVALID_ARGUMENT";
		case 401:
			return "UNAUTHENTICATED";
		case 403:
			return "PERMISSION_DENIED";
		case 404:
			return "NOT_FOUND";
		case 409:
			return "ABORTED";
		case 429:
			return "RESOURCE_EXHAUSTED";
		case 503:
		case 529:
			return "UNAVAILABLE";
		default:
			return "INTERNAL";
	}
}

async function upstreamErrorMessage(response: Response): Promise<string> {
	try {
		const bytes = await readLimitedBody(response, MAX_UPSTREAM_ERROR_BYTES);
		if (!bytes || bytes.byteLength === 0) return fallbackMessage(response.status);
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!isRecord(value)) return fallbackMessage(response.status);
		const detail = isRecord(value.error) ? value.error : undefined;
		return (
			stringField(detail, "message") ??
			stringField(value, "message") ??
			fallbackMessage(response.status)
		);
	} catch (error) {
		if (error instanceof BodySizeLimitError) return fallbackMessage(response.status);
		return fallbackMessage(response.status);
	}
}

function fallbackMessage(status: number): string {
	return `The ChatGPT Codex backend returned HTTP ${status}.`;
}
