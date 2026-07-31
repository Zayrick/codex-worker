import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const testAccessToken = [
	"e30",
	Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
	"test-signature",
].join(".");
const testAuthJson = JSON.stringify({
	tokens: {
		access_token: testAccessToken,
		account_id: "account-test",
	},
});

export default defineWorkersConfig({
	test: {
		include: ["test/**/*.spec.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						CODEX_AUTH_JSON: testAuthJson,
						CODEX_RELAY_URL:
							"https://codex-relay.test/backend-api/codex/responses",
					},
				},
			},
		},
	},
});
