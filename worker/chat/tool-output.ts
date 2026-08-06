import {
	isRecord,
	stringField,
	type JsonObject,
} from "../shared/json";
import { toInputFilePart, toInputImagePart } from "./input-parts";

export function adaptToolOutput(value: unknown): string | JsonObject[] {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (
				Array.isArray(parsed) &&
				parsed.some((part) => {
					if (!isRecord(part)) return false;
					const type = stringField(part, "type");
					return (
						type === "image_url" ||
						type === "input_image" ||
						type === "file" ||
						type === "input_file"
					);
				})
			) {
				return parsed.map(adaptToolOutputPart);
			}
		} catch {
			// Plain-text tool output is the common case.
		}
		return value;
	}
	if (value === null || value === undefined) return "";
	if (!Array.isArray(value)) return JSON.stringify(value);
	return value.map(adaptToolOutputPart);
}

function adaptToolOutputPart(value: unknown): JsonObject {
	if (typeof value === "string") {
		return { type: "input_text", text: value };
	}
	if (!isRecord(value)) {
		return {
			type: "input_text",
			text: value === null || value === undefined ? "" : JSON.stringify(value),
		};
	}

	const type = stringField(value, "type");
	if (type === "text" || type === "input_text" || type === "output_text") {
		return {
			type: "input_text",
			text:
				typeof value.text === "string"
					? value.text
					: typeof value.content === "string"
						? value.content
						: "",
		};
	}
	if (type === "image_url" || type === "input_image") {
		const part = toInputImagePart(value);
		if (part) return part;
	}
	if (type === "file" || type === "input_file") {
		const part = toInputFilePart(value);
		if (part) return part;
	}

	return { type: "input_text", text: JSON.stringify(value) };
}
