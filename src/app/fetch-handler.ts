import { authenticateClient } from "../auth/api-key";
import { getCodexCredentials } from "../auth/credentials";
import {
	isCodexProxyPath,
	isWebSocketUpgrade,
} from "../codex/proxy";
import { emptyResponse, withCors } from "../http/response";
import { hasErrorCode, logFailure } from "../shared/logging";
import { handleAdminRoute, matchAdminRoute } from "./admin-handler";
import { handleApiRoute, type ApiRoute } from "./api-handler";

export async function handleFetch(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/healthz") {
		return healthResponse(env);
	}

	const adminRoute = matchAdminRoute(
		request.method,
		url.pathname,
		env.ADMIN_PATH,
	);
	if (adminRoute) return handleAdminRoute(adminRoute, request, url, env);
	if (request.method === "OPTIONS" && matchApiPath(url.pathname)) {
		return withCors(emptyResponse(204), env.CORS_ORIGIN);
	}

	const apiRoute = matchApiRoute(request, url.pathname);
	if (!apiRoute || !(await apiClientAuthenticated(request, env))) {
		return emptyResponse(404);
	}
	return handleApiRoute(apiRoute, request, url, env, ctx);
}

function matchApiRoute(request: Request, pathname: string): ApiRoute | undefined {
	const route = matchApiPath(pathname);
	if (!route) return undefined;
	if (route === "models") return request.method === "GET" ? route : undefined;
	if (route === "responses") {
		if (request.method === "POST") return route;
		return request.method === "GET" && isWebSocketUpgrade(request)
			? "proxy"
			: undefined;
	}
	if (route === "proxy") {
		return request.method !== "OPTIONS" && request.method !== "CONNECT"
			? route
			: undefined;
	}
	return request.method === "POST" ? route : undefined;
}

function matchApiPath(pathname: string): ApiRoute | undefined {
	switch (pathname) {
		case "/v1/models":
			return "models";
		case "/v1/responses":
		case "/v1/responses/":
		case "/backend-api/codex/responses":
		case "/backend-api/codex/responses/":
			return "responses";
		case "/v1/responses/compact":
		case "/v1/responses/compact/":
		case "/backend-api/codex/responses/compact":
		case "/backend-api/codex/responses/compact/":
			return "compact";
		case "/v1/chat/completions":
			return "chat_completions";
		case "/v1/completions":
			return "completions";
		default:
			return isCodexProxyPath(pathname) ? "proxy" : undefined;
	}
}

async function apiClientAuthenticated(
	request: Request,
	env: Env,
): Promise<boolean> {
	try {
		await authenticateClient(request, env);
		return true;
	} catch (error) {
		if (!hasErrorCode(error, "invalid_api_key")) {
			logFailure("client_auth", error);
		}
		return false;
	}
}

async function healthResponse(env: Env): Promise<Response> {
	try {
		await getCodexCredentials(env);
		return emptyResponse(204);
	} catch (error) {
		logFailure("health_check", error);
		return emptyResponse(404);
	}
}
