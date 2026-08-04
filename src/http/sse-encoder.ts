const encoder = new TextEncoder();

export function sseData(value: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

export const SSE_DONE = encoder.encode("data: [DONE]\n\n");
