import { SSE_DONE, sseData } from "../http/sse-encoder";
import type { JsonObject } from "../shared/json";
import { requireChatResponseId } from "./reducer";
import { finishReason, usageToChat } from "./response";
import type {
	ChatAction,
	ChatState,
	ToolActionSnapshot,
} from "./types";

export interface StreamPresentationState {
	roleSent: boolean;
	finished: boolean;
}

export async function presentChatAction(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	state: ChatState,
	presentation: StreamPresentationState,
	action: ChatAction,
	includeUsage: boolean,
): Promise<void> {
	switch (action.type) {
		case "response_created":
			await ensureRoleChunk(writer, state, presentation);
			return;

		case "text_delta":
			await ensureRoleChunk(writer, state, presentation);
			if (action.delta) {
				await writer.write(
					sseData(chatChunk(state, { content: action.delta }, null)),
				);
			}
			return;

		case "reasoning_delta":
			await ensureRoleChunk(writer, state, presentation);
			if (action.delta) {
				await writer.write(
					sseData(
						chatChunk(state, { reasoning_content: action.delta }, null),
					),
				);
			}
			return;

		case "tool_started":
			await ensureRoleChunk(writer, state, presentation);
			await writer.write(
				sseData(toolStartChunk(state, action.tool, action.initialArguments)),
			);
			return;

		case "tool_arguments_delta":
			await ensureRoleChunk(writer, state, presentation);
			if (action.delta) {
				await writer.write(
					sseData(
						chatChunk(
							state,
							{
								tool_calls: [
									{
										index: action.tool.index,
										function: { arguments: action.delta },
									},
								],
							},
							null,
						),
					),
				);
			}
			return;

		case "response_completed":
			await ensureRoleChunk(writer, state, presentation);
			await writer.write(
				sseData(
					chatChunk(
						state,
						{},
						finishReason(
							state.incompleteReason,
							state.tools.length > 0,
							state.terminal === "incomplete",
						),
					),
				),
			);
			if (includeUsage) {
				await writer.write(
					sseData({
						id: state.id,
						object: "chat.completion.chunk",
						created: state.created,
						model: state.model,
						choices: [],
						usage: usageToChat(state.usage),
					}),
				);
			}
			await writer.write(SSE_DONE);
			presentation.finished = true;
			return;

		default:
			return assertNever(action);
	}
}

async function ensureRoleChunk(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	state: ChatState,
	presentation: StreamPresentationState,
): Promise<void> {
	if (presentation.roleSent) return;
	requireChatResponseId(state);
	await writer.write(
		sseData(chatChunk(state, { role: "assistant", content: "" }, null)),
	);
	presentation.roleSent = true;
}

function chatChunk(
	state: ChatState,
	delta: JsonObject,
	finish: string | null,
): JsonObject {
	return {
		id: state.id,
		object: "chat.completion.chunk",
		created: state.created,
		model: state.model,
		choices: [
			{
				index: 0,
				delta,
				logprobs: null,
				finish_reason: finish,
			},
		],
	};
}

function toolStartChunk(
	state: ChatState,
	tool: ToolActionSnapshot,
	initialArguments: string,
): JsonObject {
	return chatChunk(
		state,
		{
			tool_calls: [
				{
					index: tool.index,
					id: tool.id,
					type: "function",
					function: { name: tool.name, arguments: initialArguments },
				},
			],
		},
		null,
	);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled chat action: ${String(value)}`);
}
