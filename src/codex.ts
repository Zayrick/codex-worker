import { getCodexCredentials } from "./auth";
import { ApiError, requireString } from "./errors";
import { resolveModelId } from "./models";
import {
	isRecord,
	recordField,
	stringField,
	type JsonObject,
	type WorkerEnv,
} from "./types";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export interface AdaptedResponsesRequest {
	body: JsonObject;
	model: string;
	stream: boolean;
}

export function prepareResponsesRequest(
	input: JsonObject,
): AdaptedResponsesRequest {
	const model = resolveModelId(requireString(input.model, "model"));
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

	const include = Array.isArray(input.include)
		? input.include.filter((value): value is string => typeof value === "string")
		: [];
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
	}

	const body: JsonObject = {
		...input,
		input: responseInput,
		model,
		instructions:
			typeof input.instructions === "string"
				? input.instructions
				: DEFAULT_INSTRUCTIONS,
		store: false,
		stream: true,
		include,
	};
	// This private backend currently responds with
	// "Unsupported parameter: max_output_tokens".
	delete body.max_output_tokens;

	return {
		model,
		stream: input.stream === true,
		body,
	};
}

export async function requestCodex(
	body: JsonObject,
	env: WorkerEnv,
	signal?: AbortSignal,
): Promise<Response> {
	const credentials = getCodexCredentials(env);
	const sessionId = crypto.randomUUID();
	const upstreamUrl = resolveRelayUrl(env.CODEX_RELAY_URL);
	let response: Response;
	try {
		response = await fetch(upstreamUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.token}`,
				Accept: "text/event-stream",
				"Content-Type": "application/json",
				"User-Agent": "codex-worker/0.1.0",
				Originator: "codex-worker",
				Session_id: sessionId,
				Conversation_id: sessionId,
				...(credentials.accountId
					? { "Chatgpt-Account-Id": credentials.accountId }
					: {}),
			},
			body: JSON.stringify({
				...body,
				prompt_cache_key:
					typeof body.prompt_cache_key === "string"
						? body.prompt_cache_key
						: sessionId,
			}),
			signal,
		});
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

	const message = await upstreamErrorMessage(response);
	if (response.status === 401 || response.status === 403) {
		if ((response.headers.get("content-type") ?? "").includes("text/html")) {
			throw new ApiError(
				502,
				message
					? `The upstream edge rejected the relay request: ${message}`
					: "The upstream edge rejected the relay request.",
				"upstream_error",
				"codex_edge_rejected",
			);
		}
		throw new ApiError(
			502,
			message
				? `The access token in auth.json was rejected by the Codex backend: ${message}`
				: "The access token in auth.json was rejected. Re-import the current auth.json.",
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
		message || `The ChatGPT Codex backend returned HTTP ${response.status}.`,
		response.status === 429 ? "rate_limit_error" : "upstream_error",
		response.status === 429 ? "rate_limit_exceeded" : "codex_request_failed",
	);
}

function resolveRelayUrl(relayUrl: string): string {
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
	return url.toString();
}

async function upstreamErrorMessage(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return "";
	}
	if (!text) return "";
	try {
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) return "";
		const error = recordField(value, "error");
		return (
			stringField(error, "message") ??
			stringField(value, "message") ??
			stringField(value, "detail") ??
			""
		);
	} catch {
		const plain = text
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/\s+/g, " ")
			.trim();
		return plain.length <= 500 ? plain : `${plain.slice(0, 500)}…`;
	}
}
