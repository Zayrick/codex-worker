import { ApiError, requireString } from "../shared/api-error";
import { isRecord, type JsonObject } from "../shared/json";

const REMOVED_REQUEST_FIELDS = new Set([
	"contextmanagement",
	"conversationid",
	"generate",
	"maxcompletiontokens",
	"maxoutputtokens",
	"maxtokens",
	"originator",
	"previousresponseid",
	"promptcacheretention",
	"requestid",
	"safetyidentifier",
	"sessionid",
	"streamoptions",
	"temperature",
	"topk",
	"topp",
	"truncation",
	"user",
	"useragent",
	"xclientrequestid",
	"xrequestid",
]);

export function prepareResponsesRequest(input: JsonObject): JsonObject {
	const model = requireString(input.model, "model");
	if (!Object.prototype.hasOwnProperty.call(input, "input")) {
		throw new ApiError(400, "Missing required parameter: 'input'.", "invalid_request_error", "missing_required_parameter", "input");
	}
	const responseInput =
		typeof input.input === "string"
			? [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: input.input }],
					},
				]
			: input.input;
	if (!Array.isArray(responseInput)) {
		throw new ApiError(400, "'input' must be a string or an array.", "invalid_request_error", "invalid_input", "input");
	}

	return prepareCodexRequestBody({
		...input,
		input: responseInput,
		model,
	});
}

export function prepareCompactRequest(input: JsonObject): JsonObject {
	const model = requireString(input.model, "model");
	if (!Object.prototype.hasOwnProperty.call(input, "input")) {
		throw new ApiError(400, "Missing required parameter: 'input'.", "invalid_request_error", "missing_required_parameter", "input");
	}
	if (!Array.isArray(input.input)) {
		throw new ApiError(400, "'input' must be an array.", "invalid_request_error", "invalid_input", "input");
	}

	const body: JsonObject = {
		model,
		input: normalizeSystemRoles(input.input),
	};
	for (const key of ["instructions", "tools", "parallel_tool_calls", "reasoning", "prompt_cache_key", "text"] as const) {
		if (Object.prototype.hasOwnProperty.call(input, key)) {
			body[key] = input[key];
		}
	}
	if (input.service_tier === "priority") body.service_tier = "priority";
	return body;
}

export function prepareCodexRequestBody(input: JsonObject): JsonObject {
	const body: JsonObject = { ...input };
	for (const key of Object.keys(body)) {
		if (REMOVED_REQUEST_FIELDS.has(normalizeProtocolName(key))) delete body[key];
	}

	if (body.service_tier !== "priority") delete body.service_tier;
	body.input = normalizeSystemRoles(body.input);
	if (body.instructions === undefined || body.instructions === null) {
		body.instructions = "";
	}
	body.store = false;
	body.stream = true;
	normalizeReasoningEffort(body);
	body.include = ["reasoning.encrypted_content"];
	return body;
}

export function normalizeProtocolName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeSystemRoles(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => (isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item));
}

function normalizeReasoningEffort(body: JsonObject): void {
	if (body.reasoning === undefined || body.reasoning === null) {
		body.reasoning = { effort: "medium" };
		return;
	}
	if (isRecord(body.reasoning) && !Object.prototype.hasOwnProperty.call(body.reasoning, "effort")) {
		body.reasoning = { ...body.reasoning, effort: "medium" };
	}
}
