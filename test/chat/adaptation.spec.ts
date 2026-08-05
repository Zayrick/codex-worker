import { describe, expect, it } from "vitest";
import { chatRequestToResponses } from "../../src/chat/request";
import { chatCompletionFromEvents } from "../../src/chat/response";
import { CREATED_AT } from "../support/worker-fixture";

describe("request adaptation", () => {
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

	it("does not invent an empty user message or a reasoning effort", () => {
		const adapted = chatRequestToResponses({
			model: "gpt-5.6-luna",
			messages: [],
		});
		expect(adapted.body.input).toEqual([]);
		expect(adapted.body).not.toHaveProperty("reasoning");
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
});
