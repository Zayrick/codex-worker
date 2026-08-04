import { constantTimeEqual } from "../auth/constant-time";
import {
	deviceCompletePage,
	deviceErrorPage,
	deviceLoginPage,
	devicePendingPage,
	deviceStartPage,
} from "../http/device-page";
import { emptyResponse, withCors } from "../http/response";
import { readLimitedBody } from "../shared/limited-body";
import {
	pollDeviceAuthorization,
	startDeviceAuthorization,
} from "../auth/device-flow";
import {
	ApiError,
	normalizeError,
	requireString,
} from "../shared/api-error";
import { hasErrorCode, logFailure } from "../shared/logging";

const MAX_DEVICE_FORM_BYTES = 8 * 1024;

export type DeviceRoute = "start_form" | "start" | "poll";

export async function handleDeviceRoute(
	route: DeviceRoute,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	if (route === "start_form") {
		return withCors(deviceLoginPage(), env.CORS_ORIGIN);
	}

	if (route === "start") {
		try {
			await requireDeviceSecret(
				await readDeviceSecret(request),
				env.DEVICE_AUTH_SECRET,
			);
		} catch (error) {
			if (!hasErrorCode(error, "invalid_oauth_device_secret")) {
				logFailure("device_auth", error);
			}
			return emptyResponse(404);
		}
	}

	try {
		const response =
			route === "start"
				? await startDeviceRoute(request, url, env)
				: await pollDeviceRoute(request, url, env);
		return withCors(response, env.CORS_ORIGIN);
	} catch (error) {
		const apiError = normalizeError(error);
		if (apiError.status >= 500) logFailure("device_request", apiError);
		return apiError.status === 404
			? emptyResponse(404)
			: withCors(deviceErrorPage(apiError), env.CORS_ORIGIN);
	}
}

async function startDeviceRoute(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const authorization = await startDeviceAuthorization(env, request.signal);
	const pollUrl = new URL("/auth/device/poll", url);
	pollUrl.searchParams.set("state", authorization.state);
	return deviceStartPage(authorization, pollUrl);
}

async function pollDeviceRoute(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response> {
	const state = requireString(
		url.searchParams.get("state"),
		"state",
		"Missing device authorization state.",
	);
	const result = await pollDeviceAuthorization(env, state, request.signal);
	return result.status === "pending"
		? devicePendingPage(url, result.retryAfter)
		: deviceCompletePage();
}

async function readDeviceSecret(request: Request): Promise<string | null> {
	const bytes = await readLimitedBody(request, MAX_DEVICE_FORM_BYTES);
	if (!bytes) return null;
	return new URLSearchParams(new TextDecoder().decode(bytes)).get("secret");
}

async function requireDeviceSecret(
	provided: unknown,
	expected: string,
): Promise<string> {
	if (
		typeof provided !== "string" ||
		provided.length === 0 ||
		provided.length > 512 ||
		!(await constantTimeEqual(provided, expected))
	) {
		throw invalidDeviceSecret();
	}
	return provided;
}

function invalidDeviceSecret(): ApiError {
	return new ApiError(
		401,
		"Invalid OAuth device authorization secret.",
		"authentication_error",
		"invalid_oauth_device_secret",
	);
}
