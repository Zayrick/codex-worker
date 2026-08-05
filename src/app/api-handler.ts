import { chatRequestToResponses } from "../chat/request";
import { chatCompletionFromEventStream } from "../chat/response";
import { createChatCompletionStream } from "../chat/stream";
import { completionRequestToResponses } from "../completions/request";
import { completionFromChat } from "../completions/response";
import { createCompletionStream } from "../completions/stream";
import { fetchCodexModels, sendConvertedResponses } from "../codex/client";
import { decodeSseStream } from "../codex/event-stream";
import {
	forwardCodexProxy,
	type CodexProxyRoute,
} from "../codex/proxy";
import { parseJsonBody } from "../http/body";
import { geminiErrorPayload, geminiUpstreamErrorResponse } from "../gemini/error";
import { geminiModelDetail, geminiModelList } from "../gemini/models";
import { matchGeminiActionPath, matchGeminiModelPath } from "../gemini/path";
import { geminiCountRequest, geminiRequestToResponses } from "../gemini/request";
import { geminiResponseFromEventStream } from "../gemini/response";
import { createGeminiStream } from "../gemini/stream";
import {
	chatSseResponse,
	emptyResponse,
	eventStreamResponse,
	jsonResponse,
	upstreamErrorResponse,
	upstreamJsonResponse,
	upstreamProxyResponse,
	withCors,
} from "../http/response";
import { anthropicErrorPayload, anthropicUpstreamErrorResponse } from "../messages/error";
import { messagesRequestToResponses } from "../messages/request";
import { messageFromEventStream } from "../messages/response";
import { createMessagesStream } from "../messages/stream";
import { countCodexInputTokens } from "../messages/token-count";
import { toOpenAiModelList } from "../openai/models";
import { ApiError, errorPayload, normalizeError } from "../shared/api-error";
import { logFailure } from "../shared/logging";

export type ApiRoute =
	| "models"
	| "chat_completions"
	| "completions"
	| "messages"
	| "message_tokens"
	| "gemini_models"
	| "gemini_model"
	| "gemini_generate"
	| "gemini_stream"
	| "gemini_tokens"
	| CodexProxyRoute;

export async function handleApiRoute(route: ApiRoute, request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		const response = await dispatchApiRoute(route, request, url, env, ctx);
		return withCors(response, env.CORS_ORIGIN);
	} catch (error) {
		const apiError = normalizeError(error);
		if (
			apiError.status === 404 &&
			!isAnthropicRoute(route) &&
			!isGeminiRoute(route)
		) {
			return emptyResponse(404);
		}
		if (apiError.status >= 500) logFailure("api_request", apiError);
		const payload = isAnthropicRoute(route)
			? anthropicErrorPayload(apiError)
			: isGeminiRoute(route)
				? geminiErrorPayload(apiError)
				: errorPayload(apiError);
		return withCors(jsonResponse(payload, apiError.status), env.CORS_ORIGIN);
	}
}

async function dispatchApiRoute(route: ApiRoute, request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	switch (route) {
		case "models":
			return handleModels(request, url, env);
		case "responses":
		case "compact":
		case "proxy":
			return handleProxy(route, request, url, env);
		case "chat_completions":
			return handleChatCompletions(request, env, ctx);
		case "completions":
			return handleCompletions(request, env, ctx);
		case "messages":
			return handleMessages(request, env, ctx);
		case "message_tokens":
			return handleMessageTokens(request);
		case "gemini_models":
			return handleGeminiModels(request, url, env);
		case "gemini_model":
			return handleGeminiModel(request, url, env);
		case "gemini_generate":
			return handleGeminiGenerate(request, url, env, ctx, false);
		case "gemini_stream":
			return handleGeminiGenerate(request, url, env, ctx, true);
		case "gemini_tokens":
			return handleGeminiTokens(request, url);
	}
}

async function handleModels(request: Request, url: URL, env: Env): Promise<Response> {
	const codexClient = url.searchParams.has("client_version");
	const upstream = await fetchCodexModels(url, env, requestOptions(request));
	if (!upstream.ok) return upstreamErrorResponse(upstream);
	return codexClient ? upstreamJsonResponse(upstream) : jsonResponse(await toOpenAiModelList(upstream));
}

async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const adapted = chatRequestToResponses(await parseJsonBody(request));
	const upstream = await sendConvertedResponses(adapted.body, env, requestOptions(request));
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

async function handleCompletions(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const adapted = completionRequestToResponses(
		await parseJsonBody(request),
	);
	const upstream = await sendConvertedResponses(
		adapted.body,
		env,
		requestOptions(request),
	);
	if (!upstream.ok) return upstreamErrorResponse(upstream);
	const body = requireBody(upstream);
	if (adapted.stream) {
		const chatStream = createChatCompletionStream(
			body,
			{ model: adapted.model, includeUsage: adapted.includeUsage },
			ctx,
		);
		return chatSseResponse(
			createCompletionStream(chatStream, adapted.echoPrefix),
			upstream.headers,
		);
	}

	const chat = await chatCompletionFromEventStream(
		decodeSseStream(body),
		adapted.model,
	);
	return jsonResponse(completionFromChat(chat, adapted.echoPrefix));
}

async function handleProxy(
	route: CodexProxyRoute,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	return upstreamProxyResponse(
		await forwardCodexProxy(request, url, env, route),
	);
}

async function handleMessages(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const adapted = messagesRequestToResponses(await parseJsonBody(request), {
		requireMaxTokens: true,
	});
	const upstream = await sendConvertedResponses(
		adapted.body,
		env,
		requestOptions(request),
	);
	if (!upstream.ok) return anthropicUpstreamErrorResponse(upstream);
	const body = requireBody(upstream);
	if (adapted.stream) {
		return eventStreamResponse(
			createMessagesStream(
				body,
				{
					model: adapted.model,
					reverseToolNames: adapted.reverseToolNames,
				},
				ctx,
			),
			upstream.headers,
		);
	}
	return jsonResponse(
		await messageFromEventStream(
			decodeSseStream(body),
			adapted.model,
			adapted.reverseToolNames,
		),
	);
}

async function handleMessageTokens(request: Request): Promise<Response> {
	const adapted = messagesRequestToResponses(await parseJsonBody(request));
	return jsonResponse({ input_tokens: countCodexInputTokens(adapted.body) });
}

async function handleGeminiModels(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const upstream = await fetchCodexModels(url, env, requestOptions(request));
	if (!upstream.ok) return geminiUpstreamErrorResponse(upstream);
	return jsonResponse(await geminiModelList(upstream));
}

async function handleGeminiModel(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const model = matchGeminiModelPath(url.pathname);
	if (!model) throw new ApiError(404, "Model not found.", "not_found", "NOT_FOUND");
	const upstream = await fetchCodexModels(url, env, requestOptions(request));
	if (!upstream.ok) return geminiUpstreamErrorResponse(upstream);
	return jsonResponse(await geminiModelDetail(upstream, model));
}

async function handleGeminiGenerate(
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	stream: boolean,
): Promise<Response> {
	const target = matchGeminiActionPath(url.pathname);
	if (!target) throw new ApiError(404, "Action not found.", "not_found", "NOT_FOUND");
	const adapted = geminiRequestToResponses(await parseJsonBody(request), target.model);
	const upstream = await sendConvertedResponses(
		adapted.body,
		env,
		requestOptions(request),
	);
	if (!upstream.ok) return geminiUpstreamErrorResponse(upstream);
	const body = requireBody(upstream);
	if (stream) {
		return eventStreamResponse(
			createGeminiStream(
				body,
				{ model: adapted.model, reverseToolNames: adapted.reverseToolNames },
				ctx,
			),
			upstream.headers,
		);
	}
	return jsonResponse(
		await geminiResponseFromEventStream(
			decodeSseStream(body),
			adapted.model,
			adapted.reverseToolNames,
		),
	);
}

async function handleGeminiTokens(request: Request, url: URL): Promise<Response> {
	const target = matchGeminiActionPath(url.pathname);
	if (!target) throw new ApiError(404, "Action not found.", "not_found", "NOT_FOUND");
	const adapted = geminiCountRequest(await parseJsonBody(request), target.model);
	return jsonResponse({ totalTokens: countCodexInputTokens(adapted.body) });
}

function isAnthropicRoute(route: ApiRoute): boolean {
	return route === "messages" || route === "message_tokens";
}

function isGeminiRoute(route: ApiRoute): boolean {
	return route.startsWith("gemini_");
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
