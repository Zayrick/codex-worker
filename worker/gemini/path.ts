const ACTION_PATH = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)\/?$/;
const MODEL_PATH = /^\/v1beta\/models\/([^/:]+)\/?$/;

export type GeminiAction =
	| "generateContent"
	| "streamGenerateContent"
	| "countTokens";

export function matchGeminiActionPath(
	pathname: string,
): { model: string; action: GeminiAction } | undefined {
	const match = ACTION_PATH.exec(pathname);
	if (!match) return undefined;
	const model = decodeModel(match[1] ?? "");
	if (!model) return undefined;
	return {
		model,
		action: match[2] as GeminiAction,
	};
}

export function matchGeminiModelPath(pathname: string): string | undefined {
	const match = MODEL_PATH.exec(pathname);
	return match ? decodeModel(match[1] ?? "") : undefined;
}

function decodeModel(value: string): string | undefined {
	try {
		const decoded = decodeURIComponent(value).trim();
		if (decoded && !decoded.includes("/")) return decoded;
	} catch {
		// Invalid percent encoding is simply not a supported route.
	}
	return undefined;
}
