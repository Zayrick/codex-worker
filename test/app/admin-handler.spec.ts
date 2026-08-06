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
import { readApiKeys } from "../../worker/auth/api-key";
import {
	deleteOAuthCredentials,
	readOAuthCredentials,
	storeOAuthCredentials,
} from "../../worker/auth/credentials";
import { fetchMock } from "../support/fetch-mock";
import {
	ACCESS_TOKEN,
	baseCredentials,
	expectEmptyResponse,
	ID_TOKEN,
	seedClientApiKeys,
} from "../support/auth-fixture";

const NEW_API_KEY = `sk-${"d".repeat(19)}3`;
const UPDATED_API_KEY = `sk-${"e".repeat(19)}4`;

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
		expect(page.headers.get("Content-Security-Policy")).toMatch(
			/script-src 'self' 'nonce-/,
		);
		expect(page.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
		expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
		const html = await page.text();
		expect(html).toContain('data-testid="admin-react-shell"');
		expect(html).toMatch(/<script[^>]+nonce="[^"]+"/);
		expect(html).not.toContain("__CODEX_WORKER_CSP_NONCE__");
		expect(html).not.toContain(env.ADMIN_SECRET);
		expect(html).not.toContain(env.DATA_ENCRYPTION_KEY);

		const rejected = await login("wrong-admin-secret");
		expect(rejected.status).toBe(401);
		expect(rejected.headers.has("Set-Cookie")).toBe(false);
		expect(await rejected.json()).toMatchObject({
			error: {
				code: "invalid_admin_secret",
				message: "管理密钥无效。",
			},
		});

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
		expect(dashboardHtml).toContain('data-testid="admin-react-shell"');
		expect(dashboardHtml).not.toContain(env.ADMIN_SECRET);
		expect(dashboardHtml).not.toContain(ACCESS_TOKEN);
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
			subscription: {
				planType: "plus",
				subscriptionActiveStart: Date.parse("2026-01-01T00:00:00.000Z"),
				subscriptionActiveUntil: 1_800_000_000_000,
			},
			apiKeys: [
				{ name: "primary", key: `sk-${"b".repeat(19)}1`, enabled: true },
				{ name: "secondary", key: `sk-${"c".repeat(19)}2`, enabled: true },
			],
		});
	});

	it("fetches and normalizes Codex subscription quotas through the trusted relay", async () => {
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		const startedAt = Date.now();
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/wham/usage",
				method: "GET",
			})
			.reply(({ headers, signal }) => {
				expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
				expect(headers.get("Chatgpt-Account-Id")).toBe("account-test");
				expect(headers.get("Accept")).toBe("application/json");
				expect(headers.get("User-Agent")).toContain("codex_cli_rs/");
				expect(signal).toBeDefined();
				return {
					statusCode: 200,
					data: JSON.stringify({
						plan_type: "pro",
						rate_limit: {
							allowed: true,
							primary_window: {
								used_percent: 1,
								limit_window_seconds: 604_800,
								reset_at: 1_805_000_000,
							},
							secondary_window: {
								usedPercent: "42.5",
								limitWindowSeconds: "18000",
								resetAfterSeconds: 3_600,
							},
						},
						code_review_rate_limit: {
							allowed: false,
							primary_window: {
								limit_window_seconds: 18_000,
								reset_at: 1_805_000_100,
							},
						},
						additional_rate_limits: [
							{
								limit_name: "GPT-5.3-Codex-Spark",
								rate_limit: {
									primary_window: {
										used_percent: 9,
										limit_window_seconds: 28 * 24 * 60 * 60,
										reset_at: 1_806_000_000,
									},
								},
							},
						],
						rate_limit_reset_credits: {
							available_count: "2",
							applicable_available_count: 1,
						},
					}),
					responseOptions: {
						headers: { "Content-Type": "application/json" },
					},
				};
			});

		const response = await adminFetch("/subscription", cookie);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const body = (await response.json()) as {
			subscription: {
				fetchedAt: number;
				windows: Array<Record<string, unknown>>;
			};
		};
		expect(body.subscription).toMatchObject({
			planType: "pro",
			subscriptionActiveStart: Date.parse("2026-01-01T00:00:00.000Z"),
			subscriptionActiveUntil: 1_800_000_000_000,
			rateLimitResetCredits: {
				availableCount: 2,
				applicableAvailableCount: 1,
			},
		});
		expect(body.subscription.fetchedAt).toBeGreaterThanOrEqual(startedAt);
		expect(body.subscription.windows).toHaveLength(4);
		expect(body.subscription.windows).toEqual([
			expect.objectContaining({
				category: "codex",
				kind: "five_hour",
				usedPercent: 42.5,
				remainingPercent: 57.5,
				limitWindowSeconds: 18_000,
			}),
				expect.objectContaining({
					category: "codex",
					kind: "weekly",
					usedPercent: 1,
					remainingPercent: 99,
					resetAt: 1_805_000_000_000,
				}),
			expect.objectContaining({
				category: "code_review",
				kind: "five_hour",
				usedPercent: 100,
				remainingPercent: 0,
				limitReached: true,
			}),
			expect.objectContaining({
				category: "additional",
				name: "GPT-5.3-Codex-Spark",
				kind: "monthly",
				usedPercent: 9,
				remainingPercent: 91,
			}),
		]);
		const relativeReset = Number(body.subscription.windows[0]?.resetAt);
		expect(relativeReset).toBeGreaterThanOrEqual(startedAt + 3_599_000);
		expect(relativeReset).toBeLessThanOrEqual(Date.now() + 3_601_000);
		expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
	});

	it("contains rejected subscription responses behind a safe management error", async () => {
		const cookie = sessionCookie(await login(env.ADMIN_SECRET));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/wham/usage",
				method: "GET",
			})
			.reply(401, `upstream secret ${ACCESS_TOKEN}`);

		const response = await adminFetch("/subscription", cookie);
		expect(response.status).toBe(502);
		const body = await response.text();
		expect(body).not.toContain(ACCESS_TOKEN);
		expect(JSON.parse(body)).toMatchObject({
			error: { code: "codex_usage_upstream_error" },
		});
		expect(errorLog).toHaveBeenCalledWith(
			JSON.stringify({
				event: "admin_request",
				status: "failed",
				code: "codex_usage_upstream_error",
			}),
		);
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
