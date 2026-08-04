import { getCodexCredentials } from "../auth/credentials";
import { ApiError, isAbortError } from "../shared/api-error";
import { stringField, type JsonObject } from "../shared/json";

const FORWARDED_CODEX_HEADERS = [
	"Version",
	"X-Codex-Beta-Features",
	"X-Codex-Turn-Metadata",
	"X-Codex-Turn-State",
] as const;

const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1";

type CodexEnv = Pick<
	Env,
	"AUTH_KV" | "OAUTH_MASTER_KEY" | "CODEX_RELAY_URL"
>;

interface CodexRequestOptions {
	headers?: Headers;
	signal?: AbortSignal;
}

export function sendPreparedResponses(
	body: JsonObject,
	env: CodexEnv,
	options: CodexRequestOptions = {},
): Promise<Response> {
	return sendCodexJson("responses", body, env, options);
}

export function sendPreparedCompact(
	body: JsonObject,
	env: CodexEnv,
	options: CodexRequestOptions = {},
): Promise<Response> {
	return sendCodexJson("compact", body, env, options);
}

export async function fetchCodexModels(
	clientUrl: URL,
	env: CodexEnv,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	return fetchCodex(
		resolveModelsUrl(env.CODEX_RELAY_URL, clientUrl, options.headers),
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

async function sendCodexJson(
	endpoint: "responses" | "compact",
	body: JsonObject,
	env: CodexEnv,
	options: CodexRequestOptions,
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	const url =
		endpoint === "responses"
			? resolveRelayUrl(env.CODEX_RELAY_URL)
			: resolveCompactUrl(env.CODEX_RELAY_URL);
	return fetchCodex(url, {
		method: "POST",
		headers: codexHeaders(
			credentials,
			endpoint === "responses" ? "text/event-stream" : "application/json",
			options.headers,
			true,
			stringField(body, "prompt_cache_key"),
		),
		body: JSON.stringify(body),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

function codexHeaders(
	credentials: { token: string; accountId?: string },
	accept: string,
	source: Headers | undefined,
	hasJsonBody: boolean,
	promptCacheKey?: string,
): Headers {
	const headers = new Headers({
		Accept: accept,
		Authorization: `Bearer ${credentials.token}`,
	});
	if (hasJsonBody) headers.set("Content-Type", "application/json");
	if (credentials.accountId) {
		headers.set("Chatgpt-Account-Id", credentials.accountId);
	}
	if (promptCacheKey) headers.set("Session-Id", promptCacheKey);
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

function resolveRelayUrl(relayUrl: string): URL {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		throw new ApiError(
			500,
			"CODEX_RELAY_URL is not a valid URL.",
			"configuration_error",
			"invalid_relay_url",
		);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new ApiError(
			500,
			"CODEX_RELAY_URL must be an HTTPS URL without embedded credentials or a fragment.",
			"configuration_error",
			"unsafe_relay_url",
		);
	}
	if (!/\/responses\/?$/.test(url.pathname)) {
		throw new ApiError(
			500,
			"CODEX_RELAY_URL must end in /responses.",
			"configuration_error",
			"invalid_relay_path",
		);
	}
	return url;
}

function resolveCompactUrl(relayUrl: string): URL {
	const url = resolveRelayUrl(relayUrl);
	url.pathname = url.pathname.replace(/\/responses\/?$/, "/responses/compact");
	return url;
}

function resolveModelsUrl(
	relayUrl: string,
	clientUrl: URL,
	clientHeaders: Headers | undefined,
): URL {
	const url = resolveRelayUrl(relayUrl);
	url.pathname = url.pathname.replace(/\/responses\/?$/, "/models");
	url.search = "";

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
