import { zstdCompressSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../../src/http/body";
import { fetchMock } from "../support/fetch-mock";
import { authenticatedFetch, CREATED_AT, seedWorkerAuth, TEST_OAUTH } from "../support/worker-fixture";

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

describe("Codex upstream bridge", () => {
	it("uses only required auth headers and sends a sanitized request body", async () => {
		let outbound:
			| {
					headers: Headers;
					body: Record<string, unknown>;
			  }
			| undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
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

		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Version: "0.144.1",
				"X-Codex-Beta-Features": "beta-a",
				"X-Codex-Turn-Metadata": "turn-metadata",
				"X-Codex-Turn-State": "turn-state-in",
				"X-Request-Id": "request-id",
				"X-Client-Request-Id": "client-request-id",
				Session_id: "session-id",
				Conversation_id: "conversation-id",
				Originator: "client-originator",
				"User-Agent": "client-user-agent",
			},
			body: JSON.stringify({
				model: "gpt-5.6-lunar",
				input: "Verify the clean request.",
				custom_passthrough: { keep: true },
				max_completion_tokens: 32,
				max_output_tokens: 64,
				temperature: 0.5,
				top_p: 0.8,
				truncation: "auto",
				user: "user-1",
				context_management: { type: "compaction" },
				previous_response_id: "resp_previous",
				generate: true,
				prompt_cache_key: "cache-key",
				prompt_cache_retention: "24h",
				safety_identifier: "safety-id",
				stream_options: { include_usage: true },
				session_id: "body-session",
				conversation_id: "body-conversation",
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.has("x-request-id")).toBe(false);

		expect(outbound).toBeDefined();
		expect(outbound!.headers.get("authorization")).toBe(`Bearer ${TEST_OAUTH.accessToken}`);
		expect(outbound!.headers.get("chatgpt-account-id")).toBe(TEST_OAUTH.accountId);
		expect(outbound!.headers.get("accept")).toBe("text/event-stream");
		expect(outbound!.headers.get("content-type")).toBe("application/json");
		expect(outbound!.headers.get("version")).toBe("0.144.1");
		expect(outbound!.headers.get("x-codex-beta-features")).toBe("beta-a");
		expect(outbound!.headers.get("x-codex-turn-metadata")).toBe("turn-metadata");
		expect(outbound!.headers.get("x-codex-turn-state")).toBe("turn-state-in");
		expect(outbound!.headers.get("session-id")).toBe("cache-key");
		for (const name of ["originator", "user-agent", "session_id", "conversation_id", "x-request-id", "x-client-request-id"]) {
			expect(outbound!.headers.has(name), name).toBe(false);
		}

		expect(outbound!.body.model).toBe("gpt-5.6-lunar");
		expect(outbound!.body.stream).toBe(true);
		expect(outbound!.body.store).toBe(false);
		expect(outbound!.body).not.toHaveProperty("parallel_tool_calls");
		expect(outbound!.body.reasoning).toEqual({ effort: "medium" });
		expect(outbound!.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(outbound!.body.instructions).toBe("");
		expect(outbound!.body.custom_passthrough).toEqual({ keep: true });
		expect(outbound!.body.prompt_cache_key).toBe("cache-key");
		for (const name of [
			"max_completion_tokens",
			"max_output_tokens",
			"temperature",
			"top_p",
			"truncation",
			"user",
			"context_management",
			"previous_response_id",
			"generate",
			"prompt_cache_retention",
			"safety_identifier",
			"stream_options",
			"session_id",
			"conversation_id",
		]) {
			expect(outbound!.body, name).not.toHaveProperty(name);
		}
	});

	it("preserves parallel tool calls for Responses Lite requests", async () => {
		let outboundBody: Record<string, unknown> | undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply((options) => {
				outboundBody = JSON.parse(String(options.body)) as Record<string, unknown>;
				return {
					statusCode: 200,
					data: sseResponse(),
					responseOptions: {
						headers: { "Content-Type": "text/event-stream" },
					},
				};
			});

		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-OpenAI-Internal-Codex-Responses-Lite": "true",
			},
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				input: "hello",
				parallel_tool_calls: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(outboundBody?.parallel_tool_calls).toBe(true);
	});

	it("proxies Codex remote compaction as a unary JSON request", async () => {
		let outbound:
			| {
					headers: Headers;
					body: Record<string, unknown>;
			  }
			| undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses/compact",
				method: "POST",
			})
			.reply((options) => {
				outbound = {
					headers: new Headers(options.headers as HeadersInit),
					body: JSON.parse(String(options.body)) as Record<string, unknown>,
				};
				return {
					statusCode: 200,
					data: JSON.stringify({
						output: [
							{
								type: "compaction",
								encrypted_content: "encrypted-summary",
							},
						],
					}),
					responseOptions: {
						headers: {
							"Content-Type": "application/json",
							"X-Codex-Turn-State": "compact-turn-state-out",
						},
					},
				};
			});

		const response = await authenticatedFetch("https://example.com/v1/responses/compact", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codex-Turn-State": "compact-turn-state-in",
			},
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				input: [
					{
						type: "message",
						role: "system",
						content: [{ type: "input_text", text: "history" }],
					},
				],
				instructions: "retain decisions",
				parallel_tool_calls: true,
				reasoning: { effort: "medium", summary: "auto" },
				service_tier: "priority",
				prompt_cache_key: "compact-cache-key",
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-codex-turn-state")).toBe("compact-turn-state-out");
		expect(await response.json()).toEqual({
			output: [
				{
					type: "compaction",
					encrypted_content: "encrypted-summary",
				},
			],
		});
		expect(outbound).toBeDefined();
		expect(outbound!.headers.get("accept")).toBe("application/json");
		expect(outbound!.headers.get("session-id")).toBe("compact-cache-key");
		expect(outbound!.headers.get("x-codex-turn-state")).toBe("compact-turn-state-in");
		expect(outbound!.body).toEqual({
			model: "gpt-5.6-luna",
			input: [
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "history" }],
				},
			],
			instructions: "retain decisions",
			parallel_tool_calls: true,
			reasoning: { effort: "medium", summary: "auto" },
			service_tier: "priority",
			prompt_cache_key: "compact-cache-key",
		});
	});

	it("forwards Responses SSE without collecting when stream is omitted", async () => {
		const upstreamSse = sseResponse();
		mockCodex(upstreamSse);
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				input: "Reply exactly: codex-worker verified",
				reasoning: { effort: "low" },
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toBe(upstreamSse);
	});

	it("accepts the zstd request bodies emitted by Codex", async () => {
		const upstreamSse = sseResponse();
		mockCodex(upstreamSse);
		const body = zstdCompressSync(
			Buffer.from(
				JSON.stringify({
					model: "gpt-5.6-luna",
					input: "compressed Codex request",
					prompt_cache_key: "compressed-cache-key",
				}),
			),
		);
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "zstd",
			},
			body,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(upstreamSse);
	});

	it("accepts transparently decompressed JSON that retains the zstd header", async () => {
		const upstreamSse = sseResponse();
		mockCodex(upstreamSse);
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "zstd",
			},
			body: JSON.stringify({ model: "gpt-5.6-luna", input: "plain JSON" }),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(upstreamSse);
	});

	it("returns 413 before reading a body whose declared size exceeds the limit", async () => {
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(MAX_JSON_BODY_BYTES + 1),
			},
			body: "{}",
		});

		expect(response.status).toBe(413);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.json()).toMatchObject({
			error: { code: "request_too_large", type: "invalid_request_error" },
		});
	});

	it("returns 413 when zstd output exceeds the decoded JSON limit", async () => {
		const oversized = zstdCompressSync(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x20));
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "zstd",
			},
			body: oversized,
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			error: { code: "request_too_large" },
		});
	});

	it("returns invalid_json for a damaged zstd body", async () => {
		const response = await authenticatedFetch("https://example.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "zstd",
			},
			body: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_json" },
		});
	});

	it("returns a non-streaming Chat Completions response", async () => {
		mockCodex(sseResponse());
		const response = await authenticatedFetch("https://example.com/v1/chat/completions", {
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
		});
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
		const response = await authenticatedFetch("https://example.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				reasoning_effort: "low",
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "Verify the bridge." }],
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const stream = await response.text();
		expect(stream).toContain('"role":"assistant"');
		expect(stream).toContain('"content":"codex-worker verified"');
		expect(stream).toContain('"finish_reason":"stop"');
		expect(stream).toContain('"prompt_tokens":12');
		expect(stream).toContain("data: [DONE]");
	});

	it("streams custom tool input through Chat-compatible tool call deltas", async () => {
		mockCodex(customToolSseResponse());
		const response = await authenticatedFetch("https://example.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				stream: true,
				messages: [{ role: "user", content: "Patch the file." }],
				tools: [
					{
						type: "custom",
						name: "apply_patch",
						format: { type: "text" },
					},
				],
			}),
		});

		expect(response.status).toBe(200);
		const stream = await response.text();
		expect(stream).toContain('"name":"apply_patch"');
		expect(stream).toContain('"arguments":"*** Begin Patch\\n"');
		expect(stream).toContain('"arguments":"*** End Patch"');
		expect(stream).toContain('"finish_reason":"tool_calls"');
		expect(stream).toContain("data: [DONE]");
	});

	it.each([
		{
			name: "models",
			upstreamPath: "/backend-api/codex/models?client_version=0.144.1",
			upstreamMethod: "GET",
			requestUrl: "https://example.com/v1/models",
			requestInit: undefined,
			status: 404,
		},
		{
			name: "Responses",
			upstreamPath: "/backend-api/codex/responses",
			upstreamMethod: "POST",
			requestUrl: "https://example.com/v1/responses",
			requestInit: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.6-luna", input: "test" }),
			},
			status: 401,
		},
		{
			name: "remote compaction",
			upstreamPath: "/backend-api/codex/responses/compact",
			upstreamMethod: "POST",
			requestUrl: "https://example.com/v1/responses/compact",
			requestInit: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					input: [],
				}),
			},
			status: 422,
		},
		{
			name: "Chat Completions",
			upstreamPath: "/backend-api/codex/responses",
			upstreamMethod: "POST",
			requestUrl: "https://example.com/v1/chat/completions",
			requestInit: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					messages: [{ role: "user", content: "test" }],
				}),
			},
			status: 429,
		},
	])("preserves $name upstream error bodies with safe headers", async (testCase) => {
		const upstreamBody = JSON.stringify({
			error: {
				message: `${testCase.name} upstream failure`,
				upstream_only: true,
			},
		});
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: testCase.upstreamPath,
				method: testCase.upstreamMethod,
			})
			.reply(testCase.status, upstreamBody, {
				headers: {
					"Content-Type": "application/problem+json",
					"Retry-After": "5",
					"X-Request-Id": "upstream-request-id",
					"X-Upstream-Error": "drop-me",
					"Set-Cookie": "session=drop-me; Secure; HttpOnly",
				},
			});

		const response = await authenticatedFetch(testCase.requestUrl, testCase.requestInit);
		expect(response.status).toBe(testCase.status);
		expect(response.headers.get("content-type")).toContain("application/problem+json");
		expect(response.headers.get("retry-after")).toBe("5");
		expect(response.headers.get("x-request-id")).toBe("upstream-request-id");
		expect(response.headers.has("x-upstream-error")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.text()).toBe(upstreamBody);
	});
});

function mockCodex(body: string, status = 200, contentType = "text/event-stream"): void {
	fetchMock
		.intercept({
			origin: "https://codex-relay.test",
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

function customToolSseResponse(): string {
	return [
		`data: ${JSON.stringify({
			type: "response.created",
			response: {
				id: "resp_custom_stream",
				created_at: CREATED_AT,
				model: "gpt-5.6-luna",
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: {
				id: "ct_stream",
				type: "custom_tool_call",
				call_id: "call_stream",
				name: "apply_patch",
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.custom_tool_call_input.delta",
			item_id: "ct_stream",
			output_index: 0,
			delta: "*** Begin Patch\n",
		})}`,
		`data: ${JSON.stringify({
			type: "response.custom_tool_call_input.delta",
			item_id: "ct_stream",
			output_index: 0,
			delta: "*** End Patch",
		})}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				id: "ct_stream",
				type: "custom_tool_call",
				call_id: "call_stream",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_custom_stream",
				created_at: CREATED_AT,
				model: "gpt-5.6-luna",
				output: [],
			},
		})}`,
		"data: [DONE]",
		"",
	].join("\n\n");
}
