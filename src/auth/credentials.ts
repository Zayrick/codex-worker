import { ApiError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { openJson, sealJson } from "./envelope";

const OAUTH_KEY = "oauth";
const OAUTH_ENVELOPE_PURPOSE = "codex-worker/oauth/v1";
const DEFAULT_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const MAX_OAUTH_ENVELOPE_CHARS = 128 * 1024;

export interface CodexCredentials {
	token: string;
	accountId?: string;
}

export interface StoredOAuthCredentials {
	version: 1;
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	accountId?: string;
	email?: string;
	expiresAt: number;
	updatedAt: string;
}

export interface OAuthStatus {
	email: string | null;
	expiresAt: number;
}

type OAuthEnv = Pick<Env, "AUTH_KV" | "DATA_ENCRYPTION_KEY">;

export async function getCodexCredentials(
	env: OAuthEnv,
): Promise<CodexCredentials> {
	const credentials = await requireValidOAuthCredentials(env);
	return {
		token: credentials.accessToken,
		...(credentials.accountId ? { accountId: credentials.accountId } : {}),
	};
}

export async function requireValidOAuthCredentials(
	env: OAuthEnv,
): Promise<StoredOAuthCredentials> {
	const credentials = await readOAuthCredentials(env);
	if (!credentials) {
		throw new ApiError(
			503,
			"Upstream OAuth credentials are not configured.",
			"configuration_error",
			"missing_oauth_credentials",
		);
	}
	if (credentials.expiresAt <= Date.now()) {
		throw new ApiError(
			503,
			"Upstream OAuth credentials are awaiting refresh.",
			"upstream_authentication_error",
			"oauth_refresh_required",
		);
	}
	return credentials;
}

export async function requireOAuthUnconfigured(
	env: Pick<Env, "AUTH_KV">,
): Promise<void> {
	if ((await env.AUTH_KV.get(OAUTH_KEY)) !== null) {
		throw new ApiError(
			409,
			"OAuth credentials are already configured.",
			"invalid_request_error",
			"oauth_already_configured",
		);
	}
}

export async function readOAuthCredentials(
	env: OAuthEnv,
): Promise<StoredOAuthCredentials | null> {
	const encrypted = await env.AUTH_KV.get(OAUTH_KEY, {
		type: "text",
		cacheTtl: 30,
	});
	if (encrypted === null) return null;
	if (encrypted.length > MAX_OAUTH_ENVELOPE_CHARS) {
		throw invalidStoredCredentials();
	}

	try {
		const value = await openJson(
			encrypted,
			env.DATA_ENCRYPTION_KEY,
			OAUTH_ENVELOPE_PURPOSE,
		);
		return validateStoredCredentials(value);
	} catch {
		throw invalidStoredCredentials();
	}
}

export async function storeOAuthCredentials(
	env: OAuthEnv,
	credentials: StoredOAuthCredentials,
): Promise<void> {
	const validated = validateStoredCredentials(credentials);
	let encrypted: string;
	try {
		encrypted = await sealJson(
			validated,
			env.DATA_ENCRYPTION_KEY,
			OAUTH_ENVELOPE_PURPOSE,
		);
	} catch {
		throw invalidStoredCredentials();
	}
	await env.AUTH_KV.put(OAUTH_KEY, encrypted);
}

export async function deleteOAuthCredentials(
	env: Pick<Env, "AUTH_KV">,
): Promise<void> {
	await env.AUTH_KV.delete(OAUTH_KEY);
}

export function oauthStatus(
	credentials: StoredOAuthCredentials,
): OAuthStatus {
	return {
		email: credentials.email ?? null,
		expiresAt: credentials.expiresAt,
	};
}

export function credentialsFromTokenResponse(
	value: unknown,
	previous: StoredOAuthCredentials | undefined,
	now = Date.now(),
): StoredOAuthCredentials {
	if (!isRecord(value)) throw invalidProviderCredentials();
	const accessToken = stringField(value, "access_token");
	const refreshToken =
		stringField(value, "refresh_token") ?? previous?.refreshToken;
	if (!accessToken || !refreshToken) throw invalidProviderCredentials();

	const idToken = stringField(value, "id_token") ?? previous?.idToken;
	const accountId =
		stringField(value, "account_id") ??
		accountIdFromToken(idToken) ??
		previous?.accountId;
	const email =
		stringField(decodeJwt(idToken), "email") ?? previous?.email;
	const expiresIn = numberField(value, "expires_in");
	const expiresAt =
		expiresIn !== undefined && expiresIn > 0
			? now + expiresIn * 1000
			: jwtExpiry(accessToken) ?? now + DEFAULT_TOKEN_LIFETIME_MS;

	return {
		version: 1,
		accessToken,
		refreshToken,
		...(idToken ? { idToken } : {}),
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
		expiresAt,
		updatedAt: new Date(now).toISOString(),
	};
}

function validateStoredCredentials(value: unknown): StoredOAuthCredentials {
	if (!isRecord(value)) throw invalidStoredCredentials();
	const accessToken = stringField(value, "accessToken");
	const refreshToken = stringField(value, "refreshToken");
	const expiresAt = numberField(value, "expiresAt");
	const updatedAt = stringField(value, "updatedAt");
	if (
		value.version !== 1 ||
		!accessToken ||
		!refreshToken ||
		expiresAt === undefined ||
		expiresAt <= 0 ||
		!updatedAt
	) {
		throw invalidStoredCredentials();
	}
	const idToken = stringField(value, "idToken");
	const accountId = stringField(value, "accountId");
	const email = stringField(value, "email");
	return {
		version: 1,
		accessToken,
		refreshToken,
		...(idToken ? { idToken } : {}),
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
		expiresAt,
		updatedAt,
	};
}

function decodeJwt(token: string | undefined): JsonObject | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = parts[1];
		if (!payload) return undefined;
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (character) =>
			character.charCodeAt(0),
		);
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function jwtExpiry(token: string): number | undefined {
	const exp = numberField(decodeJwt(token), "exp");
	return exp !== undefined && exp > 0 ? exp * 1000 : undefined;
}

function accountIdFromToken(token: string | undefined): string | undefined {
	const claims = decodeJwt(token);
	const auth = recordField(claims, "https://api.openai.com/auth");
	return stringField(auth, "chatgpt_account_id");
}

function invalidProviderCredentials(): ApiError {
	return new ApiError(
		502,
		"The OAuth provider returned an invalid token response.",
		"upstream_error",
		"invalid_oauth_token_response",
	);
}

function invalidStoredCredentials(): ApiError {
	return new ApiError(
		500,
		"Stored OAuth credentials are unavailable.",
		"configuration_error",
		"invalid_oauth_credentials",
	);
}
