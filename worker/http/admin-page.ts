import { ApiError } from "../shared/api-error";

const ADMIN_APP_PATH = "/index.html";

export async function adminApplicationPage(
	request: Request,
	assets: Fetcher,
): Promise<Response> {
	const assetUrl = new URL(ADMIN_APP_PATH, request.url);
	let assetResponse: Response;
	try {
		assetResponse = await assets.fetch(
			new Request(assetUrl, {
				headers: { Accept: "text/html" },
			}),
		);
	} catch {
		throw unavailableAdminApplication();
	}

	if (
		!assetResponse.ok ||
		!assetResponse.headers
			.get("Content-Type")
			?.toLowerCase()
			.includes("text/html")
	) {
		await discardBody(assetResponse);
		throw unavailableAdminApplication();
	}

	const nonce = pageNonce();
	const nonceHandler = {
		element(element: Element): void {
			element.setAttribute("nonce", nonce);
		},
	};
	const transformed = new HTMLRewriter()
		.on("script", nonceHandler)
		.on("style", nonceHandler)
		.on('link[rel="stylesheet"]', nonceHandler)
		.on('link[rel="modulepreload"]', nonceHandler)
		.on('meta[property="csp-nonce"]', nonceHandler)
		.transform(assetResponse);
	const headers = new Headers(transformed.headers);
	headers.set("Cache-Control", "no-store");
	headers.set(
		"Content-Security-Policy",
		[
			"default-src 'none'",
			`script-src 'self' 'nonce-${nonce}'`,
			`style-src 'self' 'nonce-${nonce}'`,
			"connect-src 'self'",
			"img-src 'self' data:",
			"font-src 'self'",
			"form-action 'self'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
		].join("; "),
	);
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "same-origin");
	headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
	headers.set("Referrer-Policy", "same-origin");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");

	return new Response(transformed.body, {
		status: transformed.status,
		statusText: transformed.statusText,
		headers,
	});
}

function pageNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The safe application error remains useful when the body cannot be cancelled.
	}
}

function unavailableAdminApplication(): ApiError {
	return new ApiError(
		500,
		"The management application is unavailable.",
		"configuration_error",
		"admin_application_unavailable",
	);
}
