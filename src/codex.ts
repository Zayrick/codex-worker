import { getCodexCredentials } from "./auth";
import { ApiError, requireString } from "./errors";
import {
	isRecord,
	stringField,
	type JsonObject,
} from "./types";

const FORWARDED_CODEX_HEADERS = [
	"Version",
	"X-Codex-Beta-Features",
	"X-Codex-Turn-Metadata",
	"X-Codex-Turn-State",
] as const;

const DEFAULT_CODEX_CLIENT_VERSION = "0.144.1";

const REMOVED_REQUEST_FIELDS = new Set([
	"contextmanagement",
	"conversationid",
	"generate",
	"maxcompletiontokens",
	"maxoutputtokens",
	"maxtokens",
	"originator",
	"previousresponseid",
	"promptcacheretention",
	"requestid",
	"safetyidentifier",
	"sessionid",
	"streamoptions",
	"temperature",
	"topk",
	"topp",
	"truncation",
	"user",
	"useragent",
	"xclientrequestid",
	"xrequestid",
]);

const REMOVED_MODEL_QUERY_FIELDS = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"conversationid",
	"cookie",
	"idtoken",
	"promptcachekey",
	"proxyauthorization",
	"refreshtoken",
	"requestid",
	"sessionid",
	"token",
	"useragent",
	"xapikey",
	"xclientrequestid",
	"xrequestid",
]);

export interface CodexRequestOptions {
	headers?: Headers;
	signal?: AbortSignal;
}

export function prepareResponsesRequest(
	input: JsonObject,
): JsonObject {
	const model = requireString(input.model, "model");
	if (!Object.prototype.hasOwnProperty.call(input, "input")) {
		throw new ApiError(
			400,
			"Missing required parameter: 'input'.",
			"invalid_request_error",
			"missing_required_parameter",
			"input",
		);
	}
	const responseInput =
		typeof input.input === "string"
			? [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: input.input }],
					},
				]
			: input.input;
	if (!Array.isArray(responseInput)) {
		throw new ApiError(
			400,
			"'input' must be a string or an array.",
			"invalid_request_error",
			"invalid_input",
			"input",
		);
	}

	return prepareCodexRequestBody({
		...input,
		input: responseInput,
		model,
	});
}

export function prepareCompactRequest(input: JsonObject): JsonObject {
	const model = requireString(input.model, "model");
	if (!Object.prototype.hasOwnProperty.call(input, "input")) {
		throw new ApiError(
			400,
			"Missing required parameter: 'input'.",
			"invalid_request_error",
			"missing_required_parameter",
			"input",
		);
	}
	if (!Array.isArray(input.input)) {
		throw new ApiError(
			400,
			"'input' must be an array.",
			"invalid_request_error",
			"invalid_input",
			"input",
		);
	}

	const body: JsonObject = {
		model,
		input: normalizeSystemRoles(input.input),
	};
	for (const key of [
		"instructions",
		"tools",
		"parallel_tool_calls",
		"reasoning",
		"prompt_cache_key",
		"text",
	] as const) {
		if (Object.prototype.hasOwnProperty.call(input, key)) {
			body[key] = input[key];
		}
	}
	if (input.service_tier === "priority") {
		body.service_tier = "priority";
	}
	normalizeBuiltinTools(body);
	return body;
}

export function prepareCodexRequestBody(input: JsonObject): JsonObject {
	const body: JsonObject = { ...input };
	for (const key of Object.keys(body)) {
		if (REMOVED_REQUEST_FIELDS.has(normalizeName(key))) {
			delete body[key];
		}
	}

	if (body.service_tier !== "priority") {
		delete body.service_tier;
	}

	body.input = normalizeSystemRoles(body.input);
	normalizeBuiltinTools(body);
	if (body.instructions === undefined || body.instructions === null) {
		body.instructions = "";
	}
	body.store = false;
	body.stream = true;
	body.parallel_tool_calls = true;
	body.include = ["reasoning.encrypted_content"];
	return body;
}

export async function requestCodex(
	body: JsonObject,
	env: Env,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	const upstreamUrl = resolveRelayUrl(env.CODEX_RELAY_URL);
	const preparedBody = prepareCodexRequestBody(body);
	return fetchCodex(
		upstreamUrl,
		{
			method: "POST",
			headers: codexHeaders(
				credentials,
				"text/event-stream",
				options.headers,
				true,
				stringField(preparedBody, "prompt_cache_key"),
			),
			body: JSON.stringify(preparedBody),
			signal: options.signal,
		},
	);
}

export async function requestCodexCompact(
	body: JsonObject,
	env: Env,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	const upstreamUrl = resolveCompactUrl(env.CODEX_RELAY_URL);
	const preparedBody = prepareCompactRequest(body);
	return fetchCodex(
		upstreamUrl,
		{
			method: "POST",
			headers: codexHeaders(
				credentials,
				"application/json",
				options.headers,
				true,
				stringField(preparedBody, "prompt_cache_key"),
			),
			body: JSON.stringify(preparedBody),
			signal: options.signal,
		},
	);
}

export async function requestCodexModels(
	clientUrl: URL,
	env: Env,
	options: CodexRequestOptions = {},
): Promise<Response> {
	const credentials = await getCodexCredentials(env);
	const upstreamUrl = resolveModelsUrl(
		env.CODEX_RELAY_URL,
		clientUrl,
		options.headers,
	);
	return fetchCodex(
		upstreamUrl,
		{
			method: "GET",
			headers: codexHeaders(
				credentials,
				"application/json",
				options.headers,
				false,
			),
			signal: options.signal,
		},
	);
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
	if (hasJsonBody) {
		headers.set("Content-Type", "application/json");
	}
	if (credentials.accountId) {
		headers.set("Chatgpt-Account-Id", credentials.accountId);
	}
	if (promptCacheKey) {
		headers.set("Session-Id", promptCacheKey);
	}
	for (const name of FORWARDED_CODEX_HEADERS) {
		const value = source?.get(name)?.trim();
		if (value) headers.set(name, value);
	}
	return headers;
}

function normalizeSystemRoles(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) =>
		isRecord(item) && item.role === "system"
			? { ...item, role: "developer" }
			: item,
	);
}

function normalizeBuiltinTools(body: JsonObject): void {
	if (Object.prototype.hasOwnProperty.call(body, "tools")) {
		body.tools = normalizeToolArray(body.tools);
	}
	if (!isRecord(body.tool_choice)) return;

	const toolChoice = { ...body.tool_choice };
	const normalizedType = normalizeBuiltinToolType(toolChoice.type);
	if (normalizedType) toolChoice.type = normalizedType;
	if (Object.prototype.hasOwnProperty.call(toolChoice, "tools")) {
		toolChoice.tools = normalizeToolArray(toolChoice.tools);
	}
	body.tool_choice = toolChoice;
}

function normalizeToolArray(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((tool) => {
		if (!isRecord(tool)) return tool;
		const normalizedType = normalizeBuiltinToolType(tool.type);
		return normalizedType ? { ...tool, type: normalizedType } : tool;
	});
}

function normalizeBuiltinToolType(value: unknown): string | undefined {
	return value === "web_search_preview" ||
		value === "web_search_preview_2025_03_11"
		? "web_search"
		: undefined;
}

function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchCodex(url: URL, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new ApiError(
			502,
			"Unable to reach the Codex relay.",
			"upstream_error",
			"codex_unavailable",
		);
	}

	if (response.ok) {
		if (!response.body) {
			throw new ApiError(
				502,
				"The ChatGPT Codex backend returned an empty response.",
				"upstream_error",
				"empty_codex_response",
			);
		}
		return response;
	}

	try {
		await response.body?.cancel();
	} catch {
		// The upstream failure is intentionally discarded without exposing its body.
	}
	if (response.status === 401 || response.status === 403) {
		if ((response.headers.get("content-type") ?? "").includes("text/html")) {
			throw new ApiError(
				502,
				"The upstream edge rejected the relay request.",
				"upstream_error",
				"codex_edge_rejected",
			);
		}
		throw new ApiError(
			502,
			"The upstream OAuth credentials were rejected.",
			"upstream_authentication_error",
			"codex_auth_rejected",
		);
	}

	const status =
		response.status === 429
			? 429
			: response.status >= 400 && response.status < 500
				? response.status
				: 502;
	throw new ApiError(
		status,
		"The ChatGPT Codex backend rejected the request.",
		response.status === 429 ? "rate_limit_error" : "upstream_error",
		response.status === 429 ? "rate_limit_exceeded" : "codex_request_failed",
	);
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
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash
	) {
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
		if (name === "client_version") continue;
		if (!REMOVED_MODEL_QUERY_FIELDS.has(normalizeName(name))) {
			url.searchParams.append(name, value);
		}
	}
	return url;
}
