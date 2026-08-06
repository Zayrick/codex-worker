import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	html: {
		// The Worker replaces this build-time value with a fresh nonce per request.
		cspNonce: "__CODEX_WORKER_CSP_NONCE__",
	},
	plugins: [react(), cloudflare()],
});
