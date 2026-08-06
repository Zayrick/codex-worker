import type { JsonObject } from "../shared/json";

export interface AdaptedMessagesRequest {
	body: JsonObject;
	model: string;
	stream: boolean;
	reverseToolNames: ReadonlyMap<string, string>;
}

export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
}

export interface AnthropicSseEvent {
	event: string;
	data: JsonObject;
}
