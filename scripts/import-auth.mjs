import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const mode = process.argv[2] ?? "local";
const authPath = resolve(
	process.argv[3] ?? join(homedir(), ".codex", "auth.json"),
);

if (!["local", "remote"].includes(mode)) {
	fail("Usage: node scripts/import-auth.mjs <local|remote> [auth.json path]");
}

let parsed;
try {
	parsed = JSON.parse(await readFile(authPath, "utf8"));
} catch (error) {
	fail(`Unable to read a valid auth.json from ${authPath}: ${messageOf(error)}`);
}

const tokens =
	parsed && typeof parsed === "object" ? parsed.tokens : undefined;
if (
	!tokens ||
	typeof tokens !== "object" ||
	typeof tokens.access_token !== "string" ||
	tokens.access_token.length === 0
) {
	fail(`${authPath} does not contain tokens.access_token`);
}

const compact = JSON.stringify(parsed);
const bytes = Buffer.byteLength(compact, "utf8");
if (bytes > 5_000) {
	fail(
		`The compact auth.json is ${bytes} bytes, which is above the conservative 5 KB Worker secret limit.`,
	);
}

if (mode === "local") {
	const varsPath = resolve(".dev.vars");
	let existing = "";
	try {
		existing = await readFile(varsPath, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	if (compact.includes("'")) {
		fail(
			"auth.json contains a single quote and cannot be represented safely in .dev.vars.",
		);
	}
	const assignment = `CODEX_AUTH_JSON='${compact}'`;
	const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
	const index = lines.findIndex((line) => line.startsWith("CODEX_AUTH_JSON="));
	if (index >= 0) lines[index] = assignment;
	else lines.unshift(assignment);
	const output = `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join("\n").trimEnd()}\n`;
	await writeFile(varsPath, output, { encoding: "utf8", mode: 0o600 });
	try {
		await chmod(varsPath, 0o600);
	} catch {
		// Windows may not apply POSIX modes.
	}
	console.log(
		`Imported ${authPath} into ${varsPath} as CODEX_AUTH_JSON (${bytes} bytes).`,
	);
} else {
	const executable = join(
		process.cwd(),
		"node_modules",
		".bin",
		process.platform === "win32" ? "wrangler.cmd" : "wrangler",
	);
	await new Promise((resolvePromise, reject) => {
		const child = spawn(
			executable,
			["secret", "put", "CODEX_AUTH_JSON"],
			{
				cwd: process.cwd(),
				stdio: ["pipe", "inherit", "inherit"],
				windowsHide: true,
			},
		);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`wrangler exited with code ${code}`));
		});
		child.stdin.end(compact);
	});
	console.log(
		`Imported ${authPath} into the deployed Worker secret CODEX_AUTH_JSON (${bytes} bytes).`,
	);
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
