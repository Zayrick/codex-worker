import { ApiError, requireRecord, requireString } from "../shared/api-error";
import {
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { adaptToolOutput } from "./tool-output";
import { toInputFilePart, toInputImagePart } from "./input-parts";
import type { ToolKind } from "./types";

export function messageToResponseItems(
	message: JsonObject,
	role: string,
	index: number,
	customToolNames: ReadonlySet<string>,
	pendingToolKinds: Map<string, ToolKind>,
): JsonObject[] {
	if (role === "tool") {
		const callId = requireString(
			message.tool_call_id,
			`messages[${index}].tool_call_id`,
		);
		const kind = pendingToolKinds.get(callId) ?? "function";
		return [
			{
				type:
					kind === "custom"
						? "custom_tool_call_output"
						: "function_call_output",
				call_id: callId,
				output: adaptToolOutput(message.content),
			},
		];
	}

	if (role === "function") {
		const name = requireString(message.name, `messages[${index}].name`);
		return [
			{
				type: "function_call_output",
				call_id: `legacy-${name}-${index}`,
				output: adaptToolOutput(message.content),
			},
		];
	}

	if (role !== "user" && role !== "assistant" && role !== "developer") {
		throw new ApiError(
			400,
			"Unsupported message role.",
			"invalid_request_error",
			"invalid_message_role",
			`messages[${index}].role`,
		);
	}

	const items: JsonObject[] = [];
	const content = adaptMessageContent(message.content, role, index);
	if (content.length > 0) {
		items.push({
			type: "message",
			role,
			content,
		});
	}

	if (role === "assistant") {
		const toolCalls = message.tool_calls;
		if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
			throw new ApiError(
				400,
				`messages[${index}].tool_calls must be an array.`,
				"invalid_request_error",
				"invalid_tool_calls",
				`messages[${index}].tool_calls`,
			);
		}
		for (let toolIndex = 0; toolIndex < (toolCalls?.length ?? 0); toolIndex++) {
			const call = requireRecord(
				toolCalls![toolIndex],
				`messages[${index}].tool_calls[${toolIndex}]`,
			);
			const callType = stringField(call, "type") ?? "function";
			const callId = stringField(call, "id") ?? `call-${index}-${toolIndex}`;
			let kind: ToolKind;
			let name: string;
			let callInput: string;
			if (callType === "custom") {
				const custom = recordField(call, "custom") ?? call;
				kind = "custom";
				name = requireString(
					custom.name,
					`messages[${index}].tool_calls[${toolIndex}].custom.name`,
				);
				callInput =
					typeof custom.input === "string"
						? custom.input
						: typeof custom.arguments === "string"
							? custom.arguments
							: "";
			} else if (callType === "function") {
				const fn = requireRecord(
					call.function,
					`messages[${index}].tool_calls[${toolIndex}].function`,
				);
				name = requireString(
					fn.name,
					`messages[${index}].tool_calls[${toolIndex}].function.name`,
				);
				kind = customToolNames.has(name) ? "custom" : "function";
				callInput =
					typeof fn.arguments === "string"
						? fn.arguments
						: kind === "custom"
							? ""
							: "{}";
			} else {
				throw new ApiError(
					400,
					"Unsupported tool call type.",
					"invalid_request_error",
					"unsupported_tool_call_type",
					`messages[${index}].tool_calls[${toolIndex}].type`,
				);
			}

			pendingToolKinds.set(callId, kind);
			items.push(
				kind === "custom"
					? {
							type: "custom_tool_call",
							call_id: callId,
							name,
							input: callInput,
						}
					: {
							type: "function_call",
							call_id: callId,
							name,
							arguments: callInput,
						},
			);
		}
	}
	return items;
}

function adaptMessageContent(
	value: unknown,
	role: "user" | "assistant" | "developer",
	messageIndex: number,
): JsonObject[] {
	if (value === null || value === undefined) return [];
	if (typeof value === "string") {
		return [
			{
				type: role === "assistant" ? "output_text" : "input_text",
				text: value,
			},
		];
	}
	if (!Array.isArray(value)) {
		throw new ApiError(
			400,
			`messages[${messageIndex}].content must be a string, array, or null.`,
			"invalid_request_error",
			"invalid_message_content",
			`messages[${messageIndex}].content`,
		);
	}

	const parts: JsonObject[] = [];
	for (let partIndex = 0; partIndex < value.length; partIndex++) {
		const part = requireRecord(
			value[partIndex],
			`messages[${messageIndex}].content[${partIndex}]`,
		);
		const type = stringField(part, "type");
		if (type === "text" || type === "input_text" || type === "output_text") {
			parts.push({
				type: role === "assistant" ? "output_text" : "input_text",
				text: typeof part.text === "string" ? part.text : "",
			});
			continue;
		}
		if (type === "image_url" || type === "input_image") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"Image content is supported only in user messages.",
					"invalid_request_error",
					"invalid_image_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const imagePart = toInputImagePart(part);
			if (!imagePart) {
				throw new ApiError(
					400,
					"An image_url content part must include a URL.",
					"invalid_request_error",
					"invalid_image_url",
					`messages[${messageIndex}].content[${partIndex}].image_url`,
				);
			}
			parts.push(imagePart);
			continue;
		}
		if (type === "file" || type === "input_file") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"File content is supported only in user messages.",
					"invalid_request_error",
					"invalid_file_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const filePart = toInputFilePart(part);
			if (!filePart) {
				throw new ApiError(
					400,
					"A file content part must include file_id, file_data, or file_url.",
					"invalid_request_error",
					"invalid_file",
					`messages[${messageIndex}].content[${partIndex}].file`,
				);
			}
			parts.push(filePart);
			continue;
		}
		if (type === "input_audio") {
			if (role !== "user") {
				throw new ApiError(
					400,
					"Audio content is supported only in user messages.",
					"invalid_request_error",
					"invalid_audio_role",
					`messages[${messageIndex}].content[${partIndex}]`,
				);
			}
			const audio = recordField(part, "input_audio") ?? part;
			const audioPart: JsonObject = {
				type: "input_audio",
				data: requireString(
					audio.data,
					`messages[${messageIndex}].content[${partIndex}].input_audio.data`,
				),
			};
			const format = stringField(audio, "format");
			if (format) audioPart.format = format;
			parts.push(audioPart);
			continue;
		}
		if (type === "refusal" && role === "assistant") {
			parts.push({
				type: "output_text",
				text: typeof part.refusal === "string" ? part.refusal : "",
			});
			continue;
		}
		throw new ApiError(
			400,
			"Unsupported message content type.",
			"invalid_request_error",
			"unsupported_content_type",
			`messages[${messageIndex}].content[${partIndex}].type`,
		);
	}
	return parts;
}
