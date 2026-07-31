import { isRecord, type JsonObject } from "./types";

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
			const block = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			const event = parseBlock(block);
			if (event) events.push(event);
		}

		if (flush && this.buffer.trim()) {
			const event = parseBlock(this.buffer);
			this.buffer = "";
			if (event) events.push(event);
		} else if (flush) {
			this.buffer = "";
		}
		return events;
	}
}

export async function collectSseEvents(
	body: ReadableStream<Uint8Array>,
): Promise<JsonObject[]> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parser = new SseDecoder();
	const events: JsonObject[] = [];
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			events.push(...parser.push(decoder.decode(result.value, { stream: true })));
		}
		events.push(...parser.push(decoder.decode()));
		events.push(...parser.finish());
		return events;
	} finally {
		reader.releaseLock();
	}
}

export function sseData(value: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

export const SSE_DONE = new TextEncoder().encode("data: [DONE]\n\n");

function parseBlock(block: string): JsonObject | undefined {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	if (!data || data === "[DONE]") return undefined;
	try {
		const value: unknown = JSON.parse(data);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
