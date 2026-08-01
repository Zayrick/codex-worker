import { zstdCompressSync } from "node:zlib";
import {
	createExecutionContext,
	env,
	fetchMock,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { storeOAuthCredentials } from "../src/auth";
import {
	chatCompletionFromEvents,
	chatRequestToResponses,
} from "../src/chat";
import {
	prepareCompactRequest,
	prepareResponsesRequest,
} from "../src/codex";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const CREATED_AT = 1_754_006_400;
const TEST_API_KEY = "sk-test-api-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_ACCESS_TOKEN = [
	"e30",
	Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
	"test-signature",
].join(".");
const TEST_OAUTH = {
	version: 1 as const,
	accessToken: TEST_ACCESS_TOKEN,
	refreshToken: "test-refresh-token",
	accountId: "account-test",
	expiresAt: 4_102_444_800_000,
	updatedAt: "2026-07-31T00:00:00.000Z",
};
const CODEX_MODELS = {
	models: [
		{
			slug: "gpt-5.6-luna",
			display_name: "GPT-5.6 Luna",
			context_window: 400_000,
			default_reasoning_level: "medium",
		},
	],
};
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
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await env.AUTH_KV.put("API-test-client", TEST_API_KEY);
	await storeOAuthCredentials(env, TEST_OAUTH);
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
		expect(response.headers.has("x-request-id")).toBe(false);
		expect(response.headers.has("access-control-expose-headers")).toBe(false);
		expect(await response.json()).toEqual({
			status: "ok",
			oauth_configured: true,
			token_refresh: true,
		});
	});

	it("forwards the upstream Codex model catalog without a local model list", async () => {
		let outboundHeaders: Headers | undefined;
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
				path: "/backend-api/codex/models?client_version=0.200.0&channel=stable",
				method: "GET",
			})
			.reply((options) => {
				outboundHeaders = new Headers(options.headers as HeadersInit);
				return {
					statusCode: 200,
					data: JSON.stringify(CODEX_MODELS),
					responseOptions: {
						headers: {
							"Content-Type": "application/json",
							"X-Request-Id": "upstream-request-id",
							"Set-Cookie": "session=secret",
						},
					},
				};
			});

		const response = await authenticatedFetch(
			"https://example.com/v1/models?client_version=0.200.0&channel=stable&session_id=drop-me&api_key=drop-me",
			{
				headers: {
					Version: "0.144.1",
					"X-Codex-Beta-Features": "beta-a",
					"X-Codex-Turn-Metadata": "turn-metadata",
					"X-Request-Id": "client-request-id",
					"X-Client-Request-Id": "client-codex-request-id",
					Session_id: "client-session",
					Conversation_id: "client-conversation",
					Originator: "client-originator",
					"User-Agent": "client-user-agent",
					"X-Forwarded-For": "203.0.113.10",
				},
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(CODEX_MODELS);
		expect(response.headers.has("x-request-id")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);

		expect(outboundHeaders?.get("authorization")).toBe(
			`Bearer ${TEST_OAUTH.accessToken}`,
		);
		expect(outboundHeaders?.get("chatgpt-account-id")).toBe(
			TEST_OAUTH.accountId,
		);
		expect(outboundHeaders?.get("accept")).toBe("application/json");
		expect(outboundHeaders?.get("version")).toBe("0.144.1");
		expect(outboundHeaders?.get("x-codex-beta-features")).toBe("beta-a");
		expect(outboundHeaders?.get("x-codex-turn-metadata")).toBe(
			"turn-metadata",
		);
		for (const name of [
			"x-request-id",
			"x-client-request-id",
			"session_id",
			"conversation_id",
			"originator",
			"user-agent",
			"x-forwarded-for",
		]) {
			expect(outboundHeaders?.has(name), name).toBe(false);
		}
	});

	it("does not emulate the removed single-model catalog route", async () => {
		const response = await authenticatedFetch(
			"https://example.com/v1/models/gpt-5.6-lunar",
		);
		expect(response.status).toBe(404);
	});

	it("adds the required Codex client_version when the client omits it", async () => {
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
				path: "/backend-api/codex/models?client_version=0.144.1",
				method: "GET",
			})
			.reply(200, JSON.stringify(CODEX_MODELS), {
				headers: { "Content-Type": "application/json" },
			});

		const response = await authenticatedFetch("https://example.com/v1/models");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [{ id: "gpt-5.6-luna", object: "model" }],
		});
	});

	it("requires a downstream KV API key", async () => {
		const request = new IncomingRequest("https://example.com/v1/models");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_api_key" },
		});
	});
});

describe("request adaptation", () => {
	it("keeps Responses fields by default and removes only Codex-incompatible metadata", () => {
		const body = prepareResponsesRequest({
			model: "gpt-5.6-lunar",
			instructions: null,
			input: [
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "Client instruction" }],
				},
			],
			reasoning: {
				effort: "future-responses-level",
				summary: "detailed",
			},
			custom_passthrough: { keep: true },
			include: ["file_search_call.results"],
			store: true,
			stream: false,
			parallel_tool_calls: false,
			max_output_tokens: 1,
			max_completion_tokens: 2,
			max_tokens: 3,
			temperature: 0.2,
			top_p: 0.8,
			top_k: 20,
			truncation: "auto",
			user: "user-1",
			context_management: { type: "compaction" },
			previous_response_id: "resp_previous",
			generate: true,
			prompt_cache_key: "cache-key",
			prompt_cache_retention: "24h",
			safety_identifier: "safe-id",
			stream_options: { include_usage: true },
			Session_id: "session-id",
			sessionId: "camel-session-id",
			Conversation_id: "conversation-id",
			conversationId: "camel-conversation-id",
			request_id: "request-id",
			"X-Request-Id": "header-shaped-body-request-id",
			user_agent: "body-user-agent",
			originator: "body-originator",
			service_tier: "flex",
			tools: [{ type: "web_search_preview" }],
			tool_choice: { type: "web_search_preview_2025_03_11" },
		});

		expect(body).toMatchObject({
			model: "gpt-5.6-lunar",
			instructions: "",
			reasoning: {
				effort: "future-responses-level",
				summary: "detailed",
			},
			custom_passthrough: { keep: true },
			prompt_cache_key: "cache-key",
			store: false,
			stream: true,
			parallel_tool_calls: true,
			include: ["reasoning.encrypted_content"],
			tools: [{ type: "web_search" }],
			tool_choice: { type: "web_search" },
		});
		expect(body.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Client instruction" }],
			},
		]);
		for (const name of [
			"max_output_tokens",
			"max_completion_tokens",
			"max_tokens",
			"temperature",
			"top_p",
			"top_k",
			"truncation",
			"user",
			"context_management",
			"previous_response_id",
			"generate",
			"prompt_cache_retention",
			"safety_identifier",
			"stream_options",
			"Session_id",
			"sessionId",
			"Conversation_id",
			"conversationId",
			"request_id",
			"X-Request-Id",
			"user_agent",
			"originator",
			"service_tier",
		]) {
			expect(body, name).not.toHaveProperty(name);
		}
	});

	it("preserves client instructions and priority service tier", () => {
		const body = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			instructions: "Only the client's instruction.",
			input: "hello",
			service_tier: "priority",
		});
		expect(body.instructions).toBe(
			"Only the client's instruction.",
		);
		expect(body.service_tier).toBe("priority");
	});

	it("maps Chat Completions without aliases or invented optional values", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-lunar",
			reasoning_effort: "low",
			max_completion_tokens: 32,
			temperature: 0.7,
			top_p: 0.9,
			service_tier: "flex",
			messages: [
				{ role: "system", content: "Answer precisely." },
				{
					role: "user",
					content: [
						{ type: "text", text: "What is the weather?" },
						{
							type: "image_url",
							image_url: { url: "https://example.com/weather.png" },
						},
					],
				},
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
					},
				},
			],
			response_format: {
				type: "json_schema",
				json_schema: { name: "weather" },
			},
		});

		expect(adapted.model).toBe("gpt-5.6-lunar");
		expect(adapted.body).toMatchObject({
			model: "gpt-5.6-lunar",
			instructions: "",
			reasoning: { effort: "low" },
			store: false,
			stream: true,
			parallel_tool_calls: true,
			include: ["reasoning.encrypted_content"],
		});
		expect(adapted.body).not.toHaveProperty("tool_choice");
		expect(adapted.body).not.toHaveProperty("service_tier");
		expect(adapted.body).not.toHaveProperty("max_completion_tokens");
		expect(adapted.body).not.toHaveProperty("temperature");
		expect(adapted.body).not.toHaveProperty("top_p");
		expect(adapted.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					role: "developer",
				}),
				expect.objectContaining({ type: "function_call", call_id: "call_1" }),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call_1",
				}),
			]),
		);
		const tools = adapted.body.tools as Array<Record<string, unknown>>;
		expect(tools).toEqual([
			{
				type: "function",
				name: "weather",
				description: "Get weather",
			},
		]);
		const inputItems = adapted.body.input as Array<Record<string, unknown>>;
		const userMessage = inputItems.find((item) => item.role === "user");
		const image = (
			userMessage?.content as Array<Record<string, unknown>>
		).find((part) => part.type === "input_image");
		expect(image).toEqual({
			type: "input_image",
			image_url: "https://example.com/weather.png",
		});
		expect(adapted.body.text).toEqual({
			format: { type: "json_schema", name: "weather" },
		});
	});

	it("does not invent an empty user message", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-luna",
			messages: [],
		});
		expect(adapted.body.input).toEqual([]);
		expect(adapted.body).not.toHaveProperty("reasoning");
	});

	it.each(["minimal", "future-reasoning-level"])(
		"forwards reasoning_effort %s without a local enum restriction",
		(reasoningEffort) => {
			const adapted = chatRequestToResponses({
				model: "gpt-5.6-luna",
				messages: [{ role: "user", content: "hello" }],
				reasoning_effort: reasoningEffort,
			});
			expect(adapted.body.reasoning).toEqual({ effort: reasoningEffort });
		},
	);

	it("maps custom and built-in tools plus file, audio, and structured tool output", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-luna",
			prompt_cache_key: "thread-cache-key",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "file",
							file: {
								file_data: "data:application/pdf;base64,UEZERg==",
								filename: "brief.pdf",
							},
						},
						{
							type: "input_audio",
							input_audio: { data: "UklGRg==", format: "wav" },
						},
						{
							type: "image_url",
							image_url: {
								url: "https://example.com/input.png",
								detail: "high",
							},
						},
					],
				},
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_patch",
							type: "function",
							function: {
								name: "apply_patch",
								arguments: "*** Begin Patch\n*** End Patch",
							},
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_patch",
					content: [
						{ type: "text", text: "done" },
						{
							type: "image_url",
							image_url: {
								url: "https://example.com/result.png",
								detail: "low",
							},
						},
						{
							type: "file",
							file: { file_id: "file_result", filename: "result.txt" },
						},
					],
				},
			],
			tools: [
				{
					type: "custom",
					name: "apply_patch",
					description: "Apply a patch",
					format: { type: "text" },
				},
				{ type: "web_search_preview" },
				{
					type: "function",
					function: { name: "lookup", parameters: { type: "object" } },
				},
			],
			tool_choice: {
				type: "function",
				function: { name: "apply_patch" },
			},
		});

		expect(adapted.body.prompt_cache_key).toBe("thread-cache-key");
		expect(adapted.body.tools).toEqual([
			{
				type: "custom",
				name: "apply_patch",
				description: "Apply a patch",
				format: { type: "text" },
			},
			{ type: "web_search" },
			{
				type: "function",
				name: "lookup",
				parameters: { type: "object" },
			},
		]);
		expect(adapted.body.tool_choice).toEqual({
			type: "custom",
			name: "apply_patch",
		});

		const items = adapted.body.input as Array<Record<string, unknown>>;
		expect(items[0]).toMatchObject({
			type: "message",
			role: "user",
			content: [
				{
					type: "input_file",
					file_data: "data:application/pdf;base64,UEZERg==",
					filename: "brief.pdf",
				},
				{ type: "input_audio", data: "UklGRg==", format: "wav" },
				{
					type: "input_image",
					image_url: "https://example.com/input.png",
					detail: "high",
				},
			],
		});
		expect(items[1]).toEqual({
			type: "custom_tool_call",
			call_id: "call_patch",
			name: "apply_patch",
			input: "*** Begin Patch\n*** End Patch",
		});
		expect(items[2]).toEqual({
			type: "custom_tool_call_output",
			call_id: "call_patch",
			output: [
				{ type: "input_text", text: "done" },
				{
					type: "input_image",
					image_url: "https://example.com/result.png",
					detail: "low",
				},
				{
					type: "input_file",
					file_id: "file_result",
					filename: "result.txt",
				},
			],
		});
	});

	it("converts custom tool output events into Chat-compatible function calls", () => {
		const response = chatCompletionFromEvents(
			[
				{
					type: "response.created",
					response: {
						id: "resp_custom",
						created_at: CREATED_AT,
						model: "gpt-5.6-luna",
					},
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						id: "ct_patch",
						type: "custom_tool_call",
						call_id: "call_patch",
						name: "apply_patch",
					},
				},
				{
					type: "response.custom_tool_call_input.delta",
					item_id: "ct_patch",
					delta: "*** Begin Patch\n",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: "ct_patch",
						type: "custom_tool_call",
						call_id: "call_patch",
						name: "apply_patch",
						input: "*** Begin Patch\n*** End Patch",
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_custom",
						created_at: CREATED_AT,
						model: "gpt-5.6-luna",
						output: [],
					},
				},
			],
			"gpt-5.6-luna",
		);

		expect(response).toMatchObject({
			choices: [
				{
					message: {
						content: null,
						tool_calls: [
							{
								id: "call_patch",
								type: "function",
								function: {
									name: "apply_patch",
									arguments: "*** Begin Patch\n*** End Patch",
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
		});
	});

	it("prepares the canonical unary remote-compaction payload", () => {
		const body = prepareCompactRequest({
			model: "gpt-5.6-luna",
			input: [
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "compact this" }],
				},
			],
			instructions: "retain decisions",
			tools: [{ type: "web_search_preview" }],
			parallel_tool_calls: false,
			reasoning: { effort: "high" },
			service_tier: "priority",
			prompt_cache_key: "compact-cache-key",
			text: { verbosity: "low" },
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			client_metadata: { omit: true },
		});

		expect(body).toEqual({
			model: "gpt-5.6-luna",
			input: [
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "compact this" }],
				},
			],
			instructions: "retain decisions",
			tools: [{ type: "web_search" }],
			parallel_tool_calls: false,
			reasoning: { effort: "high" },
			service_tier: "priority",
			prompt_cache_key: "compact-cache-key",
			text: { verbosity: "low" },
		});
	});
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

		const response = await authenticatedFetch(
			"https://example.com/v1/responses",
			{
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
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.has("x-request-id")).toBe(false);

		expect(outbound).toBeDefined();
		expect(outbound!.headers.get("authorization")).toBe(
			`Bearer ${TEST_OAUTH.accessToken}`,
		);
		expect(outbound!.headers.get("chatgpt-account-id")).toBe(
			TEST_OAUTH.accountId,
		);
		expect(outbound!.headers.get("accept")).toBe("text/event-stream");
		expect(outbound!.headers.get("content-type")).toBe("application/json");
		expect(outbound!.headers.get("version")).toBe("0.144.1");
		expect(outbound!.headers.get("x-codex-beta-features")).toBe("beta-a");
		expect(outbound!.headers.get("x-codex-turn-metadata")).toBe(
			"turn-metadata",
		);
		expect(outbound!.headers.get("x-codex-turn-state")).toBe(
			"turn-state-in",
		);
		expect(outbound!.headers.get("session-id")).toBe("cache-key");
		for (const name of [
			"originator",
			"user-agent",
			"session_id",
			"conversation_id",
			"x-request-id",
			"x-client-request-id",
		]) {
			expect(outbound!.headers.has(name), name).toBe(false);
		}

		expect(outbound!.body.model).toBe("gpt-5.6-lunar");
		expect(outbound!.body.stream).toBe(true);
		expect(outbound!.body.store).toBe(false);
		expect(outbound!.body.parallel_tool_calls).toBe(true);
		expect(outbound!.body.include).toEqual([
			"reasoning.encrypted_content",
		]);
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

	it("proxies Codex remote compaction as a unary JSON request", async () => {
		let outbound:
			| {
					headers: Headers;
					body: Record<string, unknown>;
			  }
			| undefined;
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
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

		const response = await authenticatedFetch(
			"https://example.com/v1/responses/compact",
			{
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
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-codex-turn-state")).toBe(
			"compact-turn-state-out",
		);
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
		expect(outbound!.headers.get("x-codex-turn-state")).toBe(
			"compact-turn-state-in",
		);
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

	it("returns a non-streaming Chat Completions response", async () => {
		mockCodex(sseResponse());
		const response = await authenticatedFetch(
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
		const response = await authenticatedFetch(
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

	it("streams custom tool input through Chat-compatible tool call deltas", async () => {
		mockCodex(customToolSseResponse());
		const response = await authenticatedFetch(
			"https://example.com/v1/chat/completions",
			{
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
			},
		);

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
			status: 503,
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
	])("passes through $name upstream errors unchanged", async (testCase) => {
		const upstreamBody = JSON.stringify({
			error: {
				message: `${testCase.name} upstream failure`,
				upstream_only: true,
			},
		});
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
				path: testCase.upstreamPath,
				method: testCase.upstreamMethod,
			})
			.reply(testCase.status, upstreamBody, {
				headers: {
					"Content-Type": "application/problem+json",
					"X-Upstream-Error": "preserved",
				},
			});

		const response = await authenticatedFetch(
			testCase.requestUrl,
			testCase.requestInit,
		);
		expect(response.status).toBe(testCase.status);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect(response.headers.get("x-upstream-error")).toBe("preserved");
		expect(await response.text()).toBe(upstreamBody);
	});
});

function authenticatedFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${TEST_API_KEY}`);
	return SELF.fetch(input, { ...init, headers });
}

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
