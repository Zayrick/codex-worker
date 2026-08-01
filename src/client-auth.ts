import { ApiError } from "./errors";

const API_KEY_PREFIX = "API-";
const MAX_API_KEY_LENGTH = 512;
const BULK_READ_SIZE = 100;
const DUMMY_API_KEY = "invalid-api-key";

type ClientAuthEnv = Pick<Env, "AUTH_KV">;

export async function authenticateClient(
	request: Request,
	env: ClientAuthEnv,
): Promise<void> {
	const token = clientToken(request);
	if (!token || token.length > MAX_API_KEY_LENGTH) throw invalidApiKey();

	const tokenDigest = await digest(token);
	let cursor: string | undefined;
	while (true) {
		const page = await env.AUTH_KV.list({
			prefix: API_KEY_PREFIX,
			...(cursor ? { cursor } : {}),
		});
		if (
			await pageContainsApiKey(
				tokenDigest,
				page.keys.map((key) => key.name),
				env.AUTH_KV,
			)
		) {
			return;
		}
		if (page.list_complete) break;
		cursor = page.cursor;
	}

	throw invalidApiKey();
}

async function pageContainsApiKey(
	tokenDigest: ArrayBuffer,
	keyNames: string[],
	kv: KVNamespace,
): Promise<boolean> {
	for (let offset = 0; offset < keyNames.length; offset += BULK_READ_SIZE) {
		const names = keyNames.slice(offset, offset + BULK_READ_SIZE);
		const values = await kv.get(names, { type: "text", cacheTtl: 30 });
		const candidateDigests = await Promise.all(
			Array.from(values.values(), (value) => digest(value ?? DUMMY_API_KEY)),
		);
		if (
			candidateDigests.some((candidate) =>
				crypto.subtle.timingSafeEqual(tokenDigest, candidate),
			)
		) {
			return true;
		}
	}
	return false;
}

export async function constantTimeEqual(
	left: string,
	right: string,
): Promise<boolean> {
	const [leftDigest, rightDigest] = await Promise.all([
		digest(left),
		digest(right),
	]);
	return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}

function digest(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function clientToken(request: Request): string {
	const authorization = request.headers.get("Authorization");
	const bearer = authorization?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
	return bearer ?? request.headers.get("x-api-key")?.trim() ?? "";
}

function invalidApiKey(): ApiError {
	return new ApiError(
		401,
		"Invalid API key.",
		"authentication_error",
		"invalid_api_key",
	);
}
