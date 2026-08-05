import { env, exports } from "cloudflare:workers";
import { storeApiKeys } from "../../src/auth/api-key";
import { storeOAuthCredentials } from "../../src/auth/credentials";

export const CREATED_AT = 1_754_006_400;
export const TEST_API_KEY = `sk-${"a".repeat(64)}`;
const TEST_ACCESS_TOKEN = [
	"e30",
	Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
	"test-signature",
].join(".");

export const TEST_OAUTH = {
	version: 1 as const,
	accessToken: TEST_ACCESS_TOKEN,
	refreshToken: "test-refresh-token",
	accountId: "account-test",
	email: "worker@example.com",
	expiresAt: 4_102_444_800_000,
	updatedAt: "2026-07-31T00:00:00.000Z",
};

export async function seedWorkerAuth(): Promise<void> {
	await storeApiKeys(env, [
		{ name: "test-client", key: TEST_API_KEY, enabled: true },
	]);
	await storeOAuthCredentials(env, TEST_OAUTH);
}

export function authenticatedFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${TEST_API_KEY}`);
	return exports.default.fetch(input, { ...init, headers });
}
