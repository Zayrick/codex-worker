import { ApiError } from "../shared/api-error";
import {
	isRecord,
	numberField,
	stringField,
	type JsonObject,
} from "../shared/json";
import { readLimitedBody } from "../shared/limited-body";

const MAX_MODEL_CATALOG_BYTES = 1024 * 1024;

export async function toOpenAiModelList(response: Response): Promise<JsonObject> {
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

	const data: JsonObject[] = [];
	for (const value of payload.models) {
		if (!isRecord(value)) continue;
		const id = stringField(value, "id") ?? stringField(value, "slug");
		if (!id) continue;

		const model: JsonObject = { id, object: "model" };
		const created = numberField(value, "created");
		if (created !== undefined) model.created = created;
		const ownedBy = stringField(value, "owned_by");
		if (ownedBy) model.owned_by = ownedBy;
		data.push(model);
	}
	return { object: "list", data };
}

function invalidModelCatalog(): ApiError {
	return new ApiError(
		502,
		"The Codex backend returned an invalid model catalog.",
		"upstream_error",
		"invalid_codex_model_catalog",
	);
}
