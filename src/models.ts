export interface ModelDescriptor {
	id: string;
	created: number;
	owned_by: string;
}

const MODEL_CREATED_AT = 1_754_006_400;

export const MODELS: readonly ModelDescriptor[] = [
	{ id: "gpt-5.6-luna", created: MODEL_CREATED_AT, owned_by: "openai" },
];

const MODEL_ALIASES: Readonly<Record<string, string>> = {
	"gpt-5.6-lunar": "gpt-5.6-luna",
	"5.6-lunar": "gpt-5.6-luna",
	"5.6-luna": "gpt-5.6-luna",
};

export function resolveModelId(model: string): string {
	return MODEL_ALIASES[model.toLowerCase()] ?? model;
}

export function findModel(model: string): ModelDescriptor | undefined {
	const resolved = resolveModelId(model);
	return MODELS.find((candidate) => candidate.id === resolved);
}

export function modelObject(model: ModelDescriptor): Record<string, unknown> {
	return {
		...model,
		object: "model",
	};
}
