import { ApiError, isAbortError } from "../shared/api-error";
import { isRecord, stringField, type JsonObject } from "../shared/json";
import {
	BodySizeLimitError,
	readLimitedBody,
} from "../shared/limited-body";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL =
	"https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
	"https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_TOKEN_REDIRECT_URI =
	"https://auth.openai.com/deviceauth/callback";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

interface ProviderDeviceAuthorization {
	deviceAuthId: string;
	userCode: string;
	interval: unknown;
}

export type ProviderDevicePollResult =
	| { status: "pending" }
	| { status: "authorized"; tokenPayload: unknown };

class OAuthProviderFailure extends Error {
	constructor(readonly status: number | undefined) {
		super("OAuth provider request failed.");
		this.name = "OAuthProviderFailure";
	}
}

interface ProviderRequestOptions {
	body: JsonObject | URLSearchParams;
	signal?: AbortSignal;
	networkError?: () => Error;
}

interface ProviderResponse {
	response: Response;
	clientSignal?: AbortSignal;
	networkError: () => Error;
}

export async function requestDeviceAuthorization(
	signal?: AbortSignal,
): Promise<ProviderDeviceAuthorization> {
	const upstream = await providerFetch(DEVICE_USER_CODE_URL, {
		body: { client_id: CODEX_CLIENT_ID },
		...(signal ? { signal } : {}),
	});
	const payload = await requireProviderJson(upstream);
	if (!isRecord(payload)) throw invalidProviderResponse();
	const deviceAuthId = stringField(payload, "device_auth_id");
	const userCode =
		stringField(payload, "user_code") ?? stringField(payload, "usercode");
	if (!deviceAuthId || !userCode) throw invalidProviderResponse();
	return { deviceAuthId, userCode, interval: payload.interval };
}

export async function pollDeviceAuthorizationToken(
	deviceAuthId: string,
	userCode: string,
	signal?: AbortSignal,
): Promise<ProviderDevicePollResult> {
	const upstream = await providerFetch(DEVICE_TOKEN_URL, {
		body: {
			device_auth_id: deviceAuthId,
			user_code: userCode,
		},
		...(signal ? { signal } : {}),
	});

	if (upstream.response.status === 403 || upstream.response.status === 404) {
		await discardBody(upstream.response);
		return { status: "pending" };
	}
	const payload = await requireProviderJson(upstream);
	if (!isRecord(payload)) throw invalidProviderResponse();
	const authorizationCode = stringField(payload, "authorization_code");
	const codeVerifier = stringField(payload, "code_verifier");
	const codeChallenge = stringField(payload, "code_challenge");
	if (!authorizationCode || !codeVerifier || !codeChallenge) {
		throw invalidProviderResponse();
	}

	return {
		status: "authorized",
		tokenPayload: await exchangeAuthorizationCode(
			authorizationCode,
			codeVerifier,
			signal,
		),
	};
}

export async function refreshProviderToken(
	refreshToken: string,
): Promise<unknown> {
	try {
		return await exchangeRefreshToken(refreshToken);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw providerApiError(
			error instanceof OAuthProviderFailure ? error.status : undefined,
		);
	}
}

async function exchangeAuthorizationCode(
	code: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const upstream = await providerFetch(OAUTH_TOKEN_URL, {
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CODEX_CLIENT_ID,
			code,
			redirect_uri: DEVICE_TOKEN_REDIRECT_URI,
			code_verifier: codeVerifier,
		}),
		...(signal ? { signal } : {}),
	});
	return requireProviderJson(upstream);
}

async function exchangeRefreshToken(refreshToken: string): Promise<unknown> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const upstream = await providerFetch(OAUTH_TOKEN_URL, {
				body: new URLSearchParams({
					client_id: CODEX_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					scope: "openid profile email",
				}),
				networkError: () => new OAuthProviderFailure(undefined),
			});
			if (upstream.response.ok) return await providerJson(upstream);
			const status = upstream.response.status;
			await discardBody(upstream.response);
			throw new OAuthProviderFailure(status);
		} catch (error) {
			if (
				!(error instanceof OAuthProviderFailure) ||
				!retryableProviderFailure(error) ||
				attempt >= 2
			) {
				throw error;
			}
			await retryDelay(attempt);
		}
	}
	throw new OAuthProviderFailure(undefined);
}

async function providerFetch(
	url: string,
	options: ProviderRequestOptions,
): Promise<ProviderResponse> {
	const form = options.body instanceof URLSearchParams;
	const body =
		options.body instanceof URLSearchParams
			? options.body
			: JSON.stringify(options.body);
	const signal = providerSignal(options.signal);
	const networkError = options.networkError ?? (() => providerApiError());
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": form
					? "application/x-www-form-urlencoded"
					: "application/json",
			},
			body,
			signal,
		});
		return {
			response,
			...(options.signal ? { clientSignal: options.signal } : {}),
			networkError,
		};
	} catch (error) {
		if (options.signal?.aborted) throw clientAbortError(error);
		throw networkError();
	}
}

function providerSignal(clientSignal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
	return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;
}

async function requireProviderJson(upstream: ProviderResponse): Promise<unknown> {
	if (!upstream.response.ok) {
		await discardBody(upstream.response);
		throw providerApiError(upstream.response.status);
	}
	return providerJson(upstream);
}

async function providerJson(upstream: ProviderResponse): Promise<unknown> {
	let bytes: Uint8Array | null;
	try {
		bytes = await readLimitedBody(
			upstream.response,
			MAX_OAUTH_RESPONSE_BYTES,
		);
	} catch (error) {
		if (upstream.clientSignal?.aborted) throw clientAbortError(error);
		if (!(error instanceof BodySizeLimitError)) {
			throw upstream.networkError();
		}
		throw invalidProviderResponse();
	}
	if (!bytes) throw invalidProviderResponse();
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw invalidProviderResponse();
	}
}

function retryableProviderFailure(error: OAuthProviderFailure): boolean {
	return error.status === undefined || error.status === 429 || error.status >= 500;
}

function clientAbortError(error: unknown): DOMException {
	return isAbortError(error)
		? error
		: new DOMException("The client request was aborted.", "AbortError");
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response is already unusable; there is nothing sensitive to report.
	}
}

async function retryDelay(attempt: number): Promise<void> {
	await new Promise<void>((resolve) =>
		setTimeout(resolve, (attempt + 1) * 1000),
	);
}

function providerApiError(status?: number): ApiError {
	return new ApiError(
		502,
		"The OAuth provider request failed.",
		"upstream_error",
		status === 429 ? "oauth_rate_limited" : "oauth_provider_error",
	);
}

function invalidProviderResponse(): ApiError {
	return new ApiError(
		502,
		"The OAuth provider returned an invalid response.",
		"upstream_error",
		"invalid_oauth_provider_response",
	);
}
