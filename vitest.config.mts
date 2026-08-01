import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const testMasterKey = Buffer.alloc(32, 7).toString("base64url");

export default defineWorkersConfig({
	test: {
		include: ["test/**/*.spec.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						OAUTH_MASTER_KEY: testMasterKey,
						CODEX_RELAY_URL:
							"https://codex-relay.test/backend-api/codex/responses",
					},
				},
			},
		},
	},
});
