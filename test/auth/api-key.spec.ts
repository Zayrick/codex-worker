import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	authenticateClient,
	createApiKey,
	deleteApiKey,
	readApiKeys,
	storeApiKeys,
	updateApiKey,
} from "../../src/auth/api-key";
import { constantTimeEqual } from "../../src/auth/constant-time";
import {
	CLIENT_API_KEY,
	clientFetch,
	expectEmptyResponse,
	OTHER_API_KEY,
	seedClientApiKeys,
} from "../support/auth-fixture";

const THIRD_API_KEY = `sk-${"d".repeat(64)}`;
const FOURTH_API_KEY = `sk-${"e".repeat(64)}`;

beforeEach(async () => {
	await seedClientApiKeys();
});

describe("encrypted API_KEYS authentication", () => {
	it("reads one encrypted KV value without listing key names", async () => {
		const encrypted = await env.AUTH_KV.get("API_KEYS");
		expect(encrypted).not.toBeNull();
		expect(encrypted).not.toContain(CLIENT_API_KEY);
		expect(encrypted).not.toContain(OTHER_API_KEY);
		expect(JSON.parse(encrypted!)).toMatchObject({ v: 1, alg: "A256GCM" });

		const get = vi.fn().mockResolvedValue(encrypted);
		const list = vi.fn(() => {
			throw new Error("KV list must not be called.");
		});
		await authenticateClient(
			new Request("https://example.com/v1/models", {
				headers: { Authorization: `Bearer ${CLIENT_API_KEY}` },
			}),
			{
				AUTH_KV: { get, list } as unknown as KVNamespace,
				DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY,
			},
		);

		expect(get).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledWith("API_KEYS", {
			type: "text",
			cacheTtl: 30,
		});
		expect(list).not.toHaveBeenCalled();
	});

	it("accepts only enabled keys and keeps constant-time value comparison", async () => {
		expect(await constantTimeEqual(CLIENT_API_KEY, CLIENT_API_KEY)).toBe(true);
		expect(await constantTimeEqual(CLIENT_API_KEY, OTHER_API_KEY)).toBe(false);

		await storeApiKeys(env, [
			{ name: "disabled", key: CLIENT_API_KEY, enabled: false },
			{ name: "enabled", key: OTHER_API_KEY, enabled: true },
		]);
		await expect(
			authenticateClient(
				new Request("https://example.com/v1/models", {
					headers: { Authorization: `Bearer ${CLIENT_API_KEY}` },
				}),
				env,
			),
		).rejects.toMatchObject({ code: "invalid_api_key" });
		await expect(
			authenticateClient(
				new Request("https://example.com/v1/models", {
					headers: { Authorization: `Bearer ${OTHER_API_KEY}` },
				}),
				env,
			),
		).resolves.toBeUndefined();
	});

	it("creates, updates, and deletes validated records", async () => {
		let keys = await createApiKey(env, {
			name: " third ",
			key: THIRD_API_KEY,
			enabled: true,
		});
		expect(keys).toContainEqual({
			name: "third",
			key: THIRD_API_KEY,
			enabled: true,
		});

		keys = await updateApiKey(env, "third", {
			name: "renamed",
			key: FOURTH_API_KEY,
			enabled: false,
		});
		expect(keys).toContainEqual({
			name: "renamed",
			key: FOURTH_API_KEY,
			enabled: false,
		});
		expect(keys).not.toContainEqual(expect.objectContaining({ name: "third" }));

		keys = await deleteApiKey(env, "renamed");
		expect(keys).not.toContainEqual(expect.objectContaining({ name: "renamed" }));
		expect(await readApiKeys(env)).toEqual(keys);
	});

	it("rejects malformed and duplicate records", async () => {
		await expect(
			createApiKey(env, { name: "bad", key: "sk-short", enabled: true }),
		).rejects.toMatchObject({ code: "invalid_api_key_record" });
		await expect(
			createApiKey(env, {
				name: "primary",
				key: THIRD_API_KEY,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "api_key_conflict" });
		await expect(
			createApiKey(env, {
				name: "duplicate-value",
				key: CLIENT_API_KEY,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "api_key_conflict" });
	});

	it("accepts SDK headers and gives Bearer precedence", async () => {
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
				new Request("https://example.com/v1beta/models", {
					headers: { "X-Goog-Api-Key": `  ${CLIENT_API_KEY}  ` },
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
						Authorization: `Bearer ${THIRD_API_KEY}`,
						"X-Api-Key": CLIENT_API_KEY,
					},
				}),
				env,
			),
		).rejects.toMatchObject({ code: "invalid_api_key" });
	});

	it("hides wrong or unknown client keys behind an empty 404", async () => {
		for (const key of [THIRD_API_KEY, FOURTH_API_KEY]) {
			await expectEmptyResponse(await clientFetch("/v1/models", undefined, key), 404);
		}
	});
});
