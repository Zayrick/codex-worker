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

describe("Anthropic Messages HTTP routes", () => {
	it("converts /v1/messages and message-level system reminders", async () => {
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
				expect(call.headers.get("x-api-key")).toBeNull();
				expect(call.headers.get("anthropic-version")).toBeNull();
				outboundBody = JSON.parse(String(call.body)) as Record<string, unknown>;
				return {
					statusCode: 200,
					data: sse([
						{
							type: "response.created",
							response: { id: "resp_http", model: "resolved-model" },
						},
						{
							type: "response.completed",
							response: {
								id: "resp_http",
								model: "resolved-model",
								usage: { input_tokens: 9, output_tokens: 2 },
								output: [
									{
										type: "message",
										content: [{ type: "output_text", text: "hello" }],
									},
								],
							},
						},
					]),
					responseOptions: {
						headers: { "Content-Type": "text/event-stream" },
					},
				};
			});

		const response = await authenticatedFetch(
			"https://example.com/v1/messages?beta=true",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Anthropic-Version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					max_tokens: 100,
					system: "Be concise.",
					messages: [
						{ role: "user", content: "hello" },
						{ role: "system", content: "Follow the project instructions" },
					],
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "resp_http",
			type: "message",
			role: "assistant",
			model: "resolved-model",
			content: [{ type: "text", text: "hello" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 9, output_tokens: 2 },
		});
		expect(outboundBody).toMatchObject({
			model: "gpt-5.6-luna",
			instructions: "",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "medium" },
		});
		expect(outboundBody).not.toHaveProperty("max_tokens");
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
		]);
	});

	it("implements /v1/messages/count_tokens locally", async () => {
		const response = await authenticatedFetch(
			"https://example.com/v1/messages/count_tokens",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-luna",
					system: "Count this system prompt.",
					messages: [{ role: "user", content: "Count this message." }],
				}),
			},
		);
		expect(response.status).toBe(200);
		const value = (await response.json()) as { input_tokens: number };
		expect(value.input_tokens).toBeGreaterThan(5);
	});

	it("converts an upstream HTML failure into an Anthropic error envelope", async () => {
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/responses",
				method: "POST",
			})
			.reply(403, "<html>managed challenge</html>", {
				headers: {
					"Content-Type": "text/html",
					"X-Request-Id": "request_upstream",
				},
			});

		const response = await authenticatedFetch("https://example.com/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-luna",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "permission_error",
				message: "The ChatGPT Codex backend returned HTTP 403.",
			},
			request_id: "request_upstream",
		});
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("x-request-id")).toBe("request_upstream");
	});

	it("uses Anthropic errors for local Messages validation failures", async () => {
		const response = await authenticatedFetch("https://example.com/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			type: "error",
			error: { type: "invalid_request_error" },
		});
	});
});

function sse(events: readonly Record<string, unknown>[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
