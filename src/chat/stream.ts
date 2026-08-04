import { decodeSseStream } from "../codex/event-stream";
import { codexStreamFailed } from "../codex/stream-error";
import { SSE_DONE, sseData } from "../http/sse-encoder";
import { errorPayload } from "../shared/api-error";
import type { JsonObject } from "../shared/json";
import { logFailure } from "../shared/logging";
import {
	createChatState,
	reduceCodexEvent,
	requireChatTerminal,
} from "./reducer";
import {
	presentChatAction,
	type StreamPresentationState,
} from "./stream-presenter";
import type { ChatState } from "./types";

export function createChatCompletionStream(
	upstream: ReadableStream<Uint8Array>,
	options: { model: string; includeUsage: boolean },
	ctx: ExecutionContext,
): ReadableStream<Uint8Array> {
	const state = createChatState(options.model);
	const presentation: StreamPresentationState = {
		roleSent: false,
		finished: false,
	};
	const transform = new TransformStream<Uint8Array, Uint8Array>();
	const writer = transform.writable.getWriter();
	const abortController = new AbortController();

	const pump = (async () => {
		try {
			for await (const event of decodeSseStream(
				upstream,
				abortController.signal,
			)) {
				await processStreamEvent(
					writer,
					state,
					presentation,
					event,
					options.includeUsage,
				);
				if (presentation.finished) break;
			}
			if (!presentation.finished) requireChatTerminal(state);
		} catch (error) {
			if (!presentation.finished && !abortController.signal.aborted) {
				logFailure("chat_stream", error);
				await writeStreamFailureSafely(writer);
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

function cancellationAwareReadable(
	source: ReadableStream<Uint8Array>,
	onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		reader.releaseLock();
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel(reason) {
			onCancel(reason);
			try {
				await reader.cancel(reason);
			} catch {
				// The transform may already be closed or errored.
			} finally {
				release();
			}
		},
	});
}

async function processStreamEvent(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	state: ChatState,
	presentation: StreamPresentationState,
	event: JsonObject,
	includeUsage: boolean,
): Promise<void> {
	if (presentation.finished) return;
	const actions = reduceCodexEvent(state, event);
	for (const action of actions) {
		await presentChatAction(
			writer,
			state,
			presentation,
			action,
			includeUsage,
		);
	}
}

async function writeStreamFailureSafely(
	writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
	await writeSafely(writer, sseData(errorPayload(codexStreamFailed())));
	await writeSafely(writer, SSE_DONE);
}

async function writeSafely(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	chunk: Uint8Array,
): Promise<void> {
	try {
		await writer.write(chunk);
	} catch {
		// Downstream cancellation makes the writer reject; there is nothing left to send.
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
