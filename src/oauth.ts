import {
	credentialsFromTokenResponse,
	readOAuthCredentials,
	requireOAuthUnconfigured,
	storeOAuthCredentials,
} from "./auth";
import { openJson, sealJson } from "./crypto";
import { ApiError } from "./errors";
import { isRecord, numberField, stringField } from "./types";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL =
	"https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL =
	"https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_TOKEN_REDIRECT_URI =
	"https://auth.openai.com/deviceauth/callback";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_STATE_PURPOSE = "codex-worker/device-state/v1";
const DEVICE_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REFRESH_WINDOW_MS = 15 * 60 * 1000;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

type OAuthEnv = Pick<Env, "AUTH_KV" | "OAUTH_MASTER_KEY">;

interface DeviceState {
	version: 1;
	deviceAuthId: string;
	userCode: string;
	expiresAt: number;
	interval: number;
}

export interface DeviceAuthorization {
	verificationUri: string;
	userCode: string;
	expiresIn: number;
	interval: number;
	state: string;
}

export type DevicePollResult =
	| { status: "pending"; retryAfter: number }
	| { status: "stored" };

export type OAuthRefreshResult = "missing" | "not_due" | "refreshed";

class OAuthProviderFailure extends Error {
	constructor(
		readonly status: number | undefined,
		readonly retryable: boolean,
	) {
		super("OAuth provider request failed.");
		this.name = "OAuthProviderFailure";
	}
}

export async function startDeviceAuthorization(
	env: OAuthEnv,
	signal?: AbortSignal,
): Promise<DeviceAuthorization> {
	await requireOAuthUnconfigured(env);
	let response: Response;
	try {
		response = await fetch(DEVICE_USER_CODE_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
			signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw providerApiError();
	}

	if (!response.ok) {
		await discardBody(response);
		throw providerApiError(response.status);
	}

	const payload = await providerJson(response);
	if (!isRecord(payload)) throw invalidProviderResponse();
	const deviceAuthId = stringField(payload, "device_auth_id");
	const userCode =
		stringField(payload, "user_code") ?? stringField(payload, "usercode");
	if (!deviceAuthId || !userCode) throw invalidProviderResponse();
	const interval = pollInterval(payload.interval);
	const expiresAt = Date.now() + DEVICE_LIFETIME_MS;
	let state: string;
	try {
		state = await sealJson(
			{
				version: 1,
				deviceAuthId,
				userCode,
				expiresAt,
				interval,
			} satisfies DeviceState,
			env.OAUTH_MASTER_KEY,
			DEVICE_STATE_PURPOSE,
		);
	} catch {
		throw new ApiError(
			500,
			"Unable to create a device authorization session.",
			"configuration_error",
			"device_session_unavailable",
		);
	}

	return {
		verificationUri: DEVICE_VERIFICATION_URL,
		userCode,
		expiresIn: Math.floor(DEVICE_LIFETIME_MS / 1000),
		interval,
		state,
	};
}

export async function pollDeviceAuthorization(
	env: OAuthEnv,
	sealedState: string,
	signal?: AbortSignal,
): Promise<DevicePollResult> {
	await requireOAuthUnconfigured(env);
	const state = await deviceState(sealedState, env.OAUTH_MASTER_KEY);
	if (state.expiresAt <= Date.now()) {
		throw new ApiError(
			410,
			"The device authorization session has expired.",
			"invalid_request_error",
			"device_session_expired",
		);
	}

	let pollResponse: Response;
	try {
		pollResponse = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				device_auth_id: state.deviceAuthId,
				user_code: state.userCode,
			}),
			signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw providerApiError();
	}

	if (pollResponse.status === 403 || pollResponse.status === 404) {
		await discardBody(pollResponse);
		return { status: "pending", retryAfter: state.interval };
	}
	if (!pollResponse.ok) {
		await discardBody(pollResponse);
		throw providerApiError(pollResponse.status);
	}

	const pollPayload = await providerJson(pollResponse);
	if (!isRecord(pollPayload)) throw invalidProviderResponse();
	const authorizationCode = stringField(pollPayload, "authorization_code");
	const codeVerifier = stringField(pollPayload, "code_verifier");
	const codeChallenge = stringField(pollPayload, "code_challenge");
	if (!authorizationCode || !codeVerifier || !codeChallenge) {
		throw invalidProviderResponse();
	}

	const tokenPayload = await exchangeAuthorizationCode(
		authorizationCode,
		codeVerifier,
		signal,
	);
	const credentials = credentialsFromTokenResponse(
		tokenPayload,
		undefined,
	);
	await requireOAuthUnconfigured(env);
	await storeOAuthCredentials(env, credentials);
	return { status: "stored" };
}

export async function refreshOAuthCredentials(
	env: OAuthEnv,
	now = Date.now(),
): Promise<OAuthRefreshResult> {
	const current = await readOAuthCredentials(env);
	if (!current) return "missing";
	if (current.expiresAt > now + REFRESH_WINDOW_MS) {
		return "not_due";
	}

	let tokenPayload: unknown;
	try {
		tokenPayload = await exchangeRefreshToken(current.refreshToken);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw providerApiError(
			error instanceof OAuthProviderFailure ? error.status : undefined,
		);
	}
	const updated = credentialsFromTokenResponse(
		tokenPayload,
		current,
		Date.now(),
	);
	await storeOAuthCredentials(env, updated);
	return "refreshed";
}

async function exchangeAuthorizationCode(
	code: string,
	codeVerifier: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: CODEX_CLIENT_ID,
		code,
		redirect_uri: DEVICE_TOKEN_REDIRECT_URI,
		code_verifier: codeVerifier,
	});
	let response: Response;
	try {
		response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: form,
			signal,
		});
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw providerApiError();
	}
	if (!response.ok) {
		await discardBody(response);
		throw providerApiError(response.status);
	}
	return providerJson(response);
}

async function exchangeRefreshToken(refreshToken: string): Promise<unknown> {
	for (let attempt = 0; attempt < 3; attempt++) {
		let response: Response;
		try {
			response = await fetch(OAUTH_TOKEN_URL, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					client_id: CODEX_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					scope: "openid profile email",
				}),
			});
		} catch {
			if (attempt < 2) {
				await retryDelay(attempt);
				continue;
			}
			throw new OAuthProviderFailure(undefined, true);
		}

		if (response.ok) return providerJson(response);
		const status = response.status;
		await discardBody(response);
		const retryable = status === 429 || status >= 500;
		if (retryable && attempt < 2) {
			await retryDelay(attempt);
			continue;
		}
		throw new OAuthProviderFailure(status, retryable);
	}
	throw new OAuthProviderFailure(undefined, true);
}

async function deviceState(
	sealedState: string,
	masterKey: string,
): Promise<DeviceState> {
	let value: unknown;
	try {
		value = await openJson(sealedState, masterKey, DEVICE_STATE_PURPOSE);
	} catch {
		throw invalidDeviceState();
	}
	if (!isRecord(value)) throw invalidDeviceState();
	const deviceAuthId = stringField(value, "deviceAuthId");
	const userCode = stringField(value, "userCode");
	const expiresAt = numberField(value, "expiresAt");
	const interval = numberField(value, "interval");
	if (
		value.version !== 1 ||
		!deviceAuthId ||
		!userCode ||
		expiresAt === undefined ||
		interval === undefined ||
		interval < 1
	) {
		throw invalidDeviceState();
	}
	return { version: 1, deviceAuthId, userCode, expiresAt, interval };
}

function pollInterval(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 60
		? parsed
		: DEFAULT_POLL_INTERVAL_SECONDS;
}

async function providerJson(response: Response): Promise<unknown> {
	const declaredLength = Number.parseInt(
		response.headers.get("Content-Length") ?? "0",
		10,
	);
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > MAX_OAUTH_RESPONSE_BYTES
	) {
		await discardBody(response);
		throw invalidProviderResponse();
	}
	if (!response.body) throw invalidProviderResponse();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > MAX_OAUTH_RESPONSE_BYTES) {
				await reader.cancel();
				throw invalidProviderResponse();
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw invalidProviderResponse();
	}
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

function isAbortError(error: unknown): error is DOMException {
	return error instanceof DOMException && error.name === "AbortError";
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

function invalidDeviceState(): ApiError {
	return new ApiError(
		400,
		"The device authorization session is invalid.",
		"invalid_request_error",
		"invalid_device_session",
	);
}
