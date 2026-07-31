import { ApiError } from "./errors";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "./types";

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

export function completedResponseFromEvents(
	events: readonly JsonObject[],
): JsonObject {
	let terminalResponse: JsonObject | undefined;
	const outputItems = new Map<
		string,
		{ index: number; item: JsonObject }
	>();
	for (const event of events) {
		const type = stringField(event, "type") ?? "";
		if (
			type === "response.output_item.added" ||
			type === "response.output_item.done"
		) {
			const item = recordField(event, "item");
			if (item) {
				const index = numberField(event, "output_index") ?? outputItems.size;
				const key = stringField(item, "id") ?? String(index);
				outputItems.set(key, { index, item });
			}
		}
		if (
			type === "response.completed" ||
			type === "response.incomplete" ||
			type === "response.failed"
		) {
			terminalResponse = recordField(event, "response");
		}
		if (type === "error" || type === "response.failed") {
			const error =
				recordField(event, "error") ??
				recordField(recordField(event, "response"), "error");
			throw new ApiError(
				502,
				stringField(error, "message") ?? "The Codex response stream failed.",
				"upstream_error",
				stringField(error, "code") ?? "codex_stream_failed",
			);
		}
	}

	if (!terminalResponse) {
		throw new ApiError(
			502,
			"The Codex response stream ended before a terminal response event.",
			"upstream_error",
			"incomplete_codex_stream",
		);
	}
	if (
		Array.isArray(terminalResponse.output) &&
		terminalResponse.output.length > 0
	) {
		return terminalResponse;
	}
	const reconstructedOutput = [...outputItems.values()]
		.sort((left, right) => left.index - right.index)
		.map(({ item }) => item);
	return reconstructedOutput.length > 0
		? { ...terminalResponse, output: reconstructedOutput }
		: terminalResponse;
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
