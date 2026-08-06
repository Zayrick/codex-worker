import { MAX_SSE_EVENT_CHARS } from "../codex/event-stream";
import { codexStreamFailed } from "../codex/stream-error";
import { SSE_DONE, sseData } from "../http/sse-encoder";
import { isRecord, type JsonObject } from "../shared/json";
import { completionId } from "./response";

export function createCompletionStream(
	chatStream: ReadableStream<Uint8Array>,
	echoPrefix = "",
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = "";
	let pendingEcho = echoPrefix;

	return chatStream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
				const drained = drainBlocks(controller, buffer, pendingEcho);
				pendingEcho = drained.echo;
				buffer = drained.remainder;
			},
			flush(controller) {
				buffer += decoder.decode().replace(/\r/g, "");
				const drained = drainBlocks(controller, buffer, pendingEcho);
				pendingEcho = drained.echo;
				buffer = drained.remainder;
				if (buffer.trim()) processBlock(controller, buffer, pendingEcho);
			},
		}),
	);
}

function drainBlocks(
	controller: TransformStreamDefaultController<Uint8Array>,
	input: string,
	echo: string,
): { remainder: string; echo: string } {
	let remainder = input;
	let pendingEcho = echo;
	let boundary: number;
	while ((boundary = remainder.indexOf("\n\n")) >= 0) {
		if (boundary > MAX_SSE_EVENT_CHARS) throw codexStreamFailed();
		pendingEcho = processBlock(
			controller,
			remainder.slice(0, boundary),
			pendingEcho,
		);
		remainder = remainder.slice(boundary + 2);
	}
	if (remainder.length > MAX_SSE_EVENT_CHARS) throw codexStreamFailed();
	return { remainder, echo: pendingEcho };
}

function processBlock(
	controller: TransformStreamDefaultController<Uint8Array>,
	block: string,
	echo: string,
): string {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) return echo;
	if (data === "[DONE]") {
		controller.enqueue(SSE_DONE);
		return echo;
	}

	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw codexStreamFailed();
	}
	if (!isRecord(value)) throw codexStreamFailed();
	if (isRecord(value.error)) {
		controller.enqueue(sseData(value));
		return echo;
	}

	const converted = completionChunk(value, echo);
	if (converted) controller.enqueue(sseData(converted.value));
	return converted?.echo ?? echo;
}

function completionChunk(
	chunk: JsonObject,
	echo: string,
): { value: JsonObject; echo: string } | undefined {
	let pendingEcho = echo;
	const choices: JsonObject[] = [];
	if (Array.isArray(chunk.choices)) {
		for (const rawChoice of chunk.choices) {
			if (!isRecord(rawChoice)) continue;
			const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
			const deltaText = typeof delta?.content === "string" ? delta.content : "";
			const finishReason = rawChoice.finish_reason;
			if (!deltaText && (finishReason === undefined || finishReason === null)) {
				continue;
			}
			choices.push({
				index: typeof rawChoice.index === "number" ? rawChoice.index : 0,
				text: `${pendingEcho}${deltaText}`,
				logprobs: rawChoice.logprobs ?? null,
				finish_reason: finishReason ?? null,
			});
			pendingEcho = "";
		}
	}

	if (choices.length === 0 && chunk.usage === undefined) return undefined;
	const value: JsonObject = {
		id: completionId(chunk.id),
		object: "text_completion",
		created: chunk.created,
		model: chunk.model,
		choices,
	};
	if (chunk.usage !== undefined) value.usage = chunk.usage;
	return { value, echo: pendingEcho };
}
