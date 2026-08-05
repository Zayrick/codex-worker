import { zstdCompressSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
	it("rewrites Responses system messages without changing other fields", async () => {
		let outbound:
			| {
					headers: Headers;
					body: string;
			  }
			| undefined;
		const requestPayload = {
			model: "gpt-5.6-lunar",
			input: [
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "system prompt" }],
				},
				{
					type: "function_call_output",
					call_id: "call_previous",
					output: "tool result",
				},
			],
			previous_response_id: "resp_previous",
			store: true,
			stream: false,
			tools: [{ type: "function", name: "lookup" }],
			parallel_tool_calls: true,
			include: ["file_search_call.results"],
			service_tier: "flex",
			max_completion_tokens: 1,
			max_output_tokens: 2,
			maxOutputTokens: 3,
			max_tokens: 4,
			context_management: [
				{ type: "compaction", compact_threshold: 12_000 },
			],
			unknown_extension: { keep: true },
		};
		const requestBody = JSON.stringify(requestPayload, null, 2);
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply(async (options) => {
				outbound = {
					headers: new Headers(options.headers as HeadersInit),
					body: await new Response(options.body).text(),
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
				Accept: "application/vnd.openai.responses+json",
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
			body: requestBody,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await response.text()).toBe(sseResponse());
		expect(response.headers.has("x-request-id")).toBe(false);

		expect(outbound).toBeDefined();
		expect(outbound!.headers.get("authorization")).toBe(`Bearer ${TEST_OAUTH.accessToken}`);
		expect(outbound!.headers.get("chatgpt-account-id")).toBe(TEST_OAUTH.accountId);
		expect(outbound!.headers.get("accept")).toBe(
			"application/vnd.openai.responses+json",
		);
		expect(outbound!.headers.get("content-type")).toBe("application/json");
		expect(outbound!.headers.get("version")).toBe("0.144.1");
		expect(outbound!.headers.get("x-codex-beta-features")).toBe("beta-a");
		expect(outbound!.headers.get("x-codex-turn-metadata")).toBe("turn-metadata");
		expect(outbound!.headers.get("x-codex-turn-state")).toBe("turn-state-in");
		expect(outbound!.headers.get("session_id")).toBe("session-id");
		expect(outbound!.headers.get("conversation_id")).toBe("conversation-id");
		expect(outbound!.headers.get("x-request-id")).toBe("request-id");
		expect(outbound!.headers.get("x-client-request-id")).toBe(
			"client-request-id",
		);
		expect(outbound!.headers.get("originator")).toBe("client-originator");
		expect(outbound!.headers.get("user-agent")).toBe(
			"codex_cli_rs/0.144.1",
		);
		expect(outbound!.headers.has("session-id")).toBe(false);
		const expectedPayload: Record<string, unknown> = { ...requestPayload };
		for (const field of [
			"max_completion_tokens",
			"max_output_tokens",
			"maxOutputTokens",
			"max_tokens",
			"context_management",
		]) {
			delete expectedPayload[field];
		}
		expect(JSON.parse(outbound!.body)).toEqual({
			...expectedPayload,
			store: false,
			input: [
				{ ...requestPayload.input[0], role: "developer" },
				requestPayload.input[1],
			],
		});
	});

	it("rewrites compact system messages without changing other fields", async () => {
		let outbound:
			| {
					headers: Headers;
					body: string;
			  }
			| undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses/compact",
				method: "POST",
			})
			.reply(async (options) => {
				outbound = {
					headers: new Headers(options.headers as HeadersInit),
					body: await new Response(options.body).text(),
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

		const requestPayload = {
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
			unknown_extension: { keep: true },
		};
		const requestBody = JSON.stringify(requestPayload);
		const response = await authenticatedFetch("https://example.com/v1/responses/compact", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Codex-Turn-State": "compact-turn-state-in",
			},
			body: requestBody,
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
		expect(outbound!.headers.has("session-id")).toBe(false);
		expect(outbound!.headers.get("x-codex-turn-state")).toBe("compact-turn-state-in");
		expect(JSON.parse(outbound!.body)).toEqual({
			...requestPayload,
			input: [{ ...requestPayload.input[0], role: "developer" }],
		});
	});

	it("forwards already non-storing zstd request bodies without decoding them", async () => {
		const upstreamSse = sseResponse();
		let outboundBody: Uint8Array | undefined;
		let outboundHeaders: Headers | undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply(async (call) => {
				outboundHeaders = new Headers(call.headers as HeadersInit);
				outboundBody = new Uint8Array(
					await new Response(call.body).arrayBuffer(),
				);
				return {
					statusCode: 200,
					data: upstreamSse,
					responseOptions: {
						headers: { "Content-Type": "text/event-stream" },
					},
				};
			});
		const body = zstdCompressSync(
			Buffer.from(
				JSON.stringify({
					model: "gpt-5.6-luna",
					input: "compressed Codex request",
					store: false,
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
		expect(outboundHeaders?.get("content-encoding")).toBe("zstd");
		expect(outboundBody).toEqual(new Uint8Array(body));
	});

	it("returns a non-streaming Chat Completions response", async () => {
		mockCodex(sseResponse(), (body) => {
			expect(body).toMatchObject({
				instructions: "",
				store: false,
				stream: true,
				include: ["reasoning.encrypted_content"],
			});
		});
		const response = await authenticatedFetch("https://example.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-lunar",
				store: true,
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
			transparent: false,
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
			transparent: true,
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
			transparent: true,
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
			transparent: false,
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
		if (testCase.transparent) {
			expect(response.headers.get("x-upstream-error")).toBe("drop-me");
		} else {
			expect(response.headers.has("x-upstream-error")).toBe(false);
		}
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.text()).toBe(upstreamBody);
	});
});

function mockCodex(
	body: string,
	inspectRequest?: (body: unknown) => void,
): void {
	fetchMock
		.intercept({
			origin: "https://codex-relay.test",
			path: "/backend-api/codex/responses",
			method: "POST",
		})
		.reply(async (call) => {
			if (inspectRequest) {
				inspectRequest(
					JSON.parse(await new Response(call.body).text()),
				);
			}
			return {
				statusCode: 200,
				data: body,
				responseOptions: {
					headers: { "Content-Type": "text/event-stream" },
				},
			};
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
