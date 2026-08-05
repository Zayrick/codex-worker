import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { storeApiKeys } from "../../src/auth/api-key";
import type { StoredOAuthCredentials } from "../../src/auth/credentials";

export const CLIENT_API_KEY = `sk-${"b".repeat(64)}`;
export const OTHER_API_KEY = `sk-${"c".repeat(64)}`;

export const ACCESS_TOKEN = jwt({ exp: 4_102_444_800 });
export const ID_TOKEN = jwt({
	email: "test@example.com",
	"https://api.openai.com/auth": {
		chatgpt_account_id: "account-test",
	},
});

export async function seedClientApiKeys(): Promise<void> {
	await storeApiKeys(env, [
		{ name: "secondary", key: OTHER_API_KEY, enabled: true },
		{ name: "primary", key: CLIENT_API_KEY, enabled: true },
	]);
}

export function baseCredentials(): StoredOAuthCredentials {
	return {
		version: 1,
		accessToken: ACCESS_TOKEN,
		refreshToken: "refresh-test",
		idToken: ID_TOKEN,
		accountId: "account-test",
		email: "test@example.com",
		expiresAt: 4_102_444_800_000,
		updatedAt: "2026-07-31T00:00:00.000Z",
	};
}

export function clientFetch(
	path: string,
	init?: RequestInit,
	apiKey = CLIENT_API_KEY,
): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${apiKey}`);
	return exports.default.fetch(`https://example.com${path}`, {
		...init,
		headers,
	});
}

export async function expectEmptyResponse(
	response: Response,
	status: 204 | 404,
): Promise<void> {
	expect(response.status).toBe(status);
	expect(response.headers.has("content-type")).toBe(false);
	expect(response.headers.has("access-control-allow-origin")).toBe(false);
	expect(await response.text()).toBe("");
}

function jwt(payload: Record<string, unknown>): string {
	return [
		Buffer.from("{}").toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"test-signature",
	].join(".");
}
