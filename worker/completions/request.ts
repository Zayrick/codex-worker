import { chatRequestToResponses } from "../chat/request";
import type { AdaptedChatRequest } from "../chat/types";
import { ApiError, requireString } from "../shared/api-error";
import type { JsonObject } from "../shared/json";

export interface AdaptedCompletionRequest extends AdaptedChatRequest {
	echoPrefix: string;
}

export function completionRequestToResponses(
	input: JsonObject,
): AdaptedCompletionRequest {
	const model = requireString(input.model, "model");
	const prompt = completionPrompt(input.prompt);
	requireSingleCompletion(input.n, "n");
	requireSingleCompletion(input.best_of, "best_of");

	const chatRequest: JsonObject = {
		model,
		messages: [{ role: "user", content: prompt }],
		stream: input.stream === true,
	};
	for (const key of [
		"metadata",
		"prompt_cache_key",
		"reasoning_effort",
		"service_tier",
		"stream_options",
	] as const) {
		if (Object.prototype.hasOwnProperty.call(input, key)) {
			chatRequest[key] = input[key];
		}
	}

	const adapted = chatRequestToResponses(chatRequest);
	return {
		...adapted,
		echoPrefix: input.echo === true ? prompt : "",
	};
}

function completionPrompt(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		Array.isArray(value) &&
		value.length === 1 &&
		typeof value[0] === "string"
	) {
		return value[0];
	}
	return invalidPrompt();
}

function requireSingleCompletion(value: unknown, param: string): void {
	if (value === undefined || value === 1) return;
	throw new ApiError(
		400,
		`This proxy currently supports only ${param}=1.`,
		"invalid_request_error",
		"unsupported_parameter",
		param,
	);
}

function invalidPrompt(): never {
	throw new ApiError(
		400,
		"'prompt' must be a string or a single-item string array.",
		"invalid_request_error",
		"invalid_prompt",
		"prompt",
	);
}
