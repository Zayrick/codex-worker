import { ApiError } from "./errors";
import {
	isRecord,
	recordField,
	stringField,
	type JsonObject,
	type WorkerEnv,
} from "./types";

export interface CodexCredentials {
	token: string;
	accountId?: string;
}

interface OAuthSession {
	accessToken: string;
	accountId?: string;
	expiresAt?: number;
}

let cachedSource: string | undefined;
let cachedSession: OAuthSession | undefined;

function parseAuthJson(raw: string): OAuthSession {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ApiError(
			500,
			"CODEX_AUTH_JSON is not valid JSON.",
			"configuration_error",
			"invalid_codex_auth",
		);
	}
	if (!isRecord(parsed)) {
		throw new ApiError(
			500,
			"CODEX_AUTH_JSON must contain an auth.json object.",
			"configuration_error",
			"invalid_codex_auth",
		);
	}

	const tokens = recordField(parsed, "tokens");
	const accessToken = stringField(tokens, "access_token");
	if (!accessToken) {
		throw new ApiError(
			500,
			"CODEX_AUTH_JSON does not contain tokens.access_token.",
			"configuration_error",
			"invalid_codex_auth",
		);
	}

	const accessClaims = decodeJwt(accessToken);

	return {
		accessToken,
		accountId: stringField(tokens, "account_id"),
		expiresAt: jwtExpiry(accessClaims),
	};
}

export function getCodexCredentials(env: WorkerEnv): CodexCredentials {
	const source = env.CODEX_AUTH_JSON;
	if (!source) {
		throw new ApiError(
			500,
			"CODEX_AUTH_JSON is not configured.",
			"configuration_error",
			"missing_codex_auth",
		);
	}

	if (source !== cachedSource || !cachedSession) {
		cachedSource = source;
		cachedSession = parseAuthJson(source);
	}
	if (
		cachedSession.expiresAt !== undefined &&
		cachedSession.expiresAt <= Date.now()
	) {
		throw new ApiError(
			502,
			"The access token in CODEX_AUTH_JSON has expired. Re-import auth.json.",
			"upstream_authentication_error",
			"codex_token_expired",
		);
	}

	return {
		token: cachedSession.accessToken,
		accountId: cachedSession.accountId,
	};
}

function decodeJwt(token: string): JsonObject | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
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

function jwtExpiry(claims: JsonObject | undefined): number | undefined {
	const exp = claims?.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
	return exp * 1000;
}
