import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	adminSecretMatches,
	adminSessionCookieHeader,
	createAdminSession,
	hasValidAdminSession,
} from "../../src/auth/admin-session";

describe("encrypted admin sessions", () => {
	it("accepts the configured admin secret with a constant-time comparison", async () => {
		await expect(
			adminSecretMatches(env.ADMIN_SECRET, env.ADMIN_SECRET),
		).resolves.toBe(true);
		await expect(
			adminSecretMatches("wrong-admin-secret", env.ADMIN_SECRET),
		).resolves.toBe(false);
	});

	it("expires sessions and invalidates them when ADMIN_SECRET rotates", async () => {
		const now = 1_800_000_000_000;
		const token = await createAdminSession(env, now);
		const cookie = adminSessionCookieHeader(token).split(";", 1)[0] ?? "";
		const request = new Request("https://example.com/admin", {
			headers: { Cookie: cookie },
		});

		await expect(hasValidAdminSession(request, env, now)).resolves.toBe(true);
		await expect(
			hasValidAdminSession(
				request,
				{
					ADMIN_SECRET: "rotated-admin-secret",
					DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY,
				},
				now,
			),
		).resolves.toBe(false);
		await expect(
			hasValidAdminSession(request, env, now + 12 * 60 * 60 * 1000),
		).resolves.toBe(false);
	});

	it("rejects a modified encrypted cookie", async () => {
		const token = await createAdminSession(env);
		const cookie = adminSessionCookieHeader(`${token}corrupt`).split(";", 1)[0] ?? "";
		await expect(
			hasValidAdminSession(
				new Request("https://example.com/admin", {
					headers: { Cookie: cookie },
				}),
				env,
			),
		).resolves.toBe(false);
	});
});
