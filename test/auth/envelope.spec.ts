import { env } from "cloudflare:workers";
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
	ACCESS_TOKEN,
	baseCredentials,
	CLIENT_API_KEY,
	clientFetch,
	seedClientApiKeys,
} from "../support/auth-fixture";

const OAUTH_COMPATIBILITY_FIXTURE =
	'{"v":1,"alg":"A256GCM","iv":"AAECAwQFBgcICQoL","ciphertext":"Y6OfFW96sCYZkN-tznoNmYJZxf1MDRxUeOxZmOi-FXGrHSPP9qxSmIeW4Zp-hdBVhlUvEYC6j_MfbY6uxqljuzg9ZpHoNn7iTUbPnh2tTvraO7m7NXxTwZrtSSZmASZ1j8AkLz4YMnOtWzdmEGoFxu8sXb3t3mbSV3ZogLMHoCxz4DvqAY89KsydwolZyIlwoV9wTPp8VEA4SXjUOWk"}';

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

describe("encrypted OAuth storage", () => {
	it("decrypts the persisted v1 envelope and purpose compatibility fixture", async () => {
		await env.AUTH_KV.put("oauth", OAUTH_COMPATIBILITY_FIXTURE);

		expect(await readOAuthCredentials(env)).toEqual({
			version: 1,
			accessToken: "fixture-access",
			refreshToken: "fixture-refresh",
			expiresAt: 4_102_444_800_000,
			updatedAt: "2026-07-31T00:00:00.000Z",
		});
	});

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
			env.DATA_ENCRYPTION_KEY,
			CLIENT_API_KEY,
		]) {
			expect(body).not.toContain(sensitive);
		}
		expect(JSON.parse(body)).toMatchObject({
			error: { code: "invalid_oauth_credentials" },
		});
	});

	it("rejects an oversized stored envelope before decoding it", async () => {
		await env.AUTH_KV.put("oauth", "x".repeat(128 * 1024 + 1));

		await expect(readOAuthCredentials(env)).rejects.toMatchObject({
			code: "invalid_oauth_credentials",
		});
	});
});
