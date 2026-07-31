import {
	chatCompletionFromEvents,
	chatRequestToResponses,
	createChatCompletionStream,
} from "./chat";
import {
	prepareResponsesRequest,
	requestCodex,
	requestCodexModels,
} from "./codex";
import {
	ApiError,
	errorPayload,
	normalizeError,
	requireRecord,
} from "./errors";
import { collectSseEvents } from "./sse";
import type { WorkerEnv } from "./types";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (request.method === "OPTIONS") {
				return finalize(new Response(null, { status: 204 }), env);
			}

			if (request.method === "GET" && url.pathname === "/") {
				return finalize(
					json({
						name: "codex-worker",
						status: "ok",
						compatibility:
							"Codex Responses passthrough with an OpenAI Chat Completions adapter",
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
					env,
				);
			}

			if (request.method === "GET" && url.pathname === "/healthz") {
				return finalize(
					json({
						status: "ok",
						codex_auth_configured: Boolean(env.CODEX_AUTH_JSON),
						token_refresh: false,
					}),
					env,
				);
			}

			authenticateClient(request, env);

			if (request.method === "GET" && url.pathname === "/v1/models") {
				const upstream = await requestCodexModels(url, env, {
					headers: request.headers,
					signal: request.signal,
				});
				return finalize(
					upstreamJson(upstream),
					env,
				);
			}

			if (request.method === "POST" && url.pathname === "/v1/responses") {
				const input = await parseJsonBody(request);
				const body = prepareResponsesRequest(input);
				const upstream = await requestCodex(
					body,
					env,
					{
						headers: request.headers,
						signal: request.signal,
					},
				);
				return finalize(
					new Response(upstream.body, {
						status: 200,
						headers: sseHeaders(),
					}),
					env,
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
					{
						headers: request.headers,
						signal: request.signal,
					},
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
						env,
					);
				}

				const events = await collectSseEvents(upstream.body!);
				return finalize(
					json(chatCompletionFromEvents(events, adapted.model)),
					env,
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
				env,
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

function upstreamJson(response: Response): Response {
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: {
			"Content-Type":
				response.headers.get("Content-Type") ??
				"application/json; charset=utf-8",
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
	env: WorkerEnv,
): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
	headers.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, X-Api-Key, Version, X-Codex-Beta-Features, X-Codex-Turn-Metadata",
	);
	headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
