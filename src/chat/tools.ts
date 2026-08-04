import { ApiError, requireRecord, requireString } from "../shared/api-error";
import {
	isRecord,
	recordField,
	stringField,
	type JsonObject,
} from "../shared/json";
import type { AdaptedTools } from "./types";

export function adaptTools(value: unknown): AdaptedTools {
	if (value === undefined) {
		return { items: [], customNames: new Set() };
	}
	if (!Array.isArray(value)) {
		throw new ApiError(
			400,
			"'tools' must be an array.",
			"invalid_request_error",
			"invalid_tools",
			"tools",
		);
	}
	const customNames = new Set<string>();
	const functionNames = new Set<string>();
	const items = value.map((raw, index) => {
		const tool = requireRecord(raw, `tools[${index}]`);
		const type = requireString(tool.type, `tools[${index}].type`);
		if (type === "custom") {
			const custom = recordField(tool, "custom") ?? tool;
			const name = requireString(custom.name, `tools[${index}].name`);
			customNames.add(name);
			const adapted: JsonObject = { type: "custom", name };
			if (typeof custom.description === "string") {
				adapted.description = custom.description;
			}
			if (custom.format !== undefined) adapted.format = custom.format;
			return adapted;
		}
		if (type !== "function") {
			return { ...tool, type };
		}
		const fn = requireRecord(tool.function, `tools[${index}].function`);
		const name = requireString(fn.name, `tools[${index}].function.name`);
		functionNames.add(name);
		const adapted: JsonObject = {
			type: "function",
			name,
		};
		if (typeof fn.description === "string") {
			adapted.description = fn.description;
		}
		if (fn.parameters !== undefined) {
			adapted.parameters = fn.parameters;
		}
		if (fn.strict !== undefined) {
			adapted.strict = fn.strict;
		}
		return adapted;
	});
	for (const name of functionNames) customNames.delete(name);
	return { items, customNames };
}

export function adaptToolChoice(
	value: unknown,
	customToolNames: ReadonlySet<string>,
): unknown {
	if (value === "auto" || value === "required" || value === "none") return value;
	if (!isRecord(value)) {
		throw new ApiError(
			400,
			"Invalid 'tool_choice'.",
			"invalid_request_error",
			"invalid_tool_choice",
			"tool_choice",
		);
	}
	const type = stringField(value, "type");
	if (type === "function") {
		const fn = recordField(value, "function") ?? value;
		const name = requireString(fn.name, "tool_choice.function.name");
		return {
			type: customToolNames.has(name) ? "custom" : "function",
			name,
		};
	}
	if (type === "custom") {
		const custom = recordField(value, "custom") ?? value;
		return {
			type: "custom",
			name: requireString(custom.name, "tool_choice.custom.name"),
		};
	}
	if (type) return { ...value, type };
	throw new ApiError(
		400,
		"Invalid 'tool_choice'.",
		"invalid_request_error",
		"invalid_tool_choice",
		"tool_choice",
	);
}
