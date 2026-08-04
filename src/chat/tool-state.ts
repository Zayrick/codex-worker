import {
	numberField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { codexStreamFailed } from "../codex/stream-error";
import {
	reserveChatAlias,
	reserveChatChars,
	reserveChatTool,
} from "./state-budget";
import type {
	ChatAction,
	ChatState,
	ToolActionSnapshot,
	ToolCallState,
	ToolKind,
} from "./types";

export function reconcileToolArguments(
	state: ChatState,
	tool: ToolCallState,
	finalArguments: string | undefined,
	initialFallback: string,
): ChatAction[] {
	if (!tool.started) {
		const initialArguments = finalArguments ?? initialFallback;
		reserveChatChars(state, initialArguments.length);
		tool.arguments = initialArguments;
		return startTool(tool, initialArguments);
	}
	if (finalArguments === undefined || finalArguments === tool.arguments) return [];
	if (!finalArguments.startsWith(tool.arguments)) throw codexStreamFailed();

	const delta = finalArguments.slice(tool.arguments.length);
	reserveChatChars(state, delta.length);
	tool.arguments = finalArguments;
	return delta
		? [
				{
					type: "tool_arguments_delta",
					tool: toolSnapshot(tool),
					delta,
				},
			]
		: [];
}

export function startTool(
	tool: ToolCallState,
	initialArguments: string,
): ChatAction[] {
	if (tool.started) return [];
	tool.started = true;
	return [
		{
			type: "tool_started",
			tool: toolSnapshot(tool),
			initialArguments,
		},
	];
}

export function toolSnapshot(tool: ToolCallState): ToolActionSnapshot {
	return { index: tool.index, id: tool.id, name: tool.name };
}

export function isToolCallItem(
	item: JsonObject | undefined,
): item is JsonObject {
	return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function toolKind(item: JsonObject): ToolKind {
	return item.type === "custom_tool_call" ? "custom" : "function";
}

export function toolCallInput(item: JsonObject): string | undefined {
	return item.type === "custom_tool_call"
		? stringValue(item.input)
		: stringValue(item.arguments);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function findToolForEvent(
	state: ChatState,
	event: JsonObject,
): ToolCallState | undefined {
	const itemId = stringField(event, "item_id");
	const callId = stringField(event, "call_id");
	const outputIndex = numberField(event, "output_index");
	return uniqueTool([
		itemId ? state.toolsByItemId.get(itemId) : undefined,
		callId ? state.toolsByCallId.get(callId) : undefined,
		outputIndex !== undefined
			? state.toolsByOutputIndex.get(outputIndex)
			: undefined,
	]);
}

export function ensureTool(
	state: ChatState,
	event: JsonObject,
	item: JsonObject,
): ToolCallState {
	const explicitItemId =
		stringField(item, "id") ?? stringField(event, "item_id");
	const explicitCallId =
		stringField(item, "call_id") ?? stringField(event, "call_id");
	const outputIndex = numberField(event, "output_index");
	const existing = uniqueTool([
		explicitItemId
			? state.toolsByItemId.get(explicitItemId)
			: undefined,
		explicitCallId
			? state.toolsByCallId.get(explicitCallId)
			: undefined,
		outputIndex !== undefined
			? state.toolsByOutputIndex.get(outputIndex)
			: undefined,
	]);

	if (existing) {
		if (explicitItemId) existing.itemId = explicitItemId;
		if (explicitCallId) existing.id = explicitCallId;
		const name = stringField(item, "name");
		if (name && name !== existing.name) {
			reserveChatChars(state, name.length);
			existing.name = name;
		}
		existing.kind = toolKind(item);
		if (outputIndex !== undefined) existing.outputIndex = outputIndex;
		registerToolAliases(state, existing, explicitItemId, explicitCallId);
		return existing;
	}

	const itemId =
		explicitItemId ?? explicitCallId ?? `tool-${state.tools.length}`;
	const callId = explicitCallId ?? itemId;
	const name = stringField(item, "name") ?? "tool";
	reserveChatTool(state, name);
	const tool: ToolCallState = {
		index: state.tools.length,
		...(outputIndex !== undefined ? { outputIndex } : {}),
		itemId,
		id: callId,
		name,
		arguments: "",
		kind: toolKind(item),
		started: false,
	};
	state.tools.push(tool);
	registerToolAliases(state, tool, itemId, callId);
	return tool;
}

function registerToolAliases(
	state: ChatState,
	tool: ToolCallState,
	itemId: string | undefined,
	callId: string | undefined,
): void {
	if (itemId) registerToolAlias(state, state.toolsByItemId, itemId, tool);
	if (callId) registerToolAlias(state, state.toolsByCallId, callId, tool);
	if (tool.outputIndex !== undefined) {
		registerToolAlias(
			state,
			state.toolsByOutputIndex,
			tool.outputIndex,
			tool,
		);
	}
}

function registerToolAlias<Key extends string | number>(
	state: ChatState,
	map: Map<Key, ToolCallState>,
	key: Key,
	tool: ToolCallState,
): void {
	const existing = map.get(key);
	if (existing && existing !== tool) throw codexStreamFailed();
	if (!existing) reserveChatAlias(state, key);
	map.set(key, tool);
}

function uniqueTool(
	candidates: Array<ToolCallState | undefined>,
): ToolCallState | undefined {
	let result: ToolCallState | undefined;
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (result && result !== candidate) throw codexStreamFailed();
		result = candidate;
	}
	return result;
}
