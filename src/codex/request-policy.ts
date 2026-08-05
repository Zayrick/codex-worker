import type { JsonObject } from "../shared/json";

export type RequestBodyPolicy = (body: JsonObject) => JsonObject;

export interface RequestBodyPolicyDefinition {
	readonly allowedValues?: Readonly<Record<string, readonly unknown[]>>;
	readonly remove?: readonly string[];
	readonly override?: Readonly<JsonObject>;
}

const responseCreateEgressPolicy = {
	remove: [
		"max_completion_tokens",
		"max_output_tokens",
		"maxOutputTokens",
		"max_tokens",
		"context_management",
		"temperature",
		"top_p",
		"truncation",
		"user",
	],
	allowedValues: {
		service_tier: ["priority"],
	},
	override: {
		store: false,
	},
} as const satisfies RequestBodyPolicyDefinition;

const convertedResponseEgressPolicy = {
	override: {
		instructions: "",
		stream: true,
		include: Object.freeze(["reasoning.encrypted_content"]),
	},
} as const satisfies RequestBodyPolicyDefinition;

export const applyResponseCreateEgressPolicy =
	defineRequestBodyPolicy(responseCreateEgressPolicy);

export const applyConvertedResponseEgressPolicy = composeRequestBodyPolicies(
	applyResponseCreateEgressPolicy,
	defineRequestBodyPolicy(convertedResponseEgressPolicy),
);

export function defineRequestBodyPolicy(
	definition: RequestBodyPolicyDefinition,
): RequestBodyPolicy {
	return composeRequestBodyPolicies(
		removeRequestFields(...(definition.remove ?? [])),
		removeRequestFieldsUnlessAllowed(definition.allowedValues ?? {}),
		overrideRequestFields(definition.override ?? {}),
	);
}

export function composeRequestBodyPolicies(
	...policies: RequestBodyPolicy[]
): RequestBodyPolicy {
	return (body) => {
		let adapted = body;
		for (const policy of policies) adapted = policy(adapted);
		return adapted;
	};
}

export function overrideRequestFields(
	fields: Readonly<JsonObject>,
): RequestBodyPolicy {
	const overrides = { ...fields };
	const entries = Object.entries(overrides);
	return (body) => {
		const changed = entries.some(
			([key, value]) =>
				!Object.hasOwn(body, key) || !Object.is(body[key], value),
		);
		return changed ? { ...body, ...overrides } : body;
	};
}

export function removeRequestFields(...keys: string[]): RequestBodyPolicy {
	const removedKeys = [...keys];
	return (body) => {
		if (!removedKeys.some((key) => Object.hasOwn(body, key))) return body;
		const adapted = { ...body };
		for (const key of removedKeys) delete adapted[key];
		return adapted;
	};
}

export function removeRequestFieldsUnlessAllowed(
	allowedValuesByField: Readonly<Record<string, readonly unknown[]>>,
): RequestBodyPolicy {
	const entries = Object.entries(allowedValuesByField).map(
		([key, allowedValues]) => [key, [...allowedValues]] as const,
	);
	return (body) => {
		let adapted: JsonObject | undefined;
		for (const [key, allowedValues] of entries) {
			if (
				!Object.hasOwn(body, key) ||
				allowedValues.some((value) => Object.is(body[key], value))
			) {
				continue;
			}
			adapted ??= { ...body };
			delete adapted[key];
		}
		return adapted ?? body;
	};
}
