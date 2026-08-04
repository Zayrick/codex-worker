import { codexStreamFailed } from "../codex/stream-error";
import type { ChatState } from "./types";

export const MAX_CHAT_RETAINED_CHARS = 8 * 1024 * 1024;
export const MAX_CHAT_TOOL_CALLS = 128;
export const MAX_CHAT_TOOL_ALIASES = MAX_CHAT_TOOL_CALLS * 3;

export function reserveChatChars(
	state: ChatState,
	additionalChars: number,
): void {
	if (additionalChars <= 0) return;
	if (state.retainedChars > MAX_CHAT_RETAINED_CHARS - additionalChars) {
		throw codexStreamFailed();
	}
	state.retainedChars += additionalChars;
}

export function reserveChatTool(state: ChatState, name: string): void {
	if (state.tools.length >= MAX_CHAT_TOOL_CALLS) throw codexStreamFailed();
	reserveChatChars(state, name.length);
}

export function reserveChatAlias(
	state: ChatState,
	key: string | number,
): void {
	const aliasCount =
		state.toolsByItemId.size +
		state.toolsByCallId.size +
		state.toolsByOutputIndex.size;
	if (aliasCount >= MAX_CHAT_TOOL_ALIASES) throw codexStreamFailed();
	if (typeof key === "string") reserveChatChars(state, key.length);
}
