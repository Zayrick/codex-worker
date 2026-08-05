import { ApiError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { codexEventError } from "./error";
import { claudeToolName, claudeToolUseId } from "./identifiers";
import type { ClaudeUsage } from "./types";

export async function messageFromEventStream(
	events: AsyncIterable<JsonObject>,
	requestedModel: string,
	reverseToolNames: ReadonlyMap<string, string>,
): Promise<JsonObject> {
	let terminal: JsonObject | undefined;
	let terminalType = "";
	for await (const event of events) {
		const type = stringField(event, "type") ?? "";
		if (type === "error") throw codexEventError(event);
		if (
			type === "response.completed" ||
			type === "response.incomplete" ||
			type === "response.failed"
		) {
			terminal = recordField(event, "response");
			terminalType = type;
			break;
		}
	}
	if (!terminal) throw incompleteCodexStream();
	if (terminalType === "response.failed") throw failedCodexResponse(terminal);
	return messageFromTerminalResponse(terminal, requestedModel, reverseToolNames);
}

export function messageFromTerminalResponse(
	response: JsonObject,
	requestedModel: string,
	reverseToolNames: ReadonlyMap<string, string>,
): JsonObject {
	const id = stringField(response, "id");
	if (!id) {
		throw new ApiError(
			502,
			"The Codex response did not include a response ID.",
			"api_error",
			"missing_codex_response_id",
		);
	}
	const converted = outputToClaudeContent(response.output, reverseToolNames);
	return {
		id,
		type: "message",
		role: "assistant",
		model: stringField(response, "model") ?? requestedModel,
		content: converted.content,
		stop_reason: claudeStopReason(response, converted.hasClientToolUse),
		stop_sequence: stringField(response, "stop_sequence") ?? null,
		usage: claudeUsage(recordField(response, "usage")),
	};
}

export function outputToClaudeContent(
	value: unknown,
	reverseToolNames: ReadonlyMap<string, string>,
): { content: JsonObject[]; hasClientToolUse: boolean } {
	if (value !== undefined && !Array.isArray(value)) throw malformedCodexOutput();
	const content: JsonObject[] = [];
	let hasClientToolUse = false;
	const seenWebSearch = new Set<string>();
	for (let index = 0; index < (value?.length ?? 0); index++) {
		const item = value?.[index];
		if (!isRecord(item)) continue;
		const type = stringField(item, "type") ?? "";
		if (type === "reasoning") {
			const thinking = reasoningText(item);
			const signature = stringField(item, "encrypted_content");
			if (thinking || signature) {
				content.push({
					type: "thinking",
					thinking,
					...(signature ? { signature } : {}),
				});
			}
			continue;
		}
		if (type === "message") {
			for (const text of outputTexts(item.content)) {
				if (text) content.push({ type: "text", text });
			}
			continue;
		}
		if (type === "function_call" || type === "custom_tool_call") {
			hasClientToolUse = true;
			const rawId =
				stringField(item, "call_id") ?? stringField(item, "id") ?? "";
			const rawName = stringField(item, "name") ?? "tool";
			const rawInput =
				type === "custom_tool_call"
					? stringField(item, "input")
					: stringField(item, "arguments");
			content.push({
				type: "tool_use",
				id: claudeToolUseId(rawId, `toolu_${index}`),
				name: claudeToolName(rawName, reverseToolNames),
				input: parseToolInput(rawInput),
			});
			continue;
		}
		if (type === "web_search_call") {
			for (const block of webSearchContent(item, index, seenWebSearch)) {
				content.push(block);
			}
		}
	}
	return { content, hasClientToolUse };
}

export function claudeUsage(usage: JsonObject | undefined): ClaudeUsage {
	const cached = Math.max(
		0,
		numberField(recordField(usage, "input_tokens_details"), "cached_tokens") ??
			0,
	);
	const totalInput = Math.max(0, numberField(usage, "input_tokens") ?? 0);
	const result: ClaudeUsage = {
		input_tokens: Math.max(0, totalInput - cached),
		output_tokens: Math.max(0, numberField(usage, "output_tokens") ?? 0),
	};
	if (cached > 0) result.cache_read_input_tokens = cached;
	return result;
}

export function claudeStopReason(
	response: JsonObject,
	hasClientToolUse: boolean,
): string {
	if (hasClientToolUse) return "tool_use";
	let reason = stringField(response, "stop_reason") ?? "";
	if (!reason) {
		reason =
			stringField(recordField(response, "incomplete_details"), "reason") ?? "";
	}
	if (!reason && stringField(response, "stop_sequence")) {
		reason = "stop_sequence";
	}
	switch (reason) {
		case "max_tokens":
		case "max_output_tokens":
			return "max_tokens";
		case "content_filter":
			return "refusal";
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
		case "refusal":
		case "model_context_window_exceeded":
			return reason;
		default:
			return "end_turn";
	}
}

export function reasoningText(item: JsonObject): string {
	const summary = textFromParts(item.summary);
	return summary || textFromParts(item.content);
}

export function outputTexts(value: unknown): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (!Array.isArray(value)) return [];
	const texts: string[] = [];
	for (const part of value) {
		if (!isRecord(part)) continue;
		if (part.type === "output_text" && typeof part.text === "string") {
			texts.push(part.text);
		} else if (part.type === "refusal" && typeof part.refusal === "string") {
			texts.push(part.refusal);
		}
	}
	return texts;
}

export function parseToolInput(value: string | undefined): JsonObject {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function incompleteCodexStream(): ApiError {
	return new ApiError(
		502,
		"The Codex stream ended without a completed response.",
		"api_error",
		"incomplete_codex_stream",
	);
}

export function failedCodexResponse(response: JsonObject): ApiError {
	const error = recordField(response, "error");
	return new ApiError(
		502,
		stringField(error, "message") ?? "The Codex response failed.",
		"api_error",
		stringField(error, "code") ?? "codex_response_failed",
	);
}

function textFromParts(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	let text = "";
	for (const part of value) {
		if (typeof part === "string") text += part;
		else if (isRecord(part) && typeof part.text === "string") text += part.text;
	}
	return text;
}

function webSearchContent(
	item: JsonObject,
	index: number,
	seen: Set<string>,
): JsonObject[] {
	const rawId = stringField(item, "id") ?? `web_search_${index}`;
	const id = claudeToolUseId(rawId, `web_search_${index}`);
	if (seen.has(id)) return [];
	const action = recordField(item, "action");
	const query = stringField(action, "query") ?? stringField(item, "query");
	const results = Array.isArray(item.results) ? item.results : [];
	if (!query && results.length === 0) return [];
	seen.add(id);
	const resultContent: JsonObject[] = [];
	for (const raw of results) {
		if (!isRecord(raw)) continue;
		const url = stringField(raw, "url");
		if (!url) continue;
		resultContent.push({
			type: "web_search_result",
			title: stringField(raw, "title") ?? url,
			url,
			page_age: null,
		});
	}
	return [
		{
			type: "server_tool_use",
			id,
			name: "web_search",
			input: query ? { query } : {},
		},
		{
			type: "web_search_tool_result",
			tool_use_id: id,
			content: resultContent,
		},
	];
}

function malformedCodexOutput(): ApiError {
	return new ApiError(
		502,
		"The Codex response output was malformed.",
		"api_error",
		"malformed_codex_output",
	);
}
