import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Deterministic, non-sensitive bindings isolate tests from local developer credentials.
const testBindings = {
	OAUTH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
	DEVICE_AUTH_SECRET: "test-device-secret",
	CODEX_RELAY_URL: "https://codex-relay.test/backend-api/codex/responses",
};

// Wrangler's configuration loader and the Miniflare Worker runtime use separate
// environments, so both receive the same test binding set.
Object.assign(process.env, testBindings);

export default defineConfig({
	plugins: [
		// Execute tests in the Workers runtime described by wrangler.jsonc.
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: testBindings,
			},
		}),
	],
	test: {
		include: ["test/**/*.spec.ts"],
	},
});
