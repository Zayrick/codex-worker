import type { JsonObject } from "../shared/json";

export interface AdaptedGeminiRequest {
	body: JsonObject;
	model: string;
	reverseToolNames: ReadonlyMap<string, string>;
}

export interface GeminiStreamOptions {
	model: string;
	reverseToolNames: ReadonlyMap<string, string>;
}
