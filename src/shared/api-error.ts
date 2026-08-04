import { isRecord, type JsonObject } from "./json";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly type = "api_error",
		readonly code: string | null = null,
		readonly param: string | null = null,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function errorPayload(error: ApiError): JsonObject {
	return {
		error: {
			message: error.message,
			type: error.type,
			param: error.param,
			code: error.code,
		},
	};
}

export function normalizeError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	if (isAbortError(error)) {
		return new ApiError(
			408,
			"The request was cancelled or timed out.",
			"request_timeout",
			"request_aborted",
		);
	}
	return new ApiError(
		500,
		"An unexpected proxy error occurred.",
		"api_error",
		"internal_error",
	);
}

export function isAbortError(error: unknown): error is DOMException {
	return error instanceof DOMException && error.name === "AbortError";
}

export function requireRecord(value: unknown, label = "request body"): JsonObject {
	if (!isRecord(value)) {
		throw new ApiError(
			400,
			`The ${label} must be a JSON object.`,
			"invalid_request_error",
			"invalid_json",
		);
	}
	return value;
}

export function requireString(
	value: unknown,
	param: string,
	message = `Missing required parameter: '${param}'.`,
): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ApiError(
			400,
			message,
			"invalid_request_error",
			"missing_required_parameter",
			param,
		);
	}
	return value;
}
