import { ApiError } from "../shared/api-error";
import { equalDigests, sha256Text } from "./constant-time";

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

	const tokenDigest = await sha256Text(token);
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
			Array.from(values.values(), (value) =>
				sha256Text(value ?? DUMMY_API_KEY),
			),
		);
		if (
			candidateDigests.some((candidate) =>
				equalDigests(tokenDigest, candidate),
			)
		) {
			return true;
		}
	}
	return false;
}

function clientToken(request: Request): string {
	const authorization = request.headers.get("Authorization");
	const bearer = authorization?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
	const apiKey = request.headers.get("x-api-key")?.trim();
	const googleApiKey = request.headers.get("x-goog-api-key")?.trim();
	return bearer ?? (apiKey || googleApiKey || "");
}

function invalidApiKey(): ApiError {
	return new ApiError(
		401,
		"Invalid API key.",
		"authentication_error",
		"invalid_api_key",
	);
}
