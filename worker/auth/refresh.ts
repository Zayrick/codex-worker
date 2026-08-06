import {
	credentialsFromTokenResponse,
	readOAuthCredentials,
	storeOAuthCredentials,
} from "./credentials";
import { refreshProviderToken } from "./oauth-provider";

const REFRESH_WINDOW_MS = 3 * 60 * 60 * 1000;

type OAuthEnv = Pick<Env, "AUTH_KV" | "DATA_ENCRYPTION_KEY">;

type OAuthRefreshResult = "missing" | "not_due" | "refreshed";

export async function refreshOAuthCredentials(
	env: OAuthEnv,
	now = Date.now(),
): Promise<OAuthRefreshResult> {
	const current = await readOAuthCredentials(env);
	if (!current) return "missing";
	if (current.expiresAt > now + REFRESH_WINDOW_MS) {
		return "not_due";
	}

	const tokenPayload = await refreshProviderToken(current.refreshToken);
	const updated = credentialsFromTokenResponse(
		tokenPayload,
		current,
		Date.now(),
	);
	await storeOAuthCredentials(env, updated);
	return "refreshed";
}
