import {
	buildToolNameMaps,
	codexToolName,
	shortenCodexCallId,
	type ToolNameMaps,
} from "../messages/identifiers";
import { ApiError, requireRecord } from "../shared/api-error";
import { isRecord, type JsonObject } from "../shared/json";
import type { AdaptedGeminiRequest } from "./types";

const MAX_TOOLS = 128;

export function geminiRequestToResponses(
	input: JsonObject,
	model: string,
): AdaptedGeminiRequest {
	if (!model) throw invalidRequest("The model path parameter is required.", "model");
	const contents = input.contents;
	if (!Array.isArray(contents)) {
		throw invalidRequest("Missing required parameter: 'contents'.", "contents");
	}

	const declarations = functionDeclarations(input.tools);
	const nameMaps = buildToolNameMaps(
		declarations.map(({ declaration }) => stringValue(declaration.name)).filter(Boolean),
	);
	const responseInput: JsonObject[] = [];
	appendSystemInstruction(responseInput, input);
	appendContents(responseInput, contents, nameMaps);

	const body: JsonObject = {
		model,
		input: responseInput,
		parallel_tool_calls: true,
		reasoning: { effort: reasoningEffort(input) },
	};
	const tools = adaptTools(declarations, nameMaps);
	if (tools.length > 0) {
		body.tools = tools;
		body.tool_choice = "auto";
	}
	applyToolChoice(body, input.toolConfig ?? input.tool_config, nameMaps);
	const tier = stringValue(input.service_tier ?? input.serviceTier).toLowerCase();
	if (tier === "priority" || tier === "fast") body.service_tier = "priority";

	return { body, model, reverseToolNames: nameMaps.reverse };
}

export function geminiCountRequest(
	input: JsonObject,
	model: string,
): AdaptedGeminiRequest {
	const nested = input.generateContentRequest ?? input.generate_content_request;
	return geminiRequestToResponses(
		nested === undefined
			? input
			: requireRecord(nested, "generateContentRequest"),
		model,
	);
}

function appendSystemInstruction(output: JsonObject[], input: JsonObject): void {
	const value = input.systemInstruction ?? input.system_instruction;
	if (value === undefined || value === null) return;
	if (typeof value === "string") {
		output.push(message("developer", { type: "input_text", text: value }));
		return;
	}
	const instruction = requireRecord(value, "systemInstruction");
	if (!Array.isArray(instruction.parts)) {
		throw invalidRequest(
			"systemInstruction.parts must be an array.",
			"systemInstruction.parts",
		);
	}
	for (let index = 0; index < instruction.parts.length; index++) {
		const part = requireRecord(
			instruction.parts[index],
			`systemInstruction.parts[${index}]`,
		);
		if (typeof part.text !== "string") {
			throw invalidRequest(
				"System instructions support only text parts.",
				`systemInstruction.parts[${index}]`,
			);
		}
		output.push(message("developer", { type: "input_text", text: part.text }));
	}
}

function appendContents(
	output: JsonObject[],
	contents: unknown[],
	nameMaps: ToolNameMaps,
): void {
	const pendingCallIds: string[] = [];
	for (let contentIndex = 0; contentIndex < contents.length; contentIndex++) {
		const content = requireRecord(contents[contentIndex], `contents[${contentIndex}]`);
		const sourceRole = content.role === undefined ? "user" : stringValue(content.role);
		const role = sourceRole === "model" ? "assistant" : sourceRole;
		if (role !== "user" && role !== "assistant") {
			throw invalidRequest(
				`contents[${contentIndex}].role must be 'user' or 'model'.`,
				`contents[${contentIndex}].role`,
			);
		}
		if (!Array.isArray(content.parts)) {
			throw invalidRequest(
				`contents[${contentIndex}].parts must be an array.`,
				`contents[${contentIndex}].parts`,
			);
		}
		for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
			const param = `contents[${contentIndex}].parts[${partIndex}]`;
			const part = requireRecord(content.parts[partIndex], param);
			if (typeof part.text === "string") {
				const signature = stringValue(
					part.thoughtSignature ?? part.thought_signature,
				);
				if (
					role === "assistant" &&
					part.thought === true &&
					isCodexReasoningSignature(signature)
				) {
					output.push({
						type: "reasoning",
						summary: part.text
							? [{ type: "summary_text", text: part.text }]
							: [],
						content: null,
						encrypted_content: signature,
					});
				} else {
					output.push(
						message(role, {
							type: role === "assistant" ? "output_text" : "input_text",
							text: part.text,
						}),
					);
				}
				continue;
			}

			const inline = recordValue(part.inlineData ?? part.inline_data);
			if (inline) {
				output.push(message(role, inlineDataPart(inline, `${param}.inlineData`)));
				continue;
			}
			const file = recordValue(part.fileData ?? part.file_data);
			if (file) {
				output.push(message(role, fileDataPart(file, `${param}.fileData`)));
				continue;
			}

			const functionCall = recordValue(part.functionCall ?? part.function_call);
			if (functionCall) {
				const name = requiredString(functionCall.name, `${param}.functionCall.name`);
				const explicitId = stringValue(functionCall.id ?? functionCall.call_id);
				const callId = shortenCodexCallId(explicitId || generatedCallId());
				pendingCallIds.push(callId);
				output.push({
					type: "function_call",
					call_id: callId,
					name: codexToolName(name, nameMaps.forward),
					arguments: JSON.stringify(functionCall.args ?? {}),
				});
				continue;
			}

			const functionResponse = recordValue(
				part.functionResponse ?? part.function_response,
			);
			if (functionResponse) {
				const explicitId = stringValue(
					functionResponse.id ?? functionResponse.call_id,
				);
				let callId = explicitId ? shortenCodexCallId(explicitId) : pendingCallIds.shift();
				if (explicitId) {
					const pendingIndex = pendingCallIds.indexOf(callId ?? "");
					if (pendingIndex >= 0) pendingCallIds.splice(pendingIndex, 1);
				}
				callId ??= generatedCallId();
				output.push({
					type: "function_call_output",
					call_id: callId,
					output: functionResponseOutput(functionResponse.response),
				});
				continue;
			}

			const executable = recordValue(part.executableCode ?? part.executable_code);
			if (executable) {
				output.push(
					message(role, {
						type: role === "assistant" ? "output_text" : "input_text",
						text: stringValue(executable.code),
					}),
				);
				continue;
			}
			const execution = recordValue(
				part.codeExecutionResult ?? part.code_execution_result,
			);
			if (execution) {
				output.push(
					message(role, {
						type: role === "assistant" ? "output_text" : "input_text",
						text: stringValue(execution.output),
					}),
				);
				continue;
			}

			throw invalidRequest("Unsupported Gemini content part.", param);
		}
	}
}

function inlineDataPart(value: JsonObject, param: string): JsonObject {
	const mimeType = requiredString(value.mimeType ?? value.mime_type, `${param}.mimeType`);
	const data = requiredString(value.data, `${param}.data`);
	const lower = mimeType.toLowerCase();
	if (lower.startsWith("image/")) {
		return { type: "input_image", image_url: `data:${mimeType};base64,${data}` };
	}
	if (lower.startsWith("audio/")) {
		return {
			type: "input_audio",
			input_audio: { data, format: audioFormat(mimeType) },
		};
	}
	return { type: "input_file", file_data: data, filename: filename(mimeType) };
}

function fileDataPart(value: JsonObject, param: string): JsonObject {
	const uri = requiredString(value.fileUri ?? value.file_uri, `${param}.fileUri`);
	const mimeType = stringValue(value.mimeType ?? value.mime_type);
	const lower = mimeType.toLowerCase();
	if (lower.startsWith("image/")) return { type: "input_image", image_url: uri };
	if (
		lower.startsWith("video/") ||
		lower.startsWith("application/") ||
		lower.startsWith("text/")
	) {
		return { type: "input_file", file_url: uri, filename: filename(mimeType) };
	}
	return {
		type: "input_text",
		text: `File: ${uri}${mimeType ? ` (Type: ${mimeType})` : ""}`,
	};
}

function functionDeclarations(
	value: unknown,
): Array<{ declaration: JsonObject; param: string }> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw invalidRequest("'tools' must be an array.", "tools");
	const result: Array<{ declaration: JsonObject; param: string }> = [];
	for (let toolIndex = 0; toolIndex < value.length; toolIndex++) {
		const tool = requireRecord(value[toolIndex], `tools[${toolIndex}]`);
		const raw = tool.functionDeclarations ?? tool.function_declarations;
		if (raw === undefined) continue;
		if (!Array.isArray(raw)) {
			throw invalidRequest(
				"functionDeclarations must be an array.",
				`tools[${toolIndex}].functionDeclarations`,
			);
		}
		for (let index = 0; index < raw.length; index++) {
			if (result.length >= MAX_TOOLS) {
				throw invalidRequest(`At most ${MAX_TOOLS} functions are supported.`, "tools");
			}
			result.push({
				declaration: requireRecord(
					raw[index],
					`tools[${toolIndex}].functionDeclarations[${index}]`,
				),
				param: `tools[${toolIndex}].functionDeclarations[${index}]`,
			});
		}
	}
	return result;
}

function adaptTools(
	declarations: Array<{ declaration: JsonObject; param: string }>,
	nameMaps: ToolNameMaps,
): JsonObject[] {
	return declarations.map(({ declaration, param }) => {
		const name = requiredString(declaration.name, `${param}.name`);
		const rawSchema =
			declaration.parameters ??
			declaration.parametersJsonSchema ??
			declaration.parameters_json_schema;
		const parameters: JsonObject = isRecord(rawSchema)
			? { ...rawSchema }
			: { type: "object", properties: {} };
		delete parameters.$schema;
		if (parameters.additionalProperties !== false) {
			parameters.additionalProperties = false;
		}
		return {
			type: "function",
			name: codexToolName(name, nameMaps.forward),
			...(typeof declaration.description === "string"
				? { description: declaration.description }
				: {}),
			parameters,
			strict: false,
		};
	});
}

function applyToolChoice(
	body: JsonObject,
	value: unknown,
	nameMaps: ToolNameMaps,
): void {
	if (!isRecord(value)) return;
	const config = recordValue(value.functionCallingConfig ?? value.function_calling_config);
	if (!config) return;
	const mode = stringValue(config.mode).trim().toUpperCase();
	if (mode === "NONE") body.tool_choice = "none";
	else if (mode === "AUTO") body.tool_choice = "auto";
	else if (mode === "ANY" || mode === "VALIDATED") {
		const allowed = config.allowedFunctionNames ?? config.allowed_function_names;
		if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === "string") {
			body.tool_choice = {
				type: "function",
				name: codexToolName(allowed[0], nameMaps.forward),
			};
		} else {
			body.tool_choice = "required";
		}
	}
}

function reasoningEffort(input: JsonObject): string {
	const config = recordValue(input.generationConfig ?? input.generation_config);
	if (!config) return "medium";
	const directLevel = stringValue(config.thinkingLevel ?? config.thinking_level);
	if (directLevel) return directLevel.trim().toLowerCase();
	const thinking = recordValue(config.thinkingConfig ?? config.thinking_config);
	if (!thinking) return "medium";
	const level = stringValue(thinking.thinkingLevel ?? thinking.thinking_level);
	if (level) return level.trim().toLowerCase();
	const budget = thinking.thinkingBudget ?? thinking.thinking_budget;
	return typeof budget === "number" && Number.isFinite(budget)
		? effortFromBudget(Math.trunc(budget))
		: "medium";
}

function effortFromBudget(budget: number): string {
	if (budget < -1) return "medium";
	if (budget === -1) return "auto";
	if (budget === 0) return "none";
	if (budget <= 512) return "minimal";
	if (budget <= 1_024) return "low";
	if (budget <= 8_192) return "medium";
	if (budget <= 24_576) return "high";
	return "xhigh";
}

function message(role: string, part: JsonObject): JsonObject {
	return { type: "message", role, content: [part] };
}

function functionResponseOutput(value: unknown): string {
	if (isRecord(value) && Object.hasOwn(value, "result")) {
		return outputString(value.result);
	}
	return outputString(value);
}

function outputString(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function generatedCallId(): string {
	return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

function audioFormat(mimeType: string): string {
	switch (mimeType.trim().toLowerCase()) {
		case "audio/wav":
		case "audio/wave":
		case "audio/x-wav":
			return "wav";
		case "audio/flac":
			return "flac";
		case "audio/opus":
		case "audio/ogg":
			return "opus";
		case "audio/pcm":
		case "audio/l16":
			return "pcm16";
		default:
			return "mp3";
	}
}

function filename(mimeType: string): string {
	switch (mimeType.trim().toLowerCase()) {
		case "application/pdf":
			return "document.pdf";
		case "text/plain":
			return "document.txt";
		case "text/csv":
			return "document.csv";
		case "application/json":
			return "document.json";
		case "application/xml":
		case "text/xml":
			return "document.xml";
		default:
			return mimeType.toLowerCase().startsWith("video/") ? "video" : "document";
	}
}

function isCodexReasoningSignature(value: string): boolean {
	return (
		value.length >= 98 &&
		value.length <= 32 * 1024 * 1024 &&
		value.startsWith("gAAAA") &&
		/^[A-Za-z0-9_=-]+$/.test(value)
	);
}

function recordValue(value: unknown): JsonObject | undefined {
	return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function requiredString(value: unknown, param: string): string {
	const result = stringValue(value);
	if (!result) throw invalidRequest(`Missing required parameter: '${param}'.`, param);
	return result;
}

function invalidRequest(message: string, param: string): ApiError {
	return new ApiError(400, message, "invalid_request_error", "INVALID_ARGUMENT", param);
}
