import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createGeminiStream } from "../../src/gemini/stream";

const encoder = new TextEncoder();

describe("Gemini streaming response", () => {
	it("streams text and tools as Gemini SSE data", async () => {
		const rendered = await render([
			{
				type: "response.created",
				response: { id: "resp_stream", model: "resolved-model" },
			},
			{ type: "response.output_text.delta", delta: "hello" },
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
					usage: { input_tokens: 8, output_tokens: 3 },
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "hello" }],
						},
						{
							id: "fc_1",
							type: "function_call",
							call_id: "call_1",
							name: "lookup_short",
							arguments: '{"q":"worker"}',
						},
					],
				},
			},
		], new Map([["lookup_short", "lookup_original"]]));

		expect(rendered).toContain('"text":"hello"');
		expect(rendered).toContain('"name":"lookup_original"');
		expect(rendered).toContain('"id":"call_1"');
		expect(rendered).toContain('"finishReason":"STOP"');
		expect(rendered).toContain('"promptTokenCount":8');
	});

	it("returns a named Gemini error event for a truncated stream", async () => {
		const rendered = await render([
			{
				type: "response.created",
				response: { id: "resp_truncated", model: "model" },
			},
			{ type: "response.output_text.delta", delta: "partial" },
		]);
		expect(rendered).toContain("event: error");
		expect(rendered).toContain('"status":"INTERNAL"');
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
					events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
				),
			);
			controller.close();
		},
	});
	const ctx = createExecutionContext();
	const stream = createGeminiStream(
		source,
		{ model: "requested-model", reverseToolNames },
		ctx,
	);
	const text = await new Response(stream).text();
	await waitOnExecutionContext(ctx);
	return text;
}
