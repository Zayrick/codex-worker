import { ApiError } from "../shared/api-error";
import {
	BodySizeLimitError,
	readLimitedBody,
} from "../shared/limited-body";

const MAX_LIVE_BOOTSTRAP_BODY_BYTES = 16 * 1024 * 1024;

export async function adaptLiveBootstrapRequest(
	request: Request,
): Promise<Request> {
	if (!isMultipartBootstrap(request)) return request;

	let form: FormData;
	try {
		const bytes = await readLimitedBody(
			request,
			MAX_LIVE_BOOTSTRAP_BODY_BYTES,
		);
		if (!bytes) throw invalidLiveRequest("The live request body is empty.");
		form = await new Request(request.url, {
			method: "POST",
			headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
			body: bytes,
		}).formData();
	} catch (error) {
		if (error instanceof BodySizeLimitError) {
			throw new ApiError(
				413,
				"The live request body is too large.",
				"invalid_request_error",
				"request_too_large",
			);
		}
		if (error instanceof ApiError) throw error;
		throw invalidLiveRequest("The live multipart body is invalid.");
	}

	const rawSdp = form.get("sdp");
	if (rawSdp === null) {
		throw invalidLiveRequest("The live multipart body requires an 'sdp' field.");
	}
	const payload: { sdp: string; session?: unknown } = {
		sdp: await formValueText(rawSdp),
	};
	const rawSession = form.get("session");
	if (rawSession !== null) {
		try {
			payload.session = JSON.parse(await formValueText(rawSession));
		} catch {
			throw invalidLiveRequest(
				"The live 'session' field must contain valid JSON.",
			);
		}
	}

	const headers = new Headers(request.headers);
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Encoding");
	headers.delete("Content-Length");
	return new Request(request.url, {
		method: request.method,
		headers,
		body: JSON.stringify(payload),
		signal: request.signal,
	});
}

function isMultipartBootstrap(request: Request): boolean {
	if (request.method !== "POST") return false;
	const pathname = new URL(request.url).pathname;
	if (pathname !== "/v1/live" && pathname !== "/v1/realtime/calls") {
		return false;
	}
	return (
		request.headers
			.get("Content-Type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() === "multipart/form-data"
	);
}

async function formValueText(value: string | File): Promise<string> {
	return typeof value === "string" ? value : value.text();
}

function invalidLiveRequest(message: string): ApiError {
	return new ApiError(
		400,
		message,
		"invalid_request_error",
		"invalid_live_request",
	);
}
