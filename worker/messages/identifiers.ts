const CODEX_IDENTIFIER_LIMIT = 64;
const CLAUDE_TOOL_ID_PATTERN = /[^a-zA-Z0-9_-]/g;

export interface ToolNameMaps {
	forward: ReadonlyMap<string, string>;
	reverse: ReadonlyMap<string, string>;
}

export function buildToolNameMaps(names: readonly string[]): ToolNameMaps {
	const forward = new Map<string, string>();
	const reverse = new Map<string, string>();
	const used = new Set<string>();

	for (const name of names) {
		if (forward.has(name)) continue;
		const base = toolNameCandidate(name);
		let candidate = base;
		for (let suffix = 1; used.has(candidate); suffix++) {
			const ending = `_${suffix}`;
			candidate = `${base.slice(0, CODEX_IDENTIFIER_LIMIT - ending.length)}${ending}`;
		}
		used.add(candidate);
		forward.set(name, candidate);
		reverse.set(candidate, name);
	}
	return { forward, reverse };
}

export function codexToolName(
	name: string,
	forward: ReadonlyMap<string, string>,
): string {
	return forward.get(name) ?? toolNameCandidate(name);
}

export function claudeToolName(
	name: string,
	reverse: ReadonlyMap<string, string>,
): string {
	return reverse.get(name) ?? name;
}

export function shortenCodexCallId(id: string): string {
	if (id.length <= CODEX_IDENTIFIER_LIMIT) return id;
	const suffix = `_${stableHash(id)}`;
	return `${id.slice(0, CODEX_IDENTIFIER_LIMIT - suffix.length)}${suffix}`;
}

export function claudeToolUseId(id: string, fallback: string): string {
	const sanitized = id.replace(CLAUDE_TOOL_ID_PATTERN, "_") || fallback;
	return shortenCodexCallId(sanitized);
}

function toolNameCandidate(name: string): string {
	if (name.length <= CODEX_IDENTIFIER_LIMIT) return name;
	if (name.startsWith("mcp__")) {
		const separator = name.lastIndexOf("__");
		if (separator > 0) {
			return `mcp__${name.slice(separator + 2)}`.slice(
				0,
				CODEX_IDENTIFIER_LIMIT,
			);
		}
	}
	return name.slice(0, CODEX_IDENTIFIER_LIMIT);
}

function stableHash(value: string): string {
	let left = 0x811c9dc5;
	let right = 0x9e3779b9;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		left = Math.imul(left ^ code, 0x01000193);
		right = Math.imul(right ^ code, 0x85ebca6b);
	}
	return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}
