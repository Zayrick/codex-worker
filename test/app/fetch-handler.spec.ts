import { env, exports } from "cloudflare:workers";
import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { fetchMock } from "../support/fetch-mock";
import {
	authenticatedFetch,
	seedWorkerAuth,
	TEST_API_KEY,
	TEST_OAUTH,
} from "../support/worker-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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

describe("routing and model compatibility", () => {
	it("returns an empty 204 when the stored OAuth credentials are usable", async () => {
		const response = await exports.default.fetch("https://example.com/healthz");
		await expectEmptyResponse(response, 204);
	});

	it("returns an empty 404 and logs only a safe code when unhealthy", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const unhealthyEnv: Env = {
			...env,
			AUTH_KV: {
				get: vi.fn().mockResolvedValue(null),
			} as unknown as KVNamespace,
		};
		const request = new IncomingRequest("https://example.com/healthz");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, unhealthyEnv, ctx);
		await waitOnExecutionContext(ctx);

		await expectEmptyResponse(response, 404);
		expect(errorLog).toHaveBeenCalledWith(
			JSON.stringify({
				event: "health_check",
				status: "failed",
				code: "missing_oauth_credentials",
			}),
		);
	});

	it.each([
		["root path", "GET", "/"],
		["unknown path", "GET", "/robots.txt"],
		["wrong API method", "POST", "/v1/models"],
		["extra API path", "GET", "/v1/models/gpt-5.6-luna"],
		["wrong device method", "DELETE", "/auth/device/start"],
	])("returns an empty 404 for the %s", async (_name, method, pathname) => {
		const response = await exports.default.fetch(`https://example.com${pathname}`, {
			method,
			headers: { Authorization: `Bearer ${TEST_API_KEY}` },
		});
		await expectEmptyResponse(response, 404);
	});

	it("answers preflight only for known API routes", async () => {
		const response = await exports.default.fetch(
			"https://example.com/v1/models",
			{ method: "OPTIONS" },
		);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"OPTIONS",
		);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"Authorization",
		);
		expect(response.headers.get("access-control-expose-headers")).toContain(
			"X-Codex-Turn-State",
		);

		await expectEmptyResponse(
			await exports.default.fetch("https://example.com/v1/unknown", {
				method: "OPTIONS",
			}),
			404,
		);
	});

	it("forwards the upstream Codex model catalog without a local model list", async () => {
		let outboundHeaders: Headers | undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
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
			"https://example.com/v1/models?client_version=0.200.0&channel=stable&session_id=drop-me&api_key=drop-me&future_control=drop-me",
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
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("access-control-allow-methods")).toBe(
			"GET, POST, OPTIONS",
		);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"X-Api-Key",
		);
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
		await expectEmptyResponse(response, 404);
	});

	it("adds the required Codex client_version when the client omits it", async () => {
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
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

	it.each([
		["models", "GET", "/v1/models"],
		["Responses", "POST", "/v1/responses"],
		["compaction", "POST", "/v1/responses/compact"],
		["Chat Completions", "POST", "/v1/chat/completions"],
	])("hides $0 when the API key is absent or incorrect", async (_name, method, path) => {
		for (const apiKey of [
			undefined,
			"sk-test-wrong-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
		]) {
			const headers = new Headers();
			if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
			const request = new IncomingRequest(`https://example.com${path}`, {
				method,
				headers,
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			await expectEmptyResponse(response, 404);
		}
	});
});

async function expectEmptyResponse(
	response: Response,
	status: 204 | 404,
): Promise<void> {
	expect(response.status).toBe(status);
	expect(response.headers.has("content-type")).toBe(false);
	expect(response.headers.has("access-control-allow-origin")).toBe(false);
	expect(await response.text()).toBe("");
}
