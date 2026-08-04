import { env } from "cloudflare:workers";
import {
	createExecutionContext,
	createScheduledController,
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
} from "../../src/auth/credentials";
import {
	refreshProviderToken,
	requestDeviceAuthorization,
} from "../../src/auth/oauth-provider";
import worker from "../../src/index";
import { fetchMock } from "../support/fetch-mock";
import {
	ACCESS_TOKEN,
	baseCredentials,
	clientFetch,
	ID_TOKEN,
	seedClientApiKeys,
} from "../support/auth-fixture";

beforeAll(async () => {
	fetchMock.install();
	await seedClientApiKeys();
});

beforeEach(async () => {
	await storeOAuthCredentials(env, baseCredentials());
});

afterEach(() => {
	fetchMock.verify();
	vi.restoreAllMocks();
});

afterAll(() => {
	fetchMock.restore();
});

describe("scheduled token refresh and redaction", () => {
	it("propagates a client abort after provider response headers", async () => {
		const client = new AbortController();
		let bodyStartedResolve: (() => void) | undefined;
		const bodyStarted = new Promise<void>((resolve) => {
			bodyStartedResolve = resolve;
		});
		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/api/accounts/deviceauth/usercode",
				method: "POST",
			})
			.reply(({ signal }) => {
				if (!signal) throw new Error("Provider fetch is missing its abort signal.");
				return {
					statusCode: 200,
					data: new ReadableStream<Uint8Array>({
						start(controller) {
							signal.addEventListener(
								"abort",
								() => controller.error(signal.reason),
								{ once: true },
							);
							bodyStartedResolve?.();
						},
					}),
				};
			});

		const authorization = requestDeviceAuthorization(client.signal);
		await bodyStarted;
		client.abort();
		await expect(authorization).rejects.toMatchObject({ name: "AbortError" });
	});

	it.each([
		["network failure", "network"],
		["response-body failure", "body"],
		["HTTP 429", 429],
		["HTTP 5xx", 503],
	] as const)("retries a transient %s", async (_label, failure) => {
		vi.useFakeTimers();
		const first = fetchMock.intercept({
			origin: "https://auth.openai.com",
			path: "/oauth/token",
			method: "POST",
		});
		if (failure === "network") {
			first.reply(() => {
				throw new TypeError("simulated network failure");
			});
		} else if (failure === "body") {
			first.reply(() => ({
				statusCode: 200,
				data: new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(new TypeError("simulated body failure"));
					},
				}),
			}));
		} else {
			first.reply(failure, "");
		}
		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/oauth/token",
				method: "POST",
			})
			.reply(200, JSON.stringify({ access_token: "retried-access-token" }));

		try {
			const refresh = refreshProviderToken("retry-refresh-token");
			await vi.runAllTimersAsync();
			await expect(refresh).resolves.toEqual({
				access_token: "retried-access-token",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes an expiring token and re-encrypts oauth", async () => {
		await storeOAuthCredentials(env, {
			...baseCredentials(),
			expiresAt: Date.now() + 60_000,
		});
		let refreshForm: URLSearchParams | undefined;
		fetchMock
			.intercept({
				origin: "https://auth.openai.com",
				path: "/oauth/token",
				method: "POST",
			})
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

	it("passes upstream credential errors through unchanged", async () => {
		const raw = JSON.parse((await env.AUTH_KV.get("oauth"))!) as {
			iv: string;
			ciphertext: string;
		};
		const upstreamBody = JSON.stringify({
			error: {
				message: [
					ACCESS_TOKEN,
					"refresh-test",
					env.OAUTH_MASTER_KEY,
					raw.iv,
					raw.ciphertext,
				].join(" "),
			},
		});
		fetchMock
			.intercept({
				origin: "https://codex-relay.test",
				path: "/backend-api/codex/models?client_version=0.144.1",
				method: "GET",
			})
			.reply(
				401,
				upstreamBody,
				{ headers: { "Content-Type": "application/json" } },
			);

		const response = await clientFetch("/v1/models");
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(upstreamBody);
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
			.intercept({
				origin: "https://auth.openai.com",
				path: "/oauth/token",
				method: "POST",
			})
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
