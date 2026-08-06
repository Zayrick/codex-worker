import {
	requireValidOAuthCredentials,
	type StoredOAuthCredentials,
} from "../auth/credentials";
import { DEFAULT_CODEX_CLIENT_VERSION, resolveRelayUrl } from "./client";
import { ApiError, isAbortError } from "../shared/api-error";
import {
	isRecord,
	recordField,
	type JsonObject,
} from "../shared/json";
import {
	BodySizeLimitError,
	readLimitedBody,
} from "../shared/limited-body";

const CODEX_USAGE_PATH = "/backend-api/wham/usage";
const CODEX_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CODEX_USAGE_RESPONSE_BYTES = 256 * 1024;
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MIN_MONTH_SECONDS = 28 * 24 * 60 * 60;
const MAX_MONTH_SECONDS = 31 * 24 * 60 * 60;

type SubscriptionEnv = Pick<
	Env,
	"AUTH_KV" | "DATA_ENCRYPTION_KEY" | "CODEX_RELAY_URL"
>;

export type CodexQuotaWindowKind =
	| "five_hour"
	| "weekly"
	| "monthly"
	| "primary"
	| "secondary";

export type CodexQuotaCategory = "codex" | "code_review" | "additional";

export interface CodexSubscriptionMetadata {
	planType: string | null;
	subscriptionActiveStart: number | null;
	subscriptionActiveUntil: number | null;
}

export interface CodexQuotaWindow {
	id: string;
	category: CodexQuotaCategory;
	name: string;
	kind: CodexQuotaWindowKind;
	usedPercent: number | null;
	remainingPercent: number | null;
	limitWindowSeconds: number | null;
	resetAt: number | null;
	allowed: boolean | null;
	limitReached: boolean;
}

export interface CodexRateLimitResetCredits {
	availableCount: number | null;
	applicableAvailableCount: number | null;
}

export interface CodexSubscriptionInfo extends CodexSubscriptionMetadata {
	windows: CodexQuotaWindow[];
	rateLimitResetCredits: CodexRateLimitResetCredits;
	fetchedAt: number;
}

export function codexSubscriptionMetadata(
	credentials: StoredOAuthCredentials,
): CodexSubscriptionMetadata {
	const claims = decodeJwt(credentials.idToken);
	const auth = recordField(claims, "https://api.openai.com/auth") ?? claims;
	return {
		planType: normalizePlanType(
			auth?.chatgpt_plan_type ??
				auth?.chatgptPlanType ??
				auth?.plan_type ??
				auth?.planType,
		),
		subscriptionActiveStart: dateValueToMs(
			auth?.chatgpt_subscription_active_start ??
				auth?.chatgptSubscriptionActiveStart ??
				auth?.subscription_active_start ??
				auth?.subscriptionActiveStart,
		),
		subscriptionActiveUntil: dateValueToMs(
			auth?.chatgpt_subscription_active_until ??
				auth?.chatgptSubscriptionActiveUntil ??
				auth?.subscription_active_until ??
				auth?.subscriptionActiveUntil,
		),
	};
}

export async function fetchCodexSubscription(
	env: SubscriptionEnv,
	clientSignal?: AbortSignal,
): Promise<CodexSubscriptionInfo> {
	const credentials = await requireValidOAuthCredentials(env);
	const response = await requestCodexUsage(env, credentials, clientSignal);
	const payload = await readUsagePayload(response, clientSignal);
	return codexSubscriptionFromUsage(
		payload,
		codexSubscriptionMetadata(credentials),
	);
}

export function codexSubscriptionFromUsage(
	payload: unknown,
	metadata: CodexSubscriptionMetadata,
	now = Date.now(),
): CodexSubscriptionInfo {
	if (!isRecord(payload)) throw invalidCodexUsageResponse();
	return {
		...metadata,
		planType:
			normalizePlanType(payload.plan_type ?? payload.planType) ??
			metadata.planType,
		windows: buildQuotaWindows(payload, now),
		rateLimitResetCredits: normalizeResetCredits(
			payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits,
		),
		fetchedAt: now,
	};
}

async function requestCodexUsage(
	env: SubscriptionEnv,
	credentials: StoredOAuthCredentials,
	clientSignal: AbortSignal | undefined,
): Promise<Response> {
	const timeout = AbortSignal.timeout(CODEX_USAGE_REQUEST_TIMEOUT_MS);
	const signal = clientSignal
		? AbortSignal.any([clientSignal, timeout])
		: timeout;
	const headers = new Headers({
		Accept: "application/json",
		Authorization: `Bearer ${credentials.accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": `codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION}`,
	});
	if (credentials.accountId) {
		headers.set("Chatgpt-Account-Id", credentials.accountId);
	}

	let response: Response;
	try {
		response = await fetch(resolveUsageUrl(env.CODEX_RELAY_URL), {
			method: "GET",
			headers,
			redirect: "manual",
			signal,
		});
	} catch (error) {
		if (clientSignal?.aborted) throw clientAbortError(error);
		throw codexUsageUnavailable();
	}
	if (!response.ok) {
		await discardBody(response);
		throw codexUsageUpstreamError(response.status);
	}
	return response;
}

async function readUsagePayload(
	response: Response,
	clientSignal: AbortSignal | undefined,
): Promise<unknown> {
	let bytes: Uint8Array | null;
	try {
		bytes = await readLimitedBody(response, MAX_CODEX_USAGE_RESPONSE_BYTES);
	} catch (error) {
		if (clientSignal?.aborted) throw clientAbortError(error);
		if (error instanceof BodySizeLimitError) {
			throw invalidCodexUsageResponse();
		}
		throw codexUsageUnavailable();
	}
	if (!bytes) throw invalidCodexUsageResponse();
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw invalidCodexUsageResponse();
	}
}

function resolveUsageUrl(relayUrl: string): URL {
	const url = resolveRelayUrl(relayUrl);
	const suffix = "/backend-api/codex/responses";
	const normalizedPath = url.pathname.endsWith("/")
		? url.pathname.slice(0, -1)
		: url.pathname;
	const suffixIndex = normalizedPath.lastIndexOf(suffix);
	url.pathname =
		suffixIndex >= 0 && suffixIndex + suffix.length === normalizedPath.length
			? `${normalizedPath.slice(0, suffixIndex)}${CODEX_USAGE_PATH}`
			: CODEX_USAGE_PATH;
	url.search = "";
	return url;
}

function buildQuotaWindows(payload: JsonObject, now: number): CodexQuotaWindow[] {
	const windows: CodexQuotaWindow[] = [];
	appendRateLimitWindows(
		windows,
		payload.rate_limit ?? payload.rateLimit,
		{ id: "codex", category: "codex", name: "Codex" },
		now,
	);
	appendRateLimitWindows(
		windows,
		payload.code_review_rate_limit ?? payload.codeReviewRateLimit,
		{ id: "code-review", category: "code_review", name: "Code Review" },
		now,
	);

	const additional = payload.additional_rate_limits ?? payload.additionalRateLimits;
	if (Array.isArray(additional)) {
		for (const [index, item] of additional.entries()) {
			if (!isRecord(item)) continue;
			const name =
				normalizeString(item.limit_name ?? item.limitName) ??
				normalizeString(item.metered_feature ?? item.meteredFeature) ??
				`Additional ${index + 1}`;
			appendRateLimitWindows(
				windows,
				item.rate_limit ?? item.rateLimit,
				{
					id: `additional-${index + 1}-${slug(name)}`,
					category: "additional",
					name,
				},
				now,
			);
		}
	}
	return windows;
}

interface WindowGroup {
	id: string;
	category: CodexQuotaCategory;
	name: string;
}

function appendRateLimitWindows(
	target: CodexQuotaWindow[],
	value: unknown,
	group: WindowGroup,
	now: number,
): void {
	if (!isRecord(value)) return;
	const allowed = booleanValue(value.allowed);
	const limitReached =
		booleanValue(value.limit_reached ?? value.limitReached) === true ||
		allowed === false;
	const candidates = [
		{ source: "primary" as const, value: value.primary_window ?? value.primaryWindow },
		{
			source: "secondary" as const,
			value: value.secondary_window ?? value.secondaryWindow,
		},
	]
		.filter(
			(candidate): candidate is { source: "primary" | "secondary"; value: JsonObject } =>
				isRecord(candidate.value),
		)
		.map((candidate) => ({
			...candidate,
			kind: quotaWindowKind(candidate.value, candidate.source),
		}))
		.sort((left, right) => windowKindRank(left.kind) - windowKindRank(right.kind));

	for (const [index, candidate] of candidates.entries()) {
		const rawUsed = numberValue(
			candidate.value.used_percent ?? candidate.value.usedPercent,
		);
		const usedPercent =
			rawUsed === null
				? limitReached
					? 100
					: null
				: clampPercent(rawUsed);
		const limitWindowSeconds = positiveNumber(
			candidate.value.limit_window_seconds ??
				candidate.value.limitWindowSeconds,
		);
		target.push({
			id: `${group.id}-${candidate.kind}-${index}`,
			category: group.category,
			name: group.name,
			kind: candidate.kind,
			usedPercent,
			remainingPercent:
				usedPercent === null ? null : clampPercent(100 - usedPercent),
			limitWindowSeconds,
			resetAt: quotaResetAt(candidate.value, now),
			allowed,
			limitReached,
		});
	}
}

function quotaWindowKind(
	window: JsonObject,
	fallback: "primary" | "secondary",
): CodexQuotaWindowKind {
	const seconds = positiveNumber(
		window.limit_window_seconds ?? window.limitWindowSeconds,
	);
	if (seconds === FIVE_HOUR_SECONDS) return "five_hour";
	if (seconds === WEEK_SECONDS) return "weekly";
	if (
		seconds !== null &&
		seconds >= MIN_MONTH_SECONDS &&
		seconds <= MAX_MONTH_SECONDS
	) {
		return "monthly";
	}
	return fallback;
}

function quotaResetAt(window: JsonObject, now: number): number | null {
	const absolute = dateValueToMs(window.reset_at ?? window.resetAt);
	if (absolute !== null) return absolute;
	const offset = positiveNumber(
		window.reset_after_seconds ?? window.resetAfterSeconds,
	);
	return offset === null ? null : now + offset * 1000;
}

function normalizeResetCredits(value: unknown): CodexRateLimitResetCredits {
	if (!isRecord(value)) {
		return { availableCount: null, applicableAvailableCount: null };
	}
	return {
		availableCount: nonNegativeNumber(
			value.available_count ?? value.availableCount,
		),
		applicableAvailableCount: nonNegativeNumber(
			value.applicable_available_count ?? value.applicableAvailableCount,
		),
	};
}

function decodeJwt(token: string | undefined): JsonObject | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (character) =>
			character.charCodeAt(0),
		);
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function dateValueToMs(value: unknown): number | null {
	const numeric = numberValue(value);
	if (numeric !== null) {
		if (numeric <= 0) return null;
		const milliseconds = numeric < 1e11 ? numeric * 1000 : numeric;
		return Number.isNaN(new Date(milliseconds).getTime())
			? null
			: milliseconds;
	}
	const text = normalizeString(value);
	if (!text) return null;
	const parsed = Date.parse(text.replace(/(\.\d{6})\d+/, "$1"));
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlanType(value: unknown): string | null {
	return normalizeString(value)?.toLowerCase() ?? null;
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
	const normalized = numberValue(value);
	return normalized !== null && normalized > 0 ? normalized : null;
}

function nonNegativeNumber(value: unknown): number | null {
	const normalized = numberValue(value);
	return normalized !== null && normalized >= 0 ? normalized : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function windowKindRank(kind: CodexQuotaWindowKind): number {
	switch (kind) {
		case "five_hour":
			return 0;
		case "weekly":
			return 1;
		case "monthly":
			return 2;
		case "primary":
			return 3;
		case "secondary":
			return 4;
	}
}

function slug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "quota"
	);
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The safe status-only error remains useful when the body cannot be cancelled.
	}
}

function clientAbortError(error: unknown): DOMException {
	return isAbortError(error)
		? error
		: new DOMException("The client request was aborted.", "AbortError");
}

function codexUsageUnavailable(): ApiError {
	return new ApiError(
		502,
		"Unable to retrieve Codex subscription usage.",
		"upstream_error",
		"codex_usage_unavailable",
	);
}

function codexUsageUpstreamError(status: number): ApiError {
	return new ApiError(
		502,
		"The Codex subscription usage request was rejected.",
		"upstream_error",
		status === 429 ? "codex_usage_rate_limited" : "codex_usage_upstream_error",
	);
}

function invalidCodexUsageResponse(): ApiError {
	return new ApiError(
		502,
		"The Codex subscription usage response was invalid.",
		"upstream_error",
		"invalid_codex_usage_response",
	);
}
