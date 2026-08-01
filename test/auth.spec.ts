import {
	createExecutionContext,
	createScheduledController,
	env,
	fetchMock,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
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
import {
	readOAuthCredentials,
	storeOAuthCredentials,
	type StoredOAuthCredentials,
} from "../src/auth";
import {
	authenticateClient,
	constantTimeEqual,
} from "../src/client-auth";
import worker from "../src/index";

const CLIENT_API_KEY = "sk-test-client-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OTHER_API_KEY = "sk-test-other-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ACCESS_TOKEN = jwt({ exp: 4_102_444_800 });
const ID_TOKEN = jwt({
	email: "test@example.com",
	"https://api.openai.com/auth": {
		chatgpt_account_id: "account-test",
	},
});

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await Promise.all([
		env.AUTH_KV.put("API-secondary", OTHER_API_KEY),
		env.AUTH_KV.put("API-primary", CLIENT_API_KEY),
	]);
});

beforeEach(async () => {
	await storeOAuthCredentials(env, baseCredentials());
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
	vi.restoreAllMocks();
});

afterAll(() => {
	fetchMock.deactivate();
});

describe("encrypted OAuth storage", () => {
	it("stores only an AES-GCM envelope under oauth", async () => {
		const raw = await env.AUTH_KV.get("oauth");
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(ACCESS_TOKEN);
		expect(raw).not.toContain("refresh-test");
		expect(raw).not.toContain("account-test");
		expect(JSON.parse(raw!)).toMatchObject({ v: 1, alg: "A256GCM" });

		const restored = await readOAuthCredentials(env);
		expect(restored).toMatchObject({
			accessToken: ACCESS_TOKEN,
			refreshToken: "refresh-test",
			accountId: "account-test",
		});
	});

	it("never includes key material or envelopes in decryption errors", async () => {
		const corrupt = JSON.stringify({
			v: 1,
			alg: "A256GCM",
			iv: "iv-marker",
			ciphertext: "ciphertext-marker",
		});
		await env.AUTH_KV.put("oauth", corrupt);
		const response = await clientFetch("/v1/models");
		const body = await response.text();
		expect(response.status).toBe(500);
		for (const sensitive of [
			"iv-marker",
			"ciphertext-marker",
			env.OAUTH_MASTER_KEY,
			CLIENT_API_KEY,
		]) {
			expect(body).not.toContain(sensitive);
		}
		expect(JSON.parse(body)).toMatchObject({
			error: { code: "invalid_oauth_credentials" },
		});
	});
});

describe("API-* value authentication", () => {
	it("lists API-* labels and matches their opaque values across pages", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				keys: [{ name: "API-first" }],
				list_complete: false,
				cursor: "next-page",
			})
			.mockResolvedValueOnce({
				keys: [{ name: "API-second" }],
				list_complete: true,
				cursor: "",
			});
		const get = vi
			.fn()
			.mockResolvedValueOnce(new Map([["API-first", OTHER_API_KEY]]))
			.mockResolvedValueOnce(new Map([["API-second", CLIENT_API_KEY]]));

		await authenticateClient(
			new Request("https://example.com/v1/models", {
				headers: { Authorization: `Bearer ${CLIENT_API_KEY}` },
			}),
			{
				AUTH_KV: { list, get } as unknown as KVNamespace,
			},
		);

		expect(list).toHaveBeenNthCalledWith(1, { prefix: "API-" });
		expect(list).toHaveBeenNthCalledWith(2, {
			prefix: "API-",
			cursor: "next-page",
		});
		expect(get).toHaveBeenNthCalledWith(1, ["API-first"], {
			type: "text",
			cacheTtl: 30,
		});
		expect(get).toHaveBeenNthCalledWith(2, ["API-second"], {
			type: "text",
			cacheTtl: 30,
		});
	});

	it("uses a constant-time comparison and rejects wrong or unknown keys", async () => {
		expect(await constantTimeEqual(CLIENT_API_KEY, CLIENT_API_KEY)).toBe(true);
		expect(
			await constantTimeEqual(
				CLIENT_API_KEY,
				"sk-test-wrong-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
			),
		).toBe(false);

		const wrong = await clientFetch(
			"/v1/models",
			undefined,
			"sk-test-wrong-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
		);
		expect(wrong.status).toBe(401);
		const missing = await clientFetch(
			"/v1/models",
			undefined,
			"sk-test-missing-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
		);
		expect(missing.status).toBe(401);
	});
});

describe("Codex device authorization", () => {
	it("serves a browser error page when the secret query parameter is invalid", async () => {
		const apiKeyOnly = await deviceStart(undefined, {
			headers: { Authorization: `Bearer ${CLIENT_API_KEY}` },
		});
		expect(apiKeyOnly.status).toBe(401);
		expect(apiKeyOnly.headers.get("Content-Type")).toContain("text/html");
		expect(await apiKeyOnly.text()).toContain("invalid_oauth_device_secret");

		const wrongSecret = await deviceStart("wrong-oauth-master-key");
		expect(wrongSecret.status).toBe(401);
		expect(wrongSecret.headers.get("Content-Type")).toContain("text/html");
		expect(await wrongSecret.text()).toContain("invalid_oauth_device_secret");
	});

	it("refuses to replace OAuth credentials already stored in KV", async () => {
		const response = await deviceStart(env.OAUTH_MASTER_KEY);
		expect(response.status).toBe(409);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(await response.text()).toContain("oauth_already_configured");
	});

	describe("when oauth is absent", () => {
		beforeEach(async () => {
			await env.AUTH_KV.delete("oauth");
		});

		it("renders two plain-text lines, polls invisibly, and closes on completion", async () => {
			mockDeviceStart();
			const started = await deviceStart(env.OAUTH_MASTER_KEY);
			expect(started.status).toBe(200);
			expect(started.headers.get("Content-Type")).toContain("text/html");
			const page = await started.text();
			expect(page).toContain("设备码：ABCD-EFGH<br>");
			expect(page).toContain(
				'验证页面：<a href="https://auth.openai.com/codex/device"',
			);
			expect(page).toContain(
				'>https://auth.openai.com/codex/device</a>',
			);
			expect(page).toContain('id="device-status"');
			expect(page).toContain(" hidden></iframe>");
			expect(page).toContain("http-equiv=&quot;refresh&quot;");
			expect(page).not.toContain("device-auth-test");
			expect(page).not.toContain("<style");
			expect(page).not.toContain("<h1");
			expect(page).toContain(
				'event.data === "device-authorization-complete"',
			);
			expect(page).toContain("window.close();");

			const pollUrl = pollUrlFromDevicePage(page);
			expect(pollUrl.pathname).toBe("/auth/device/poll");
			expect(pollUrl.searchParams.get("secret")).toBe(env.OAUTH_MASTER_KEY);
			expect(pollUrl.searchParams.get("state")).toBeTruthy();
			expect(refreshUrlFromDocument(iframeDocumentFromPage(page)).toString()).toBe(
				pollUrl.toString(),
			);

			const rejectedUrl = new URL(pollUrl);
			rejectedUrl.searchParams.set("secret", "wrong-oauth-master-key");
			const rejected = await SELF.fetch(rejectedUrl.toString());
			expect(rejected.status).toBe(401);
			expect(rejected.headers.get("Content-Type")).toContain("text/html");
			expect(await rejected.text()).toContain("invalid_oauth_device_secret");

			fetchMock
				.get("https://auth.openai.com")
				.intercept({
					path: "/api/accounts/deviceauth/token",
					method: "POST",
				})
				.reply(403, "");
			const pending = await SELF.fetch(pollUrl.toString());
			expect(pending.status).toBe(202);
			expect(pending.headers.get("Content-Type")).toContain("text/html");
			const pendingPage = await pending.text();
			expect(pendingPage).toContain('http-equiv="refresh"');
			expect(pendingPage).toContain("尚未完成验证，1 秒后再次检查");
			expect(pendingPage).not.toContain("<style");
			expect(refreshUrlFromDocument(pendingPage).toString()).toBe(
				pollUrl.toString(),
			);
		});

		it("exchanges an approved device code and stores only ciphertext", async () => {
			mockDeviceStart();
			const started = await deviceStart(env.OAUTH_MASTER_KEY);
			const pollUrl = pollUrlFromDevicePage(await started.text());

			fetchMock
				.get("https://auth.openai.com")
				.intercept({
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
				.get("https://auth.openai.com")
				.intercept({ path: "/oauth/token", method: "POST" })
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

			const completed = await SELF.fetch(pollUrl.toString());
			expect(completed.status).toBe(200);
			expect(completed.headers.get("Content-Type")).toContain("text/html");
			const completedPage = await completed.text();
			expect(completedPage).toContain("登录完成，OAuth 凭据已保存");
			expect(completedPage).toContain(
				'window.parent.postMessage("device-authorization-complete", window.location.origin)',
			);
			expect(completedPage).not.toContain("<style");
			const raw = await env.AUTH_KV.get("oauth");
			expect(raw).not.toContain("device-access-token");
			expect(raw).not.toContain("device-refresh-token");
			expect(await readOAuthCredentials(env)).toMatchObject({
				accessToken: "device-access-token",
				refreshToken: "device-refresh-token",
				accountId: "account-test",
			});
		});
	});
});

describe("scheduled token refresh and redaction", () => {
	it("refreshes an expiring token and re-encrypts oauth", async () => {
		await storeOAuthCredentials(env, {
			...baseCredentials(),
			expiresAt: Date.now() + 60_000,
		});
		let refreshForm: URLSearchParams | undefined;
		fetchMock
			.get("https://auth.openai.com")
			.intercept({ path: "/oauth/token", method: "POST" })
			.reply((options) => {
				refreshForm = new URLSearchParams(String(options.body));
				return {
					statusCode: 200,
					data: JSON.stringify({
						access_token: "refreshed-access-token",
						refresh_token: "refreshed-refresh-token",
						id_token: ID_TOKEN,
						expires_in: 3600,
					}),
					responseOptions: {
						headers: { "Content-Type": "application/json" },
					},
				};
			});

		const ctx = createExecutionContext();
		await worker.scheduled(
			createScheduledController({ cron: "*/10 * * * *" }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(refreshForm?.get("grant_type")).toBe("refresh_token");
		expect(refreshForm?.get("refresh_token")).toBe("refresh-test");
		const raw = await env.AUTH_KV.get("oauth");
		expect(raw).not.toContain("refreshed-access-token");
		expect(await readOAuthCredentials(env)).toMatchObject({
			accessToken: "refreshed-access-token",
			refreshToken: "refreshed-refresh-token",
		});
	});

	it("does not copy upstream credential text into API errors", async () => {
		const raw = JSON.parse((await env.AUTH_KV.get("oauth"))!) as {
			iv: string;
			ciphertext: string;
		};
		fetchMock
			.get("https://codex-relay.test")
			.intercept({
				path: "/backend-api/codex/models?client_version=0.144.1",
				method: "GET",
			})
			.reply(
				401,
				JSON.stringify({
					error: {
						message: [
							ACCESS_TOKEN,
							"refresh-test",
							env.OAUTH_MASTER_KEY,
							raw.iv,
							raw.ciphertext,
						].join(" "),
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			);

		const response = await clientFetch("/v1/models");
		const body = await response.text();
		expect(response.status).toBe(502);
		for (const sensitive of [
			ACCESS_TOKEN,
			"refresh-test",
			env.OAUTH_MASTER_KEY,
			raw.iv,
			raw.ciphertext,
		]) {
			expect(body).not.toContain(sensitive);
		}
	});

	it("logs only a safe code when scheduled refresh fails", async () => {
		await storeOAuthCredentials(env, {
			...baseCredentials(),
			expiresAt: Date.now() + 60_000,
		});
		const raw = JSON.parse((await env.AUTH_KV.get("oauth"))!) as {
			iv: string;
			ciphertext: string;
		};
		fetchMock
			.get("https://auth.openai.com")
			.intercept({ path: "/oauth/token", method: "POST" })
			.reply(
				400,
				[
					ACCESS_TOKEN,
					"refresh-test",
					env.OAUTH_MASTER_KEY,
					raw.iv,
					raw.ciphertext,
				].join(" "),
			);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);
		const logged = errorLog.mock.calls.flat().join(" ");
		expect(logged).toContain("oauth_provider_error");
		for (const sensitive of [
			ACCESS_TOKEN,
			"refresh-test",
			env.OAUTH_MASTER_KEY,
			raw.iv,
			raw.ciphertext,
		]) {
			expect(logged).not.toContain(sensitive);
		}
	});
});

function baseCredentials(): StoredOAuthCredentials {
	return {
		version: 1,
		accessToken: ACCESS_TOKEN,
		refreshToken: "refresh-test",
		idToken: ID_TOKEN,
		accountId: "account-test",
		expiresAt: 4_102_444_800_000,
		updatedAt: "2026-07-31T00:00:00.000Z",
	};
}

function mockDeviceStart(): void {
	fetchMock
		.get("https://auth.openai.com")
		.intercept({
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

function deviceStart(
	secret?: string,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL("https://example.com/auth/device/start");
	if (secret !== undefined) url.searchParams.set("secret", secret);
	return SELF.fetch(url.toString(), init);
}

function pollUrlFromDevicePage(page: string): URL {
	const match = page.match(/data-poll-url="([^"]+)"/);
	if (!match) throw new Error("Device page is missing its poll URL.");
	return new URL(decodeHtmlAttribute(match[1]));
}

function iframeDocumentFromPage(page: string): string {
	const match = page.match(/srcdoc="([^"]+)"/);
	if (!match) throw new Error("Device page is missing its iframe document.");
	return decodeHtmlAttribute(match[1]);
}

function refreshUrlFromDocument(document: string): URL {
	const match = document.match(
		/<meta http-equiv="refresh" content="\d+;url=([^"]+)">/,
	);
	if (!match) throw new Error("Device status document is missing its refresh URL.");
	return new URL(decodeHtmlAttribute(match[1]));
}

function decodeHtmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function clientFetch(
	path: string,
	init?: RequestInit,
	apiKey = CLIENT_API_KEY,
): Promise<Response> {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${apiKey}`);
	return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

function jwt(payload: Record<string, unknown>): string {
	return [
		Buffer.from("{}").toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"test-signature",
	].join(".");
}
