import { describe, expect, it } from "vitest";
import { resolveChatGptRelayUrl } from "../../worker/shared/relay-url";

describe("relay URL configuration", () => {
	it("appends the upstream path to a standard HTTPS origin", () => {
		expect(
			resolveChatGptRelayUrl(
				"https://relay.example.com",
				"/backend-api/codex/models",
				"?client_version=0.144.1",
			).toString(),
		).toBe(
			"https://relay.example.com/backend-api/codex/models?client_version=0.144.1",
		);
	});

	it.each([
		"relay.example.com",
		"https://relay.example.com/",
		" http://relay.example.com ",
		"http://relay.example.com",
		"https://user:pass@relay.example.com",
		"https://relay.example.com/backend-api/codex/responses",
		"https://relay.example.com?target=chatgpt",
		"https://relay.example.com#target",
	])("rejects a non-standard relay origin: %s", (configured) => {
		expect(() =>
			resolveChatGptRelayUrl(configured, "/backend-api/codex/models"),
		).toThrow();
	});
});
