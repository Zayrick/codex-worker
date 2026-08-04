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
import {
	readOAuthCredentials,
	storeOAuthCredentials,
} from "../../src/auth/credentials";
import { fetchMock } from "../support/fetch-mock";
import {
	baseCredentials,
	CLIENT_API_KEY,
	expectEmptyResponse,
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

describe("Codex device authorization", () => {
	it("serves a safe form and hides invalid posted secrets", async () => {
		const form = await exports.default.fetch(
			"https://example.com/auth/device/start",
		);
		expect(form.status).toBe(200);
		expect(form.headers.get("Content-Security-Policy")).toContain(
			"form-action 'self'",
		);
		expect(form.headers.get("Referrer-Policy")).toBe("no-referrer");
		const formPage = await form.text();
		expect(formPage).toContain('method="post"');
		expect(formPage).toContain('name="secret" type="password"');
		expect(formPage).not.toContain(env.OAUTH_MASTER_KEY);
		expect(formPage).not.toContain(env.DEVICE_AUTH_SECRET);

		const apiKeyOnly = await deviceStart(undefined, {
			headers: { Authorization: `Bearer ${CLIENT_API_KEY}` },
		});
		await expectEmptyResponse(apiKeyOnly, 404);

		const wrongSecret = await deviceStart("wrong-device-secret");
		await expectEmptyResponse(wrongSecret, 404);

		await env.AUTH_KV.delete("oauth");
		const invalidState = await exports.default.fetch(
			"https://example.com/auth/device/poll?state=opaque",
		);
		expect(invalidState.status).toBe(400);
		expect(await invalidState.text()).toContain("invalid_device_session");
	});

	it("refuses to replace OAuth credentials already stored in KV", async () => {
		const response = await deviceStart(env.DEVICE_AUTH_SECRET);
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
			const started = await deviceStart(env.DEVICE_AUTH_SECRET);
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
			expect(page).not.toContain(env.OAUTH_MASTER_KEY);
			expect(page).not.toContain(env.DEVICE_AUTH_SECRET);

			const pollUrl = pollUrlFromDevicePage(page);
			expect(pollUrl.pathname).toBe("/auth/device/poll");
			expect(pollUrl.searchParams.has("secret")).toBe(false);
			expect(pollUrl.searchParams.get("state")).toBeTruthy();
			expect(refreshUrlFromDocument(iframeDocumentFromPage(page)).toString()).toBe(
				pollUrl.toString(),
			);

			const rejectedUrl = new URL(pollUrl);
			rejectedUrl.searchParams.set(
				"state",
				`${rejectedUrl.searchParams.get("state")}corrupt`,
			);
			const rejected = await exports.default.fetch(rejectedUrl.toString());
			expect(rejected.status).toBe(400);
			expect(await rejected.text()).toContain("invalid_device_session");

			fetchMock
				.intercept({
					origin: "https://auth.openai.com",
					path: "/api/accounts/deviceauth/token",
					method: "POST",
				})
				.reply(403, "");
			const pending = await exports.default.fetch(pollUrl.toString());
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
			const started = await deviceStart(env.DEVICE_AUTH_SECRET);
			const pollUrl = pollUrlFromDevicePage(await started.text());

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

			const completed = await exports.default.fetch(pollUrl.toString());
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

function deviceStart(
	secret?: string,
	init?: RequestInit,
): Promise<Response> {
	const body = new URLSearchParams();
	if (secret !== undefined) body.set("secret", secret);
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/x-www-form-urlencoded");
	return exports.default.fetch("https://example.com/auth/device/start", {
		...init,
		method: "POST",
		headers,
		body,
	});
}

function pollUrlFromDevicePage(page: string): URL {
	const value = page.match(/data-poll-url="([^"]+)"/)?.[1];
	if (!value) throw new Error("Device page is missing its poll URL.");
	return new URL(decodeHtmlAttribute(value));
}

function iframeDocumentFromPage(page: string): string {
	const value = page.match(/srcdoc="([^"]+)"/)?.[1];
	if (!value) throw new Error("Device page is missing its iframe document.");
	return decodeHtmlAttribute(value);
}

function refreshUrlFromDocument(document: string): URL {
	const value = document.match(
		/<meta http-equiv="refresh" content="\d+;url=([^"]+)">/,
	)?.[1];
	if (!value) throw new Error("Device status document is missing its refresh URL.");
	return new URL(decodeHtmlAttribute(value));
}

function decodeHtmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
