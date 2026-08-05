import { ApiError, requireRecord, requireString } from "../shared/api-error";
import { isRecord, type JsonObject } from "../shared/json";
import { messageToResponseItems } from "./content";
import { adaptToolChoice, adaptTools } from "./tools";
import type { AdaptedChatRequest, ToolKind } from "./types";

export function chatRequestToResponses(input: JsonObject): AdaptedChatRequest {
	const model = requireString(input.model, "model");
	const messages = input.messages;
	if (!Array.isArray(messages)) {
		throw new ApiError(400, "Missing required parameter: 'messages'.", "invalid_request_error", "missing_required_parameter", "messages");
	}

	const tools = adaptTools(input.tools);
	const pendingToolKinds = new Map<string, ToolKind>();
	const responseInput: JsonObject[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = requireRecord(messages[index], `messages[${index}]`);
		const sourceRole = requireString(message.role, `messages[${index}].role`, `messages[${index}].role must be a string.`);
		const role = sourceRole === "system" ? "developer" : sourceRole;
		responseInput.push(...messageToResponseItems(message, role, index, tools.customNames, pendingToolKinds));
	}

	const body: JsonObject = {
		model,
		instructions: "",
		input: responseInput,
		store: false,
		stream: true,
		reasoning: { effort: "medium" },
		include: ["reasoning.encrypted_content"],
	};

	if (tools.items.length > 0) {
		body.tools = tools.items;
	}
	if (input.parallel_tool_calls !== undefined) {
		body.parallel_tool_calls = input.parallel_tool_calls;
	}
	if (input.tool_choice !== undefined) {
		body.tool_choice = adaptToolChoice(input.tool_choice, tools.customNames);
	}

	const reasoningEffort = input.reasoning_effort;
	if (reasoningEffort !== undefined) {
		if (typeof reasoningEffort !== "string" || reasoningEffort.length === 0) {
			throw new ApiError(
				400,
				"'reasoning_effort' must be a non-empty string.",
				"invalid_request_error",
				"invalid_reasoning_effort",
				"reasoning_effort",
			);
		}
		body.reasoning = { effort: reasoningEffort };
	}

	const text = adaptResponseFormat(input.response_format);
	if (text) body.text = text;
	if (input.service_tier === "priority") body.service_tier = "priority";
	if (isRecord(input.metadata)) body.metadata = input.metadata;
	if (input.prompt_cache_key !== undefined) {
		body.prompt_cache_key = requireString(input.prompt_cache_key, "prompt_cache_key", "'prompt_cache_key' must be a non-empty string.");
	}

	if (input.n !== undefined && (typeof input.n !== "number" || input.n !== 1)) {
		throw new ApiError(400, "This proxy currently supports only n=1.", "invalid_request_error", "unsupported_parameter", "n");
	}

	const stream = input.stream === true;
	const streamOptions = isRecord(input.stream_options) ? input.stream_options : undefined;
	return {
		body,
		model,
		stream,
		includeUsage: streamOptions?.include_usage === true,
	};
}

function adaptResponseFormat(value: unknown): JsonObject | undefined {
	if (value === undefined) return undefined;
	const responseFormat = requireRecord(value, "response_format");
	const type = requireString(responseFormat.type, "response_format.type");
	if (type === "text") return { format: { type: "text" } };
	if (type === "json_object") return { format: { type: "json_object" } };
	if (type !== "json_schema") {
		throw new ApiError(
			400,
			"Unsupported response_format type.",
			"invalid_request_error",
			"unsupported_response_format",
			"response_format.type",
		);
	}
	const schema = requireRecord(responseFormat.json_schema, "response_format.json_schema");
	const format: JsonObject = {
		type: "json_schema",
		name: requireString(schema.name, "response_format.json_schema.name"),
	};
	if (typeof schema.description === "string") {
		format.description = schema.description;
	}
	if (schema.schema !== undefined) {
		format.schema = schema.schema;
	}
	if (schema.strict !== undefined) {
		format.strict = schema.strict;
	}
	return { format };
}
