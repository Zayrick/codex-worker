import { decodeSseStream } from "../codex/event-stream";
import { codexStreamFailed } from "../codex/stream-error";
import { cancellationAwareReadable } from "../http/cancellation";
import { namedSseEvent } from "../http/sse-encoder";
import { normalizeError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { logFailure } from "../shared/logging";
import { anthropicErrorPayload, codexEventError } from "./error";
import { claudeToolName, claudeToolUseId } from "./identifiers";
import {
	claudeStopReason,
	claudeUsage,
	failedCodexResponse,
	incompleteCodexStream,
	outputTexts,
	reasoningText,
} from "./response";
import type { AnthropicSseEvent } from "./types";

const MAX_RETAINED_CHARS = 8 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_ALIASES = MAX_TOOL_CALLS * 3;
const THINKING_PART_SEPARATOR = "\n\n";

interface ToolCallStream {
	callId: string;
	name: string;
	blockIndex: number;
	arguments: string;
	emittedArgumentsLength: number;
	hasReceivedDelta: boolean;
	emitInitialEmptyDelta: boolean;
	started: boolean;
	done: boolean;
	closed: boolean;
}

interface MessagesStreamState {
	requestedModel: string;
	reverseToolNames: ReadonlyMap<string, string>;
	id: string;
	model: string;
	messageStarted: boolean;
	terminal: boolean;
	blockIndex: number;
	textBlockOpen: boolean;
	thinkingBlockOpen: boolean;
	thinkingSignature: string;
	thinkingSummarySeen: boolean;
	currentThinkingText: string;
	completedReasoningBlocks: number;
	hasTextDelta: boolean;
	text: string;
	hasEmittedToolUse: boolean;
	retainedChars: number;
	toolAliases: Map<string, ToolCallStream>;
	toolQueue: ToolCallStream[];
	activeTool: ToolCallStream | undefined;
	lastTool?: ToolCallStream;
	deferred: JsonObject[];
	webSearchIds: Set<string>;
}

export function createMessagesStream(
	upstream: ReadableStream<Uint8Array>,
	options: {
		model: string;
		reverseToolNames: ReadonlyMap<string, string>;
	},
	ctx: ExecutionContext,
): ReadableStream<Uint8Array> {
	const state = createState(options.model, options.reverseToolNames);
	const transform = new TransformStream<Uint8Array, Uint8Array>();
	const writer = transform.writable.getWriter();
	const abortController = new AbortController();

	const pump = (async () => {
		try {
			for await (const event of decodeSseStream(
				upstream,
				abortController.signal,
			)) {
				for (const translated of translateEvent(state, event)) {
					await writer.write(namedSseEvent(translated.event, translated.data));
				}
				if (state.terminal) break;
			}
			if (!state.terminal && !abortController.signal.aborted) {
				throw incompleteCodexStream();
			}
		} catch (error) {
			if (!state.terminal && !abortController.signal.aborted) {
				const apiError = normalizeError(error);
				logFailure("messages_stream", apiError);
				await writeSafely(
					writer,
					namedSseEvent("error", anthropicErrorPayload(apiError)),
				);
			}
		} finally {
			await closeWriterSafely(writer);
		}
	})();
	ctx.waitUntil(pump);
	return cancellationAwareReadable(transform.readable, (reason) => {
		abortController.abort(reason);
	});
}

function createState(
	model: string,
	reverseToolNames: ReadonlyMap<string, string>,
): MessagesStreamState {
	return {
		requestedModel: model,
		reverseToolNames,
		id: "",
		model,
		messageStarted: false,
		terminal: false,
		blockIndex: 0,
		textBlockOpen: false,
		thinkingBlockOpen: false,
		thinkingSignature: "",
		thinkingSummarySeen: false,
		currentThinkingText: "",
		completedReasoningBlocks: 0,
		hasTextDelta: false,
		text: "",
		hasEmittedToolUse: false,
		retainedChars: 0,
		toolAliases: new Map(),
		toolQueue: [],
		activeTool: undefined,
		deferred: [],
		webSearchIds: new Set(),
	};
}

function translateEvent(
	state: MessagesStreamState,
	event: JsonObject,
): AnthropicSseEvent[] {
	if (state.terminal) return [];
	const type = stringField(event, "type") ?? "";
	if (state.activeTool && shouldDefer(type, event)) {
		reserve(state, JSON.stringify(event).length);
		state.deferred.push(event);
		return [];
	}

	const output: AnthropicSseEvent[] = [];
	if (type === "error") throw codexEventError(event);
	if (type === "response.created") {
		output.push(...ensureMessageStart(state, recordField(event, "response")));
		return output;
	}
	if (type === "response.reasoning_summary_part.added") {
		output.push(...ensureMessageStart(state));
		output.push(...stopTextBlock(state));
		if (state.thinkingBlockOpen) {
			output.push(...appendThinkingDelta(state, THINKING_PART_SEPARATOR));
		} else {
			output.push(...startThinkingBlock(state));
		}
		state.thinkingSummarySeen = true;
		return drainDeferredIfReady(state, output);
	}
	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		output.push(...ensureMessageStart(state));
		output.push(...stopTextBlock(state));
		output.push(...startThinkingBlock(state));
		output.push(...appendThinkingDelta(state, stringValue(event.delta)));
		state.thinkingSummarySeen = true;
		return drainDeferredIfReady(state, output);
	}
	if (type === "response.content_part.added") {
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state));
		if (recordField(event, "part")?.type === "output_text") {
			output.push(...startTextBlock(state));
		}
		return drainDeferredIfReady(state, output);
	}
	if (type === "response.output_text.delta") {
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state));
		output.push(...startTextBlock(state));
		const delta = stringValue(event.delta);
		if (delta) {
			reserve(state, delta.length);
			state.text += delta;
			state.hasTextDelta = true;
			output.push(contentDelta(state.blockIndex, { type: "text_delta", text: delta }));
		}
		return drainDeferredIfReady(state, output);
	}
	if (type === "response.content_part.done") {
		if (recordField(event, "part")?.type === "output_text") {
			output.push(...stopTextBlock(state));
		}
		return drainDeferredIfReady(state, output);
	}
	if (type === "response.output_item.added") {
		output.push(...handleOutputItemAdded(state, event));
		return drainDeferredIfReady(state, output);
	}
	if (type === "response.output_item.done") {
		output.push(...handleOutputItemDone(state, event));
		return drainDeferredIfReady(state, output);
	}
	if (
		type === "response.function_call_arguments.delta" ||
		type === "response.custom_tool_call_input.delta"
	) {
		const call = findOrCreateTool(state, event);
		updateToolArguments(state, call, stringValue(event.delta), true);
		output.push(...flushToolQueue(state));
		return drainDeferredIfReady(state, output);
	}
	if (
		type === "response.function_call_arguments.done" ||
		type === "response.custom_tool_call_input.done"
	) {
		const call = findOrCreateTool(state, event);
		const value =
			type.includes("custom_tool")
				? stringValue(event.input)
				: stringValue(event.arguments);
		updateToolArguments(state, call, value, false);
		output.push(...flushToolQueue(state));
		return drainDeferredIfReady(state, output);
	}
	if (
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed"
	) {
		const response = recordField(event, "response");
		if (!response) throw codexStreamFailed();
		if (type === "response.failed") throw failedCodexResponse(response);
		output.push(...completeMessage(state, response));
		return output;
	}
	return drainDeferredIfReady(state, output);
}

function handleOutputItemAdded(
	state: MessagesStreamState,
	event: JsonObject,
): AnthropicSseEvent[] {
	const item = recordField(event, "item");
	if (!item) return [];
	const type = stringField(item, "type") ?? "";
	const output: AnthropicSseEvent[] = [];
	if (isFunctionCallType(type)) {
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state), ...stopTextBlock(state));
		const call = ensureTool(state, event, item);
		if (call.name) call.emitInitialEmptyDelta = true;
		output.push(...flushToolQueue(state));
	} else if (type === "reasoning") {
		output.push(...ensureMessageStart(state));
		output.push(...stopTextBlock(state), ...finalizeThinkingBlock(state));
		state.thinkingSummarySeen = false;
		state.currentThinkingText = "";
		state.thinkingSignature = stringField(item, "encrypted_content") ?? "";
	}
	return output;
}

function handleOutputItemDone(
	state: MessagesStreamState,
	event: JsonObject,
): AnthropicSseEvent[] {
	const item = recordField(event, "item");
	if (!item) return [];
	const type = stringField(item, "type") ?? "";
	const output: AnthropicSseEvent[] = [];
	if (type === "message") {
		if (state.hasTextDelta) return output;
		const text = outputTexts(item.content).join("");
		if (!text) return output;
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state), ...startTextBlock(state));
		reserve(state, text.length);
		state.text += text;
		state.hasTextDelta = true;
		output.push(contentDelta(state.blockIndex, { type: "text_delta", text }));
		output.push(...stopTextBlock(state));
		return output;
	}
	if (isFunctionCallType(type)) {
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state), ...stopTextBlock(state));
		const call = ensureTool(state, event, item);
		updateToolArguments(state, call, toolArguments(item), false);
		call.done = true;
		output.push(...flushToolQueue(state));
		return output;
	}
	if (type === "reasoning") {
		output.push(...ensureMessageStart(state), ...stopTextBlock(state));
		const finalText = reasoningTextForStream(item);
		if (finalText) {
			output.push(...startThinkingBlock(state));
			output.push(...reconcileThinkingText(state, finalText));
		}
		state.thinkingSignature =
			stringField(item, "encrypted_content") ?? state.thinkingSignature;
		if (state.thinkingBlockOpen || state.thinkingSignature) {
			output.push(...startThinkingBlock(state));
			output.push(...finalizeThinkingBlock(state));
			state.completedReasoningBlocks++;
		}
		state.thinkingSignature = "";
		state.thinkingSummarySeen = false;
		state.currentThinkingText = "";
		return output;
	}
	if (type === "web_search_call") {
		output.push(...appendWebSearch(state, item));
	}
	return output;
}

function completeMessage(
	state: MessagesStreamState,
	response: JsonObject,
): AnthropicSseEvent[] {
	const output = ensureMessageStart(state, response);
	const terminalOutput = response.output;
	if (terminalOutput !== undefined && !Array.isArray(terminalOutput)) {
		throw codexStreamFailed();
	}
	let reasoningIndex = 0;
	let finalText = "";
	for (let index = 0; index < (terminalOutput?.length ?? 0); index++) {
		const item = terminalOutput?.[index];
		if (!isRecord(item)) continue;
		const type = stringField(item, "type") ?? "";
		if (type === "reasoning") {
			if (reasoningIndex++ < state.completedReasoningBlocks) continue;
			output.push(...stopTextBlock(state));
			const text = reasoningTextForStream(item);
			output.push(...startThinkingBlock(state));
			output.push(...reconcileThinkingText(state, text));
			state.thinkingSignature = stringField(item, "encrypted_content") ?? "";
			output.push(...finalizeThinkingBlock(state));
			state.completedReasoningBlocks++;
			continue;
		}
		if (type === "message") {
			finalText += outputTexts(item.content).join("");
			output.push(...reconcileTerminalText(state, finalText));
			continue;
		}
		if (isFunctionCallType(type)) {
			output.push(...finalizeThinkingBlock(state), ...stopTextBlock(state));
			const call = ensureTool(state, { output_index: index }, item);
			updateToolArguments(state, call, toolArguments(item), false);
			call.done = true;
			output.push(...flushToolQueue(state));
			continue;
		}
		if (type === "web_search_call") {
			output.push(...appendWebSearch(state, item));
		}
	}
	if (finalText) output.push(...reconcileText(state, finalText));
	for (const call of state.toolQueue) call.done = true;
	output.push(...flushToolQueue(state));
	output.push(...finalizeThinkingBlock(state), ...stopTextBlock(state));
	state.deferred = [];

	output.push({
		event: "message_delta",
		data: {
			type: "message_delta",
			delta: {
				stop_reason: claudeStopReason(response, state.hasEmittedToolUse),
				stop_sequence: stringField(response, "stop_sequence") ?? null,
			},
			usage: claudeUsage(recordField(response, "usage")),
		},
	});
	output.push({ event: "message_stop", data: { type: "message_stop" } });
	state.terminal = true;
	return output;
}

function reconcileTerminalText(
	state: MessagesStreamState,
	terminalText: string,
): AnthropicSseEvent[] {
	if (terminalText.startsWith(state.text)) {
		return reconcileText(state, terminalText);
	}
	if (state.text.startsWith(terminalText)) {
		return [];
	}
	throw codexStreamFailed();
}

function ensureMessageStart(
	state: MessagesStreamState,
	response?: JsonObject,
): AnthropicSseEvent[] {
	if (response) {
		state.id = stringField(response, "id") ?? state.id;
		state.model = stringField(response, "model") ?? state.model;
	}
	if (state.messageStarted) return [];
	if (!state.id) throw codexStreamFailed();
	state.messageStarted = true;
	return [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: state.id,
					type: "message",
					role: "assistant",
					model: state.model || state.requestedModel,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: claudeUsage(recordField(response, "usage")),
				},
			},
		},
	];
}

function startTextBlock(state: MessagesStreamState): AnthropicSseEvent[] {
	if (state.textBlockOpen) return [];
	state.textBlockOpen = true;
	return [contentStart(state.blockIndex, { type: "text", text: "" })];
}

function stopTextBlock(state: MessagesStreamState): AnthropicSseEvent[] {
	if (!state.textBlockOpen) return [];
	const index = state.blockIndex++;
	state.textBlockOpen = false;
	return [contentStop(index)];
}

function startThinkingBlock(state: MessagesStreamState): AnthropicSseEvent[] {
	if (state.thinkingBlockOpen) return [];
	state.thinkingBlockOpen = true;
	state.currentThinkingText = "";
	return [contentStart(state.blockIndex, { type: "thinking", thinking: "" })];
}

function appendThinkingDelta(
	state: MessagesStreamState,
	text: string,
): AnthropicSseEvent[] {
	if (!text) return [];
	reserve(state, text.length);
	state.currentThinkingText += text;
	return [
		contentDelta(state.blockIndex, { type: "thinking_delta", thinking: text }),
	];
}

function reconcileThinkingText(
	state: MessagesStreamState,
	finalText: string,
): AnthropicSseEvent[] {
	if (!finalText || finalText === state.currentThinkingText) return [];
	if (!finalText.startsWith(state.currentThinkingText)) throw codexStreamFailed();
	return appendThinkingDelta(
		state,
		finalText.slice(state.currentThinkingText.length),
	);
}

function finalizeThinkingBlock(
	state: MessagesStreamState,
): AnthropicSseEvent[] {
	if (!state.thinkingBlockOpen) return [];
	const index = state.blockIndex++;
	const output: AnthropicSseEvent[] = [];
	if (state.thinkingSignature) {
		output.push(
			contentDelta(index, {
				type: "signature_delta",
				signature: state.thinkingSignature,
			}),
		);
	}
	output.push(contentStop(index));
	state.thinkingBlockOpen = false;
	state.currentThinkingText = "";
	return output;
}

function reconcileText(
	state: MessagesStreamState,
	finalText: string,
): AnthropicSseEvent[] {
	if (finalText === state.text) return [];
	if (!finalText.startsWith(state.text)) throw codexStreamFailed();
	const delta = finalText.slice(state.text.length);
	if (!delta) return [];
	const output = [
		...finalizeThinkingBlock(state),
		...startTextBlock(state),
	];
	reserve(state, delta.length);
	state.text = finalText;
	state.hasTextDelta = true;
	output.push(contentDelta(state.blockIndex, { type: "text_delta", text: delta }));
	return output;
}

function appendWebSearch(
	state: MessagesStreamState,
	item: JsonObject,
): AnthropicSseEvent[] {
	const rawId = stringField(item, "id") ?? `web_search_${state.blockIndex}`;
	const id = claudeToolUseId(rawId, `web_search_${state.blockIndex}`);
	if (state.webSearchIds.has(id)) return [];
	const action = recordField(item, "action");
	const query = stringField(action, "query") ?? stringField(item, "query");
	const results = Array.isArray(item.results) ? item.results : [];
	if (!query && results.length === 0) return [];
	state.webSearchIds.add(id);
	const output = [
		...ensureMessageStart(state),
		...finalizeThinkingBlock(state),
		...stopTextBlock(state),
	];
	let index = state.blockIndex++;
	output.push(
		contentStart(index, {
			type: "server_tool_use",
			id,
			name: "web_search",
			input: {},
		}),
	);
	if (query) {
		output.push(
			contentDelta(index, {
				type: "input_json_delta",
				partial_json: JSON.stringify({ query }),
			}),
		);
	}
	output.push(contentStop(index));

	const content: JsonObject[] = [];
	for (const raw of results) {
		if (!isRecord(raw)) continue;
		const url = stringField(raw, "url");
		if (!url) continue;
		content.push({
			type: "web_search_result",
			title: stringField(raw, "title") ?? url,
			url,
			page_age: null,
		});
	}
	index = state.blockIndex++;
	output.push(
		contentStart(index, {
			type: "web_search_tool_result",
			tool_use_id: id,
			content,
		}),
		contentStop(index),
	);
	return output;
}

function findOrCreateTool(
	state: MessagesStreamState,
	event: JsonObject,
): ToolCallStream {
	return findTool(state, event) ?? ensureTool(state, event, {});
}

function ensureTool(
	state: MessagesStreamState,
	event: JsonObject,
	item: JsonObject,
): ToolCallStream {
	const keys = toolKeys(event, item);
	let call = uniqueTools(keys.map((key) => state.toolAliases.get(key)));
	if (!call) {
		if (state.toolQueue.length >= MAX_TOOL_CALLS) throw codexStreamFailed();
		call = {
			callId:
				stringField(item, "call_id") ??
				stringField(event, "call_id") ??
				stringField(item, "id") ??
				`tool_${state.toolQueue.length}`,
			name: stringField(item, "name") ?? "",
			blockIndex: -1,
			arguments: "",
			emittedArgumentsLength: 0,
			hasReceivedDelta: false,
			emitInitialEmptyDelta: false,
			started: false,
			done: false,
			closed: false,
		};
		reserve(state, call.callId.length + call.name.length);
		state.toolQueue.push(call);
	}
	const callId = stringField(item, "call_id") ?? stringField(event, "call_id");
	if (callId) call.callId = callId;
	const name = stringField(item, "name");
	if (name && name !== call.name) {
		reserve(state, name.length);
		call.name = name;
	}
	for (const key of keys) registerToolAlias(state, key, call);
	state.lastTool = call;
	return call;
}

function findTool(
	state: MessagesStreamState,
	event: JsonObject,
): ToolCallStream | undefined {
	const keys = toolKeys(event, {});
	const found = uniqueTools(keys.map((key) => state.toolAliases.get(key)));
	return found ?? (keys.length === 0 ? state.lastTool : undefined);
}

function toolKeys(event: JsonObject, item: JsonObject): string[] {
	const keys: string[] = [];
	const outputIndex = numberField(event, "output_index");
	if (outputIndex !== undefined) keys.push(`output:${outputIndex}`);
	for (const value of [
		stringField(item, "call_id"),
		stringField(event, "call_id"),
	]) {
		if (value) keys.push(`call:${value}`);
	}
	for (const value of [stringField(item, "id"), stringField(event, "item_id")]) {
		if (value) keys.push(`item:${value}`);
	}
	return [...new Set(keys)];
}

function registerToolAlias(
	state: MessagesStreamState,
	key: string,
	call: ToolCallStream,
): void {
	const existing = state.toolAliases.get(key);
	if (existing && existing !== call) throw codexStreamFailed();
	if (existing) return;
	if (state.toolAliases.size >= MAX_TOOL_ALIASES) throw codexStreamFailed();
	reserve(state, key.length);
	state.toolAliases.set(key, call);
}

function uniqueTools(
	values: Array<ToolCallStream | undefined>,
): ToolCallStream | undefined {
	let result: ToolCallStream | undefined;
	for (const value of values) {
		if (!value) continue;
		if (result && result !== value) throw codexStreamFailed();
		result = value;
	}
	return result;
}

function updateToolArguments(
	state: MessagesStreamState,
	call: ToolCallStream,
	value: string,
	isDelta: boolean,
): void {
	if (!value) return;
	if (isDelta) {
		reserve(state, value.length);
		call.arguments += value;
		call.hasReceivedDelta = true;
		return;
	}
	if (!call.hasReceivedDelta) {
		reserve(state, value.length - call.arguments.length);
		call.arguments = value;
		return;
	}
	if (!value.startsWith(call.arguments)) throw codexStreamFailed();
	reserve(state, value.length - call.arguments.length);
	call.arguments = value;
}

function flushToolQueue(state: MessagesStreamState): AnthropicSseEvent[] {
	const output: AnthropicSseEvent[] = [];
	while (true) {
		const active = state.activeTool;
		if (active) {
			output.push(...emitBufferedToolArguments(active));
			if (!active.done) return output;
			output.push(contentStop(active.blockIndex));
			state.blockIndex = Math.max(state.blockIndex, active.blockIndex + 1);
			active.closed = true;
			state.activeTool = undefined;
			state.toolQueue = state.toolQueue.filter((call) => call !== active);
		}
		while (state.toolQueue[0]?.closed) state.toolQueue.shift();
		const call = state.toolQueue[0];
		if (!call || !call.name) return output;
		output.push(...ensureMessageStart(state));
		output.push(...finalizeThinkingBlock(state), ...stopTextBlock(state));
		call.blockIndex = state.blockIndex;
		output.push(
			contentStart(call.blockIndex, {
				type: "tool_use",
				id: claudeToolUseId(call.callId, `toolu_${call.blockIndex}`),
				name: claudeToolName(call.name, state.reverseToolNames),
				input: {},
			}),
		);
		if (call.emitInitialEmptyDelta) {
			output.push(
				contentDelta(call.blockIndex, {
					type: "input_json_delta",
					partial_json: "",
				}),
			);
		}
		call.started = true;
		state.activeTool = call;
		state.hasEmittedToolUse = true;
		output.push(...emitBufferedToolArguments(call));
	}
}

function emitBufferedToolArguments(
	call: ToolCallStream,
): AnthropicSseEvent[] {
	if (
		!call.started ||
		call.closed ||
		call.emittedArgumentsLength >= call.arguments.length
	) {
		return [];
	}
	const partialJson = call.arguments.slice(call.emittedArgumentsLength);
	call.emittedArgumentsLength = call.arguments.length;
	return [
		contentDelta(call.blockIndex, {
			type: "input_json_delta",
			partial_json: partialJson,
		}),
	];
}

function drainDeferredIfReady(
	state: MessagesStreamState,
	output: AnthropicSseEvent[],
): AnthropicSseEvent[] {
	if (state.activeTool || state.toolQueue.length > 0 || state.deferred.length === 0) {
		return output;
	}
	const deferred = state.deferred;
	state.deferred = [];
	for (const event of deferred) output.push(...translateEvent(state, event));
	return output;
}

function shouldDefer(type: string, event: JsonObject): boolean {
	if (
		type === "error" ||
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed" ||
		type === "response.function_call_arguments.delta" ||
		type === "response.function_call_arguments.done" ||
		type === "response.custom_tool_call_input.delta" ||
		type === "response.custom_tool_call_input.done"
	) {
		return false;
	}
	if (type === "response.output_item.added" || type === "response.output_item.done") {
		return !isFunctionCallType(
			stringField(recordField(event, "item"), "type") ?? "",
		);
	}
	return true;
}

function contentStart(index: number, block: JsonObject): AnthropicSseEvent {
	return {
		event: "content_block_start",
		data: { type: "content_block_start", index, content_block: block },
	};
}

function contentDelta(index: number, delta: JsonObject): AnthropicSseEvent {
	return {
		event: "content_block_delta",
		data: { type: "content_block_delta", index, delta },
	};
}

function contentStop(index: number): AnthropicSseEvent {
	return {
		event: "content_block_stop",
		data: { type: "content_block_stop", index },
	};
}

function reasoningTextForStream(item: JsonObject): string {
	if (Array.isArray(item.summary)) {
		return item.summary
			.map((part) =>
				isRecord(part) && typeof part.text === "string" ? part.text : "",
			)
			.filter(Boolean)
			.join(THINKING_PART_SEPARATOR);
	}
	return reasoningText(item);
}

function toolArguments(item: JsonObject): string {
	return item.type === "custom_tool_call"
		? stringField(item, "input") ?? ""
		: stringField(item, "arguments") ?? "{}";
}

function isFunctionCallType(type: string): boolean {
	return type === "function_call" || type === "custom_tool_call";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function reserve(state: MessagesStreamState, additional: number): void {
	if (additional <= 0) return;
	if (state.retainedChars > MAX_RETAINED_CHARS - additional) {
		throw codexStreamFailed();
	}
	state.retainedChars += additional;
}

async function writeSafely(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	chunk: Uint8Array,
): Promise<void> {
	try {
		await writer.write(chunk);
	} catch {
		// Downstream cancellation leaves nothing to send.
	}
}

async function closeWriterSafely(
	writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
	try {
		await writer.close();
	} catch {
		// The readable side may already have cancelled the transform.
	}
}
