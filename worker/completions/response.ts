import { isRecord, type JsonObject } from "../shared/json";

export function completionFromChat(
	chat: JsonObject,
	echoPrefix = "",
): JsonObject {
	const choices = Array.isArray(chat.choices)
		? chat.choices.flatMap((value) => {
			if (!isRecord(value)) return [];
			const message = isRecord(value.message) ? value.message : undefined;
			const content = typeof message?.content === "string" ? message.content : "";
			return [
				{
					index: typeof value.index === "number" ? value.index : 0,
					text: `${echoPrefix}${content}`,
					logprobs: value.logprobs ?? null,
					finish_reason: value.finish_reason ?? null,
				},
			];
		})
		: [];

	const result: JsonObject = {
		id: completionId(chat.id),
		object: "text_completion",
		created: chat.created,
		model: chat.model,
		choices,
	};
	if (chat.usage !== undefined) result.usage = chat.usage;
	return result;
}

export function completionId(value: unknown): unknown {
	if (typeof value !== "string") return value;
	if (value.startsWith("chatcmpl-")) return `cmpl-${value.slice(9)}`;
	if (value.startsWith("resp_")) return `cmpl-${value.slice(5)}`;
	return value;
}
