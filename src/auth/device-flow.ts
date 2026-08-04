import {
	credentialsFromTokenResponse,
	requireOAuthUnconfigured,
	storeOAuthCredentials,
} from "./credentials";
import { openJson, sealJson } from "./envelope";
import {
	DEVICE_VERIFICATION_URL,
	pollDeviceAuthorizationToken,
	requestDeviceAuthorization,
} from "./oauth-provider";
import { ApiError } from "../shared/api-error";
import { isRecord, numberField, stringField } from "../shared/json";

const DEVICE_STATE_PURPOSE = "codex-worker/device-state/v1";
const DEVICE_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

type OAuthEnv = Pick<Env, "AUTH_KV" | "OAUTH_MASTER_KEY">;

interface DeviceState {
	version: 1;
	deviceAuthId: string;
	userCode: string;
	expiresAt: number;
	interval: number;
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
	| { status: "stored" };

export async function startDeviceAuthorization(
	env: OAuthEnv,
	signal?: AbortSignal,
): Promise<DeviceAuthorization> {
	await requireOAuthUnconfigured(env);
	const providerAuthorization = await requestDeviceAuthorization(signal);
	const interval = pollInterval(providerAuthorization.interval);
	const expiresAt = Date.now() + DEVICE_LIFETIME_MS;
	let state: string;
	try {
		state = await sealJson(
			{
				version: 1,
				deviceAuthId: providerAuthorization.deviceAuthId,
				userCode: providerAuthorization.userCode,
				expiresAt,
				interval,
			} satisfies DeviceState,
			env.OAUTH_MASTER_KEY,
			DEVICE_STATE_PURPOSE,
		);
	} catch {
		throw new ApiError(
			500,
			"Unable to create a device authorization session.",
			"configuration_error",
			"device_session_unavailable",
		);
	}

	return {
		verificationUri: DEVICE_VERIFICATION_URL,
		userCode: providerAuthorization.userCode,
		expiresIn: Math.floor(DEVICE_LIFETIME_MS / 1000),
		interval,
		state,
	};
}

export async function pollDeviceAuthorization(
	env: OAuthEnv,
	sealedState: string,
	signal?: AbortSignal,
): Promise<DevicePollResult> {
	await requireOAuthUnconfigured(env);
	const state = await deviceState(sealedState, env.OAUTH_MASTER_KEY);
	if (state.expiresAt <= Date.now()) {
		throw new ApiError(
			410,
			"The device authorization session has expired.",
			"invalid_request_error",
			"device_session_expired",
		);
	}

	const result = await pollDeviceAuthorizationToken(
		state.deviceAuthId,
		state.userCode,
		signal,
	);
	if (result.status === "pending") {
		return { status: "pending", retryAfter: state.interval };
	}

	const credentials = credentialsFromTokenResponse(
		result.tokenPayload,
		undefined,
	);
	await requireOAuthUnconfigured(env);
	await storeOAuthCredentials(env, credentials);
	return { status: "stored" };
}

async function deviceState(
	sealedState: string,
	masterKey: string,
): Promise<DeviceState> {
	let value: unknown;
	try {
		value = await openJson(sealedState, masterKey, DEVICE_STATE_PURPOSE);
	} catch {
		throw invalidDeviceState();
	}
	if (!isRecord(value)) throw invalidDeviceState();
	const deviceAuthId = stringField(value, "deviceAuthId");
	const userCode = stringField(value, "userCode");
	const expiresAt = numberField(value, "expiresAt");
	const interval = numberField(value, "interval");
	if (
		value.version !== 1 ||
		!deviceAuthId ||
		!userCode ||
		expiresAt === undefined ||
		interval === undefined ||
		interval < 1
	) {
		throw invalidDeviceState();
	}
	return { version: 1, deviceAuthId, userCode, expiresAt, interval };
}

function pollInterval(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 60
		? parsed
		: DEFAULT_POLL_INTERVAL_SECONDS;
}

function invalidDeviceState(): ApiError {
	return new ApiError(
		400,
		"The device authorization session is invalid.",
		"invalid_request_error",
		"invalid_device_session",
	);
}
