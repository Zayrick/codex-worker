import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../worker/shared/json";
import { fetchMock } from "../support/fetch-mock";
import {
	authenticatedFetch,
	CREATED_AT,
	seedWorkerAuth,
} from "../support/worker-fixture";

const COMPLETED_RESPONSE = {
	id: "resp_completion",
	created_at: CREATED_AT,
	model: "gpt-5.6-luna",
	output: [
		{
			id: "msg_completion",
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "generated" }],
		},
	],
	usage: {
		input_tokens: 3,
		output_tokens: 2,
		total_tokens: 5,
	},
};

beforeAll(async () => {
	fetchMock.install();
	await seedWorkerAuth();
});

afterEach(() => {
	fetchMock.verify();
	vi.restoreAllMocks();
});

afterAll(() => {
	fetchMock.restore();
});

describe("legacy Completions compatibility", () => {
	it("converts a non-streaming completion through the Responses API", async () => {
		mockCompletionUpstream((body) => {
			expect(body.model).toBe("gpt-5.6-luna");
			expect(body.stream).toBe(true);
			expect(body.store).toBe(false);
			expect(body.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Prompt: " }],
				},
			]);
		});

		const response = await authenticatedFetch(
			"https://example.com/v1/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					prompt: "Prompt: ",
					echo: true,
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "cmpl-completion",
			object: "text_completion",
			created: CREATED_AT,
			model: "gpt-5.6-luna",
			choices: [
				{
					index: 0,
					text: "Prompt: generated",
					logprobs: null,
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 3,
				completion_tokens: 2,
				total_tokens: 5,
			},
		});
	});

	it("converts streaming Chat chunks into text_completion chunks", async () => {
		mockCompletionUpstream();
		const response = await authenticatedFetch(
			"https://example.com/v1/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					prompt: "Prompt: ",
					echo: true,
					stream: true,
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain('"object":"text_completion"');
		expect(body).toContain('"id":"cmpl-completion"');
		expect(body).toContain('"text":"Prompt: generated"');
		expect(body).toContain('"finish_reason":"stop"');
		expect(body).toContain("data: [DONE]");
		expect(body).not.toContain("chat.completion.chunk");
	});

	it("rejects multi-prompt requests with an OpenAI error envelope", async () => {
		const response = await authenticatedFetch(
			"https://example.com/v1/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					prompt: ["one", "two"],
				}),
			},
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_prompt", param: "prompt" },
		});
	});
});

function mockCompletionUpstream(
	assertBody?: (body: Record<string, unknown>) => void,
): void {
	fetchMock
		.intercept({
			origin: "https://codex-relay.test",
			path: "/backend-api/codex/responses",
			method: "POST",
		})
		.reply(async (call) => {
			const raw =
				typeof call.body === "string"
					? call.body
					: await new Response(call.body).text();
			const parsed: unknown = JSON.parse(raw);
			if (assertBody && isRecord(parsed)) assertBody(parsed);
			return {
				statusCode: 200,
				data: completionSse(),
				responseOptions: {
					headers: { "Content-Type": "text/event-stream" },
				},
			};
		});
}

function completionSse(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.created",
			response: {
				id: COMPLETED_RESPONSE.id,
				created_at: COMPLETED_RESPONSE.created_at,
				model: COMPLETED_RESPONSE.model,
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			item_id: "msg_completion",
			output_index: 0,
			content_index: 0,
			delta: "generated",
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 0,
			item: COMPLETED_RESPONSE.output[0],
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { ...COMPLETED_RESPONSE, output: [] },
		})}`,
		"data: [DONE]",
		"",
	].join("\n\n");
}
