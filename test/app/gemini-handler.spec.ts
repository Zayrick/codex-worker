import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchMock } from "../support/fetch-mock";
import {
	authenticatedFetch,
	seedWorkerAuth,
	TEST_OAUTH,
} from "../support/worker-fixture";

beforeAll(async () => {
	fetchMock.install();
	await seedWorkerAuth();
});

afterEach(() => {
	fetchMock.verify();
});

afterAll(() => {
	fetchMock.restore();
});

describe("Gemini HTTP routes", () => {
	it("converts generateContent through the Codex OAuth Responses endpoint", async () => {
		let outboundBody: Record<string, unknown> | undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply((call) => {
				expect(call.headers.get("authorization")).toBe(
					`Bearer ${TEST_OAUTH.accessToken}`,
				);
				expect(call.headers.get("x-goog-api-key")).toBeNull();
				outboundBody = JSON.parse(String(call.body)) as Record<string, unknown>;
				return {
					statusCode: 200,
					data: sse([
						{
							type: "response.created",
							response: { id: "resp_gemini_http", model: "resolved-model" },
						},
						{
							type: "response.completed",
							response: {
								id: "resp_gemini_http",
								model: "resolved-model",
								usage: { input_tokens: 6, output_tokens: 2 },
								output: [
									{
										type: "message",
										content: [{ type: "output_text", text: "hello" }],
									},
								],
							},
						},
					]),
					responseOptions: { headers: { "Content-Type": "text/event-stream" } },
				};
			});

		const response = await authenticatedFetch(
			"https://example.com/v1beta/models/gpt-5.6-luna:generateContent?key=drop-me",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					systemInstruction: { parts: [{ text: "Be concise." }] },
					contents: [{ role: "user", parts: [{ text: "hello" }] }],
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			responseId: "resp_gemini_http",
			modelVersion: "resolved-model",
			candidates: [
				{
					finishReason: "STOP",
					content: { role: "model", parts: [{ text: "hello" }] },
				},
			],
		});
		expect(outboundBody).toMatchObject({
			model: "gpt-5.6-luna",
			instructions: "",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		});
		expect(outboundBody?.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Be concise." }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hello" }],
			},
		]);
	});

	it("implements countTokens locally, including nested generateContentRequest", async () => {
		const response = await authenticatedFetch(
			"https://example.com/v1beta/models/gpt-5.6-luna:countTokens",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					generateContentRequest: {
						contents: [
							{ role: "user", parts: [{ text: "Count this message." }] },
						],
					},
				}),
			},
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { totalTokens: number };
		expect(body.totalTokens).toBeGreaterThan(2);
	});

	it("converts the Codex catalog into Gemini model list and detail responses", async () => {
		for (const path of [
			"/v1beta/models",
			"/v1beta/models/gpt-5.6-luna",
		]) {
			fetchMock
				.intercept({
					origin: "https://codex-relay.test",
					path: "/backend-api/codex/models?client_version=0.144.1",
					method: "GET",
				})
				.reply(
					200,
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-luna",
								display_name: "GPT-5.6 Luna",
								description: "Fast model",
								context_window: 272_000,
							},
						],
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			const response = await authenticatedFetch(`https://example.com${path}`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			const model = Array.isArray(body.models)
				? (body.models[0] as Record<string, unknown>)
				: body;
			expect(model).toMatchObject({
				name: "models/gpt-5.6-luna",
				displayName: "GPT-5.6 Luna",
				inputTokenLimit: 272_000,
			});
		}
	});

	it("turns an upstream HTML failure into a Google-style error", async () => {
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply(403, "<html>managed challenge</html>", {
				headers: { "Content-Type": "text/html" },
			});

		const response = await authenticatedFetch(
			"https://example.com/v1beta/models/gpt-5.6-luna:generateContent",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "hello" }] }],
				}),
			},
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				code: 403,
				message: "The ChatGPT Codex backend returned HTTP 403.",
				status: "PERMISSION_DENIED",
			},
		});
	});
});

function sse(events: readonly Record<string, unknown>[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
