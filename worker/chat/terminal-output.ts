import {
	isRecord,
	stringField,
	type JsonObject,
} from "../shared/json";
import { codexStreamFailed } from "../codex/stream-error";
import { reserveChatChars } from "./state-budget";
import {
	ensureTool,
	isToolCallItem,
	reconcileToolArguments,
	toolCallInput,
} from "./tool-state";
import type { ChatAction, ChatState } from "./types";

export function reconcileTerminalOutput(
	state: ChatState,
	response: JsonObject,
): ChatAction[] {
	if (response.output === undefined) return [];
	if (!Array.isArray(response.output)) throw codexStreamFailed();

	let finalText = "";
	let finalReasoning = "";
	let textOrder = Number.POSITIVE_INFINITY;
	let reasoningOrder = Number.POSITIVE_INFINITY;
	const terminalTools: Array<{ item: JsonObject; outputIndex: number }> = [];

	for (let outputIndex = 0; outputIndex < response.output.length; outputIndex++) {
		const item = response.output[outputIndex];
		if (!isRecord(item)) continue;
		const type = stringField(item, "type");
		if (type === "message") {
			if (!Array.isArray(item.content)) continue;
			for (const content of item.content) {
				if (!isRecord(content)) continue;
				if (content.type === "output_text") {
					finalText += stringValue(content.text) ?? "";
					textOrder = Math.min(textOrder, outputIndex);
				} else if (content.type === "refusal") {
					finalText += stringValue(content.refusal) ?? "";
					textOrder = Math.min(textOrder, outputIndex);
				}
			}
		} else if (type === "reasoning") {
			if (!Array.isArray(item.summary)) continue;
			for (const summary of item.summary) {
				if (!isRecord(summary)) continue;
				finalReasoning += stringValue(summary.text) ?? "";
				reasoningOrder = Math.min(reasoningOrder, outputIndex);
			}
		} else if (isToolCallItem(item)) {
			terminalTools.push({ item, outputIndex });
		}
	}

	const orderedActions: Array<{
		order: number;
		sequence: number;
		action: ChatAction;
	}> = [];
	let sequence = 0;
	for (const action of reconcileText(state, "text", finalText)) {
		orderedActions.push({ order: textOrder, sequence: sequence++, action });
	}
	for (const action of reconcileText(state, "reasoning", finalReasoning)) {
		orderedActions.push({
			order: reasoningOrder,
			sequence: sequence++,
			action,
		});
	}
	for (const { item, outputIndex } of terminalTools) {
		const tool = ensureTool(state, { output_index: outputIndex }, item);
		const finalArguments =
			toolCallInput(item) ?? (tool.kind === "function" ? "{}" : "");
		for (const action of reconcileToolArguments(
			state,
			tool,
			finalArguments,
			finalArguments,
		)) {
			orderedActions.push({ order: outputIndex, sequence: sequence++, action });
		}
	}

	orderedActions.sort(
		(left, right) => left.order - right.order || left.sequence - right.sequence,
	);
	return orderedActions.map(({ action }) => action);
}

function reconcileText(
	state: ChatState,
	field: "text" | "reasoning",
	finalValue: string,
): ChatAction[] {
	if (!finalValue) return [];
	const currentValue = state[field];
	if (currentValue === finalValue) return [];
	if (!finalValue.startsWith(currentValue)) throw codexStreamFailed();

	const delta = finalValue.slice(currentValue.length);
	reserveChatChars(state, delta.length);
	state[field] = finalValue;
	if (!delta) return [];
	return field === "text"
		? [{ type: "text_delta", delta }]
		: [{ type: "reasoning_delta", delta }];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
