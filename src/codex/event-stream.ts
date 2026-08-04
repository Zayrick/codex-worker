import { codexStreamFailed } from "./stream-error";
import { isRecord, type JsonObject } from "../shared/json";

export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

export class SseDecoder {
	private buffer = "";

	push(chunk: string): JsonObject[] {
		this.buffer += chunk.replace(/\r/g, "");
		return this.drain(false);
	}

	finish(): JsonObject[] {
		return this.drain(true);
	}

	private drain(flush: boolean): JsonObject[] {
		const events: JsonObject[] = [];
		let boundary: number;
		while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
			if (boundary > MAX_SSE_EVENT_CHARS) throw codexStreamFailed();
			const block = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			const event = parseBlock(block);
			if (event) events.push(event);
		}
		if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
			throw codexStreamFailed();
		}

		if (flush && this.buffer.trim()) {
			const event = parseBlock(this.buffer);
			if (event) events.push(event);
		}
		if (flush) this.buffer = "";
		return events;
	}
}

export async function* decodeSseStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<JsonObject> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parser = new SseDecoder();
	let reachedEof = false;
	const cancelFromSignal = (): void => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	if (signal?.aborted) cancelFromSignal();
	else signal?.addEventListener("abort", cancelFromSignal, { once: true });
	try {
		while (true) {
			const result = await reader.read();
			if (signal?.aborted) return;
			if (result.done) {
				reachedEof = true;
				break;
			}
			for (const event of parser.push(
				decoder.decode(result.value, { stream: true }),
			)) {
				yield event;
			}
		}
		for (const event of parser.push(decoder.decode())) yield event;
		for (const event of parser.finish()) yield event;
	} finally {
		signal?.removeEventListener("abort", cancelFromSignal);
		if (!reachedEof) {
			try {
				await reader.cancel();
			} catch {
				// The source may already be errored or cancelled by its producer.
			}
		}
		reader.releaseLock();
	}
}

function parseBlock(block: string): JsonObject | undefined {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	if (!data.trim() || data.trim() === "[DONE]") return undefined;
	try {
		const value: unknown = JSON.parse(data);
		if (!isRecord(value)) throw codexStreamFailed();
		return value;
	} catch {
		throw codexStreamFailed();
	}
}
