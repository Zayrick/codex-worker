import { ApiError } from "../shared/api-error";

export function codexStreamFailed(): ApiError {
	return new ApiError(
		502,
		"The Codex response stream failed.",
		"upstream_error",
		"codex_stream_failed",
	);
}
