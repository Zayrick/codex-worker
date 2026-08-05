import {
	adminSecretMatches,
	adminSessionCookieHeader,
	clearAdminSessionCookieHeader,
	createAdminSession,
	hasValidAdminSession,
} from "../auth/admin-session";
import {
	createApiKey,
	deleteApiKey,
	readApiKeys,
	updateApiKey,
} from "../auth/api-key";
import {
	deleteOAuthCredentials,
	oauthStatus,
	readOAuthCredentials,
} from "../auth/credentials";
import {
	pollDeviceAuthorization,
	startDeviceAuthorization,
} from "../auth/device-flow";
import { adminDashboardPage, adminLoginPage } from "../http/admin-page";
import { jsonResponse } from "../http/response";
import {
	ApiError,
	errorPayload,
	normalizeError,
	requireRecord,
	requireString,
} from "../shared/api-error";
import { stringField, type JsonObject } from "../shared/json";
import {
	BodySizeLimitError,
	readLimitedBody,
} from "../shared/limited-body";
import { logFailure } from "../shared/logging";

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const ADMIN_PATH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type AdminRoute =
	| "page"
	| "login"
	| "logout"
	| "state"
	| "oauth_start"
	| "oauth_poll"
	| "oauth_delete"
	| "api_keys_get"
	| "api_keys_create"
	| "api_keys_update"
	| "api_keys_delete";

export interface MatchedAdminRoute {
	basePath: string;
	route: AdminRoute;
}

export function matchAdminRoute(
	method: string,
	pathname: string,
	configuredPath: string,
): MatchedAdminRoute | undefined {
	const basePath = adminBasePath(configuredPath);
	if (!basePath) return undefined;
	if (pathname === basePath) {
		return method === "GET" ? { basePath, route: "page" } : undefined;
	}
	if (!pathname.startsWith(`${basePath}/`)) return undefined;
	const relative = pathname.slice(basePath.length);
	const route = ADMIN_ROUTES.get(`${method} ${relative}`);
	return route ? { basePath, route } : undefined;
}

export async function handleAdminRoute(
	match: MatchedAdminRoute,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	try {
		if (match.route === "page") {
			return (await hasValidAdminSession(request, env))
				? adminDashboardPage(match.basePath)
				: adminLoginPage(match.basePath);
		}
		if (match.route === "login") {
			return await handleAdminLogin(request, url, match.basePath, env);
		}
		if (match.route === "logout") {
			requireSameOrigin(request, url);
			const response = redirectResponse(match.basePath, url);
			response.headers.append("Set-Cookie", clearAdminSessionCookieHeader());
			return response;
		}

		if (!(await hasValidAdminSession(request, env))) {
			throw invalidAdminSession();
		}
		if (request.method !== "GET") requireSameOrigin(request, url);

		switch (match.route) {
			case "state":
				return await adminState(env);
			case "oauth_start":
				return await startOAuth(request, env);
			case "oauth_poll":
				return await pollOAuth(request, env);
			case "oauth_delete":
				await deleteOAuthCredentials(env);
				return jsonResponse({ oauth: null });
			case "api_keys_get":
				return jsonResponse({ apiKeys: await readApiKeys(env) });
			case "api_keys_create":
				return jsonResponse({
					apiKeys: await createApiKey(env, await parseAdminJson(request)),
				}, 201);
			case "api_keys_update": {
				const body = await parseAdminJson(request);
				return jsonResponse({
					apiKeys: await updateApiKey(
						env,
						stringField(body, "originalName"),
						body,
					),
				});
			}
			case "api_keys_delete": {
				const body = await parseAdminJson(request);
				return jsonResponse({
					apiKeys: await deleteApiKey(env, stringField(body, "name")),
				});
			}
			default:
				throw new ApiError(404, "Not found.", "invalid_request_error", "not_found");
		}
	} catch (error) {
		const apiError = normalizeError(error);
		if (apiError.status >= 500) logFailure("admin_request", apiError);
		return jsonResponse(errorPayload(apiError), apiError.status);
	}
}

async function handleAdminLogin(
	request: Request,
	url: URL,
	basePath: string,
	env: Env,
): Promise<Response> {
	requireSameOrigin(request, url);
	let secret: string | null = null;
	try {
		const bytes = await readLimitedBody(request, MAX_ADMIN_BODY_BYTES);
		if (bytes) {
			secret = new URLSearchParams(new TextDecoder().decode(bytes)).get("secret");
		}
	} catch (error) {
		if (!(error instanceof BodySizeLimitError)) throw error;
	}
	if (!(await adminSecretMatches(secret, env.ADMIN_SECRET))) {
		return adminLoginPage(basePath, true, 401);
	}

	const response = redirectResponse(basePath, url);
	response.headers.append(
		"Set-Cookie",
		adminSessionCookieHeader(await createAdminSession(env)),
	);
	return response;
}

async function adminState(env: Env): Promise<Response> {
	const [credentials, apiKeys] = await Promise.all([
		readOAuthCredentials(env),
		readApiKeys(env),
	]);
	return jsonResponse({
		oauth: credentials ? oauthStatus(credentials) : null,
		apiKeys,
	});
}

async function startOAuth(request: Request, env: Env): Promise<Response> {
	const authorization = await startDeviceAuthorization(env, request.signal);
	return jsonResponse(authorization, 201);
}

async function pollOAuth(request: Request, env: Env): Promise<Response> {
	const body = await parseAdminJson(request);
	const sealedState = requireString(
		stringField(body, "state"),
		"state",
		"Missing device authorization state.",
	);
	const result = await pollDeviceAuthorization(env, sealedState, request.signal);
	return result.status === "pending"
		? jsonResponse(result, 202)
		: jsonResponse({ status: "stored", oauth: oauthStatus(result.credentials) });
}

async function parseAdminJson(request: Request): Promise<JsonObject> {
	try {
		const bytes = await readLimitedBody(request, MAX_ADMIN_BODY_BYTES);
		if (!bytes) throw invalidAdminJson();
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return requireRecord(value);
	} catch (error) {
		if (error instanceof BodySizeLimitError) {
			throw new ApiError(
				413,
				"The management request body is too large.",
				"invalid_request_error",
				"request_too_large",
			);
		}
		if (error instanceof ApiError) throw error;
		throw invalidAdminJson();
	}
}

function requireSameOrigin(request: Request, url: URL): void {
	if (request.headers.get("Origin") !== url.origin) {
		throw new ApiError(
			403,
			"The management request must be same-origin.",
			"authentication_error",
			"invalid_admin_origin",
		);
	}
}

function redirectResponse(basePath: string, url: URL): Response {
	return new Response(null, {
		status: 303,
		headers: {
			Location: new URL(basePath, url).toString(),
			"Cache-Control": "no-store",
		},
	});
}

function adminBasePath(value: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = value.trim();
	return ADMIN_PATH_PATTERN.test(path) ? `/${path}/admin` : undefined;
}

function invalidAdminSession(): ApiError {
	return new ApiError(
		401,
		"The management session is missing or expired.",
		"authentication_error",
		"invalid_admin_session",
	);
}

function invalidAdminJson(): ApiError {
	return new ApiError(
		400,
		"The management request body is not valid JSON.",
		"invalid_request_error",
		"invalid_json",
	);
}

const ADMIN_ROUTES = new Map<string, AdminRoute>([
	["POST /login", "login"],
	["POST /logout", "logout"],
	["GET /state", "state"],
	["POST /oauth/device", "oauth_start"],
	["POST /oauth/device/poll", "oauth_poll"],
	["DELETE /oauth", "oauth_delete"],
	["GET /api-keys", "api_keys_get"],
	["POST /api-keys", "api_keys_create"],
	["PUT /api-keys", "api_keys_update"],
	["DELETE /api-keys", "api_keys_delete"],
]);
