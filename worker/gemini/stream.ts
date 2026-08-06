import { decodeSseStream } from "../codex/event-stream";
import { codexStreamFailed } from "../codex/stream-error";
import { cancellationAwareReadable } from "../http/cancellation";
import { namedSseEvent, sseData } from "../http/sse-encoder";
import {
	failedCodexResponse,
	incompleteCodexStream,
	outputTexts,
	parseToolInput,
	reasoningText,
} from "../messages/response";
import { normalizeError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { logFailure } from "../shared/logging";
import { geminiCodexEventError, geminiErrorPayload } from "./error";
import {
	geminiChunk,
	geminiFinishReason,
	outputMimeType,
} from "./response";
import type { GeminiStreamOptions } from "./types";

const MAX_RETAINED_CHARS = 8 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 256;
const THINKING_SEPARATOR = "\n\n";

interface GeminiStreamState {
	requestedModel: string;
	reverseToolNames: ReadonlyMap<string, string>;
	id: string;
	model: string;
	createdAt: number | undefined;
	terminal: boolean;
	text: string;
	reasoning: string;
	terminalText: string;
	terminalReasoning: string;
	retainedChars: number;
	seenItems: Set<string>;
}

export function createGeminiStream(
	upstream: ReadableStream<Uint8Array>,
	options: GeminiStreamOptions,
	ctx: ExecutionContext,
): ReadableStream<Uint8Array> {
	const state = createState(options);
	const transform = new TransformStream<Uint8Array, Uint8Array>();
	const writer = transform.writable.getWriter();
	const abortController = new AbortController();

	const pump = (async () => {
		try {
			for await (const event of decodeSseStream(
				upstream,
				abortController.signal,
			)) {
				for (const chunk of translateEvent(state, event)) {
					await writer.write(sseData(chunk));
				}
				if (state.terminal) break;
			}
			if (!state.terminal && !abortController.signal.aborted) {
				throw incompleteCodexStream();
			}
		} catch (error) {
			if (!state.terminal && !abortController.signal.aborted) {
				const apiError = normalizeError(error);
				logFailure("gemini_stream", apiError);
				await writeSafely(
					writer,
					namedSseEvent("error", geminiErrorPayload(apiError)),
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

function createState(options: GeminiStreamOptions): GeminiStreamState {
	return {
		requestedModel: options.model,
		reverseToolNames: options.reverseToolNames,
		id: "",
		model: options.model,
		createdAt: undefined,
		terminal: false,
		text: "",
		reasoning: "",
		terminalText: "",
		terminalReasoning: "",
		retainedChars: 0,
		seenItems: new Set(),
	};
}

function translateEvent(
	state: GeminiStreamState,
	event: JsonObject,
): JsonObject[] {
	if (state.terminal) return [];
	const type = stringField(event, "type") ?? "";
	if (type === "error") throw geminiCodexEventError(event);
	if (type === "response.created") {
		updateMetadata(state, recordField(event, "response"));
		return [];
	}
	if (type === "response.reasoning_summary_part.added") {
		return emitReasoning(state, state.reasoning ? THINKING_SEPARATOR : "");
	}
	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		return emitReasoning(state, stringValue(event.delta));
	}
	if (type === "response.output_text.delta") {
		return emitText(state, stringValue(event.delta));
	}
	if (type === "response.output_item.done") {
		return outputItemDone(
			state,
			recordField(event, "item"),
			numberField(event, "output_index"),
		);
	}
	if (
		type === "response.completed" ||
		type === "response.incomplete" ||
		type === "response.failed"
	) {
		const response = recordField(event, "response");
		if (!response) throw codexStreamFailed();
		if (type === "response.failed") throw failedCodexResponse(response);
		return completeResponse(state, response, type === "response.incomplete");
	}
	return [];
}

function outputItemDone(
	state: GeminiStreamState,
	item: JsonObject | undefined,
	outputIndex: number | undefined,
): JsonObject[] {
	if (!item) return [];
	const key = itemKey(item, outputIndex);
	if (state.seenItems.has(key)) return [];
	rememberItem(state, key);
	const type = stringField(item, "type") ?? "";
	if (type === "message") {
		state.terminalText += outputTexts(item.content).join("");
		return reconcileTerminalText(state, state.terminalText);
	}
	if (type === "reasoning") {
		const text = reasoningText(item);
		state.terminalReasoning += `${state.terminalReasoning && text ? THINKING_SEPARATOR : ""}${text}`;
		const chunks = reconcileTerminalReasoning(state, state.terminalReasoning);
		const signature = stringField(item, "encrypted_content");
		if (signature) chunks.push(partChunk(state, { thought: true, text: "", thoughtSignature: signature }));
		return chunks;
	}
	if (type === "function_call" || type === "custom_tool_call") {
		return [partChunk(state, functionCallPart(state, item, type))];
	}
	if (type === "image_generation_call") {
		const part = imagePart(item);
		return part ? [partChunk(state, part)] : [];
	}
	return [];
}

function completeResponse(
	state: GeminiStreamState,
	response: JsonObject,
	incomplete: boolean,
): JsonObject[] {
	updateMetadata(state, response);
	const output = response.output;
	if (output !== undefined && !Array.isArray(output)) throw codexStreamFailed();
	const chunks: JsonObject[] = [];
	let terminalText = "";
	let terminalReasoning = "";
	for (let index = 0; index < (output?.length ?? 0); index++) {
		const item = output?.[index];
		if (!isRecord(item)) continue;
		const type = stringField(item, "type") ?? "";
		if (type === "message") {
			terminalText += outputTexts(item.content).join("");
			if (!state.seenItems.has(itemKey(item, index))) {
				chunks.push(...reconcileTerminalText(state, terminalText));
			}
			continue;
		}
		if (type === "reasoning") {
			const text = reasoningText(item);
			terminalReasoning += `${terminalReasoning && text ? THINKING_SEPARATOR : ""}${text}`;
			const key = itemKey(item, index);
			if (!state.seenItems.has(key)) {
				chunks.push(...reconcileTerminalReasoning(state, terminalReasoning));
				const signature = stringField(item, "encrypted_content");
				if (signature) {
					chunks.push(partChunk(state, { thought: true, text: "", thoughtSignature: signature }));
				}
			}
			continue;
		}
		const key = itemKey(item, index);
		if (state.seenItems.has(key)) continue;
		rememberItem(state, key);
		if (type === "function_call" || type === "custom_tool_call") {
			chunks.push(partChunk(state, functionCallPart(state, item, type)));
		} else if (type === "image_generation_call") {
			const part = imagePart(item);
			if (part) chunks.push(partChunk(state, part));
		}
	}
	if (terminalText) chunks.push(...reconcileText(state, terminalText));
	if (terminalReasoning) chunks.push(...reconcileReasoning(state, terminalReasoning));
	chunks.push(
		geminiChunk(metadata(state), [], {
			finishReason: geminiFinishReason(response, incomplete),
			usage: recordField(response, "usage"),
		}),
	);
	state.terminal = true;
	return chunks;
}

function emitText(state: GeminiStreamState, text: string): JsonObject[] {
	if (!text) return [];
	reserve(state, text.length);
	state.text += text;
	return [partChunk(state, { text })];
}

function emitReasoning(state: GeminiStreamState, text: string): JsonObject[] {
	if (!text) return [];
	reserve(state, text.length);
	state.reasoning += text;
	return [partChunk(state, { thought: true, text })];
}

function reconcileText(
	state: GeminiStreamState,
	terminalText: string,
): JsonObject[] {
	if (!terminalText || terminalText === state.text) return [];
	if (!terminalText.startsWith(state.text)) throw codexStreamFailed();
	return emitText(state, terminalText.slice(state.text.length));
}

function reconcileTerminalText(
	state: GeminiStreamState,
	terminalText: string,
): JsonObject[] {
	if (terminalText.startsWith(state.text)) return reconcileText(state, terminalText);
	if (state.text.startsWith(terminalText)) return [];
	throw codexStreamFailed();
}

function reconcileReasoning(
	state: GeminiStreamState,
	terminalReasoning: string,
): JsonObject[] {
	if (!terminalReasoning || terminalReasoning === state.reasoning) return [];
	if (!terminalReasoning.startsWith(state.reasoning)) throw codexStreamFailed();
	return emitReasoning(state, terminalReasoning.slice(state.reasoning.length));
}

function reconcileTerminalReasoning(
	state: GeminiStreamState,
	terminalReasoning: string,
): JsonObject[] {
	if (terminalReasoning.startsWith(state.reasoning)) {
		return reconcileReasoning(state, terminalReasoning);
	}
	if (state.reasoning.startsWith(terminalReasoning)) return [];
	throw codexStreamFailed();
}

function functionCallPart(
	state: GeminiStreamState,
	item: JsonObject,
	type: string,
): JsonObject {
	const rawName = stringField(item, "name") ?? "tool";
	const rawArguments =
		type === "custom_tool_call"
			? stringField(item, "input")
			: stringField(item, "arguments");
	const functionCall: JsonObject = {
		name: state.reverseToolNames.get(rawName) ?? rawName,
		args: parseToolInput(rawArguments),
	};
	const callId = stringField(item, "call_id") ?? stringField(item, "id");
	if (callId) functionCall.id = callId;
	return { functionCall };
}

function imagePart(item: JsonObject): JsonObject | undefined {
	const data = stringField(item, "result");
	return data
		? {
				inlineData: {
					data,
					mimeType: outputMimeType(stringField(item, "output_format")),
				},
			}
		: undefined;
}

function partChunk(state: GeminiStreamState, part: JsonObject): JsonObject {
	return geminiChunk(metadata(state), [part]);
}

function metadata(state: GeminiStreamState): {
	id: string;
	model: string;
	createdAt: number | undefined;
} {
	if (!state.id) throw codexStreamFailed();
	return { id: state.id, model: state.model || state.requestedModel, createdAt: state.createdAt };
}

function updateMetadata(
	state: GeminiStreamState,
	response: JsonObject | undefined,
): void {
	if (!response) return;
	state.id = stringField(response, "id") ?? state.id;
	state.model = stringField(response, "model") ?? state.model;
	state.createdAt = numberField(response, "created_at") ?? state.createdAt;
}

function itemKey(item: JsonObject, outputIndex: number | undefined): string {
	const type = stringField(item, "type") ?? "item";
	return (
		stringField(item, "id") ??
		stringField(item, "call_id") ??
		`${type}:${outputIndex ?? "unknown"}`
	);
}

function rememberItem(state: GeminiStreamState, key: string): void {
	if (state.seenItems.size >= MAX_OUTPUT_ITEMS) throw codexStreamFailed();
	reserve(state, key.length);
	state.seenItems.add(key);
}

function reserve(state: GeminiStreamState, additional: number): void {
	if (additional <= 0) return;
	if (state.retainedChars > MAX_RETAINED_CHARS - additional) {
		throw codexStreamFailed();
	}
	state.retainedChars += additional;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
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
