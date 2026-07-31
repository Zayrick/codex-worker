import { ApiError, requireRecord, requireString } from "./errors";
import { prepareCodexRequestBody } from "./codex";
import { SSE_DONE, SseDecoder, sseData } from "./sse";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "./types";

export interface AdaptedChatRequest {
	body: JsonObject;
	model: string;
	stream: boolean;
	includeUsage: boolean;
}

type ToolKind = "function" | "custom";

interface ToolCallState {
	index: number;
	itemId: string;
	id: string;
	name: string;
	arguments: string;
	kind: ToolKind;
	started: boolean;
}

interface AdaptedTools {
	items: JsonObject[];
	customNames: Set<string>;
}

interface ChatState {
	id: string;
	created: number;
	model: string;
	text: string;
	reasoning: string;
	tools: ToolCallState[];
	toolsByItemId: Map<string, ToolCallState>;
	response?: JsonObject;
	usage?: JsonObject;
	roleSent: boolean;
	finished: boolean;
}

export function chatRequestToResponses(input: JsonObject): AdaptedChatRequest {
	const model = requireString(input.model, "model");
	const messages = input.messages;
	if (!Array.isArray(messages)) {
		throw new ApiError(
			400,
			"Missing required parameter: 'messages'.",
			"invalid_request_error",
			"missing_required_parameter",
			"messages",
		);
	}

	const tools = adaptTools(input.tools);
	const pendingToolKinds = new Map<string, ToolKind>();
	const responseInput: JsonObject[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = requireRecord(messages[index], `messages[${index}]`);
		const sourceRole = requireString(
			message.role,
			`messages[${index}].role`,
			`messages[${index}].role must be a string.`,
		);
		const role = sourceRole === "system" ? "developer" : sourceRole;
		responseInput.push(
			...messageToResponseItems(
				message,
				role,
				index,
				tools.customNames,
				pendingToolKinds,
			),
		);
	}

	const body: JsonObject = {
		model,
		instructions: "",
		input: responseInput,
	};

	if (tools.items.length > 0) {
		body.tools = tools.items;
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
		body.prompt_cache_key = requireString(
			input.prompt_cache_key,
			"prompt_cache_key",
			"'prompt_cache_key' must be a non-empty string.",
		);
	}

	if (
		input.n !== undefined &&
		(typeof input.n !== "number" || input.n !== 1)
	) {
		throw new ApiError(
			400,
			"This proxy currently supports only n=1.",
			"invalid_request_error",
			"unsupported_parameter",
			"n",
		);
	}

	const stream = input.stream === true;
	const streamOptions = isRecord(input.stream_options)
		? input.stream_options
		: undefined;
	return {
		body: prepareCodexRequestBody(body),
		model,
		stream,
		includeUsage: streamOptions?.include_usage === true,
	};
}

export function chatCompletionFromEvents(
	events: readonly JsonObject[],
	model: string,
): JsonObject {
	const state = createChatState(model);
	for (const event of events) absorbEvent(state, event);

	if (!state.response && !state.text && state.tools.length === 0) {
		throw new ApiError(
			502,
			"The Codex stream ended without a completed response.",
			"upstream_error",
			"incomplete_codex_stream",
		);
	}
	requireChatResponseId(state);

	const extracted = state.response
		? extractCompletedOutput(state.response)
		: undefined;
	const text = extracted?.text || state.text;
	const reasoning = extracted?.reasoning || state.reasoning;
	const tools = extracted?.tools.length ? extracted.tools : state.tools;
	const message: JsonObject = {
		role: "assistant",
		content: text || tools.length === 0 ? text : null,
		refusal: null,
	};
	if (reasoning) message.reasoning_content = reasoning;
	if (tools.length > 0) {
		message.tool_calls = tools.map((tool) => ({
			id: tool.id,
			type: "function",
			function: {
				name: tool.name,
				arguments:
					tool.kind === "custom" ? tool.arguments : tool.arguments || "{}",
			},
		}));
	}

	return {
		id: state.id,
		object: "chat.completion",
		created: state.created,
		model: stringField(state.response, "model") ?? state.model,
		choices: [
			{
				index: 0,
				message,
				logprobs: null,
				finish_reason: finishReason(state.response, tools.length > 0),
			},
		],
		usage: usageToChat(state.usage ?? recordField(state.response, "usage")),
	};
}

export function createChatCompletionStream(
	upstream: ReadableStream<Uint8Array>,
	options: { model: string; includeUsage: boolean },
	ctx: ExecutionContext,
): ReadableStream<Uint8Array> {
	const state = createChatState(options.model);
	const transform = new TransformStream<Uint8Array, Uint8Array>();
	const writer = transform.writable.getWriter();
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const parser = new SseDecoder();

	const pump = (async () => {
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				const events = parser.push(
					decoder.decode(result.value, { stream: true }),
				);
				for (const event of events) {
					await writeStreamEvent(writer, state, event, options.includeUsage);
				}
			}
			for (const event of parser.push(decoder.decode())) {
				await writeStreamEvent(writer, state, event, options.includeUsage);
			}
			for (const event of parser.finish()) {
				await writeStreamEvent(writer, state, event, options.includeUsage);
			}
			if (!state.finished) {
				await ensureRoleChunk(writer, state);
				await writer.write(
					sseData(chatChunk(state, {}, state.tools.length ? "tool_calls" : "stop")),
				);
				await writer.write(SSE_DONE);
				state.finished = true;
			}
		} catch (error) {
			if (!state.finished) {
				const message =
					error instanceof Error
						? error.message
						: "The Codex response stream failed.";
				await writer.write(
					sseData({
						error: {
							message,
							type: "upstream_error",
							param: null,
							code: "codex_stream_failed",
						},
					}),
				);
				await writer.write(SSE_DONE);
			}
		} finally {
			reader.releaseLock();
			await writer.close();
		}
	})();
	ctx.waitUntil(pump);
	return transform.readable;
}

function messageToResponseItems(
	message: JsonObject,
	role: string,
	index: number,
	customToolNames: ReadonlySet<string>,
	pendingToolKinds: Map<string, ToolKind>,
): JsonObject[] {
	if (role === "tool") {
		const callId = requireString(
			message.tool_call_id,
			`messages[${index}].tool_call_id`,
		);
		const kind = pendingToolKinds.get(callId) ?? "function";
		return [
			{
				type:
					kind === "custom"
						? "custom_tool_call_output"
						: "function_call_output",
				call_id: callId,
				output: adaptToolOutput(message.content),
			},
		];
	}

	if (role === "function") {
		const name = requireString(message.name, `messages[${index}].name`);
		return [
			{
				type: "function_call_output",
				call_id: `legacy-${name}-${index}`,
				output: adaptToolOutput(message.content),
			},
		];
	}

	if (role !== "user" && role !== "assistant" && role !== "developer") {
		throw new ApiError(
			400,
			`Unsupported message role '${role}'.`,
			"invalid_request_error",
			"invalid_message_role",
			`messages[${index}].role`,
		);
	}

	const items: JsonObject[] = [];
	const content = adaptMessageContent(message.content, role, index);
	if (content.length > 0) {
		items.push({
			type: "message",
			role,
			content,
		});
	}

	if (role === "assistant") {
		const toolCalls = message.tool_calls;
		if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
			throw new ApiError(
				400,
				`messages[${index}].tool_calls must be an array.`,
				"invalid_request_error",
				"invalid_tool_calls",
				`messages[${index}].tool_calls`,
			);
		}
		for (let toolIndex = 0; toolIndex < (toolCalls?.length ?? 0); toolIndex++) {
			const call = requireRecord(
				toolCalls![toolIndex],
				`messages[${index}].tool_calls[${toolIndex}]`,
			);
			const callType = stringField(call, "type") ?? "function";
			const callId =
				stringField(call, "id") ?? `call-${index}-${toolIndex}`;
			let kind: ToolKind;
			let name: string;
			let callInput: string;
			if (callType === "custom") {
				const custom = recordField(call, "custom") ?? call;
				kind = "custom";
				name = requireString(
					custom.name,
					`messages[${index}].tool_calls[${toolIndex}].custom.name`,
				);
				callInput =
					typeof custom.input === "string"
						? custom.input
						: typeof custom.arguments === "string"
							? custom.arguments
							: "";
			} else if (callType === "function") {
				const fn = requireRecord(
					call.function,
					`messages[${index}].tool_calls[${toolIndex}].function`,
				);
				name = requireString(
					fn.name,
					`messages[${index}].tool_calls[${toolIndex}].function.name`,
				);
				kind = customToolNames.has(name) ? "custom" : "function";
				callInput =
					typeof fn.arguments === "string"
						? fn.arguments
						: kind === "custom"
							? ""
							: "{}";
			} else {
				throw new ApiError(
					400,
					`Unsupported tool call type '${callType}'.`,
					"invalid_request_error",
					"unsupported_tool_call_type",
					`messages[${index}].tool_calls[${toolIndex}].type`,
				);
			}

			pendingToolKinds.set(callId, kind);
			items.push(
				kind === "custom"
					? {
							type: "custom_tool_call",
							call_id: callId,
							name,
							input: callInput,
						}
					: {
							type: "function_call",
							call_id: callId,
							name,
							arguments: callInput,
						},
			);
		}
	}
	return items;
}

function adaptMessageContent(
	value: unknown,
	role: "user" | "assistant" | "developer",
	messageIndex: number,
): JsonObject[] {
	if (value === null || value === undefined) return [];
	if (typeof value === "string") {
		return [
			{
				type: role === "assistant" ? "output_text" : "input_text",
				text: value,
			},
		];
	}
	if (!Array.isArray(value)) {
		throw new ApiError(
			400,
			`messages[${messageIndex}].content must be a string, array, or null.`,
			"invalid_request_error",
			"invalid_message_content",
			`messages[${messageIndex}].content`,
		);
	}

	const parts: JsonObject[] = [];
	for (let partIndex = 0; partIndex < value.length; partIndex++) {
		const part = requireRecord(
			value[partIndex],
			`messages[${messageIndex}].content[${partIndex}]`,
		);
		const type = stringField(part, "type");
		if (type === "text" || type === "input_text" || type === "output_text") {
			parts.push({
				type: role === "assistant" ? "output_text" : "input_text",
				text: typeof part.text === "string" ? part.text : "",
			});
			continue;
		}
		if (type === "image_url" || type === "input_image") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"Image content is supported only in user messages.",
					"invalid_request_error",
					"invalid_image_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const image = isRecord(part.image_url) ? part.image_url : undefined;
			const imageUrl =
				typeof part.image_url === "string"
					? part.image_url
					: stringField(image, "url") ?? stringField(part, "image_url");
			if (!imageUrl) {
				throw new ApiError(
					400,
					"An image_url content part must include a URL.",
					"invalid_request_error",
					"invalid_image_url",
					`messages[${messageIndex}].content[${partIndex}].image_url`,
				);
			}
			const imagePart: JsonObject = {
				type: "input_image",
				image_url: imageUrl,
			};
			const detail =
				stringField(image, "detail") ?? stringField(part, "detail");
			if (detail) imagePart.detail = detail;
			parts.push(imagePart);
			continue;
		}
		if (type === "file" || type === "input_file") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"File content is supported only in user messages.",
					"invalid_request_error",
					"invalid_file_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const file = recordField(part, "file") ?? part;
			const filePart: JsonObject = { type: "input_file" };
			for (const key of [
				"file_id",
				"file_data",
				"file_url",
				"filename",
			] as const) {
				const field = stringField(file, key);
				if (field) filePart[key] = field;
			}
			if (
				!filePart.file_id &&
				!filePart.file_data &&
				!filePart.file_url
			) {
				throw new ApiError(
					400,
					"A file content part must include file_id, file_data, or file_url.",
					"invalid_request_error",
					"invalid_file",
					`messages[${messageIndex}].content[${partIndex}].file`,
				);
			}
			parts.push(filePart);
			continue;
		}
		if (type === "input_audio") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"Audio content is supported only in user messages.",
					"invalid_request_error",
					"invalid_audio_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const audio = recordField(part, "input_audio") ?? part;
			const audioPart: JsonObject = {
				type: "input_audio",
				data: requireString(
					audio.data,
					`messages[${messageIndex}].content[${partIndex}].input_audio.data`,
				),
			};
			const format = stringField(audio, "format");
			if (format) audioPart.format = format;
			parts.push(audioPart);
			continue;
		}
		if (type === "refusal" && role === "assistant") {
			parts.push({
				type: "output_text",
				text: typeof part.refusal === "string" ? part.refusal : "",
			});
			continue;
		}
		throw new ApiError(
			400,
			`Unsupported message content type '${type ?? "(missing)"}'.`,
			"invalid_request_error",
			"unsupported_content_type",
			`messages[${messageIndex}].content[${partIndex}].type`,
		);
	}
	return parts;
}

function adaptToolOutput(value: unknown): string | JsonObject[] {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (
				Array.isArray(parsed) &&
				parsed.some((part) => {
					if (!isRecord(part)) return false;
					const type = stringField(part, "type");
					return (
						type === "image_url" ||
						type === "input_image" ||
						type === "file" ||
						type === "input_file"
					);
				})
			) {
				return parsed.map(adaptToolOutputPart);
			}
		} catch {
			// Plain-text tool output is the common case.
		}
		return value;
	}
	if (value === null || value === undefined) return "";
	if (!Array.isArray(value)) return JSON.stringify(value);
	return value.map(adaptToolOutputPart);
}

function adaptToolOutputPart(value: unknown): JsonObject {
	if (typeof value === "string") {
		return { type: "input_text", text: value };
	}
	if (!isRecord(value)) {
		return {
			type: "input_text",
			text: value === null || value === undefined ? "" : JSON.stringify(value),
		};
	}

	const type = stringField(value, "type");
	if (type === "text" || type === "input_text" || type === "output_text") {
		return {
			type: "input_text",
			text:
				typeof value.text === "string"
					? value.text
					: typeof value.content === "string"
						? value.content
						: "",
		};
	}
	if (type === "image_url" || type === "input_image") {
		const image = recordField(value, "image_url");
		const imageUrl =
			typeof value.image_url === "string"
				? value.image_url
				: stringField(image, "url") ?? stringField(value, "url");
		if (imageUrl) {
			const part: JsonObject = { type: "input_image", image_url: imageUrl };
			const detail =
				stringField(image, "detail") ?? stringField(value, "detail");
			if (detail) part.detail = detail;
			return part;
		}
	}
	if (type === "file" || type === "input_file") {
		const file = recordField(value, "file") ?? value;
		const part: JsonObject = { type: "input_file" };
		for (const key of [
			"file_id",
			"file_data",
			"file_url",
			"filename",
		] as const) {
			const field = stringField(file, key);
			if (field) part[key] = field;
		}
		if (part.file_id || part.file_data || part.file_url) return part;
	}

	return { type: "input_text", text: JSON.stringify(value) };
}

function adaptTools(value: unknown): AdaptedTools {
	if (value === undefined) {
		return { items: [], customNames: new Set() };
	}
	if (!Array.isArray(value)) {
		throw new ApiError(
			400,
			"'tools' must be an array.",
			"invalid_request_error",
			"invalid_tools",
			"tools",
		);
	}
	const customNames = new Set<string>();
	const functionNames = new Set<string>();
	const items = value.map((raw, index) => {
		const tool = requireRecord(raw, `tools[${index}]`);
		const type = requireString(tool.type, `tools[${index}].type`);
		if (type === "custom") {
			const custom = recordField(tool, "custom") ?? tool;
			const name = requireString(
				custom.name,
				`tools[${index}].name`,
			);
			customNames.add(name);
			const adapted: JsonObject = { type: "custom", name };
			if (typeof custom.description === "string") {
				adapted.description = custom.description;
			}
			if (custom.format !== undefined) adapted.format = custom.format;
			return adapted;
		}
		if (type !== "function") {
			return { ...tool, type };
		}
		const fn = requireRecord(tool.function, `tools[${index}].function`);
		const name = requireString(fn.name, `tools[${index}].function.name`);
		functionNames.add(name);
		const adapted: JsonObject = {
			type: "function",
			name,
		};
		if (typeof fn.description === "string") {
			adapted.description = fn.description;
		}
		if (fn.parameters !== undefined) {
			adapted.parameters = fn.parameters;
		}
		if (fn.strict !== undefined) {
			adapted.strict = fn.strict;
		}
		return adapted;
	});
	for (const name of functionNames) customNames.delete(name);
	return { items, customNames };
}

function adaptToolChoice(
	value: unknown,
	customToolNames: ReadonlySet<string>,
): unknown {
	if (value === "auto" || value === "required" || value === "none") return value;
	if (!isRecord(value)) {
		throw new ApiError(
			400,
			"Invalid 'tool_choice'.",
			"invalid_request_error",
			"invalid_tool_choice",
			"tool_choice",
		);
	}
	const type = stringField(value, "type");
	if (type === "function") {
		const fn = recordField(value, "function") ?? value;
		const name = requireString(fn.name, "tool_choice.function.name");
		return {
			type: customToolNames.has(name) ? "custom" : "function",
			name,
		};
	}
	if (type === "custom") {
		const custom = recordField(value, "custom") ?? value;
		return {
			type: "custom",
			name: requireString(custom.name, "tool_choice.custom.name"),
		};
	}
	if (type) return { ...value, type };
	throw new ApiError(
		400,
		"Invalid 'tool_choice'.",
		"invalid_request_error",
		"invalid_tool_choice",
		"tool_choice",
	);
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
	const schema = requireRecord(
		responseFormat.json_schema,
		"response_format.json_schema",
	);
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

function createChatState(model: string): ChatState {
	return {
		id: "",
		created: Math.floor(Date.now() / 1000),
		model,
		text: "",
		reasoning: "",
		tools: [],
		toolsByItemId: new Map(),
		roleSent: false,
		finished: false,
	};
}

function absorbEvent(state: ChatState, event: JsonObject): void {
	const type = stringField(event, "type") ?? "";
	if (type === "response.created") {
		updateResponseMetadata(state, recordField(event, "response"));
		return;
	}
	if (type === "response.output_text.delta") {
		state.text += stringField(event, "delta") ?? "";
		return;
	}
	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		state.reasoning += stringField(event, "delta") ?? "";
		return;
	}
	if (type === "response.output_item.added") {
		const item = recordField(event, "item");
		if (isToolCallItem(item)) ensureTool(state, event, item);
		return;
	}
	if (
		type === "response.function_call_arguments.delta" ||
		type === "response.custom_tool_call_input.delta"
	) {
		const itemId = toolEventItemId(state, event);
		const tool =
			state.toolsByItemId.get(itemId) ??
			ensureTool(state, event, {
				type:
					type === "response.custom_tool_call_input.delta"
						? "custom_tool_call"
						: "function_call",
				id: itemId,
				call_id: stringField(event, "call_id") ?? itemId,
				name: "tool",
			});
		tool.arguments += stringField(event, "delta") ?? "";
		return;
	}
	if (type === "response.custom_tool_call_input.done") {
		const itemId = toolEventItemId(state, event);
		const tool = state.toolsByItemId.get(itemId);
		const input = stringField(event, "input") ?? "";
		if (tool && !tool.arguments && input) tool.arguments = input;
		return;
	}
	if (type === "response.output_item.done") {
		const item = recordField(event, "item");
		if (isToolCallItem(item)) {
			const tool = ensureTool(state, event, item);
			tool.arguments = toolCallInput(item) ?? tool.arguments;
		}
		return;
	}
	if (
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed"
	) {
		state.response = recordField(event, "response");
		state.usage = recordField(state.response, "usage");
		updateResponseMetadata(state, state.response);
	}
	if (type === "error" || type === "response.failed") {
		const error =
			recordField(event, "error") ?? recordField(state.response, "error");
		throw new ApiError(
			502,
			stringField(error, "message") ?? "The Codex response stream failed.",
			"upstream_error",
			stringField(error, "code") ?? "codex_stream_failed",
		);
	}
}

function isToolCallItem(item: JsonObject | undefined): item is JsonObject {
	return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function toolKind(item: JsonObject): ToolKind {
	return item.type === "custom_tool_call" ? "custom" : "function";
}

function toolCallInput(item: JsonObject): string | undefined {
	return item.type === "custom_tool_call"
		? stringField(item, "input")
		: stringField(item, "arguments");
}

function toolEventItemId(state: ChatState, event: JsonObject): string {
	const direct =
		stringField(event, "item_id") ?? stringField(event, "call_id");
	if (direct) return direct;
	const outputIndex = numberField(event, "output_index");
	if (outputIndex !== undefined) {
		const indexed = state.tools.find((tool) => tool.index === outputIndex);
		if (indexed) return indexed.itemId;
	}
	const last = state.tools[state.tools.length - 1];
	return last?.itemId ?? `tool-${state.tools.length}`;
}

function ensureTool(
	state: ChatState,
	event: JsonObject,
	item: JsonObject,
): ToolCallState {
	const itemId =
		stringField(item, "id") ??
		stringField(event, "item_id") ??
		stringField(item, "call_id") ??
		`tool-${state.tools.length}`;
	const existing = state.toolsByItemId.get(itemId);
	if (existing) {
		const name = stringField(item, "name");
		if (name) existing.name = name;
		const callId = stringField(item, "call_id");
		if (callId) existing.id = callId;
		existing.kind = toolKind(item);
		return existing;
	}
	const outputIndex = numberField(event, "output_index");
	const tool: ToolCallState = {
		index: outputIndex ?? state.tools.length,
		itemId,
		id: stringField(item, "call_id") ?? itemId,
		name: stringField(item, "name") ?? "tool",
		arguments: "",
		kind: toolKind(item),
		started: false,
	};
	state.tools.push(tool);
	state.toolsByItemId.set(itemId, tool);
	return tool;
}

function updateResponseMetadata(
	state: ChatState,
	response: JsonObject | undefined,
): void {
	if (!response) return;
	const responseId = stringField(response, "id");
	if (responseId) {
		state.id = responseId.startsWith("resp_")
			? `chatcmpl-${responseId.slice(5)}`
			: `chatcmpl-${responseId}`;
	}
	state.created = numberField(response, "created_at") ?? state.created;
	state.model = stringField(response, "model") ?? state.model;
}

function extractCompletedOutput(response: JsonObject): {
	text: string;
	reasoning: string;
	tools: ToolCallState[];
} {
	let text = "";
	let reasoning = "";
	const tools: ToolCallState[] = [];
	const output = response.output;
	if (!Array.isArray(output)) return { text, reasoning, tools };

	for (const itemValue of output) {
		if (!isRecord(itemValue)) continue;
		const type = stringField(itemValue, "type");
		if (type === "message" && Array.isArray(itemValue.content)) {
			for (const content of itemValue.content) {
				if (!isRecord(content)) continue;
				if (content.type === "output_text") {
					text += typeof content.text === "string" ? content.text : "";
				} else if (content.type === "refusal") {
					text +=
						typeof content.refusal === "string" ? content.refusal : "";
				}
			}
		} else if (type === "function_call" || type === "custom_tool_call") {
			tools.push({
				index: tools.length,
				itemId: stringField(itemValue, "id") ?? `tool-${tools.length}`,
				id:
					stringField(itemValue, "call_id") ??
					stringField(itemValue, "id") ??
					`call-${tools.length}`,
				name: stringField(itemValue, "name") ?? "tool",
				arguments:
					type === "custom_tool_call"
						? stringField(itemValue, "input") ?? ""
						: stringField(itemValue, "arguments") ?? "{}",
				kind: type === "custom_tool_call" ? "custom" : "function",
				started: true,
			});
		} else if (type === "reasoning" && Array.isArray(itemValue.summary)) {
			for (const summary of itemValue.summary) {
				if (isRecord(summary) && typeof summary.text === "string") {
					reasoning += summary.text;
				}
			}
		}
	}
	return { text, reasoning, tools };
}

async function writeStreamEvent(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	state: ChatState,
	event: JsonObject,
	includeUsage: boolean,
): Promise<void> {
	if (state.finished) return;
	const type = stringField(event, "type") ?? "";

	if (type === "response.created") {
		absorbEvent(state, event);
		await ensureRoleChunk(writer, state);
		return;
	}

	if (type === "response.output_text.delta") {
		await ensureRoleChunk(writer, state);
		const delta = stringField(event, "delta") ?? "";
		if (delta) {
			state.text += delta;
			await writer.write(sseData(chatChunk(state, { content: delta }, null)));
		}
		return;
	}

	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		await ensureRoleChunk(writer, state);
		const delta = stringField(event, "delta") ?? "";
		if (delta) {
			state.reasoning += delta;
			await writer.write(
				sseData(chatChunk(state, { reasoning_content: delta }, null)),
			);
		}
		return;
	}

	if (type === "response.output_item.added") {
		const item = recordField(event, "item");
		if (isToolCallItem(item)) {
			await ensureRoleChunk(writer, state);
			const tool = ensureTool(state, event, item);
			if (!tool.started) {
				tool.started = true;
				await writer.write(sseData(toolStartChunk(state, tool)));
			}
		}
		return;
	}

	if (
		type === "response.function_call_arguments.delta" ||
		type === "response.custom_tool_call_input.delta"
	) {
		await ensureRoleChunk(writer, state);
		const itemId = toolEventItemId(state, event);
		const tool =
			state.toolsByItemId.get(itemId) ??
			ensureTool(state, event, {
				type:
					type === "response.custom_tool_call_input.delta"
						? "custom_tool_call"
						: "function_call",
				id: itemId,
				call_id: stringField(event, "call_id") ?? itemId,
				name: "tool",
			});
		if (!tool.started) {
			tool.started = true;
			await writer.write(sseData(toolStartChunk(state, tool)));
		}
		const delta = stringField(event, "delta") ?? "";
		tool.arguments += delta;
		if (delta) {
			await writer.write(
				sseData(
					chatChunk(
						state,
						{
							tool_calls: [
								{
									index: tool.index,
									function: { arguments: delta },
								},
							],
						},
						null,
					),
				),
			);
		}
		return;
	}

	if (type === "response.custom_tool_call_input.done") {
		await ensureRoleChunk(writer, state);
		const itemId = toolEventItemId(state, event);
		const tool =
			state.toolsByItemId.get(itemId) ??
			ensureTool(state, event, {
				type: "custom_tool_call",
				id: itemId,
				call_id: stringField(event, "call_id") ?? itemId,
				name: "tool",
			});
		if (!tool.started) {
			tool.started = true;
			await writer.write(sseData(toolStartChunk(state, tool)));
		}
		const input = stringField(event, "input") ?? "";
		if (!tool.arguments && input) {
			tool.arguments = input;
			await writer.write(
				sseData(
					chatChunk(
						state,
						{
							tool_calls: [
								{
									index: tool.index,
									function: { arguments: input },
								},
							],
						},
						null,
					),
				),
			);
		}
		return;
	}

	if (type === "response.output_item.done") {
		const item = recordField(event, "item");
		if (isToolCallItem(item)) {
			await ensureRoleChunk(writer, state);
			const tool = ensureTool(state, event, item);
			const finalArguments = toolCallInput(item) ?? "";
			if (!tool.started) {
				tool.arguments = finalArguments;
				tool.started = true;
				await writer.write(
					sseData({
						...toolStartChunk(state, tool),
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: tool.index,
											id: tool.id,
											type: "function",
											function: {
												name: tool.name,
												arguments: finalArguments,
											},
										},
									],
								},
								logprobs: null,
								finish_reason: null,
							},
						],
					}),
				);
			} else if (!tool.arguments && finalArguments) {
				tool.arguments = finalArguments;
				await writer.write(
					sseData(
						chatChunk(
							state,
							{
								tool_calls: [
									{
										index: tool.index,
										function: { arguments: finalArguments },
									},
								],
							},
							null,
						),
					),
				);
			}
		}
		return;
	}

	if (
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed"
	) {
		absorbEvent(state, event);
		await ensureRoleChunk(writer, state);
		await writer.write(
			sseData(
				chatChunk(
					state,
					{},
					finishReason(state.response, state.tools.length > 0),
				),
			),
		);
		if (includeUsage) {
			await writer.write(
				sseData({
					id: state.id,
					object: "chat.completion.chunk",
					created: state.created,
					model: state.model,
					choices: [],
					usage: usageToChat(
						state.usage ?? recordField(state.response, "usage"),
					),
				}),
			);
		}
		await writer.write(SSE_DONE);
		state.finished = true;
		return;
	}

	if (type === "error") {
		const error = recordField(event, "error");
		throw new Error(
			stringField(error, "message") ?? "The Codex response stream failed.",
		);
	}
}

async function ensureRoleChunk(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	state: ChatState,
): Promise<void> {
	if (state.roleSent) return;
	requireChatResponseId(state);
	state.roleSent = true;
	await writer.write(
		sseData(chatChunk(state, { role: "assistant", content: "" }, null)),
	);
}

function requireChatResponseId(state: ChatState): void {
	if (state.id) return;
	throw new ApiError(
		502,
		"The Codex response did not include a response ID.",
		"upstream_error",
		"missing_codex_response_id",
	);
}

function chatChunk(
	state: ChatState,
	delta: JsonObject,
	finish: string | null,
): JsonObject {
	return {
		id: state.id,
		object: "chat.completion.chunk",
		created: state.created,
		model: state.model,
		choices: [
			{
				index: 0,
				delta,
				logprobs: null,
				finish_reason: finish,
			},
		],
	};
}

function toolStartChunk(state: ChatState, tool: ToolCallState): JsonObject {
	return chatChunk(
		state,
		{
			tool_calls: [
				{
					index: tool.index,
					id: tool.id,
					type: "function",
					function: { name: tool.name, arguments: "" },
				},
			],
		},
		null,
	);
}

function finishReason(
	response: JsonObject | undefined,
	hasTools: boolean,
): "tool_calls" | "length" | "stop" {
	if (hasTools) return "tool_calls";
	const incomplete = recordField(response, "incomplete_details");
	const reason = stringField(incomplete, "reason");
	return reason?.includes("max_output") ? "length" : "stop";
}

function usageToChat(usage: JsonObject | undefined): JsonObject | null {
	if (!usage) return null;
	const inputDetails = recordField(usage, "input_tokens_details");
	const outputDetails = recordField(usage, "output_tokens_details");
	const result: JsonObject = {
		prompt_tokens: numberField(usage, "input_tokens") ?? 0,
		completion_tokens: numberField(usage, "output_tokens") ?? 0,
		total_tokens: numberField(usage, "total_tokens") ?? 0,
	};
	if (inputDetails) {
		result.prompt_tokens_details = {
			cached_tokens: numberField(inputDetails, "cached_tokens") ?? 0,
		};
	}
	if (outputDetails) {
		result.completion_tokens_details = {
			reasoning_tokens: numberField(outputDetails, "reasoning_tokens") ?? 0,
		};
	}
	return result;
}
