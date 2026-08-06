import { env, exports } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	forwardCodexProxy,
	resolveCodexProxyUrl,
} from "../../worker/codex/proxy";
import { upstreamProxyResponse, withCors } from "../../worker/http/response";
import { isRecord } from "../../worker/shared/json";
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
	vi.restoreAllMocks();
});

afterAll(() => {
	fetchMock.restore();
});

describe("streaming compatibility proxy", () => {
	it.each([
		{
			clientPath: "/v1/live/call_123?key=drop-me",
			upstreamPath: "/v1/live/call_123",
		},
		{
			clientPath: "/v1/realtime/calls/call_123?token=drop-me",
			upstreamPath: "/v1/realtime/calls/call_123",
		},
		{
			clientPath: "/v1/realtime?call_id=call_123&intent=override&key=drop-me",
			upstreamPath: "/v1/realtime?intent=quicksilver&call_id=call_123",
		},
	])("routes Codex sideband directly to its dedicated origin: $clientPath", ({ clientPath, upstreamPath }) => {
		expect(
			resolveCodexProxyUrl(
				"https://codex-relay.test",
				new URL(`https://worker.example${clientPath}`),
				"GET",
			).toString(),
		).toBe(`https://api.openai.com${upstreamPath}`);
	});

	it("streams multipart image edits to the native Codex image endpoint", async () => {
		let outboundHeaders: Headers | undefined;
		let outboundForm: FormData | undefined;
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/images/edits?stream=true",
				method: "POST",
			})
			.reply(async (call) => {
				outboundHeaders = call.headers;
				const bytes = await new Response(call.body).arrayBuffer();
				outboundForm = await new Request("https://upstream.test/images", {
					method: "POST",
					headers: call.headers,
					body: bytes,
				}).formData();
				return {
					statusCode: 200,
					data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
					responseOptions: {
						headers: {
							"Content-Type": "image/png",
							"Content-Disposition": 'attachment; filename="result.png"',
							"Set-Cookie": "upstream=secret",
						},
					},
				};
			});

		const form = new FormData();
		form.set("model", "gpt-image-2");
		form.set("prompt", "make the sky blue");
		form.set(
			"image",
			new File([new Uint8Array([1, 2, 3, 4])], "source.png", {
				type: "image/png",
			}),
		);
		const response = await authenticatedFetch(
			"https://example.com/v1/images/edits?stream=true",
			{
				method: "POST",
				headers: {
					"Chatgpt-Account-Id": "attacker-account",
					Origin: "https://untrusted.example",
				},
				body: form,
			},
		);

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("content-disposition")).toContain("result.png");
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");

		expect(outboundHeaders?.get("authorization")).toBe(
			`Bearer ${TEST_OAUTH.accessToken}`,
		);
		expect(outboundHeaders?.get("chatgpt-account-id")).toBe(
			TEST_OAUTH.accountId,
		);
		expect(outboundHeaders?.get("originator")).toBe("codex_cli_rs");
		expect(outboundHeaders?.get("user-agent")).toBe(
			"codex_cli_rs/0.144.1",
		);
		expect(outboundHeaders?.has("origin")).toBe(false);
		expect(outboundHeaders?.has("x-api-key")).toBe(false);
		expect(outboundHeaders?.has("content-length")).toBe(false);
		expect(outboundHeaders?.get("content-type")).toContain(
			"multipart/form-data",
		);
		expect(outboundForm?.get("model")).toBe("gpt-image-2");
		expect(outboundForm?.get("prompt")).toBe("make the sky blue");
		const image = outboundForm?.get("image");
		expect(image).toBeInstanceOf(File);
		expect(image instanceof File ? image.size : 0).toBe(4);
	});

	it.each([
		{
			name: "Codex CLI direct alias",
			method: "DELETE",
			clientPath: "/backend-api/codex/videos/video_123",
			upstreamPath: "/backend-api/codex/videos/video_123",
		},
		{
			name: "Codex Alpha Search",
			method: "POST",
			clientPath: "/v1/alpha/search?locale=en",
			upstreamPath: "/backend-api/codex/alpha/search?locale=en",
		},
		{
			name: "Codex Live bootstrap",
			method: "POST",
			clientPath: "/v1/live?voice=marin",
			upstreamPath:
				"/backend-api/codex/realtime/calls?voice=marin&intent=quicksilver&architecture=avas",
		},
	])("maps $name without buffering the response", async (testCase) => {
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: testCase.upstreamPath,
				method: testCase.method,
			})
			.reply((call) => {
				expect(call.headers.get("authorization")).toBe(
					`Bearer ${TEST_OAUTH.accessToken}`,
				);
				expect(call.headers.has("x-api-key")).toBe(false);
				expect(call.headers.has("x-goog-api-key")).toBe(false);
				return {
					statusCode: 200,
					data: "proxied",
					responseOptions: {
						headers: { "Content-Type": "text/plain" },
					},
				};
			});

		const response = await authenticatedFetch(
			`https://example.com${testCase.clientPath}`,
			{
				method: testCase.method,
				...(testCase.method === "GET"
					? {}
					: {
						body: "payload",
						headers: {
							"Content-Type": "text/plain",
							"X-Goog-Api-Key": "must-not-forward",
						},
					}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied");
	});

	it("adapts multipart Realtime bootstrap requests for the Codex endpoint", async () => {
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/realtime/calls?model=gpt-live-1-codex&intent=quicksilver&architecture=avas",
				method: "POST",
			})
			.reply(async (call) => {
				expect(call.headers.get("content-type")).toBe("application/json");
				const value: unknown = await new Response(call.body).json();
				expect(isRecord(value) ? value : undefined).toEqual({
					sdp: "v=0\r\n",
					session: { model: "gpt-live-1-codex", voice: "marin" },
				});
				return {
					statusCode: 201,
					data: "v=0\r\nanswer",
					responseOptions: {
						headers: {
							"Content-Type": "application/sdp",
							Location: "/v1/realtime/calls/call_123",
						},
					},
				};
			});

		const form = new FormData();
		form.set("sdp", "v=0\r\n");
		form.set(
			"session",
			new File(
				[JSON.stringify({ model: "gpt-live-1-codex", voice: "marin" })],
				"session.json",
				{ type: "application/json" },
			),
		);
		const response = await authenticatedFetch(
			"https://example.com/v1/realtime/calls?model=gpt-live-1-codex",
			{ method: "POST", body: form },
		);

		expect(response.status).toBe(201);
		expect(response.headers.get("content-type")).toBe("application/sdp");
		expect(response.headers.get("location")).toBe(
			"/v1/realtime/calls/call_123",
		);
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
			"v=0\r\nanswer",
		);
	});

	it("bridges Responses WebSocket frames and normalizes Codex request events", async () => {
		const upstreamPair = new WebSocketPair();
		const upstreamSocket = upstreamPair[0];
		const upstreamPeer = upstreamPair[1];
		upstreamPeer.binaryType = "arraybuffer";
		upstreamPeer.accept();
		let outboundHeaders: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			outboundHeaders = new Headers(init?.headers);
			return new Response(null, {
				status: 101,
				headers: {
					"Sec-WebSocket-Protocol": "openai-responses-v1",
					"Set-Cookie": "upstream=secret",
				},
				webSocket: upstreamSocket,
			});
		});

		const request = new Request("https://example.com/v1/responses", {
				method: "GET",
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Key": "downstream-key",
					"Sec-WebSocket-Protocol": "openai-responses-v1",
				},
			});
		const response = withCors(
			upstreamProxyResponse(
				await forwardCodexProxy(
					request,
					new URL(request.url),
					env,
					"responses",
				),
			),
			"*",
		);

		expect(response.status).toBe(101);
		expect(outboundHeaders?.get("upgrade")).toBe("websocket");
		expect(outboundHeaders?.get("sec-websocket-protocol")).toBe(
			"openai-responses-v1",
		);
		expect(outboundHeaders?.get("openai-beta")).toBe(
			"responses_websockets=2026-02-06",
		);
		expect(outboundHeaders?.has("sec-websocket-key")).toBe(false);
		expect(outboundHeaders?.get("authorization")).toBe(
			`Bearer ${TEST_OAUTH.accessToken}`,
		);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("sec-websocket-protocol")).toBe(
			"openai-responses-v1",
		);
		const downstream = response.webSocket;
		expect(downstream).not.toBeNull();
		if (!downstream) throw new Error("Missing downstream WebSocket.");
		downstream.accept();

		const wsRequest = {
			type: "response.create",
			model: "gpt-5.6-luna",
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
			max_completion_tokens: 1,
			max_output_tokens: 2,
			maxOutputTokens: 3,
			max_tokens: 4,
			context_management: [{ type: "compaction" }],
			temperature: 0.2,
			top_p: 0.9,
			truncation: "auto",
			user: "request-owner",
			service_tier: "flex",
			unknown_extension: { keep: true },
		};
		const upstreamMessage = await exchangeWebSocketMessage(
			downstream,
			upstreamPeer,
			JSON.stringify(wsRequest),
		);
		const expectedWsRequest: Record<string, unknown> = { ...wsRequest };
		for (const field of [
			"max_completion_tokens",
			"max_output_tokens",
			"maxOutputTokens",
			"max_tokens",
			"context_management",
			"temperature",
			"top_p",
			"truncation",
			"user",
			"service_tier",
		]) {
			delete expectedWsRequest[field];
		}
		expect(JSON.parse(String(upstreamMessage))).toEqual({
			...expectedWsRequest,
			store: false,
			input: [
				{ ...wsRequest.input[0], role: "developer" },
				wsRequest.input[1],
			],
		});

		const appendRequest = {
			type: "response.append",
			input: [
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "appended system prompt" }],
				},
				{
					type: "function_call_output",
					call_id: "call_current",
					output: "next tool result",
				},
			],
			previous_response_id: "resp_current",
			unknown_extension: { keep: true },
		};
		const upstreamAppendMessage = await exchangeWebSocketMessage(
			downstream,
			upstreamPeer,
			JSON.stringify(appendRequest),
		);
		expect(JSON.parse(String(upstreamAppendMessage))).toEqual({
			...appendRequest,
			input: [
				{ ...appendRequest.input[0], role: "developer" },
				appendRequest.input[1],
			],
		});

		const emptyAppendRequest = JSON.stringify({
			type: "response.append",
			input: [],
		});
		expect(
			await exchangeWebSocketMessage(
				downstream,
				upstreamPeer,
				emptyAppendRequest,
			),
		).toBe(emptyAppendRequest);

		const otherRequest = JSON.stringify({
			type: "session.update",
			input: [{ type: "message", role: "system", content: "unchanged" }],
		});
		expect(
			await exchangeWebSocketMessage(downstream, upstreamPeer, otherRequest),
		).toBe(otherRequest);

		const binaryRequest = new Uint8Array([1, 2, 3, 4]).buffer;
		const upstreamBinary = await exchangeWebSocketMessage(
			downstream,
			upstreamPeer,
			binaryRequest,
		);
		expect(upstreamBinary).toBeInstanceOf(ArrayBuffer);
		if (!(upstreamBinary instanceof ArrayBuffer)) {
			throw new Error("Expected an ArrayBuffer WebSocket message.");
		}
		expect(new Uint8Array(upstreamBinary)).toEqual(
			new Uint8Array(binaryRequest),
		);

		const responseEvent = JSON.stringify({
			type: "response.completed",
			response: { id: "resp_current" },
		});
		expect(
			await exchangeWebSocketMessage(upstreamPeer, downstream, responseEvent),
		).toBe(responseEvent);
		downstream.close(1000, "done");
	});

	it("forwards a Realtime sideband WebSocket handshake without translating frames", async () => {
		fetchMock
			.intercept({
				origin: "https://api.openai.com",
				path: "/v1/realtime?intent=quicksilver&call_id=call_123",
				method: "GET",
			})
			.reply((call) => {
				expect(call.headers.get("authorization")).toBe(
					`Bearer ${TEST_OAUTH.accessToken}`,
				);
				expect(call.headers.get("chatgpt-account-id")).toBe(
					TEST_OAUTH.accountId,
				);
				expect(call.headers.get("upgrade")).toBe("websocket");
				expect(call.headers.get("sec-websocket-protocol")).toBe(
					"openai-realtime-v1",
				);
				return {
					statusCode: 426,
					data: "upgrade rejected",
					responseOptions: {
						headers: { "Content-Type": "text/plain" },
					},
				};
			});

		const response = await authenticatedFetch(
			"https://example.com/v1/realtime?call_id=call_123&intent=override&key=drop-me",
			{
				method: "GET",
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Protocol": "openai-realtime-v1",
				},
			},
		);
		expect(response.status).toBe(426);
		expect(await response.text()).toBe("upgrade rejected");
	});

	it("preserves the upstream WebSocket when response headers and CORS are applied", () => {
		const pair = new WebSocketPair();
		const upstream = new Response(null, {
			status: 101,
			headers: {
				"Sec-WebSocket-Accept": "upstream-handshake-value",
				"Sec-WebSocket-Extensions": "permessage-deflate",
				"Sec-WebSocket-Protocol": "openai-responses-v1",
				"Set-Cookie": "upstream=secret",
			},
			webSocket: pair[0],
		});

		const response = withCors(
			upstreamProxyResponse(upstream),
			"https://client.example",
		);
		expect(response.status).toBe(101);
		expect(response.webSocket).toBe(pair[0]);
		expect(response.headers.get("sec-websocket-protocol")).toBe(
			"openai-responses-v1",
		);
		expect(response.headers.has("sec-websocket-accept")).toBe(false);
		expect(response.headers.has("sec-websocket-extensions")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://client.example",
		);
	});

	it("only exposes compatibility families after API-key authentication", async () => {
		const response = await exports.default.fetch(
			"https://example.com/v1/images/generations",
			{ method: "POST", body: "{}" },
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});

	it("answers preflight for converted Gemini routes", async () => {
		const response = await exports.default.fetch(
			"https://example.com/v1beta/models/gpt-5.6-luna:streamGenerateContent",
			{ method: "OPTIONS" },
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"DELETE",
		);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"Anthropic-Version",
		);
	});

	it.each([
		"/v1/videos/video_123/content",
		"/openai/v1/videos/video_123/content",
		"/v1beta/interactions",
		"/v1beta/models/gemini:testAction",
		"/v1/realtime/unknown/path",
	])("does not send unsupported vendor paths to the ChatGPT origin: %s", async (path) => {
		const response = await authenticatedFetch(`https://example.com${path}`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
	});

	it("requires the documented methods and WebSocket upgrade for Realtime routes", async () => {
		for (const [method, path] of [
			["GET", "/v1/live"],
			["POST", "/v1/live/call_123"],
			["GET", "/v1/realtime"],
			["GET", "/v1/realtime?call_id=bad%2Fid"],
		] as const) {
			const response = await authenticatedFetch(`https://example.com${path}`, {
				method,
			});
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("");
		}
	});
});

async function exchangeWebSocketMessage(
	sender: WebSocket,
	receiver: WebSocket,
	message: string | ArrayBuffer | ArrayBufferView,
): Promise<unknown> {
	const received = new Promise<unknown>((resolve) => {
		receiver.addEventListener("message", (event) => resolve(event.data), {
			once: true,
		});
	});
	sender.send(message);
	return received;
}
