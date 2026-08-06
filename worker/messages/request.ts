import { ApiError, requireRecord, requireString } from "../shared/api-error";
import {
	isRecord,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import {
	buildToolNameMaps,
	codexToolName,
	shortenCodexCallId,
	type ToolNameMaps,
} from "./identifiers";
import type { AdaptedMessagesRequest } from "./types";

const MAX_TOOLS = 128;
const WEB_SEARCH_TOOL_TYPES = new Set([
	"web_search_20250305",
	"web_search_20260209",
]);

export function messagesRequestToResponses(
	input: JsonObject,
	options: { requireMaxTokens?: boolean } = {},
): AdaptedMessagesRequest {
	const model = requireString(input.model, "model");
	const messages = input.messages;
	if (!Array.isArray(messages)) {
		throw invalidRequest(
			"Missing required parameter: 'messages'.",
			"missing_required_parameter",
			"messages",
		);
	}
	if (options.requireMaxTokens) validateMaxTokens(input.max_tokens);

	const toolNames = declaredToolNames(input.tools);
	const nameMaps = buildToolNameMaps(toolNames);
	const responseInput: JsonObject[] = [];
	appendSystem(responseInput, input.system);

	for (let index = 0; index < messages.length; index++) {
		const message = requireRecord(messages[index], `messages[${index}]`);
		const role = requireString(
			message.role,
			`messages[${index}].role`,
			`messages[${index}].role must be 'user' or 'assistant'.`,
		);
		if (role === "system") {
			appendMessageSystemReminder(responseInput, message.content);
			continue;
		}
		if (role !== "user" && role !== "assistant") {
			throw invalidRequest(
				`messages[${index}].role must be 'user' or 'assistant'.`,
				"invalid_message_role",
				`messages[${index}].role`,
			);
		}
		appendMessage(responseInput, message.content, role, index, nameMaps);
	}

	const body: JsonObject = {
		model,
		input: responseInput,
		parallel_tool_calls: parallelToolCalls(input.tool_choice),
		reasoning: { effort: reasoningEffort(input) },
	};
	const tools = adaptTools(input.tools, nameMaps);
	if (tools.items.length > 0) {
		body.tools = tools.items;
		body.tool_choice = adaptToolChoice(
			input.tool_choice,
			nameMaps,
			tools.webSearchNames,
		);
	}
	if (
		input.service_tier === "priority" ||
		input.service_tier === "fast" ||
		input.speed === "fast"
	) {
		body.service_tier = "priority";
	}

	return {
		body,
		model,
		stream: input.stream === true,
		reverseToolNames: nameMaps.reverse,
	};
}

function validateMaxTokens(value: unknown): void {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0
	) {
		throw invalidRequest(
			"'max_tokens' must be a non-negative integer.",
			"invalid_max_tokens",
			"max_tokens",
		);
	}
}

function appendSystem(output: JsonObject[], value: unknown): void {
	if (value === undefined || value === null) return;
	const parts: JsonObject[] = [];
	if (typeof value === "string") {
		parts.push({ type: "input_text", text: value });
	} else if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const block = requireRecord(value[index], `system[${index}]`);
			if (block.type !== "text" || typeof block.text !== "string") {
				throw invalidRequest(
					"System content supports only text blocks.",
					"unsupported_content_type",
					`system[${index}].type`,
				);
			}
			parts.push({ type: "input_text", text: block.text });
		}
	} else {
		throw invalidRequest(
			"'system' must be a string or an array of text blocks.",
			"invalid_system",
			"system",
		);
	}
	if (parts.length > 0) {
		output.push({ type: "message", role: "developer", content: parts });
	}
}

function appendMessage(
	output: JsonObject[],
	value: unknown,
	role: "user" | "assistant",
	messageIndex: number,
	nameMaps: ToolNameMaps,
): void {
	if (typeof value === "string") {
		output.push({
			type: "message",
			role,
			content: [{ type: textPartType(role), text: value }],
		});
		return;
	}
	if (!Array.isArray(value)) {
		throw invalidRequest(
			`messages[${messageIndex}].content must be a string or an array.`,
			"invalid_message_content",
			`messages[${messageIndex}].content`,
		);
	}

	let content: JsonObject[] = [];
	const flush = (): void => {
		if (content.length === 0) return;
		output.push({ type: "message", role, content });
		content = [];
	};

	for (let partIndex = 0; partIndex < value.length; partIndex++) {
		const param = `messages[${messageIndex}].content[${partIndex}]`;
		const block = requireRecord(value[partIndex], param);
		const type = requireString(block.type, `${param}.type`);

		if (type === "text") {
			content.push({
				type: textPartType(role),
				text: typeof block.text === "string" ? block.text : "",
			});
			continue;
		}
		if (type === "image" || type === "document") {
			if (role !== "user") {
				throw invalidRequest(
					`${type} blocks are supported only in user messages.`,
					`invalid_${type}_role`,
					param,
				);
			}
			content.push(adaptMediaBlock(block, type, param));
			continue;
		}
		if (type === "search_result") {
			content.push({ type: textPartType(role), text: searchResultText(block) });
			continue;
		}
		if (type === "thinking" || type === "redacted_thinking") {
			if (role !== "assistant") continue;
			const signature =
				type === "thinking"
					? stringField(block, "signature")
					: stringField(block, "data");
			if (!signature || !isCodexReasoningSignature(signature)) continue;
			flush();
			output.push({
				type: "reasoning",
				summary: [],
				content: null,
				encrypted_content: signature,
			});
			continue;
		}
		if (type === "tool_use" || type === "mcp_tool_use") {
			if (role !== "assistant") {
				throw invalidRequest(
					"tool_use blocks are supported only in assistant messages.",
					"invalid_tool_use_role",
					param,
				);
			}
			flush();
			const name = requireString(block.name, `${param}.name`);
			const callId = requireString(block.id, `${param}.id`);
			output.push({
				type: "function_call",
				call_id: shortenCodexCallId(callId),
				name: codexToolName(name, nameMaps.forward),
				arguments: JSON.stringify(block.input ?? {}),
			});
			continue;
		}
		if (type === "tool_result" || type === "mcp_tool_result") {
			if (role !== "user") {
				throw invalidRequest(
					"tool_result blocks are supported only in user messages.",
					"invalid_tool_result_role",
					param,
				);
			}
			flush();
			const callId = requireString(
				block.tool_use_id ?? block.id,
				`${param}.tool_use_id`,
			);
			output.push({
				type: "function_call_output",
				call_id: shortenCodexCallId(callId),
				output: adaptToolResult(block.content),
			});
			continue;
		}
		if (type === "server_tool_use") {
			if (role !== "assistant") continue;
			flush();
			const name = requireString(block.name, `${param}.name`);
			output.push({
				type: "function_call",
				call_id: shortenCodexCallId(requireString(block.id, `${param}.id`)),
				name: codexToolName(name, nameMaps.forward),
				arguments: JSON.stringify(block.input ?? {}),
			});
			continue;
		}
		if (type === "web_search_tool_result") {
			content.push({
				type: textPartType(role),
				text: webSearchResultText(block.content),
			});
			continue;
		}

		throw invalidRequest(
			"Unsupported message content type.",
			"unsupported_content_type",
			`${param}.type`,
		);
	}
	flush();
}

function appendMessageSystemReminder(
	output: JsonObject[],
	value: unknown,
): void {
	const parts = messageSystemTextParts(value);
	if (parts.length === 0) return;
	const text = parts.join("\n");
	if (text.trim() === "") return;
	output.push({
		type: "message",
		role: "user",
		content: [
			{
				type: "input_text",
				text: `<system-reminder>\n${text}\n</system-reminder>`,
			},
		],
	});
}

function messageSystemTextParts(value: unknown): string[] {
	if (typeof value === "string") {
		return value === "" || isClaudeCodeAttributionSystemText(value)
			? []
			: [value];
	}
	if (!Array.isArray(value)) return [];

	const parts: string[] = [];
	for (const item of value) {
		if (!isRecord(item) || item.type !== "text") continue;
		const text = stringField(item, "text");
		if (!text || isClaudeCodeAttributionSystemText(text)) continue;
		parts.push(text);
	}
	return parts;
}

function isClaudeCodeAttributionSystemText(value: string): boolean {
	return value.trimStart().startsWith("x-anthropic-billing-header:");
}

function adaptMediaBlock(
	block: JsonObject,
	kind: "image" | "document",
	param: string,
): JsonObject {
	const source = requireRecord(block.source, `${param}.source`);
	const sourceType = requireString(source.type, `${param}.source.type`);
	if (sourceType === "base64") {
		const mediaType = requireString(
			source.media_type,
			`${param}.source.media_type`,
		);
		const data = requireString(source.data, `${param}.source.data`);
		if (kind === "image") {
			return {
				type: "input_image",
				image_url: `data:${mediaType};base64,${data}`,
			};
		}
		return {
			type: "input_file",
			file_data: `data:${mediaType};base64,${data}`,
			filename: documentFilename(block, source, mediaType),
		};
	}
	if (sourceType === "url") {
		const url = requireString(source.url, `${param}.source.url`);
		return kind === "image"
			? { type: "input_image", image_url: url }
			: {
					type: "input_file",
					file_url: url,
					filename: documentFilename(block, source),
				};
	}
	if (sourceType === "file") {
		return {
			type: "input_file",
			file_id: requireString(source.file_id, `${param}.source.file_id`),
			filename: documentFilename(block, source),
		};
	}
	if (kind === "document" && sourceType === "text") {
		return {
			type: "input_text",
			text: requireString(source.data, `${param}.source.data`),
		};
	}
	throw invalidRequest(
		`Unsupported ${kind} source type.`,
		`unsupported_${kind}_source`,
		`${param}.source.type`,
	);
}

function documentFilename(
	block: JsonObject,
	source: JsonObject,
	mediaType = "",
): string {
	return (
		stringField(block, "title") ??
		stringField(source, "filename") ??
		defaultFilename(mediaType)
	);
}

function defaultFilename(mediaType: string): string {
	switch (mediaType.toLowerCase()) {
		case "application/pdf":
			return "document.pdf";
		case "text/plain":
			return "document.txt";
		case "text/csv":
			return "document.csv";
		case "application/json":
			return "document.json";
		default:
			return "document";
	}
}

function searchResultText(block: JsonObject): string {
	const title = stringField(block, "title") ?? "Search result";
	const source = stringField(block, "source") ?? stringField(block, "url");
	const content = webSearchResultText(block.content);
	return [title, source, content].filter(Boolean).join("\n");
}

function webSearchResultText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
	const lines: string[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string") {
			lines.push(item.text);
			continue;
		}
		const url = stringField(item, "url");
		if (!url) continue;
		lines.push(`${stringField(item, "title") ?? url}\n${url}`);
	}
	return lines.join("\n\n");
}

function adaptToolResult(value: unknown): unknown {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return JSON.stringify(value);

	const items: JsonObject[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) continue;
		if (raw.type === "text") {
			items.push({
				type: "input_text",
				text: typeof raw.text === "string" ? raw.text : "",
			});
			continue;
		}
		if (raw.type === "image") {
			const source = recordField(raw, "source");
			if (!source) continue;
			if (source.type === "base64") {
				const mediaType = stringField(source, "media_type");
				const data = stringField(source, "data");
				if (mediaType && data) {
					items.push({
						type: "input_image",
						image_url: `data:${mediaType};base64,${data}`,
					});
				}
			} else if (source.type === "url") {
				const url = stringField(source, "url");
				if (url) items.push({ type: "input_image", image_url: url });
			}
			continue;
		}
		if (raw.type === "document" || raw.type === "search_result") {
			items.push({ type: "input_text", text: searchResultText(raw) });
		}
	}
	return items.length > 0 ? items : JSON.stringify(value);
}

function declaredToolNames(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw invalidRequest("'tools' must be an array.", "invalid_tools", "tools");
	}
	if (value.length > MAX_TOOLS) {
		throw invalidRequest(
			`'tools' supports at most ${MAX_TOOLS} entries.`,
			"too_many_tools",
			"tools",
		);
	}
	const names: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const tool = requireRecord(value[index], `tools[${index}]`);
		const name = stringField(tool, "name");
		if (name) names.push(name);
	}
	return names;
}

function adaptTools(
	value: unknown,
	nameMaps: ToolNameMaps,
): { items: JsonObject[]; webSearchNames: ReadonlySet<string> } {
	if (value === undefined) return { items: [], webSearchNames: new Set() };
	if (!Array.isArray(value)) {
		throw invalidRequest("'tools' must be an array.", "invalid_tools", "tools");
	}
	const items: JsonObject[] = [];
	const webSearchNames = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const tool = requireRecord(value[index], `tools[${index}]`);
		const type = stringField(tool, "type") ?? "custom";
		if (WEB_SEARCH_TOOL_TYPES.has(type)) {
			const adapted: JsonObject = { type: "web_search" };
			if (Array.isArray(tool.allowed_domains)) {
				adapted.filters = { allowed_domains: tool.allowed_domains };
			}
			if (isRecord(tool.user_location)) {
				adapted.user_location = tool.user_location;
			}
			items.push(adapted);
			const name = stringField(tool, "name");
			if (name) webSearchNames.add(name);
			continue;
		}

		const name = requireString(tool.name, `tools[${index}].name`);
		const schema = normalizeToolSchema(tool.input_schema);
		const adapted: JsonObject = {
			type: "function",
			name: codexToolName(name, nameMaps.forward),
			parameters: schema,
			strict: false,
		};
		if (typeof tool.description === "string") {
			adapted.description = tool.description;
		}
		items.push(adapted);
	}
	return { items, webSearchNames };
}

function normalizeToolSchema(value: unknown): JsonObject {
	if (!isRecord(value)) return { type: "object", properties: {} };
	const schema = { ...value };
	delete schema.$schema;
	if (schema.type === undefined) schema.type = "object";
	if (schema.properties === undefined) schema.properties = {};
	return schema;
}

function adaptToolChoice(
	value: unknown,
	nameMaps: ToolNameMaps,
	webSearchNames: ReadonlySet<string>,
): unknown {
	if (value === undefined || value === null) return "auto";
	if (typeof value === "string") {
		if (value === "auto" || value === "none") return value;
		if (value === "any") return "required";
		return "auto";
	}
	if (!isRecord(value)) return "auto";
	const type = stringField(value, "type") ?? "auto";
	if (type === "auto" || type === "none") return type;
	if (type === "any") return "required";
	if (type !== "tool") return "auto";
	const name = stringField(value, "name");
	if (!name) return "auto";
	if (webSearchNames.has(name)) return { type: "web_search" };
	return { type: "function", name: codexToolName(name, nameMaps.forward) };
}

function parallelToolCalls(toolChoice: unknown): boolean {
	return !(
		isRecord(toolChoice) && toolChoice.disable_parallel_tool_use === true
	);
}

function reasoningEffort(input: JsonObject): string {
	const thinking = recordField(input, "thinking");
	if (!thinking) return "medium";
	const type = stringField(thinking, "type") ?? "";
	if (type === "disabled") return "none";
	if (type === "enabled") {
		const budget = thinking.budget_tokens;
		if (typeof budget === "number" && Number.isFinite(budget)) {
			return effortFromBudget(Math.trunc(budget));
		}
		return "medium";
	}
	if (type === "adaptive" || type === "auto") {
		const effort = stringField(recordField(input, "output_config"), "effort");
		return effort?.trim().toLowerCase() || "xhigh";
	}
	return "medium";
}

function effortFromBudget(budget: number): string {
	if (budget < -1) return "medium";
	if (budget === -1) return "auto";
	if (budget === 0) return "none";
	if (budget <= 512) return "minimal";
	if (budget <= 1_024) return "low";
	if (budget <= 8_192) return "medium";
	if (budget <= 24_576) return "high";
	return "xhigh";
}

function textPartType(role: "user" | "assistant"): "input_text" | "output_text" {
	return role === "assistant" ? "output_text" : "input_text";
}

function isCodexReasoningSignature(value: string): boolean {
	return (
		value.length >= 98 &&
		value.length <= 32 * 1024 * 1024 &&
		value.startsWith("gAAAA") &&
		/^[A-Za-z0-9_=-]+$/.test(value)
	);
}

function invalidRequest(
	message: string,
	code: string,
	param: string,
): ApiError {
	return new ApiError(400, message, "invalid_request_error", code, param);
}
