import { getCodexCredentials } from "../auth/credentials";
import { ApiError, isAbortError } from "../shared/api-error";
import type { JsonObject } from "../shared/json";
import { resolveChatGptRelayUrl } from "../shared/relay-url";
import { applyConvertedResponseEgressPolicy } from "./request-policy";

const FORWARDED_CODEX_HEADERS = [
	"Version",
	"X-Codex-Beta-Features",
	"X-Codex-Turn-Metadata",
	"X-Codex-Turn-State",
] as const;

export const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1";
const CODEX_MODELS_PATH = "/backend-api/codex/models";
const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";

type CodexEnv = Pick<
	Env,
	"AUTH_KV" | "DATA_ENCRYPTION_KEY" | "CHATGPT_RELAY_URL"
>;

interface CodexRequestOptions {
	headers?: Headers;
	signal?: AbortSignal;
}

export async function sendConvertedResponses(
	body: JsonObject,
	env: CodexEnv,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	return fetchCodex(chatGptRelayUrl(env.CHATGPT_RELAY_URL, CODEX_RESPONSES_PATH), {
		method: "POST",
		headers: codexHeaders(
			credentials,
			"text/event-stream",
			options.headers,
			true,
		),
		body: JSON.stringify(applyConvertedResponseEgressPolicy(body)),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

export async function fetchCodexModels(
	clientUrl: URL,
	env: CodexEnv,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	return fetchCodex(
		resolveModelsUrl(env.CHATGPT_RELAY_URL, clientUrl, options.headers),
		{
			method: "GET",
			headers: codexHeaders(
				credentials,
				"application/json",
				options.headers,
				false,
			),
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
}

function codexHeaders(
	credentials: { token: string; accountId?: string },
	accept: string,
	source: Headers | undefined,
	hasJsonBody: boolean,
): Headers {
	const headers = new Headers({
		Accept: accept,
		Authorization: `Bearer ${credentials.token}`,
	});
	if (hasJsonBody) headers.set("Content-Type", "application/json");
	if (credentials.accountId) {
		headers.set("Chatgpt-Account-Id", credentials.accountId);
	}
	for (const name of FORWARDED_CODEX_HEADERS) {
		const value = source?.get(name)?.trim();
		if (value) headers.set(name, value);
	}
	return headers;
}

async function fetchCodex(url: URL, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw new ApiError(
			502,
			"Unable to reach the Codex relay.",
			"upstream_error",
			"codex_unavailable",
		);
	}

	if (response.ok && !response.body) {
		throw new ApiError(
			502,
			"The ChatGPT Codex backend returned an empty response.",
			"upstream_error",
			"empty_codex_response",
		);
	}
	return response;
}

function resolveModelsUrl(
	relayUrl: string,
	clientUrl: URL,
	clientHeaders: Headers | undefined,
): URL {
	const url = chatGptRelayUrl(relayUrl, CODEX_MODELS_PATH);

	const clientVersion =
		clientUrl.searchParams.get("client_version")?.trim() ||
		clientHeaders?.get("Version")?.trim() ||
		DEFAULT_CODEX_CLIENT_VERSION;
	url.searchParams.set("client_version", clientVersion);
	for (const [name, value] of clientUrl.searchParams) {
		if (name === "channel") url.searchParams.append(name, value);
	}
	return url;
}

function chatGptRelayUrl(relayUrl: string, pathname: string): URL {
	return resolveChatGptRelayUrl(relayUrl, pathname);
}
