import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMessagesStream } from "../../worker/messages/stream";

const encoder = new TextEncoder();
const SIGNATURE = `gAAAA${"B".repeat(120)}`;

describe("Anthropic Messages streaming response", () => {
	it("emits named SSE events in valid block order and defers text around a tool call", async () => {
		const events = [
			{
				type: "response.created",
				response: { id: "resp_stream", model: "resolved-model" },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "rs_1", type: "reasoning", summary: [] },
			},
			{ type: "response.reasoning_summary_text.delta", delta: "thinking" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					id: "rs_1",
					type: "reasoning",
					summary: [{ type: "summary_text", text: "thinking" }],
					encrypted_content: SIGNATURE,
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: {
					id: "fc_1",
					type: "function_call",
					call_id: "call_1",
					name: "lookup_short",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				delta: '{"q":',
			},
			{ type: "response.output_text.delta", delta: "answer" },
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				delta: '"worker"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					id: "fc_1",
					type: "function_call",
					call_id: "call_1",
					name: "lookup_short",
					arguments: '{"q":"worker"}',
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_stream",
					model: "resolved-model",
					usage: {
						input_tokens: 20,
						output_tokens: 7,
						input_tokens_details: { cached_tokens: 3 },
					},
					output: [
						{
							type: "reasoning",
							summary: [{ type: "summary_text", text: "thinking" }],
							encrypted_content: SIGNATURE,
						},
						{
							type: "function_call",
							call_id: "call_1",
							name: "lookup_short",
							arguments: '{"q":"worker"}',
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "answer" }],
						},
					],
				},
			},
		];

		const rendered = await render(events, new Map([["lookup_short", "lookup_original"]]));
		expect(rendered).toContain("event: message_start");
		expect(rendered).toContain('"type":"thinking_delta","thinking":"thinking"');
		expect(rendered).toContain(`"type":"signature_delta","signature":"${SIGNATURE}"`);
		expect(rendered).toContain('"type":"tool_use","id":"call_1","name":"lookup_original"');
		expect(rendered).toContain('"partial_json":"{\\"q\\":"');
		expect(rendered).toContain('"partial_json":"\\"worker\\"}"');
		expect(rendered).toContain('"type":"text_delta","text":"answer"');
		expect(rendered).toContain('"stop_reason":"tool_use"');
		expect(rendered).toContain('"input_tokens":17');
		expect(rendered).toContain('"cache_read_input_tokens":3');
		expect(rendered).toContain("event: message_stop");

		const thinkingStop = rendered.indexOf(
			'"type":"content_block_stop","index":0',
		);
		const toolStart = rendered.indexOf(
			'"type":"content_block_start","index":1',
		);
		const toolStop = rendered.indexOf(
			'"type":"content_block_stop","index":1',
		);
		const textStart = rendered.indexOf(
			'"type":"content_block_start","index":2',
		);
		expect(thinkingStop).toBeGreaterThan(0);
		expect(toolStart).toBeGreaterThan(thinkingStop);
		expect(toolStop).toBeGreaterThan(toolStart);
		expect(textStart).toBeGreaterThan(toolStop);
	});

	it("emits an Anthropic in-stream error for a truncated Codex stream", async () => {
		const rendered = await render([
			{
				type: "response.created",
				response: { id: "resp_truncated", model: "model" },
			},
			{ type: "response.output_text.delta", delta: "partial" },
		]);
		expect(rendered).toContain('event: error\ndata: {"type":"error"');
		expect(rendered).toContain('"type":"api_error"');
		expect(rendered).not.toContain("event: message_stop");
	});

	it("preserves terminal-only text and tool block order", async () => {
		const rendered = await render([
			{
				type: "response.completed",
				response: {
					id: "resp_terminal",
					model: "model",
					usage: { input_tokens: 5, output_tokens: 4 },
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "before" }],
						},
						{
							type: "function_call",
							call_id: "call_terminal",
							name: "lookup",
							arguments: '{"q":"worker"}',
						},
						{
							type: "message",
							content: [{ type: "output_text", text: "after" }],
						},
					],
				},
			},
		]);

		const before = rendered.indexOf('"type":"text_delta","text":"before"');
		const tool = rendered.indexOf('"type":"tool_use","id":"call_terminal"');
		const after = rendered.indexOf('"type":"text_delta","text":"after"');
		expect(before).toBeGreaterThan(0);
		expect(tool).toBeGreaterThan(before);
		expect(after).toBeGreaterThan(tool);
	});
});

async function render(
	events: readonly Record<string, unknown>[],
	reverseToolNames: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(
					events
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join(""),
				),
			);
			controller.close();
		},
	});
	const ctx = createExecutionContext();
	const stream = createMessagesStream(
		source,
		{ model: "requested-model", reverseToolNames },
		ctx,
	);
	const text = await new Response(stream).text();
	await waitOnExecutionContext(ctx);
	return text;
}
