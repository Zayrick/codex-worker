import { describe, expect, it } from "vitest";
import {
	codexSubscriptionFromUsage,
	codexSubscriptionMetadata,
} from "../../src/codex/subscription";
import { baseCredentials } from "../support/auth-fixture";

describe("Codex subscription normalization", () => {
	it("extracts plan and subscription dates from the OAuth ID token", () => {
		expect(codexSubscriptionMetadata(baseCredentials())).toEqual({
			planType: "plus",
			subscriptionActiveStart: Date.parse("2026-01-01T00:00:00.000Z"),
			subscriptionActiveUntil: 1_800_000_000_000,
		});
	});

	it("accepts camelCase usage payloads and clamps provider percentages", () => {
		const now = Date.parse("2026-08-06T00:00:00.000Z");
		const subscription = codexSubscriptionFromUsage(
			{
				rateLimit: {
					allowed: true,
					primaryWindow: {
						usedPercent: "150",
						limitWindowSeconds: "604800",
						resetAfterSeconds: "60",
					},
				},
				rateLimitResetCredits: {
					availableCount: "0",
					applicableAvailableCount: "0",
				},
			},
			{
				planType: "team",
				subscriptionActiveStart: null,
				subscriptionActiveUntil: null,
			},
			now,
		);

		expect(subscription).toMatchObject({
			planType: "team",
			fetchedAt: now,
			rateLimitResetCredits: {
				availableCount: 0,
				applicableAvailableCount: 0,
			},
		});
		expect(subscription.windows).toEqual([
				expect.objectContaining({
					kind: "weekly",
					usedPercent: 100,
					remainingPercent: 0,
					resetAt: now + 60_000,
				}),
		]);
	});

	it("rejects non-object upstream payloads", () => {
		expect(() =>
			codexSubscriptionFromUsage(null, {
				planType: null,
				subscriptionActiveStart: null,
				subscriptionActiveUntil: null,
			}),
		).toThrowError(
			expect.objectContaining({ code: "invalid_codex_usage_response" }),
		);
	});
});
