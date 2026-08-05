import { describe, expect, it } from "vitest";
import { geminiRequestToResponses } from "../../src/gemini/request";
import { geminiResponseFromTerminal } from "../../src/gemini/response";

const CODEX_SIGNATURE = `gAAAA${"G".repeat(120)}`;

describe("Gemini request adaptation", () => {
	it("maps contents, media, thought signatures, functions, and tool configuration", () => {
		const longName = `mcp__weather__${"lookup".repeat(12)}`;
		const adapted = geminiRequestToResponses(
			{
				systemInstruction: { parts: [{ text: "Be concise." }] },
				contents: [
					{
						role: "user",
						parts: [
							{ text: "weather" },
							{
								inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
							},
						],
					},
					{
						role: "model",
						parts: [
							{
								text: "checking",
								thought: true,
								thoughtSignature: CODEX_SIGNATURE,
							},
							{
								functionCall: {
									id: "call_weather",
									name: longName,
									args: { city: "Shanghai" },
								},
							},
						],
					},
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									id: "call_weather",
									name: longName,
									response: { result: "sunny" },
								},
							},
						],
					},
				],
				tools: [
					{
						functionDeclarations: [
							{
								name: longName,
								description: "Look up weather",
								parameters: {
									$schema: "https://json-schema.org/draft/2020-12/schema",
									type: "object",
									properties: { city: { type: "string" } },
								},
							},
						],
					},
				],
				toolConfig: {
					functionCallingConfig: {
						mode: "ANY",
						allowedFunctionNames: [longName],
					},
				},
				generationConfig: { thinkingConfig: { thinkingBudget: 20_000 } },
				serviceTier: "fast",
			},
			"gpt-5.6-luna",
		);

		expect(adapted.body).toMatchObject({
			model: "gpt-5.6-luna",
			parallel_tool_calls: true,
			reasoning: { effort: "high" },
			service_tier: "priority",
		});
		const tools = adapted.body.tools as Array<Record<string, unknown>>;
		expect(tools[0]?.name).toHaveLength(64);
		expect(tools[0]?.parameters).not.toHaveProperty("$schema");
		expect(tools[0]?.parameters).toHaveProperty("additionalProperties", false);
		expect(adapted.body.tool_choice).toEqual({
			type: "function",
			name: tools[0]?.name,
		});
		const input = adapted.body.input as Array<Record<string, unknown>>;
		expect(input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "developer" }),
				expect.objectContaining({
					type: "reasoning",
					encrypted_content: CODEX_SIGNATURE,
				}),
				expect.objectContaining({
					type: "function_call",
					call_id: "call_weather",
				}),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call_weather",
					output: "sunny",
				}),
			]),
		);
		expect(adapted.reverseToolNames.get(String(tools[0]?.name))).toBe(longName);
	});

	it("maps Gemini dynamic thinking budget to Codex auto effort", () => {
		const adapted = geminiRequestToResponses(
			{
				contents: [],
				generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
			},
			"model",
		);

		expect(adapted.body.reasoning).toEqual({ effort: "auto" });
	});
});

describe("Gemini non-stream response", () => {
	it("maps ordered thinking, text, functions, images, usage, and finish reason", () => {
		const response = geminiResponseFromTerminal(
			{
				id: "resp_gemini",
				model: "resolved-model",
				created_at: 1_700_000_000,
				usage: {
					input_tokens: 12,
					output_tokens: 7,
					total_tokens: 19,
					input_tokens_details: { cached_tokens: 3 },
					output_tokens_details: { reasoning_tokens: 2 },
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
						call_id: "call_1",
						name: "lookup_short",
						arguments: '{"q":"status"}',
					},
					{
						type: "image_generation_call",
						output_format: "png",
						result: "aW1hZ2U=",
					},
				],
			},
			"requested-model",
			new Map([["lookup_short", "lookup_original"]]),
		);

		expect(response).toMatchObject({
			responseId: "resp_gemini",
			modelVersion: "resolved-model",
			candidates: [{ finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: 12,
				candidatesTokenCount: 7,
				totalTokenCount: 19,
				cachedContentTokenCount: 3,
				thoughtsTokenCount: 2,
			},
		});
		const parts = (
			(response.candidates as Array<Record<string, unknown>>)[0]?.content as {
				parts: Array<Record<string, unknown>>;
			}
		).parts;
		expect(parts.map((part) => Object.keys(part)[0])).toEqual([
			"thought",
			"text",
			"functionCall",
			"inlineData",
		]);
		expect(parts[2]).toEqual({
			functionCall: {
				id: "call_1",
				name: "lookup_original",
				args: { q: "status" },
			},
		});
	});
});
