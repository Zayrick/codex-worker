import { ApiError } from "../shared/api-error";
import { isRecord, stringField } from "../shared/json";
import { equalDigests, sha256Text } from "./constant-time";
import { openJson, sealJson } from "./envelope";

const API_KEYS_KV_KEY = "API_KEYS";
const API_KEYS_ENVELOPE_PURPOSE = "codex-worker/api-keys/v1";
const MAX_API_KEYS_ENVELOPE_CHARS = 128 * 1024;
const MAX_API_KEYS = 100;
const MAX_API_KEY_NAME_LENGTH = 100;
const MIN_API_KEY_LENGTH = 11;
const MAX_API_KEY_LENGTH = 512;
const API_KEY_LETTER_PATTERN = /[A-Za-z]/;
const API_KEY_DIGIT_PATTERN = /[0-9]/;
const API_KEY_SYMBOL_PATTERN = /[^A-Za-z0-9\s]/;
const DUMMY_API_KEY = `sk-${"a".repeat(19)}0`;

type ApiKeyEnv = Pick<Env, "AUTH_KV" | "DATA_ENCRYPTION_KEY">;

export interface ClientApiKey {
	name: string;
	key: string;
	enabled: boolean;
}

interface StoredApiKeys {
	version: 1;
	keys: ClientApiKey[];
}

export async function authenticateClient(
	request: Request,
	env: ApiKeyEnv,
): Promise<void> {
	const token = clientToken(request);
	if (!token || token.length > MAX_API_KEY_LENGTH) {
		throw invalidApiKey();
	}

	const configured = await readApiKeys(env);
	const candidates = configured.filter((entry) => entry.enabled);
	const values =
		candidates.length > 0
			? candidates.map((entry) => entry.key)
			: [DUMMY_API_KEY];
	const [tokenDigest, candidateDigests] = await Promise.all([
		sha256Text(token),
		Promise.all(values.map((value) => sha256Text(value))),
	]);
	let matched = false;
	for (const candidate of candidateDigests) {
		matched = equalDigests(tokenDigest, candidate) || matched;
	}
	if (candidates.length > 0 && matched) {
		return;
	}

	throw invalidApiKey();
}

export async function readApiKeys(env: ApiKeyEnv): Promise<ClientApiKey[]> {
	const encrypted = await env.AUTH_KV.get(API_KEYS_KV_KEY, {
		type: "text",
		cacheTtl: 30,
	});
	if (encrypted === null) return [];
	if (encrypted.length > MAX_API_KEYS_ENVELOPE_CHARS) {
		throw invalidStoredApiKeys();
	}

	try {
		const value = await openJson(
			encrypted,
			env.DATA_ENCRYPTION_KEY,
			API_KEYS_ENVELOPE_PURPOSE,
		);
		return validateStoredApiKeys(value);
	} catch {
		throw invalidStoredApiKeys();
	}
}

export async function storeApiKeys(
	env: ApiKeyEnv,
	keys: readonly ClientApiKey[],
): Promise<ClientApiKey[]> {
	const validated = validateApiKeyCollection(keys, invalidStoredApiKeys);
	let encrypted: string;
	try {
		encrypted = await sealJson(
			{ version: 1, keys: validated } satisfies StoredApiKeys,
			env.DATA_ENCRYPTION_KEY,
			API_KEYS_ENVELOPE_PURPOSE,
		);
	} catch {
		throw invalidStoredApiKeys();
	}
	await putApiKeys(env.AUTH_KV, encrypted);
	return validated;
}

export async function createApiKey(
	env: ApiKeyEnv,
	value: unknown,
): Promise<ClientApiKey[]> {
	const candidate = validateApiKeyInput(value);
	const current = await readApiKeys(env);
	requireAvailableApiKey(current, candidate);
	return storeApiKeys(env, [...current, candidate]);
}

export async function updateApiKey(
	env: ApiKeyEnv,
	originalName: unknown,
	value: unknown,
): Promise<ClientApiKey[]> {
	const targetName = validateApiKeyName(originalName);
	const candidate = validateApiKeyInput(value);
	const current = await readApiKeys(env);
	const index = current.findIndex((entry) => entry.name === targetName);
	if (index < 0) throw apiKeyNotFound();
	requireAvailableApiKey(
		current.filter((_entry, entryIndex) => entryIndex !== index),
		candidate,
	);
	const updated = current.slice();
	updated[index] = candidate;
	return storeApiKeys(env, updated);
}

export async function deleteApiKey(
	env: ApiKeyEnv,
	name: unknown,
): Promise<ClientApiKey[]> {
	const targetName = validateApiKeyName(name);
	const current = await readApiKeys(env);
	const updated = current.filter((entry) => entry.name !== targetName);
	if (updated.length === current.length) throw apiKeyNotFound();
	return storeApiKeys(env, updated);
}

export function validateApiKeyInput(value: unknown): ClientApiKey {
	if (!isRecord(value)) throw invalidApiKeyRecord();
	const name = validateApiKeyName(stringField(value, "name"));
	const key = stringField(value, "key");
	if (
		!key ||
		key.length < MIN_API_KEY_LENGTH ||
		key.length > MAX_API_KEY_LENGTH ||
		!API_KEY_LETTER_PATTERN.test(key) ||
		!API_KEY_DIGIT_PATTERN.test(key) ||
		!API_KEY_SYMBOL_PATTERN.test(key)
	) {
		throw invalidApiKeyRecord();
	}
	if (typeof value.enabled !== "boolean") throw invalidApiKeyRecord();
	return { name, key, enabled: value.enabled };
}

function validateStoredApiKeys(value: unknown): ClientApiKey[] {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.keys)) {
		throw invalidStoredApiKeys();
	}
	return validateApiKeyCollection(value.keys, invalidStoredApiKeys);
}

function validateApiKeyCollection(
	values: readonly unknown[],
	error: () => ApiError,
): ClientApiKey[] {
	if (values.length > MAX_API_KEYS) throw error();
	const names = new Set<string>();
	const keys = new Set<string>();
	const validated: ClientApiKey[] = [];
	for (const value of values) {
		let entry: ClientApiKey;
		try {
			entry = validateApiKeyInput(value);
		} catch {
			throw error();
		}
		if (names.has(entry.name) || keys.has(entry.key)) throw error();
		names.add(entry.name);
		keys.add(entry.key);
		validated.push(entry);
	}
	return validated.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
}

function validateApiKeyName(value: unknown): string {
	if (typeof value !== "string") throw invalidApiKeyRecord();
	const name = value.trim();
	if (
		name.length === 0 ||
		name.length > MAX_API_KEY_NAME_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(name)
	) {
		throw invalidApiKeyRecord();
	}
	return name;
}

function requireAvailableApiKey(
	current: readonly ClientApiKey[],
	candidate: ClientApiKey,
): void {
	if (current.some((entry) => entry.name === candidate.name)) {
		throw apiKeyConflict("An API key with that name already exists.");
	}
	if (current.some((entry) => entry.key === candidate.key)) {
		throw apiKeyConflict("That API key value is already configured.");
	}
	if (current.length >= MAX_API_KEYS) {
		throw apiKeyConflict("The API key limit has been reached.");
	}
}

function clientToken(request: Request): string {
	const authorization = request.headers.get("Authorization");
	const bearer = authorization?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
	const apiKey = request.headers.get("x-api-key")?.trim();
	const googleApiKey = request.headers.get("x-goog-api-key")?.trim();
	return bearer ?? (apiKey || googleApiKey || "");
}

async function putApiKeys(kv: KVNamespace, encrypted: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await kv.put(API_KEYS_KV_KEY, encrypted);
			return;
		} catch (error) {
			if (attempt >= 2 || !isKvWriteRateLimit(error)) throw error;
			await new Promise<void>((resolve) =>
				setTimeout(resolve, (attempt + 1) * 1000),
			);
		}
	}
}

function isKvWriteRateLimit(error: unknown): boolean {
	return error instanceof Error && /(?:^|\D)429(?:\D|$)/.test(error.message);
}

function invalidApiKey(): ApiError {
	return new ApiError(
		401,
		"Invalid API key.",
		"authentication_error",
		"invalid_api_key",
	);
}

function invalidApiKeyRecord(): ApiError {
	return new ApiError(
		400,
		"API keys require a unique name, 11 to 512 characters with at least one letter, number, and non-whitespace symbol, and an enabled state.",
		"invalid_request_error",
		"invalid_api_key_record",
	);
}

function apiKeyConflict(message: string): ApiError {
	return new ApiError(
		409,
		message,
		"invalid_request_error",
		"api_key_conflict",
	);
}

function apiKeyNotFound(): ApiError {
	return new ApiError(
		404,
		"The requested API key does not exist.",
		"invalid_request_error",
		"api_key_not_found",
	);
}

function invalidStoredApiKeys(): ApiError {
	return new ApiError(
		500,
		"Stored API keys are unavailable.",
		"configuration_error",
		"invalid_stored_api_keys",
	);
}
