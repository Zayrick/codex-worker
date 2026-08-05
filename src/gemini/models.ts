import { ApiError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { readLimitedBody } from "../shared/limited-body";

const MAX_MODEL_CATALOG_BYTES = 1024 * 1024;

export async function geminiModelList(response: Response): Promise<JsonObject> {
	return { models: await geminiModels(response) };
}

export async function geminiModelDetail(
	response: Response,
	modelId: string,
): Promise<JsonObject> {
	const model = (await geminiModels(response)).find(
		(candidate) => candidate.name === `models/${modelId}`,
	);
	if (model) return model;
	throw new ApiError(404, `Model '${modelId}' was not found.`, "not_found", "NOT_FOUND");
}

async function geminiModels(response: Response): Promise<JsonObject[]> {
	let payload: unknown;
	try {
		const body = await readLimitedBody(response, MAX_MODEL_CATALOG_BYTES);
		if (!body) throw invalidModelCatalog();
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw invalidModelCatalog();
	}
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw invalidModelCatalog();
	}

	const models: JsonObject[] = [];
	for (const raw of payload.models) {
		if (!isRecord(raw)) continue;
		const id = stringField(raw, "id") ?? stringField(raw, "slug");
		if (!id) continue;
		const displayName = stringField(raw, "display_name") ?? id;
		const model: JsonObject = {
			name: `models/${id}`,
			baseModelId: id,
			version: id,
			displayName,
			description: stringField(raw, "description") ?? displayName,
			supportedGenerationMethods: ["generateContent", "countTokens"],
		};
		const contextWindow =
			numberField(raw, "context_window") ?? numberField(raw, "max_context_window");
		if (contextWindow !== undefined) model.inputTokenLimit = contextWindow;
		models.push(model);
	}
	return models;
}

function invalidModelCatalog(): ApiError {
	return new ApiError(
		502,
		"The Codex backend returned an invalid model catalog.",
		"upstream_error",
		"INTERNAL",
	);
}
