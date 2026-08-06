import { recordField, stringField, type JsonObject } from "../shared/json";

export function toInputImagePart(value: JsonObject): JsonObject | undefined {
	const image = recordField(value, "image_url");
	const imageUrl =
		typeof value.image_url === "string"
			? value.image_url
			: stringField(image, "url") ?? stringField(value, "url");
	if (!imageUrl) return undefined;

	const part: JsonObject = { type: "input_image", image_url: imageUrl };
	const detail = stringField(image, "detail") ?? stringField(value, "detail");
	if (detail) part.detail = detail;
	return part;
}

export function toInputFilePart(value: JsonObject): JsonObject | undefined {
	const file = recordField(value, "file") ?? value;
	const part: JsonObject = { type: "input_file" };
	for (const key of [
		"file_id",
		"file_data",
		"file_url",
		"filename",
	] as const) {
		const field = stringField(file, key);
		if (field) part[key] = field;
	}
	return part.file_id || part.file_data || part.file_url ? part : undefined;
}
