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
import { authenticateClient } from "../../src/auth/api-key";
import { constantTimeEqual } from "../../src/auth/constant-time";
import { storeOAuthCredentials } from "../../src/auth/credentials";
import { fetchMock } from "../support/fetch-mock";
import {
	baseCredentials,
	CLIENT_API_KEY,
	clientFetch,
	expectEmptyResponse,
	OTHER_API_KEY,
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
		await expectEmptyResponse(wrong, 404);
		const missing = await clientFetch(
			"/v1/models",
			undefined,
			"sk-test-missing-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
		);
		await expectEmptyResponse(missing, 404);
	});

	it("accepts X-Api-Key and gives a valid Bearer token precedence", async () => {
		await expect(
			authenticateClient(
				new Request("https://example.com/v1/models", {
					headers: { "X-Api-Key": `  ${CLIENT_API_KEY}  ` },
				}),
				env,
			),
		).resolves.toBeUndefined();

		await expect(
			authenticateClient(
				new Request("https://example.com/v1/models", {
					headers: {
						Authorization: `Bearer ${OTHER_API_KEY}`,
						"X-Api-Key": CLIENT_API_KEY,
					},
				}),
				env,
			),
		).resolves.toBeUndefined();

		await expect(
			authenticateClient(
				new Request("https://example.com/v1/models", {
					headers: {
						Authorization:
							"Bearer sk-test-wrong-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
						"X-Api-Key": CLIENT_API_KEY,
					},
				}),
				env,
			),
		).rejects.toMatchObject({ code: "invalid_api_key" });
	});
});
