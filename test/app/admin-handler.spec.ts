import { env, exports } from "cloudflare:workers";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { readApiKeys } from "../../src/auth/api-key";
import {
	deleteOAuthCredentials,
	readOAuthCredentials,
	storeOAuthCredentials,
} from "../../src/auth/credentials";
import { fetchMock } from "../support/fetch-mock";
import {
	baseCredentials,
	expectEmptyResponse,
	ID_TOKEN,
	seedClientApiKeys,
} from "../support/auth-fixture";

const NEW_API_KEY = `sk-${"d".repeat(64)}`;
const UPDATED_API_KEY = `sk-${"e".repeat(64)}`;

beforeAll(() => {
	fetchMock.install();
});

beforeEach(async () => {
	await seedClientApiKeys();
	await storeOAuthCredentials(env, baseCredentials());
});

afterEach(() => {
	fetchMock.verify();
	vi.restoreAllMocks();
});

afterAll(() => {
	fetchMock.restore();
});

describe("protected management panel", () => {
	it("removes every public /auth/device route and hides other admin paths", async () => {
		for (const [method, path] of [
			["GET", "/auth/device/start"],
			["POST", "/auth/device/start"],
			["GET", "/auth/device/poll?state=opaque"],
			["GET", "/wrong-management-path/admin"],
		] as const) {
			await expectEmptyResponse(
				await exports.default.fetch(`https://example.com${path}`, { method }),
				404,
			);
		}
	});

	it("logs in with ADMIN_SECRET and issues a hardened encrypted session cookie", async () => {
		const page = await exports.default.fetch(adminUrl());
		expect(page.status).toBe(200);
		expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
		expect(page.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
		expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
		const html = await page.text();
		expect(html).toContain(`action="${adminPath()}/login"`);
		expect(html).toContain('name="secret" type="password"');
		expect(html).not.toContain(env.ADMIN_SECRET);
		expect(html).not.toContain(env.DATA_ENCRYPTION_KEY);

		const rejected = await login("wrong-admin-secret");
		expect(rejected.status).toBe(401);
		expect(rejected.headers.has("Set-Cookie")).toBe(false);
		expect(await rejected.text()).toContain("管理密钥无效");

		const accepted = await login(env.ADMIN_SECRET);
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("Location")).toBe(adminUrl());
		const setCookie = accepted.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("__Host-codex-admin=");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).not.toContain(env.ADMIN_SECRET);
		expect(setCookie).not.toContain(env.DATA_ENCRYPTION_KEY);

		const dashboard = await adminFetch("", sessionCookie(accepted));
		expect(dashboard.status).toBe(200);
		const dashboardHtml = await dashboard.text();
		expect(dashboardHtml).toContain("Codex OAuth");
		expect(dashboardHtml).toContain("API Keys");
		expect(dashboardHtml).toContain("crypto.getRandomValues(bytes)");
		expect(dashboardHtml).toContain(
			'const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"',
		);
		expect(dashboardHtml).toContain('return "sk-" + value');
	});

	it("returns OAuth metadata and API keys only to an authenticated session", async () => {
		const unauthenticated = await exports.default.fetch(`${adminUrl()}/state`);
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toMatchObject({
			error: { code: "invalid_admin_session" },
		});

		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		const response = await adminFetch("/state", cookie);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			oauth: {
				email: "test@example.com",
				expiresAt: 4_102_444_800_000,
			},
			apiKeys: [
				{ name: "primary", key: `sk-${"b".repeat(64)}`, enabled: true },
				{ name: "secondary", key: `sk-${"c".repeat(64)}`, enabled: true },
			],
		});
	});

	it("contains corrupt encrypted management data behind a safe JSON error", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		await env.AUTH_KV.put("API_KEYS", "corrupt-api-key-envelope-marker");

		const response = await adminFetch("/state", cookie);
		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toMatchObject({
			error: { code: "invalid_stored_api_keys" },
		});
		expect(body).not.toContain("corrupt-api-key-envelope-marker");
		expect(body).not.toContain(env.ADMIN_SECRET);
		expect(errorLog).toHaveBeenCalledWith(
			JSON.stringify({
				event: "admin_request",
				status: "failed",
				code: "invalid_stored_api_keys",
			}),
		);
	});

	it("requires same-origin mutations and supports API-key CRUD", async () => {
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		const crossOrigin = await adminFetch("/api-keys", cookie, {
			method: "POST",
			headers: { Origin: "https://attacker.example" },
			body: JSON.stringify({
				name: "new",
				key: NEW_API_KEY,
				enabled: true,
			}),
		});
		expect(crossOrigin.status).toBe(403);
		expect(await crossOrigin.json()).toMatchObject({
			error: { code: "invalid_admin_origin" },
		});

		const created = await adminFetch("/api-keys", cookie, {
			method: "POST",
			body: JSON.stringify({
				name: "new",
				key: NEW_API_KEY,
				enabled: true,
			}),
		});
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { apiKeys: unknown[] };
		expect(createdBody.apiKeys).toContainEqual({
			name: "new",
			key: NEW_API_KEY,
			enabled: true,
		});

		const updated = await adminFetch("/api-keys", cookie, {
			method: "PUT",
			body: JSON.stringify({
				originalName: "new",
				name: "renamed",
				key: UPDATED_API_KEY,
				enabled: false,
			}),
		});
		expect(updated.status).toBe(200);
		const updatedBody = (await updated.json()) as { apiKeys: unknown[] };
		expect(updatedBody.apiKeys).toContainEqual({
			name: "renamed",
			key: UPDATED_API_KEY,
			enabled: false,
		});

		const removed = await adminFetch("/api-keys", cookie, {
			method: "DELETE",
			body: JSON.stringify({ name: "renamed" }),
		});
		expect(removed.status).toBe(200);
		const removedBody = (await removed.json()) as { apiKeys: unknown[] };
		expect(removedBody.apiKeys).not.toContainEqual(
			expect.objectContaining({ name: "renamed" }),
		);
		expect(await readApiKeys(env)).not.toContainEqual(
			expect.objectContaining({ name: "renamed" }),
		);

		const raw = await env.AUTH_KV.get("API_KEYS");
		expect(raw).not.toContain(NEW_API_KEY);
		expect(raw).not.toContain(UPDATED_API_KEY);
		expect(raw).not.toContain("primary");
	});

	it("removes OAuth credentials from the panel", async () => {
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		const response = await adminFetch("/oauth", cookie, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ oauth: null });
		expect(await env.AUTH_KV.get("oauth")).toBeNull();
	});

	it("starts and polls device login through authenticated admin endpoints", async () => {
		await deleteOAuthCredentials(env);
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		mockDeviceStart();
		const started = await adminFetch("/oauth/device", cookie, { method: "POST" });
		expect(started.status).toBe(201);
		const authorization = (await started.json()) as {
			verificationUri: string;
			userCode: string;
			interval: number;
			state: string;
		};
		expect(authorization).toMatchObject({
			verificationUri: "https://auth.openai.com/codex/device",
			userCode: "ABCD-EFGH",
			interval: 1,
		});
		expect(JSON.stringify(authorization)).not.toContain("device-auth-test");

		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/api/accounts/deviceauth/token",
				method: "POST",
			})
			.reply(403, "");
		const pending = await adminFetch("/oauth/device/poll", cookie, {
			method: "POST",
			body: JSON.stringify({ state: authorization.state }),
		});
		expect(pending.status).toBe(202);
		expect(await pending.json()).toEqual({ status: "pending", retryAfter: 1 });

		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/api/accounts/deviceauth/token",
				method: "POST",
			})
			.reply(
				200,
				JSON.stringify({
					authorization_code: "authorization-code-test",
					code_verifier: "code-verifier-test",
					code_challenge: "code-challenge-test",
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/oauth/token",
				method: "POST",
			})
			.reply(
				200,
				JSON.stringify({
					access_token: "device-access-token",
					refresh_token: "device-refresh-token",
					id_token: ID_TOKEN,
					expires_in: 3600,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);

		const completed = await adminFetch("/oauth/device/poll", cookie, {
			method: "POST",
			body: JSON.stringify({ state: authorization.state }),
		});
		expect(completed.status).toBe(200);
		expect(await completed.json()).toMatchObject({
			status: "stored",
			oauth: { email: "test@example.com" },
		});
		const raw = await env.AUTH_KV.get("oauth");
		expect(raw).not.toContain("device-access-token");
		expect(raw).not.toContain("device-refresh-token");
		expect(await readOAuthCredentials(env)).toMatchObject({
			accessToken: "device-access-token",
			refreshToken: "device-refresh-token",
			email: "test@example.com",
		});
	});
});

function adminPath(): string {
	return `/${env.ADMIN_PATH}/admin`;
}

function adminUrl(): string {
	return `https://example.com${adminPath()}`;
}

function login(secret: string): Promise<Response> {
	return exports.default.fetch(`${adminUrl()}/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: "https://example.com",
		},
		body: new URLSearchParams({ secret }),
	});
}

function sessionCookie(response: Response): string {
	const setCookie = response.headers.get("Set-Cookie");
	if (!setCookie) throw new Error("Login response is missing its session cookie.");
	return setCookie.split(";", 1)[0] ?? "";
}

function adminFetch(
	path: string,
	cookie: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Cookie", cookie);
	if ((init.method ?? "GET") !== "GET" && !headers.has("Origin")) {
		headers.set("Origin", "https://example.com");
	}
	return exports.default.fetch(`${adminUrl()}${path}`, { ...init, headers });
}

function mockDeviceStart(): void {
	fetchMock
		.intercept({
			origin: "https://auth.openai.com",
			path: "/api/accounts/deviceauth/usercode",
			method: "POST",
		})
		.reply(
			200,
			JSON.stringify({
				device_auth_id: "device-auth-test",
				user_code: "ABCD-EFGH",
				interval: 1,
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
}
