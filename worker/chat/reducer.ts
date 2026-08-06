import { ApiError } from "../shared/api-error";
import {
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { codexStreamFailed } from "../codex/stream-error";
import { reserveChatChars } from "./state-budget";
import { reconcileTerminalOutput } from "./terminal-output";
import {
	ensureTool,
	findToolForEvent,
	isToolCallItem,
	reconcileToolArguments,
	startTool,
	toolCallInput,
	toolSnapshot,
} from "./tool-state";
import type { ChatAction, ChatState, ToolKind } from "./types";

export function createChatState(model: string): ChatState {
	return {
		id: "",
		created: Math.floor(Date.now() / 1000),
		model,
		text: "",
		reasoning: "",
		retainedChars: 0,
		tools: [],
		toolsByItemId: new Map(),
		toolsByCallId: new Map(),
		toolsByOutputIndex: new Map(),
		terminal: null,
	};
}

export function reduceCodexEvent(
	state: ChatState,
	event: JsonObject,
): ChatAction[] {
	if (state.terminal !== null) return [];

	const type = stringField(event, "type") ?? "";
	if (type === "response.created") {
		updateResponseMetadata(state, recordField(event, "response"));
		return [{ type: "response_created" }];
	}

	if (type === "response.output_text.delta") {
		const delta = stringValue(event.delta) ?? "";
		reserveChatChars(state, delta.length);
		state.text += delta;
		return delta ? [{ type: "text_delta", delta }] : [];
	}

	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		const delta = stringValue(event.delta) ?? "";
		reserveChatChars(state, delta.length);
		state.reasoning += delta;
		return delta ? [{ type: "reasoning_delta", delta }] : [];
	}

	if (type === "response.output_item.added") {
		const item = recordField(event, "item");
		if (!isToolCallItem(item)) return [];
		const tool = ensureTool(state, event, item);
		return startTool(tool, "");
	}

	if (
		type === "response.function_call_arguments.delta" ||
		type === "response.custom_tool_call_input.delta"
	) {
		const tool =
			findToolForEvent(state, event) ??
			ensureTool(state, event, {
				type:
					type === "response.custom_tool_call_input.delta"
						? "custom_tool_call"
						: "function_call",
				name: "tool",
			});
		const actions = startTool(tool, "");
		const delta = stringValue(event.delta) ?? "";
		if (delta) {
			reserveChatChars(state, delta.length);
			tool.arguments += delta;
			actions.push({
				type: "tool_arguments_delta",
				tool: toolSnapshot(tool),
				delta,
			});
		}
		return actions;
	}

	if (
		type === "response.function_call_arguments.done" ||
		type === "response.custom_tool_call_input.done"
	) {
		const kind: ToolKind = type.includes("custom_tool")
			? "custom"
			: "function";
		const tool =
			findToolForEvent(state, event) ??
			ensureTool(state, event, {
				type: kind === "custom" ? "custom_tool_call" : "function_call",
				name: "tool",
			});
		const finalArguments =
			kind === "custom"
				? stringValue(event.input)
				: stringValue(event.arguments);
		return reconcileToolArguments(state, tool, finalArguments, "");
	}

	if (type === "response.output_item.done") {
		const item = recordField(event, "item");
		if (!isToolCallItem(item)) return [];
		const tool = ensureTool(state, event, item);
		return reconcileToolArguments(state, tool, toolCallInput(item), "");
	}

	if (
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed"
	) {
		const response = recordField(event, "response");
		if (!response) {
			state.terminal = "failed";
			throw codexStreamFailed();
		}

		const usage = recordField(response, "usage");
		if (usage) state.usage = usage;
		else delete state.usage;
		const incompleteReason = stringField(
			recordField(response, "incomplete_details"),
			"reason",
		);
		if (incompleteReason) state.incompleteReason = incompleteReason;
		else delete state.incompleteReason;
		updateResponseMetadata(state, response);
		if (type === "response.failed") {
			state.terminal = "failed";
			throw codexStreamFailed();
		}

		try {
			const actions = reconcileTerminalOutput(state, response);
			state.terminal =
				type === "response.completed" ? "completed" : "incomplete";
			return [...actions, { type: "response_completed" }];
		} catch (error) {
			state.terminal = "failed";
			throw error;
		}
	}

	if (type === "error") {
		state.terminal = "failed";
		throw codexStreamFailed();
	}
	return [];
}

export function requireChatTerminal(state: ChatState): void {
	if (state.terminal === "completed" || state.terminal === "incomplete") return;
	throw new ApiError(
		502,
		"The Codex stream ended without a completed response.",
		"upstream_error",
		"incomplete_codex_stream",
	);
}

export function requireChatResponseId(state: ChatState): void {
	if (state.id) return;
	throw new ApiError(
		502,
		"The Codex response did not include a response ID.",
		"upstream_error",
		"missing_codex_response_id",
	);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
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
