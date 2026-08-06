import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	createChatState,
	reduceCodexEvent,
} from "../../worker/chat/reducer";
import {
	MAX_CHAT_RETAINED_CHARS,
	MAX_CHAT_TOOL_ALIASES,
	MAX_CHAT_TOOL_CALLS,
} from "../../worker/chat/state-budget";
import { chatCompletionFromEvents } from "../../worker/chat/response";
import { createChatCompletionStream } from "../../worker/chat/stream";
import {
	decodeSseStream,
	MAX_SSE_EVENT_CHARS,
	SseDecoder,
} from "../../worker/codex/event-stream";

const encoder = new TextEncoder();

describe("Chat response event contract", () => {
	it("presents terminal-only message, reasoning, and tool output in JSON and SSE", async () => {
		const events = terminalOnlyEvents();
		const completion = chatCompletionFromEvents(events, "requested-model");

		expect(completion).toMatchObject({
			id: "chatcmpl-terminal",
			model: "resolved-model",
			choices: [
				{
					message: {
						content: "terminal answer",
						reasoning_content: "terminal reasoning",
						tool_calls: [
							{
								id: "call_terminal",
								function: {
									name: "lookup",
									arguments: '{"q":"worker"}',
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		});

		const stream = await renderChatStream(events);
		expect(stream).toContain('"reasoning_content":"terminal reasoning"');
		expect(stream).toContain('"content":"terminal answer"');
		expect(stream).toContain(
			'"index":0,"id":"call_terminal","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"worker\\"}"}',
		);
		expect(stream).toContain('"finish_reason":"tool_calls"');
		expect(stream).toContain("data: [DONE]");
	});

	it("rejects a truncated response instead of synthesizing success", async () => {
		const events = [
			createdEvent("resp_truncated"),
			{ type: "response.output_text.delta", delta: "partial" },
		];

		expect(() => chatCompletionFromEvents(events, "model")).toThrowError(
			expect.objectContaining({ code: "incomplete_codex_stream" }),
		);

		const stream = await renderChatStream(events, false);
		expect(stream).toContain('"content":"partial"');
		expect(stream).toContain('"code":"codex_stream_failed"');
		expect(stream).not.toContain('"finish_reason":"stop"');
		expect(stream).toContain("data: [DONE]");
	});

	it("rejects cumulative output beyond the Chat memory budget", () => {
		const state = createChatState("model");
		state.retainedChars = MAX_CHAT_RETAINED_CHARS;

		expect(() =>
			reduceCodexEvent(state, {
				type: "response.output_text.delta",
				delta: "x",
			}),
		).toThrowError(expect.objectContaining({ code: "codex_stream_failed" }));
	});

	it("bounds zero-argument tool calls independently of text output", () => {
		const state = createChatState("model");
		for (let index = 0; index < MAX_CHAT_TOOL_CALLS; index++) {
			reduceCodexEvent(state, {
				type: "response.output_item.added",
				output_index: index,
				item: {
					id: `item-${index}`,
					type: "function_call",
					call_id: `call-${index}`,
					name: "tool",
				},
			});
		}

		expect(() =>
			reduceCodexEvent(state, {
				type: "response.output_item.added",
				output_index: MAX_CHAT_TOOL_CALLS,
				item: {
					id: "item-over-limit",
					type: "function_call",
					call_id: "call-over-limit",
					name: "tool",
				},
			}),
		).toThrowError(expect.objectContaining({ code: "codex_stream_failed" }));
	});

	it("bounds alias churn for a single tool call", () => {
		const state = createChatState("model");
		const toolEvent = (suffix: number): Record<string, unknown> => ({
			type: "response.output_item.added",
			output_index: 0,
			item: {
				id: `item-${suffix}`,
				type: "function_call",
				call_id: `call-${suffix}`,
				name: "tool",
			},
		});
		reduceCodexEvent(state, toolEvent(0));
		const successfulRealiases = Math.floor(
			(MAX_CHAT_TOOL_ALIASES - 3) / 2,
		);
		for (let index = 1; index <= successfulRealiases; index++) {
			reduceCodexEvent(state, toolEvent(index));
		}

		expect(() =>
			reduceCodexEvent(state, toolEvent(successfulRealiases + 1)),
		).toThrowError(expect.objectContaining({ code: "codex_stream_failed" }));
	});

	it("maps an incomplete token limit to length and rejects failed terminals", () => {
		const incomplete = completedEvent("resp_incomplete", []);
		incomplete.type = "response.incomplete";
		incomplete.response = {
			...(incomplete.response as Record<string, unknown>),
			incomplete_details: { reason: "max_output_tokens" },
		};
		expect(
			chatCompletionFromEvents(
				[createdEvent("resp_incomplete"), incomplete],
				"model",
			),
		).toMatchObject({ choices: [{ finish_reason: "length" }] });

		const unspecified = completedEvent("resp_unspecified_incomplete", []);
		unspecified.type = "response.incomplete";
		expect(
			chatCompletionFromEvents(
				[createdEvent("resp_unspecified_incomplete"), unspecified],
				"model",
			),
		).toMatchObject({ choices: [{ finish_reason: "length" }] });

		const filtered = completedEvent("resp_filtered", []);
		filtered.type = "response.incomplete";
		filtered.response = {
			...(filtered.response as Record<string, unknown>),
			incomplete_details: { reason: "content_filter" },
		};
		expect(
			chatCompletionFromEvents(
				[createdEvent("resp_filtered"), filtered],
				"model",
			),
		).toMatchObject({ choices: [{ finish_reason: "content_filter" }] });

		const failed = completedEvent("resp_failed", []);
		failed.type = "response.failed";
		expect(() =>
			chatCompletionFromEvents([createdEvent("resp_failed"), failed], "model"),
		).toThrowError(expect.objectContaining({ code: "codex_stream_failed" }));
	});

	it("reuses one tool for item_id and call_id and emits Chat index zero", async () => {
		const events = [
			createdEvent("resp_alias"),
			{
				type: "response.output_item.added",
				output_index: 4,
				item: {
					id: "fc_alias",
					type: "function_call",
					call_id: "call_alias",
					name: "lookup",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				call_id: "call_alias",
				delta: '{"q":"one"}',
			},
			completedEvent("resp_alias", []),
		];

		const stream = await renderChatStream(events);
		expect(stream.match(/"name":"lookup"/g)).toHaveLength(1);
		expect(stream).toContain('"index":0,"id":"call_alias"');
		expect(stream).not.toContain('"index":4');
		expect(stream).toContain('"arguments":"{\\"q\\":\\"one\\"}"');
	});

	it("cancels the upstream stream after a terminal event", async () => {
		let upstreamCancelled = false;
		const events = terminalOnlyEvents();
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseText(events)));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		const ctx = createExecutionContext();
		const stream = createChatCompletionStream(
			upstream,
			{ model: "requested-model", includeUsage: false },
			ctx,
		);

		await new Response(stream).text();
		await waitOnExecutionContext(ctx);
		expect(upstreamCancelled).toBe(true);
	});

	it("propagates downstream cancellation to a pending upstream read", async () => {
		let upstreamCancelled = false;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseText([createdEvent("resp_open")])));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});
		const ctx = createExecutionContext();
		const stream = createChatCompletionStream(
			upstream,
			{ model: "requested-model", includeUsage: false },
			ctx,
		);
		const reader = stream.getReader();

		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			'"role":"assistant"',
		);
		await reader.cancel("client stopped reading");
		await waitOnExecutionContext(ctx);
		expect(upstreamCancelled).toBe(true);
	});
});

describe("SSE decoder contract", () => {
	it("decodes CRLF, multiline data, comments, and split UTF-8 code points", async () => {
		const source = [
			": keepalive\r\n\r\n",
			'data: {"type":"response.output_text.delta","delta":\r\n',
			'data: "你"}\r\n\r\n',
		].join("");
		const bytes = encoder.encode(source);
		const multibyteStart = bytes.indexOf(0xe4);
		const events = await collect(
			decodeSseStream(
				byteStream(
					bytes.slice(0, multibyteStart + 1),
					bytes.slice(multibyteStart + 1),
				),
			),
		);

		expect(events).toEqual([
			{ type: "response.output_text.delta", delta: "你" },
		]);
	});

	it("rejects malformed and oversized event payloads", async () => {
		await expect(
			collect(decodeSseStream(byteStream(encoder.encode("data: {bad}\n\n")))),
		).rejects.toMatchObject({ code: "codex_stream_failed" });

		expect(() => new SseDecoder().push("x".repeat(MAX_SSE_EVENT_CHARS + 1))).toThrowError(
			expect.objectContaining({ code: "codex_stream_failed" }),
		);
	});
});

async function renderChatStream(
	events: readonly Record<string, unknown>[],
	includeDone = true,
): Promise<string> {
	const suffix = includeDone ? "data: [DONE]\n\n" : "";
	const ctx = createExecutionContext();
	const stream = createChatCompletionStream(
		byteStream(encoder.encode(sseText(events) + suffix)),
		{ model: "requested-model", includeUsage: false },
		ctx,
	);
	const rendered = await new Response(stream).text();
	await waitOnExecutionContext(ctx);
	return rendered;
}

function sseText(events: readonly Record<string, unknown>[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function terminalOnlyEvents(): Record<string, unknown>[] {
	return [
		createdEvent("resp_terminal"),
		completedEvent("resp_terminal", [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "terminal reasoning" }],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "terminal answer" }],
			},
			{
				id: "fc_terminal",
				type: "function_call",
				call_id: "call_terminal",
				name: "lookup",
				arguments: '{"q":"worker"}',
			},
		]),
	];
}

function createdEvent(id: string): Record<string, unknown> {
	return {
		type: "response.created",
		response: { id, created_at: 1_754_006_400, model: "resolved-model" },
	};
}

function completedEvent(
	id: string,
	output: readonly Record<string, unknown>[],
): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id,
			created_at: 1_754_006_400,
			model: "resolved-model",
			output,
		},
	};
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const collected: T[] = [];
	for await (const value of values) collected.push(value);
	return collected;
}
