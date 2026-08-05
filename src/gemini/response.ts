import {
	failedCodexResponse,
	incompleteCodexStream,
	outputTexts,
	parseToolInput,
	reasoningText,
} from "../messages/response";
import { ApiError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { geminiCodexEventError } from "./error";

export async function geminiResponseFromEventStream(
	events: AsyncIterable<JsonObject>,
	requestedModel: string,
	reverseToolNames: ReadonlyMap<string, string>,
): Promise<JsonObject> {
	let terminal: JsonObject | undefined;
	let terminalType = "";
	for await (const event of events) {
		const type = stringField(event, "type") ?? "";
		if (type === "error") throw geminiCodexEventError(event);
		if (
			type === "response.completed" ||
			type === "response.incomplete" ||
			type === "response.failed"
		) {
			terminal = recordField(event, "response");
			terminalType = type;
			break;
		}
	}
	if (!terminal) throw incompleteCodexStream();
	if (terminalType === "response.failed") throw failedCodexResponse(terminal);
	return geminiResponseFromTerminal(
		terminal,
		requestedModel,
		reverseToolNames,
		terminalType === "response.incomplete",
	);
}

export function geminiResponseFromTerminal(
	response: JsonObject,
	requestedModel: string,
	reverseToolNames: ReadonlyMap<string, string>,
	incomplete = false,
): JsonObject {
	const id = stringField(response, "id");
	if (!id) {
		throw new ApiError(
			502,
			"The Codex response did not include a response ID.",
			"upstream_error",
			"missing_codex_response_id",
		);
	}
	const parts = outputToGeminiParts(response.output, reverseToolNames);
	return geminiChunk(
		{
			id,
			model: stringField(response, "model") ?? requestedModel,
			createdAt: numberField(response, "created_at"),
		},
		parts,
		{
			finishReason: geminiFinishReason(response, incomplete),
			usage: recordField(response, "usage"),
		},
	);
}

export function outputToGeminiParts(
	value: unknown,
	reverseToolNames: ReadonlyMap<string, string>,
): JsonObject[] {
	if (value !== undefined && !Array.isArray(value)) throw malformedCodexOutput();
	const parts: JsonObject[] = [];
	for (const raw of value ?? []) {
		if (!isRecord(raw)) continue;
		const type = stringField(raw, "type") ?? "";
		if (type === "reasoning") {
			const text = reasoningText(raw);
			const signature = stringField(raw, "encrypted_content");
			if (text || signature) {
				parts.push({
					thought: true,
					text,
					...(signature ? { thoughtSignature: signature } : {}),
				});
			}
			continue;
		}
		if (type === "message") {
			for (const text of outputTexts(raw.content)) {
				if (text) parts.push({ text });
			}
			continue;
		}
		if (type === "function_call" || type === "custom_tool_call") {
			const rawName = stringField(raw, "name") ?? "tool";
			const args =
				type === "custom_tool_call"
					? parseToolInput(stringField(raw, "input"))
					: parseToolInput(stringField(raw, "arguments"));
			const functionCall: JsonObject = {
				name: reverseToolNames.get(rawName) ?? rawName,
				args,
			};
			const callId = stringField(raw, "call_id") ?? stringField(raw, "id");
			if (callId) functionCall.id = callId;
			parts.push({ functionCall });
			continue;
		}
		if (type === "image_generation_call") {
			const data = stringField(raw, "result");
			if (data) {
				parts.push({
					inlineData: {
						data,
						mimeType: outputMimeType(stringField(raw, "output_format")),
					},
				});
			}
		}
	}
	return parts;
}

export function geminiChunk(
	metadata: { id: string; model: string; createdAt: number | undefined },
	parts: JsonObject[],
	options: {
		finishReason?: string | undefined;
		usage?: JsonObject | undefined;
	} = {},
): JsonObject {
	const candidate: JsonObject = {
		content: { role: "model", parts },
	};
	if (options.finishReason) candidate.finishReason = options.finishReason;
	const result: JsonObject = {
		candidates: [candidate],
		modelVersion: metadata.model,
		responseId: metadata.id,
	};
	const createTime = createTimeValue(metadata.createdAt);
	if (createTime) result.createTime = createTime;
	if (options.usage) result.usageMetadata = geminiUsage(options.usage);
	return result;
}

export function geminiUsage(usage: JsonObject | undefined): JsonObject {
	const prompt = Math.max(0, numberField(usage, "input_tokens") ?? 0);
	const candidates = Math.max(0, numberField(usage, "output_tokens") ?? 0);
	const total = Math.max(
		0,
		numberField(usage, "total_tokens") ?? prompt + candidates,
	);
	const result: JsonObject = {
		promptTokenCount: prompt,
		candidatesTokenCount: candidates,
		totalTokenCount: total,
		trafficType: "PROVISIONED_THROUGHPUT",
	};
	const cached = numberField(recordField(usage, "input_tokens_details"), "cached_tokens");
	if (cached !== undefined && cached > 0) result.cachedContentTokenCount = cached;
	const thoughts = numberField(
		recordField(usage, "output_tokens_details"),
		"reasoning_tokens",
	);
	if (thoughts !== undefined && thoughts > 0) result.thoughtsTokenCount = thoughts;
	return result;
}

export function geminiFinishReason(
	response: JsonObject,
	incomplete: boolean,
): string {
	if (!incomplete) return "STOP";
	const reason =
		stringField(recordField(response, "incomplete_details"), "reason") ?? "";
	if (reason === "max_tokens" || reason === "max_output_tokens") {
		return "MAX_TOKENS";
	}
	if (reason === "content_filter") return "SAFETY";
	return "OTHER";
}

export function outputMimeType(format: string | undefined): string {
	if (!format) return "image/png";
	if (format.includes("/")) return format;
	switch (format.toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

function createTimeValue(createdAt: number | undefined): string | undefined {
	if (createdAt === undefined) return undefined;
	const date = new Date(createdAt * 1_000);
	return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function malformedCodexOutput(): ApiError {
	return new ApiError(
		502,
		"The Codex response output was malformed.",
		"upstream_error",
		"malformed_codex_output",
	);
}
