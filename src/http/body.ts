import { zstdDecompressSync } from "node:zlib";
import { ApiError, requireRecord } from "../shared/api-error";
import { BodySizeLimitError, readLimitedBody } from "../shared/limited-body";
import type { JsonObject } from "../shared/json";

export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

export async function parseJsonBody(request: Request): Promise<JsonObject> {
	let value: unknown;
	try {
		const encoded = await readLimitedBody(request, MAX_JSON_BODY_BYTES);
		if (!encoded) throw invalidJson();
		const decoded = hasZstdEncoding(request.headers)
			? decompressZstd(encoded)
			: encoded;
		value = JSON.parse(new TextDecoder().decode(decoded));
	} catch (error) {
		if (error instanceof BodySizeLimitError) throw requestTooLarge();
		if (error instanceof ApiError) throw error;
		throw invalidJson();
	}
	return requireRecord(value);
}

function hasZstdEncoding(headers: Headers): boolean {
	return (headers.get("Content-Encoding") ?? "")
		.split(",")
		.some((value) => value.trim().toLowerCase() === "zstd");
}

function decompressZstd(encoded: Uint8Array): Uint8Array {
	try {
		return zstdDecompressSync(encoded, {
			maxOutputLength: MAX_JSON_BODY_BYTES,
		});
	} catch (error) {
		if (
			error instanceof RangeError ||
			(typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ERR_BUFFER_TOO_LARGE")
		) {
			throw requestTooLarge();
		}
		// Some clients transparently decompress while retaining the original header.
		return encoded;
	}
}

function invalidJson(): ApiError {
	return new ApiError(
		400,
		"The request body is not valid JSON.",
		"invalid_request_error",
		"invalid_json",
	);
}

function requestTooLarge(): ApiError {
	return new ApiError(
		413,
		"The request body is too large.",
		"invalid_request_error",
		"request_too_large",
	);
}
