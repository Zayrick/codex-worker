export type JsonObject = Record<string, unknown>;

export interface WorkerEnv {
	CODEX_AUTH_JSON: string;
	CODEX_RELAY_URL: string;
	PROXY_API_KEY?: string;
	CORS_ORIGIN?: string;
}

export function isRecord(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringField(
	value: JsonObject | undefined,
	key: string,
): string | undefined {
	const field = value?.[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function numberField(
	value: JsonObject | undefined,
	key: string,
): number | undefined {
	const field = value?.[key];
	return typeof field === "number" && Number.isFinite(field)
		? field
		: undefined;
}

export function recordField(
	value: JsonObject | undefined,
	key: string,
): JsonObject | undefined {
	const field = value?.[key];
	return isRecord(field) ? field : undefined;
}
