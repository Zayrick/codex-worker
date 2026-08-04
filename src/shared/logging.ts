import { ApiError } from "./api-error";

export function errorCode(error: unknown): string {
	return error instanceof ApiError && error.code
		? error.code
		: "internal_error";
}

export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof ApiError && error.code === code;
}

export function logFailure(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			status: "failed",
			code: errorCode(error),
		}),
	);
}
