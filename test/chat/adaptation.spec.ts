import { describe, expect, it } from "vitest";
import { chatRequestToResponses } from "../../src/chat/request";
import { chatCompletionFromEvents } from "../../src/chat/response";
import { prepareCompactRequest, prepareResponsesRequest } from "../../src/codex/request-policy";
import { CREATED_AT } from "../support/worker-fixture";

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
			parallel_tool_calls: false,
			include: ["reasoning.encrypted_content"],
			tools: [{ type: "web_search_preview" }],
			tool_choice: { type: "web_search_preview_2025_03_11" },
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
		expect(body.instructions).toBe("Only the client's instruction.");
		expect(body.service_tier).toBe("priority");
		expect(body.reasoning).toEqual({ effort: "medium" });
		expect(body).not.toHaveProperty("parallel_tool_calls");
	});

	it("preserves parallel tool calls regardless of the tool list", () => {
		const withoutTools = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			input: "hello",
			parallel_tool_calls: false,
		});
		const withEmptyTools = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			input: "hello",
			tools: [],
			parallel_tool_calls: true,
		});
		const withTools = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			input: "hello",
			tools: [{ type: "function", name: "lookup" }],
			parallel_tool_calls: false,
		});

		expect(withoutTools.parallel_tool_calls).toBe(false);
		expect(withEmptyTools.parallel_tool_calls).toBe(true);
		expect(withTools.parallel_tool_calls).toBe(false);
	});

	it.each([
		["boolean", true],
		["string", " TRUE "],
	] as const)("preserves parallel tool calls with Responses Lite metadata as a %s", (_name, liteValue) => {
		const body = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			input: "hello",
			client_metadata: {
				ws_request_header_x_openai_internal_codex_responses_lite: liteValue,
			},
			tools: [{ type: "function", name: "lookup" }],
			parallel_tool_calls: true,
		});

		expect(body.parallel_tool_calls).toBe(true);
	});

	it("adds a missing reasoning effort without replacing other reasoning fields", () => {
		const body = prepareResponsesRequest({
			model: "gpt-5.6-luna",
			input: "hello",
			reasoning: { summary: "detailed" },
		});

		expect(body.reasoning).toEqual({
			summary: "detailed",
			effort: "medium",
		});
	});

	it("maps Chat Completions without aliases or invented optional values", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-lunar",
			reasoning_effort: "low",
			parallel_tool_calls: false,
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
			parallel_tool_calls: false,
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
		const image = (userMessage?.content as Array<Record<string, unknown>>).find((part) => part.type === "input_image");
		expect(image).toEqual({
			type: "input_image",
			image_url: "https://example.com/weather.png",
		});
		expect(adapted.body.text).toEqual({
			format: { type: "json_schema", name: "weather" },
		});
	});

	it("does not invent an empty user message and applies request defaults", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-luna",
			messages: [],
		});
		expect(adapted.body.input).toEqual([]);
		expect(adapted.body.reasoning).toEqual({ effort: "medium" });
		expect(adapted.body).not.toHaveProperty("parallel_tool_calls");
	});

	it.each(["minimal", "future-reasoning-level"])("forwards reasoning_effort %s without a local enum restriction", (reasoningEffort) => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-luna",
			messages: [{ role: "user", content: "hello" }],
			reasoning_effort: reasoningEffort,
		});
		expect(adapted.body.reasoning).toEqual({ effort: reasoningEffort });
	});

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
			{ type: "web_search_preview" },
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
			tools: [{ type: "web_search_preview" }],
			parallel_tool_calls: false,
			reasoning: { effort: "high" },
			service_tier: "priority",
			prompt_cache_key: "compact-cache-key",
			text: { verbosity: "low" },
		});
	});
});
