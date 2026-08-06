import type { JsonObject } from "../shared/json";

export interface AdaptedChatRequest {
	body: JsonObject;
	model: string;
	stream: boolean;
	includeUsage: boolean;
}

export type ToolKind = "function" | "custom";

export interface ToolCallState {
	index: number;
	outputIndex?: number;
	itemId: string;
	id: string;
	name: string;
	arguments: string;
	kind: ToolKind;
	started: boolean;
}

export interface AdaptedTools {
	items: JsonObject[];
	customNames: Set<string>;
}

export interface ChatState {
	id: string;
	created: number;
	model: string;
	text: string;
	reasoning: string;
	retainedChars: number;
	tools: ToolCallState[];
	toolsByItemId: Map<string, ToolCallState>;
	toolsByCallId: Map<string, ToolCallState>;
	toolsByOutputIndex: Map<number, ToolCallState>;
	usage?: JsonObject;
	incompleteReason?: string;
	terminal: "completed" | "incomplete" | "failed" | null;
}

export interface ToolActionSnapshot {
	readonly index: number;
	readonly id: string;
	readonly name: string;
}

export type ChatAction =
	| { readonly type: "response_created" }
	| { readonly type: "text_delta"; readonly delta: string }
	| { readonly type: "reasoning_delta"; readonly delta: string }
	| {
			readonly type: "tool_started";
			readonly tool: ToolActionSnapshot;
			readonly initialArguments: string;
	  }
	| {
			readonly type: "tool_arguments_delta";
			readonly tool: ToolActionSnapshot;
			readonly delta: string;
	  }
	| { readonly type: "response_completed" };
