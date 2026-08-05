import { isRecord, numberField, stringField } from "../shared/json";
import { constantTimeEqual, sha256Text } from "./constant-time";
import { openJson, sealJson } from "./envelope";

const ADMIN_SESSION_COOKIE = "__Host-codex-admin";
const ADMIN_SESSION_PURPOSE = "codex-worker/admin-session/v1";
const ADMIN_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
const ADMIN_SESSION_CLOCK_SKEW_MS = 60 * 1000;
const MAX_ADMIN_SESSION_CHARS = 4096;

type AdminSessionEnv = Pick<
	Env,
	"ADMIN_SECRET" | "DATA_ENCRYPTION_KEY"
>;

interface AdminSession {
	version: 1;
	issuedAt: number;
	expiresAt: number;
	secretTag: string;
}

export async function adminSecretMatches(
	provided: unknown,
	expected: string,
): Promise<boolean> {
	return (
		typeof provided === "string" &&
		provided.length > 0 &&
		provided.length <= 512 &&
		(await constantTimeEqual(provided, expected))
	);
}

export async function createAdminSession(
	env: AdminSessionEnv,
	now = Date.now(),
): Promise<string> {
	return sealJson(
		{
			version: 1,
			issuedAt: now,
			expiresAt: now + ADMIN_SESSION_LIFETIME_SECONDS * 1000,
			secretTag: await adminSecretTag(env.ADMIN_SECRET),
		} satisfies AdminSession,
		env.DATA_ENCRYPTION_KEY,
		ADMIN_SESSION_PURPOSE,
	);
}

export async function hasValidAdminSession(
	request: Request,
	env: AdminSessionEnv,
	now = Date.now(),
): Promise<boolean> {
	const token = adminSessionCookie(request.headers.get("Cookie"));
	if (!token || token.length > MAX_ADMIN_SESSION_CHARS) return false;

	try {
		const value = await openJson(
			token,
			env.DATA_ENCRYPTION_KEY,
			ADMIN_SESSION_PURPOSE,
		);
		if (!isRecord(value) || value.version !== 1) return false;
		const issuedAt = numberField(value, "issuedAt");
		const expiresAt = numberField(value, "expiresAt");
		const secretTag = stringField(value, "secretTag");
		if (
			issuedAt === undefined ||
			expiresAt === undefined ||
			!secretTag ||
			issuedAt > now + ADMIN_SESSION_CLOCK_SKEW_MS ||
			expiresAt <= now ||
			expiresAt - issuedAt !== ADMIN_SESSION_LIFETIME_SECONDS * 1000
		) {
			return false;
		}
		return constantTimeEqual(secretTag, await adminSecretTag(env.ADMIN_SECRET));
	} catch {
		return false;
	}
}

export function adminSessionCookieHeader(token: string): string {
	return [
		`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"Secure",
		"HttpOnly",
		"SameSite=Strict",
		`Max-Age=${ADMIN_SESSION_LIFETIME_SECONDS}`,
	].join("; ");
}

export function clearAdminSessionCookieHeader(): string {
	return [
		`${ADMIN_SESSION_COOKIE}=`,
		"Path=/",
		"Secure",
		"HttpOnly",
		"SameSite=Strict",
		"Max-Age=0",
	].join("; ");
}

function adminSessionCookie(header: string | null): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
		try {
			return decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function adminSecretTag(secret: string): Promise<string> {
	const bytes = new Uint8Array(await sha256Text(secret));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}
