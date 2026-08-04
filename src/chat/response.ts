import {
	numberField,
	recordField,
	type JsonObject,
} from "../shared/json";
import {
	createChatState,
	reduceCodexEvent,
	requireChatResponseId,
	requireChatTerminal,
} from "./reducer";
import type { ChatState } from "./types";

export function chatCompletionFromEvents(
	events: readonly JsonObject[],
	model: string,
): JsonObject {
	const state = createChatState(model);
	for (const event of events) {
		reduceCodexEvent(state, event);
		if (state.terminal !== null) break;
	}
	return chatCompletionFromState(state);
}

export async function chatCompletionFromEventStream(
	events: AsyncIterable<JsonObject>,
	model: string,
): Promise<JsonObject> {
	const state = createChatState(model);
	for await (const event of events) {
		reduceCodexEvent(state, event);
		if (state.terminal !== null) break;
	}
	return chatCompletionFromState(state);
}

function chatCompletionFromState(state: ChatState): JsonObject {
	requireChatTerminal(state);
	requireChatResponseId(state);

	const text = state.text;
	const reasoning = state.reasoning;
	const tools = state.tools;
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
		model: state.model,
		choices: [
			{
				index: 0,
				message,
				logprobs: null,
				finish_reason: finishReason(
					state.incompleteReason,
					tools.length > 0,
					state.terminal === "incomplete",
				),
			},
		],
		usage: usageToChat(state.usage),
	};
}

export function finishReason(
	incompleteReason: string | undefined,
	hasTools: boolean,
	incomplete = false,
): "tool_calls" | "length" | "content_filter" | "stop" {
	if (hasTools) return "tool_calls";
	if (incomplete) {
		return incompleteReason?.includes("content_filter")
			? "content_filter"
			: "length";
	}
	return "stop";
}

export function usageToChat(usage: JsonObject | undefined): JsonObject | null {
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
