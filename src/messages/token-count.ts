import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";
import { isRecord, type JsonObject } from "../shared/json";

const tokenizer = new Tiktoken(cl100kBase);
const MAX_TOKENIZER_CHUNK_CHARS = 64 * 1024;

export function countCodexInputTokens(body: JsonObject): number {
	const values: string[] = [];
	appendString(values, body.instructions);
	appendInput(values, body.input);
	appendTools(values, body.tools);
	appendTextControls(values, body.text);

	let count = 0;
	for (let index = 0; index < values.length; index++) {
		if (index > 0) count += 1;
		count += encodeInChunks(values[index] ?? "");
	}
	return count;
}

function appendInput(values: string[], input: unknown): void {
	if (!Array.isArray(input)) return;
	for (const raw of input) {
		if (!isRecord(raw)) continue;
		appendString(values, raw.name);
		appendString(values, raw.arguments);
		appendString(values, raw.input);
		if (typeof raw.output === "string") {
			values.push(raw.output);
		} else if (Array.isArray(raw.output)) {
			appendContent(values, raw.output);
		}
		appendContent(values, raw.content);
		if (Array.isArray(raw.summary)) appendContent(values, raw.summary);
	}
}

function appendContent(values: string[], content: unknown): void {
	if (!Array.isArray(content)) return;
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		appendString(values, raw.text);
	}
}

function appendTools(values: string[], tools: unknown): void {
	if (!Array.isArray(tools)) return;
	for (const raw of tools) {
		if (!isRecord(raw)) continue;
		appendString(values, raw.name);
		appendString(values, raw.description);
		if (raw.parameters !== undefined) {
			values.push(JSON.stringify(raw.parameters));
		}
	}
}

function appendTextControls(values: string[], text: unknown): void {
	if (!isRecord(text) || !isRecord(text.format)) return;
	appendString(values, text.format.name);
	if (text.format.schema !== undefined) {
		values.push(JSON.stringify(text.format.schema));
	}
}

function appendString(values: string[], value: unknown): void {
	if (typeof value === "string" && value) values.push(value);
}

function encodeInChunks(value: string): number {
	let count = 0;
	for (let offset = 0; offset < value.length; offset += MAX_TOKENIZER_CHUNK_CHARS) {
		count += tokenizer.encode(
			value.slice(offset, offset + MAX_TOKENIZER_CHUNK_CHARS),
		).length;
	}
	return count;
}
