import { describe, expect, it } from "vitest";
import { messagesRequestToResponses } from "../../worker/messages/request";
import { messageFromTerminalResponse } from "../../worker/messages/response";
import { countCodexInputTokens } from "../../worker/messages/token-count";

const CODEX_SIGNATURE = `gAAAA${"A".repeat(120)}`;

describe("Anthropic Messages request adaptation", () => {
	it("maps system, multimodal content, thinking, tools, and tool results", () => {
		const longToolName = `mcp__weather__${"lookup".repeat(12)}`;
		const longCallId = `toolu_${"x".repeat(90)}`;
		const adapted = messagesRequestToResponses(
			{
				model: "gpt-5.6-luna",
				max_tokens: 2048,
				stream: true,
				system: [
					{ type: "text", text: "Answer precisely.", cache_control: { type: "ephemeral" } },
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "aW1hZ2U=",
								},
							},
							{
								type: "document",
								title: "brief.pdf",
								source: {
									type: "base64",
									media_type: "application/pdf",
									data: "UERG",
								},
							},
							{ type: "text", text: "What is the weather?" },
						],
					},
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "checking", signature: CODEX_SIGNATURE },
							{
								type: "tool_use",
								id: longCallId,
								name: longToolName,
								input: { city: "Shanghai" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: longCallId,
								content: [
									{ type: "text", text: "sunny" },
									{
										type: "image",
										source: {
											type: "url",
											url: "https://example.com/weather.png",
										},
									},
								],
							},
						],
					},
				],
				tools: [
					{
						name: longToolName,
						description: "Look up weather",
						input_schema: {
							$schema: "https://json-schema.org/draft/2020-12/schema",
							type: "object",
							properties: { city: { type: "string" } },
						},
					},
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: ["example.com"],
					},
				],
				tool_choice: {
					type: "tool",
					name: longToolName,
					disable_parallel_tool_use: true,
				},
				thinking: { type: "enabled", budget_tokens: 20_000 },
				speed: "fast",
			},
			{ requireMaxTokens: true },
		);

		expect(adapted.stream).toBe(true);
		expect(adapted.body).toMatchObject({
			model: "gpt-5.6-luna",
			parallel_tool_calls: false,
			reasoning: { effort: "high" },
			service_tier: "priority",
		});
		expect(adapted.body).not.toHaveProperty("max_tokens");
		expect(adapted.body).not.toHaveProperty("temperature");

		const tools = adapted.body.tools as Array<Record<string, unknown>>;
		expect(tools[0]?.name).toHaveLength(64);
		expect(tools[0]).toMatchObject({
			type: "function",
			description: "Look up weather",
			strict: false,
		});
		expect(tools[0]?.parameters).not.toHaveProperty("$schema");
		expect(tools[1]).toEqual({
			type: "web_search",
			filters: { allowed_domains: ["example.com"] },
		});
		expect(adapted.body.tool_choice).toEqual({
			type: "function",
			name: tools[0]?.name,
		});

		const input = adapted.body.input as Array<Record<string, unknown>>;
		expect(input[0]).toMatchObject({ type: "message", role: "developer" });
		expect(input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "reasoning",
					encrypted_content: CODEX_SIGNATURE,
				}),
				expect.objectContaining({ type: "function_call" }),
				expect.objectContaining({ type: "function_call_output" }),
			]),
		);
		const call = input.find((item) => item.type === "function_call");
		expect(String(call?.call_id)).toHaveLength(64);
		expect(call?.arguments).toBe('{"city":"Shanghai"}');
		expect(adapted.reverseToolNames.get(String(call?.name))).toBe(longToolName);
		expect(countCodexInputTokens(adapted.body)).toBeGreaterThan(10);
	});

	it("rejects invalid Messages fields instead of silently dropping them", () => {
		expect(() =>
			messagesRequestToResponses(
				{ model: "model", messages: [], max_tokens: -1 },
				{ requireMaxTokens: true },
			),
		).toThrowError(expect.objectContaining({ code: "invalid_max_tokens" }));

		expect(() =>
			messagesRequestToResponses({
				model: "model",
				messages: [
					{
						role: "user",
						content: [{ type: "audio", source: { type: "base64" } }],
					},
				],
			}),
		).toThrowError(expect.objectContaining({ code: "unsupported_content_type" }));
	});

	it("maps the CLIProxy dynamic thinking sentinel to Codex auto effort", () => {
		const adapted = messagesRequestToResponses({
			model: "model",
			messages: [],
			thinking: { type: "enabled", budget_tokens: -1 },
		});

		expect(adapted.body.reasoning).toEqual({ effort: "auto" });
	});

	it("wraps message-level system roles as user-visible reminders", () => {
		const adapted = messagesRequestToResponses({
			model: "model",
			system: [{ type: "text", text: "Top-level rules" }],
			messages: [
				{ role: "user", content: "hello" },
				{ role: "system", content: "Follow the project instructions" },
				{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				{
					role: "system",
					content: [
						{ type: "text", text: "Use the current repo" },
						{ type: "image", source: { type: "url", url: "ignored" } },
					],
				},
				{
					role: "system",
					content: " x-anthropic-billing-header: cc_version=2.1.63;",
				},
			],
		});

		expect(adapted.body.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Top-level rules" }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hello" }],
			},
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "<system-reminder>\nFollow the project instructions\n</system-reminder>",
					},
				],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "ok" }],
			},
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: "<system-reminder>\nUse the current repo\n</system-reminder>",
					},
				],
			},
		]);
	});
});

describe("Anthropic Messages non-stream response", () => {
	it("maps ordered thinking, text, client tools, web search, usage, and stop reason", () => {
		const response = messageFromTerminalResponse(
			{
				id: "resp_message",
				model: "resolved-model",
				usage: {
					input_tokens: 30,
					output_tokens: 12,
					input_tokens_details: { cached_tokens: 5 },
				},
				output: [
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "thinking" }],
						encrypted_content: CODEX_SIGNATURE,
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
					{
						type: "function_call",
						call_id: "call_weather",
						name: "weather_short",
						arguments: '{"city":"Shanghai"}',
					},
					{
						type: "web_search_call",
						id: "ws_1",
						action: { type: "search", query: "Workers streams" },
						results: [
							{ title: "Streams", url: "https://example.com/streams" },
						],
					},
				],
			},
			"requested-model",
			new Map([["weather_short", "weather_original"]]),
		);

		expect(response).toMatchObject({
			id: "resp_message",
			type: "message",
			role: "assistant",
			model: "resolved-model",
			stop_reason: "tool_use",
			usage: {
				input_tokens: 25,
				output_tokens: 12,
				cache_read_input_tokens: 5,
			},
		});
		const content = response.content as Array<Record<string, unknown>>;
		expect(content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"tool_use",
			"server_tool_use",
			"web_search_tool_result",
		]);
		expect(content[2]).toMatchObject({
			name: "weather_original",
			input: { city: "Shanghai" },
		});
	});
});
