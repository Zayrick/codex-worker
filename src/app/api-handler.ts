import { chatRequestToResponses } from "../chat/request";
import { chatCompletionFromEventStream } from "../chat/response";
import { createChatCompletionStream } from "../chat/stream";
import { fetchCodexModels, sendPreparedCompact, sendPreparedResponses } from "../codex/client";
import { decodeSseStream } from "../codex/event-stream";
import { prepareCompactRequest, prepareResponsesRequest } from "../codex/request-policy";
import { parseJsonBody } from "../http/body";
import {
	chatSseResponse,
	codexSseResponse,
	emptyResponse,
	jsonResponse,
	upstreamErrorResponse,
	upstreamJsonResponse,
	withCors,
} from "../http/response";
import { toOpenAiModelList } from "../openai/models";
import { ApiError, errorPayload, normalizeError } from "../shared/api-error";
import { logFailure } from "../shared/logging";

export type ApiRoute = "models" | "responses" | "compact" | "chat_completions";

export async function handleApiRoute(route: ApiRoute, request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		const response = await dispatchApiRoute(route, request, url, env, ctx);
		return withCors(response, env.CORS_ORIGIN);
	} catch (error) {
		const apiError = normalizeError(error);
		if (apiError.status === 404) return emptyResponse(404);
		if (apiError.status >= 500) logFailure("api_request", apiError);
		return withCors(jsonResponse(errorPayload(apiError), apiError.status), env.CORS_ORIGIN);
	}
}

async function dispatchApiRoute(route: ApiRoute, request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	switch (route) {
		case "models":
			return handleModels(request, url, env);
		case "responses":
			return handleResponses(request, env);
		case "compact":
			return handleCompact(request, env);
		case "chat_completions":
			return handleChatCompletions(request, env, ctx);
	}
}

async function handleModels(request: Request, url: URL, env: Env): Promise<Response> {
	const codexClient = url.searchParams.has("client_version");
	const upstream = await fetchCodexModels(url, env, requestOptions(request));
	if (!upstream.ok) return upstreamErrorResponse(upstream);
	return codexClient ? upstreamJsonResponse(upstream) : jsonResponse(await toOpenAiModelList(upstream));
}

async function handleResponses(request: Request, env: Env): Promise<Response> {
	const input = await parseJsonBody(request);
	const upstream = await sendPreparedResponses(prepareResponsesRequest(input, request.headers), env, requestOptions(request));
	return upstream.ok ? codexSseResponse(upstream) : upstreamErrorResponse(upstream);
}

async function handleCompact(request: Request, env: Env): Promise<Response> {
	const input = await parseJsonBody(request);
	const upstream = await sendPreparedCompact(prepareCompactRequest(input), env, requestOptions(request));
	return upstream.ok ? upstreamJsonResponse(upstream) : upstreamErrorResponse(upstream);
}

async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const adapted = chatRequestToResponses(await parseJsonBody(request), request.headers);
	const upstream = await sendPreparedResponses(adapted.body, env, requestOptions(request));
	if (!upstream.ok) return upstreamErrorResponse(upstream);
	const body = requireBody(upstream);
	if (adapted.stream) {
		return chatSseResponse(
			createChatCompletionStream(body, { model: adapted.model, includeUsage: adapted.includeUsage }, ctx),
			upstream.headers,
		);
	}

	return jsonResponse(await chatCompletionFromEventStream(decodeSseStream(body), adapted.model));
}

function requestOptions(request: Request): {
	headers: Headers;
	signal: AbortSignal;
} {
	return { headers: request.headers, signal: request.signal };
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
	if (response.body) return response.body;
	throw new ApiError(502, "The ChatGPT Codex backend returned an empty response.", "upstream_error", "empty_codex_response");
}
