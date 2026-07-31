import {
	createExecutionContext,
	env,
	fetchMock,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatRequestToResponses } from "../src/chat";
import worker from "../src/index";
import type { WorkerEnv } from "../src/types";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const CREATED_AT = 1_754_006_400;
const COMPLETED_RESPONSE = {
	id: "resp_test",
	object: "response",
	created_at: CREATED_AT,
	status: "completed",
	model: "gpt-5.6-luna",
	output: [
		{
			id: "msg_test",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [
				{
					type: "output_text",
					text: "codex-worker verified",
					annotations: [],
				},
			],
		},
	],
	usage: {
		input_tokens: 12,
		output_tokens: 3,
		total_tokens: 15,
		input_tokens_details: { cached_tokens: 2 },
		output_tokens_details: { reasoning_tokens: 1 },
	},
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
	fetchMock.deactivate();
});

describe("routing and model compatibility", () => {
	it("reports health without exposing credentials", async () => {
		const response = await SELF.fetch("https://example.com/healthz");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			codex_auth_configured: true,
			token_refresh: false,
		});
	});

	it("lists GPT-5.6 Luna and resolves the lunar alias", async () => {
		const list = await SELF.fetch("https://example.com/v1/models");
		const payload = (await list.json()) as {
			data: Array<{ id: string }>;
		};
		expect(payload.data.map((model) => model.id)).toContain("gpt-5.6-luna");

		const model = await SELF.fetch(
			"https://example.com/v1/models/gpt-5.6-lunar",
		);
		expect(model.status).toBe(200);
		expect(await model.json()).toMatchObject({
			id: "gpt-5.6-luna",
			object: "model",
		});
	});

	it("enforces an optional downstream proxy API key", async () => {
		const request = new IncomingRequest("https://example.com/v1/models");
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...(env as WorkerEnv), PROXY_API_KEY: "proxy-secret" },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_api_key" },
		});
	});
});

describe("request adaptation", () => {
	it("maps Chat Completions messages, tools, Luna alias, and low reasoning", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-lunar",
			reasoning_effort: "low",
			messages: [
				{ role: "system", content: "Answer precisely." },
				{ role: "user", content: "What is the weather?" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: {
								name: "weather",
								arguments: '{"city":"Shanghai"}',
							},
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sunny" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						description: "Get weather",
						parameters: {
							type: "object",
							properties: { city: { type: "string" } },
						},
					},
				},
			],
		});

		expect(adapted.model).toBe("gpt-5.6-luna");
		expect(adapted.body).toMatchObject({
			model: "gpt-5.6-luna",
			instructions: "Answer precisely.",
			reasoning: { effort: "low", summary: "auto" },
			store: false,
			stream: true,
		});
		expect(adapted.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function_call", call_id: "call_1" }),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call_1",
				}),
			]),
		);
	});
});

describe("Codex upstream bridge", () => {
	it("uses the relay and forwards required Codex metadata", async () => {
		let outbound:
			| {
					headers: Headers;
					body: Record<string, unknown>;
			  }
			| undefined;
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply((options) => {
				outbound = {
					headers: new Headers(options.headers as HeadersInit),
					body: JSON.parse(String(options.body)) as Record<string, unknown>,
				};
				return {
					statusCode: 200,
					data: sseResponse(),
					responseOptions: {
						headers: { "Content-Type": "text/event-stream" },
					},
				};
			});

		const response = await SELF.fetch(
			"https://example.com/v1/chat/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-lunar",
					reasoning_effort: "low",
					max_completion_tokens: 32,
					messages: [{ role: "user", content: "Verify the headers." }],
				}),
			},
		);
		expect(response.status).toBe(200);

		const configuredAuth = JSON.parse(
			(env as WorkerEnv).CODEX_AUTH_JSON,
		) as {
			tokens: { access_token: string; account_id: string };
		};
		expect(outbound).toBeDefined();
		expect(outbound!.headers.get("authorization")).toBe(
			`Bearer ${configuredAuth.tokens.access_token}`,
		);
		expect(outbound!.headers.get("chatgpt-account-id")).toBe(
			configuredAuth.tokens.account_id,
		);
		expect(outbound!.headers.get("accept")).toBe("text/event-stream");
		expect(outbound!.headers.get("content-type")).toBe("application/json");
		expect(outbound!.headers.get("originator")).toBe("codex-worker");
		expect(outbound!.headers.get("user-agent")).toBe("codex-worker/0.1.0");

		const sessionId = outbound!.headers.get("session_id");
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(outbound!.headers.get("conversation_id")).toBe(sessionId);
		expect(outbound!.body.prompt_cache_key).toBe(sessionId);
		expect(outbound!.body.model).toBe("gpt-5.6-luna");
		expect(outbound!.body.stream).toBe(true);
		expect(outbound!.body.store).toBe(false);
		expect(outbound!.body).not.toHaveProperty("max_output_tokens");
	});

	it("returns a non-streaming Responses API object", async () => {
		mockCodex(sseResponse());
		const response = await SELF.fetch("https://example.com/v1/responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				input: "Reply exactly: codex-worker verified",
				reasoning: { effort: "low" },
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(COMPLETED_RESPONSE);
	});

	it("returns a non-streaming Chat Completions response", async () => {
		mockCodex(sseResponse());
		const response = await SELF.fetch(
			"https://example.com/v1/chat/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-lunar",
					reasoning_effort: "low",
					messages: [
						{
							role: "user",
							content: "Reply exactly: codex-worker verified",
						},
					],
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "chatcmpl-test",
			object: "chat.completion",
			created: CREATED_AT,
			model: "gpt-5.6-luna",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: "codex-worker verified",
						refusal: null,
					},
					logprobs: null,
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 12,
				completion_tokens: 3,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 2 },
				completion_tokens_details: { reasoning_tokens: 1 },
			},
		});
	});

	it("converts Codex SSE into Chat Completions chunks and usage", async () => {
		mockCodex(sseResponse());
		const response = await SELF.fetch(
			"https://example.com/v1/chat/completions",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					reasoning_effort: "low",
					stream: true,
					stream_options: { include_usage: true },
					messages: [{ role: "user", content: "Verify the bridge." }],
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const stream = await response.text();
		expect(stream).toContain('"role":"assistant"');
		expect(stream).toContain('"content":"codex-worker verified"');
		expect(stream).toContain('"finish_reason":"stop"');
		expect(stream).toContain('"prompt_tokens":12');
		expect(stream).toContain("data: [DONE]");
	});

	it("does not refresh tokens after an upstream 401", async () => {
		mockCodex(
			JSON.stringify({ error: { message: "Unauthorized" } }),
			401,
			"application/json",
		);
		const response = await SELF.fetch("https://example.com/v1/responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				input: "test",
			}),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: {
				type: "upstream_authentication_error",
				code: "codex_auth_rejected",
			},
		});
	});
});

function mockCodex(
	body: string,
	status = 200,
	contentType = "text/event-stream",
): void {
	fetchMock
		.get("https://codex-relay.test")
		.intercept({
			path: "/backend-api/codex/responses",
			method: "POST",
		})
		.reply(status, body, {
			headers: { "Content-Type": contentType },
		});
}

function sseResponse(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.created",
			response: {
				id: COMPLETED_RESPONSE.id,
				created_at: CREATED_AT,
				model: COMPLETED_RESPONSE.model,
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_text.delta",
			item_id: "msg_test",
			output_index: 0,
			content_index: 0,
			delta: "codex-worker verified",
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
