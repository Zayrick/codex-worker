export interface OAuthStatus {
	email: string | null;
	expiresAt: number;
}

export interface SubscriptionMetadata {
	planType: string | null;
	subscriptionActiveStart: number | null;
	subscriptionActiveUntil: number | null;
}

export type QuotaWindowKind =
	| "five_hour"
	| "weekly"
	| "monthly"
	| "primary"
	| "secondary";

export type QuotaCategory = "codex" | "code_review" | "additional";

export interface QuotaWindow {
	id: string;
	category: QuotaCategory;
	name: string;
	kind: QuotaWindowKind;
	usedPercent: number | null;
	remainingPercent: number | null;
	limitWindowSeconds: number | null;
	resetAt: number | null;
	allowed: boolean | null;
	limitReached: boolean;
}

export interface SubscriptionInfo extends SubscriptionMetadata {
	windows: QuotaWindow[];
	rateLimitResetCredits: {
		availableCount: number | null;
		applicableAvailableCount: number | null;
	};
	fetchedAt: number;
}

export interface ClientApiKey {
	name: string;
	key: string;
	enabled: boolean;
}

export interface AuthProxyAccount {
	name: string;
	accountId: string;
	enabled: boolean;
}

export interface AdminState {
	oauth: OAuthStatus | null;
	subscription: SubscriptionMetadata | null;
	apiKeys: ClientApiKey[];
	authProxyAccounts: AuthProxyAccount[];
}

export interface DeviceAuthorization {
	verificationUri: string;
	userCode: string;
	expiresIn: number;
	interval: number;
	state: string;
}

export type DevicePollResult =
	| { status: "pending"; retryAfter: number }
	| {
			status: "stored";
			oauth: OAuthStatus;
			subscription: SubscriptionMetadata;
	  };

export class AdminApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "AdminApiError";
		this.status = status;
		this.code = code;
	}
}

export class AdminSessionExpiredError extends AdminApiError {
	constructor() {
		super("管理会话已失效，请重新登录。", 401, "invalid_admin_session");
		this.name = "AdminSessionExpiredError";
	}
}

export class AdminApiClient {
	readonly basePath: string;

	constructor(basePath: string) {
		this.basePath = basePath.replace(/\/$/, "");
	}

	async login(secret: string): Promise<void> {
		await this.submitSessionForm(
			"/login",
			new URLSearchParams({ secret }),
			false,
		);
	}

	async logout(): Promise<void> {
		await this.submitSessionForm("/logout", undefined, true);
	}

	getState(): Promise<AdminState> {
		return this.requestJson("/state", undefined, parseAdminState);
	}

	getSubscription(): Promise<SubscriptionInfo> {
		return this.requestJson(
			"/subscription",
			undefined,
			(value) => parseSubscriptionEnvelope(value).subscription,
		);
	}

	startDeviceAuthorization(): Promise<DeviceAuthorization> {
		return this.requestJson(
			"/oauth/device",
			{ method: "POST" },
			parseDeviceAuthorization,
		);
	}

	pollDeviceAuthorization(state: string): Promise<DevicePollResult> {
		return this.requestJson(
			"/oauth/device/poll",
			jsonRequest("POST", { state }),
			parseDevicePollResult,
		);
	}

	async removeOAuth(): Promise<void> {
		await this.requestJson(
			"/oauth",
			{ method: "DELETE" },
			(value) => {
				if (!isRecord(value) || value.oauth !== null) throw invalidPayload();
				return null;
			},
		);
	}

	createApiKey(value: ClientApiKey): Promise<ClientApiKey[]> {
		return this.requestJson(
			"/api-keys",
			jsonRequest("POST", value),
			(value) => parseApiKeysEnvelope(value).apiKeys,
		);
	}

	updateApiKey(
		originalName: string,
		value: ClientApiKey,
	): Promise<ClientApiKey[]> {
		return this.requestJson(
			"/api-keys",
			jsonRequest("PUT", { originalName, ...value }),
			(value) => parseApiKeysEnvelope(value).apiKeys,
		);
	}

	deleteApiKey(name: string): Promise<ClientApiKey[]> {
		return this.requestJson(
			"/api-keys",
			jsonRequest("DELETE", { name }),
			(value) => parseApiKeysEnvelope(value).apiKeys,
		);
	}

	createAuthProxyAccount(value: AuthProxyAccount): Promise<AuthProxyAccount[]> {
		return this.requestJson(
			"/auth-proxy",
			jsonRequest("POST", value),
			(value) => parseAuthProxyAccountsEnvelope(value).authProxyAccounts,
		);
	}

	updateAuthProxyAccount(
		originalName: string,
		value: AuthProxyAccount,
	): Promise<AuthProxyAccount[]> {
		return this.requestJson(
			"/auth-proxy",
			jsonRequest("PUT", { originalName, ...value }),
			(value) => parseAuthProxyAccountsEnvelope(value).authProxyAccounts,
		);
	}

	deleteAuthProxyAccount(name: string): Promise<AuthProxyAccount[]> {
		return this.requestJson(
			"/auth-proxy",
			jsonRequest("DELETE", { name }),
			(value) => parseAuthProxyAccountsEnvelope(value).authProxyAccounts,
		);
	}

	private async submitSessionForm(
		path: string,
		body: URLSearchParams | undefined,
		sessionRequired: boolean,
	): Promise<void> {
		const headers = new Headers({ Accept: "application/json" });
		const init: RequestInit = {
			method: "POST",
			credentials: "same-origin",
			headers,
			...(body ? { body } : {}),
		};
		const response = await fetch(`${this.basePath}${path}`, init);
		if (response.ok) {
			await discardResponse(response);
			return;
		}
		throw await responseError(response, sessionRequired);
	}

	private async requestJson<T>(
		path: string,
		init: RequestInit | undefined,
		parse: (value: unknown) => T,
	): Promise<T> {
		const headers = new Headers(init?.headers);
		headers.set("Accept", "application/json");
		const response = await fetch(`${this.basePath}${path}`, {
			...init,
			credentials: "same-origin",
			headers,
		});
		if (!response.ok) throw await responseError(response, true);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw invalidPayload();
		}
		return parse(payload);
	}
}

function jsonRequest(method: string, value: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(value),
	};
}

async function responseError(
	response: Response,
	sessionRequired: boolean,
): Promise<AdminApiError> {
	if (sessionRequired && response.status === 401) {
		await discardResponse(response);
		return new AdminSessionExpiredError();
	}

	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		// Fall back to the status-only error below.
	}
	const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
	const message = error && typeof error.message === "string"
		? error.message
		: "管理请求失败，请稍后重试。";
	const code = error && typeof error.code === "string" ? error.code : undefined;
	return new AdminApiError(message, response.status, code);
}

async function discardResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The status-only result is still authoritative if cancellation fails.
	}
}

function parseAdminState(value: unknown): AdminState {
	if (!isRecord(value) || !Array.isArray(value.apiKeys)) throw invalidPayload();
	return {
		oauth: value.oauth === null ? null : parseOAuthStatus(value.oauth),
		subscription:
			value.subscription === null
				? null
				: parseSubscriptionMetadata(value.subscription),
		apiKeys: value.apiKeys.map(parseClientApiKey),
		authProxyAccounts: parseAuthProxyAccounts(value.authProxyAccounts),
	};
}

function parseSubscriptionEnvelope(value: unknown): {
	subscription: SubscriptionInfo;
} {
	if (!isRecord(value)) throw invalidPayload();
	return { subscription: parseSubscriptionInfo(value.subscription) };
}

function parseSubscriptionInfo(value: unknown): SubscriptionInfo {
	if (!isRecord(value) || !Array.isArray(value.windows)) throw invalidPayload();
	const metadata = parseSubscriptionMetadata(value);
	const credits = value.rateLimitResetCredits;
	if (!isRecord(credits)) throw invalidPayload();
	return {
		...metadata,
		windows: value.windows.map(parseQuotaWindow),
		rateLimitResetCredits: {
			availableCount: nullableNumber(credits.availableCount),
			applicableAvailableCount: nullableNumber(
				credits.applicableAvailableCount,
			),
		},
		fetchedAt: finiteNumber(value.fetchedAt),
	};
}

function parseSubscriptionMetadata(value: unknown): SubscriptionMetadata {
	if (!isRecord(value)) throw invalidPayload();
	return {
		planType: nullableString(value.planType),
		subscriptionActiveStart: nullableNumber(value.subscriptionActiveStart),
		subscriptionActiveUntil: nullableNumber(value.subscriptionActiveUntil),
	};
}

function parseOAuthStatus(value: unknown): OAuthStatus {
	if (!isRecord(value)) throw invalidPayload();
	return {
		email: nullableString(value.email),
		expiresAt: finiteNumber(value.expiresAt),
	};
}

function parseQuotaWindow(value: unknown): QuotaWindow {
	if (!isRecord(value)) throw invalidPayload();
	const kind = value.kind;
	const category = value.category;
	if (!isQuotaWindowKind(kind) || !isQuotaCategory(category)) {
		throw invalidPayload();
	}
	return {
		id: requiredString(value.id),
		category,
		name: requiredString(value.name),
		kind,
		usedPercent: nullableNumber(value.usedPercent),
		remainingPercent: nullableNumber(value.remainingPercent),
		limitWindowSeconds: nullableNumber(value.limitWindowSeconds),
		resetAt: nullableNumber(value.resetAt),
		allowed: nullableBoolean(value.allowed),
		limitReached: requiredBoolean(value.limitReached),
	};
}

function parseClientApiKey(value: unknown): ClientApiKey {
	if (!isRecord(value)) throw invalidPayload();
	return {
		name: requiredString(value.name),
		key: requiredString(value.key),
		enabled: requiredBoolean(value.enabled),
	};
}

function parseApiKeysEnvelope(value: unknown): { apiKeys: ClientApiKey[] } {
	if (!isRecord(value) || !Array.isArray(value.apiKeys)) throw invalidPayload();
	return { apiKeys: value.apiKeys.map(parseClientApiKey) };
}

function parseAuthProxyAccountsEnvelope(value: unknown): {
	authProxyAccounts: AuthProxyAccount[];
} {
	if (!isRecord(value)) throw invalidPayload();
	return {
		authProxyAccounts: parseAuthProxyAccounts(value.authProxyAccounts),
	};
}

function parseAuthProxyAccounts(value: unknown): AuthProxyAccount[] {
	if (!Array.isArray(value)) throw invalidPayload();
	return value.map(parseAuthProxyAccount);
}

function parseAuthProxyAccount(value: unknown): AuthProxyAccount {
	if (!isRecord(value)) throw invalidPayload();
	return {
		name: requiredString(value.name),
		accountId: requiredString(value.accountId),
		enabled: requiredBoolean(value.enabled),
	};
}

function parseDeviceAuthorization(value: unknown): DeviceAuthorization {
	if (!isRecord(value)) throw invalidPayload();
	return {
		verificationUri: requiredString(value.verificationUri),
		userCode: requiredString(value.userCode),
		expiresIn: positiveNumber(value.expiresIn),
		interval: positiveNumber(value.interval),
		state: requiredString(value.state),
	};
}

function parseDevicePollResult(value: unknown): DevicePollResult {
	if (!isRecord(value)) throw invalidPayload();
	if (value.status === "pending") {
		return { status: "pending", retryAfter: positiveNumber(value.retryAfter) };
	}
	if (value.status === "stored") {
		return {
			status: "stored",
			oauth: parseOAuthStatus(value.oauth),
			subscription: parseSubscriptionMetadata(value.subscription),
		};
	}
	throw invalidPayload();
}

function isQuotaWindowKind(value: unknown): value is QuotaWindowKind {
	return (
		value === "five_hour" ||
		value === "weekly" ||
		value === "monthly" ||
		value === "primary" ||
		value === "secondary"
	);
}

function isQuotaCategory(value: unknown): value is QuotaCategory {
	return value === "codex" || value === "code_review" || value === "additional";
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw invalidPayload();
	return value;
}

function nullableString(value: unknown): string | null {
	if (value === null) return null;
	return requiredString(value);
}

function finiteNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalidPayload();
	return value;
}

function positiveNumber(value: unknown): number {
	const result = finiteNumber(value);
	if (result <= 0) throw invalidPayload();
	return result;
}

function nullableNumber(value: unknown): number | null {
	return value === null ? null : finiteNumber(value);
}

function requiredBoolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw invalidPayload();
	return value;
}

function nullableBoolean(value: unknown): boolean | null {
	return value === null ? null : requiredBoolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(): AdminApiError {
	return new AdminApiError(
		"管理服务返回了无法识别的数据。",
		502,
		"invalid_admin_response",
	);
}
