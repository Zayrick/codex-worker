import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import {
	defineConfig,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from "vite";

const workerRoot = resolve(import.meta.dirname, "worker-rs");
const rustSourceRoot = `${normalizePath(resolve(workerRoot, "src"))}/`;
const rustManifests = new Set(
	["Cargo.toml", "Cargo.lock"].map((name) =>
		normalizePath(resolve(workerRoot, name)),
	),
);

function runWorkerDevBuild(): Promise<void> {
	return new Promise((done, fail) => {
		const child = spawn("worker-build", ["--dev"], {
			cwd: workerRoot,
			stdio: "inherit",
			windowsHide: true,
		});
		child.once("error", fail);
		child.once("close", (code, signal) => {
			if (code === 0) {
				done();
				return;
			}
			fail(
				new Error(
					`worker-build --dev failed (${signal ?? code ?? "unknown"}).`,
				),
			);
		});
	});
}

function rustWorkerWatch(): Plugin {
	let running: Promise<void> | undefined;
	let pending = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const build = async (server: ViteDevServer) => {
		if (running) {
			pending = true;
			return;
		}
		do {
			pending = false;
			server.config.logger.info("Rebuilding Rust Worker...");
			running = runWorkerDevBuild();
			try {
				await running;
			} catch (error) {
				server.config.logger.error(
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				running = undefined;
			}
		} while (pending);
	};

	return {
		name: "codex-rust-worker-watch",
		apply: "serve",
		configureServer(server) {
			server.watcher.add([
				resolve(workerRoot, "src"),
				...rustManifests,
			]);
			const schedule = (file: string) => {
				const normalized = normalizePath(file);
				const isRustSource =
					normalized.startsWith(rustSourceRoot) &&
					normalized.endsWith(".rs");
				if (!isRustSource && !rustManifests.has(normalized)) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => void build(server), 100);
			};
			server.watcher.on("add", schedule);
			server.watcher.on("change", schedule);
			server.watcher.on("unlink", schedule);
		},
	};
}

export default defineConfig({
	html: {
		// The Worker replaces this build-time value with a fresh nonce per request.
		cspNonce: "__CODEX_WORKER_CSP_NONCE__",
	},
	plugins: [react(), rustWorkerWatch(), cloudflare()],
	server: {
		port: 8787,
		strictPort: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
