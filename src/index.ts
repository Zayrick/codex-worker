import {
	chatCompletionFromEvents,
	chatRequestToResponses,
	createChatCompletionStream,
} from "./chat";
import { prepareResponsesRequest, requestCodex } from "./codex";
import {
	ApiError,
	errorPayload,
	normalizeError,
	requireRecord,
} from "./errors";
import { findModel, modelObject, MODELS } from "./models";
import { collectSseEvents, completedResponseFromEvents } from "./sse";
import type { WorkerEnv } from "./types";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const requestId = crypto.randomUUID();
		try {
			const url = new URL(request.url);
			if (request.method === "OPTIONS") {
				return finalize(new Response(null, { status: 204 }), request, env, requestId);
			}

			if (request.method === "GET" && url.pathname === "/") {
				return finalize(
					json({
						name: "codex-worker",
						status: "ok",
						compatibility: "OpenAI-compatible subset",
						endpoints: [
							"GET /v1/models",
							"POST /v1/responses",
							"POST /v1/chat/completions",
						],
						client_authentication: env.PROXY_API_KEY
							? "enabled"
							: "disabled",
						token_refresh: "disabled",
					}),
					request,
					env,
					requestId,
				);
			}

			if (request.method === "GET" && url.pathname === "/healthz") {
				return finalize(
					json({
						status: "ok",
						codex_auth_configured: Boolean(env.CODEX_AUTH_JSON),
						token_refresh: false,
					}),
					request,
					env,
					requestId,
				);
			}

			authenticateClient(request, env);

			if (request.method === "GET" && url.pathname === "/v1/models") {
				return finalize(
					json({
						object: "list",
						data: MODELS.map(modelObject),
					}),
					request,
					env,
					requestId,
				);
			}

			if (
				request.method === "GET" &&
				url.pathname.startsWith("/v1/models/")
			) {
				const requested = decodeURIComponent(
					url.pathname.slice("/v1/models/".length),
				);
				const model = findModel(requested);
				if (!model) {
					throw new ApiError(
						404,
						`The model '${requested}' does not exist in this proxy's model catalog.`,
						"invalid_request_error",
						"model_not_found",
						"model",
					);
				}
				return finalize(
					json(modelObject(model)),
					request,
					env,
					requestId,
				);
			}

			if (request.method === "POST" && url.pathname === "/v1/responses") {
				const input = await parseJsonBody(request);
				const adapted = prepareResponsesRequest(input);
				const upstream = await requestCodex(
					adapted.body,
					env,
					request.signal,
				);
				if (adapted.stream) {
					return finalize(
						new Response(upstream.body, {
							status: 200,
							headers: sseHeaders(),
						}),
						request,
						env,
						requestId,
					);
				}

				const events = await collectSseEvents(upstream.body!);
				return finalize(
					json(completedResponseFromEvents(events)),
					request,
					env,
					requestId,
				);
			}

			if (
				request.method === "POST" &&
				url.pathname === "/v1/chat/completions"
			) {
				const input = await parseJsonBody(request);
				const adapted = chatRequestToResponses(input);
				const upstream = await requestCodex(
					adapted.body,
					env,
					request.signal,
				);
				if (adapted.stream) {
					return finalize(
						new Response(
							createChatCompletionStream(
								upstream.body!,
								{
									model: adapted.model,
									includeUsage: adapted.includeUsage,
								},
								ctx,
							),
							{
								status: 200,
								headers: sseHeaders(),
							},
						),
						request,
						env,
						requestId,
					);
				}

				const events = await collectSseEvents(upstream.body!);
				return finalize(
					json(chatCompletionFromEvents(events, adapted.model)),
					request,
					env,
					requestId,
				);
			}

			throw new ApiError(
				404,
				`No route matches ${request.method} ${url.pathname}.`,
				"invalid_request_error",
				"not_found",
			);
		} catch (error) {
			const apiError = normalizeError(error);
			return finalize(
				json(errorPayload(apiError), apiError.status),
				request,
				env,
				requestId,
			);
		}
	},
} satisfies ExportedHandler<WorkerEnv>;

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = await request.json();
	} catch {
		throw new ApiError(
			400,
			"The request body is not valid JSON.",
			"invalid_request_error",
			"invalid_json",
		);
	}
	return requireRecord(value);
}

function authenticateClient(request: Request, env: WorkerEnv): void {
	if (!env.PROXY_API_KEY) return;
	const authorization = request.headers.get("Authorization");
	const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	const apiKey = bearer ?? request.headers.get("x-api-key") ?? "";
	if (!constantTimeEqual(apiKey, env.PROXY_API_KEY)) {
		throw new ApiError(
			401,
			"Invalid proxy API key.",
			"authentication_error",
			"invalid_api_key",
		);
	}
}

function constantTimeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index++) {
		difference |=
			(leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function sseHeaders(): HeadersInit {
	return {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
	};
}

function finalize(
	response: Response,
	request: Request,
	env: WorkerEnv,
	requestId: string,
): Response {
	const headers = new Headers(response.headers);
	const origin = request.headers.get("Origin");
	headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
	headers.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, X-Api-Key",
	);
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	headers.set("Access-Control-Expose-Headers", "X-Request-Id");
	headers.set("X-Request-Id", requestId);
	if (origin) headers.append("Vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
