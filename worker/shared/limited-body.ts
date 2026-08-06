export class BodySizeLimitError extends Error {
	constructor(readonly maxBytes: number) {
		super(`Body exceeds the ${maxBytes}-byte limit.`);
		this.name = "BodySizeLimitError";
	}
}

interface BodySource {
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: Headers;
}

export async function readLimitedBody(
	source: BodySource,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declaredLength = Number.parseInt(
		source.headers.get("Content-Length") ?? "0",
		10,
	);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await cancelQuietly(source.body);
		throw new BodySizeLimitError(maxBytes);
	}
	if (!source.body) return null;

	const reader = source.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// The size error remains the useful failure for the caller.
				}
				throw new BodySizeLimitError(maxBytes);
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function cancelQuietly(
	body: ReadableStream<Uint8Array> | null,
): Promise<void> {
	try {
		await body?.cancel();
	} catch {
		// The caller still receives the deterministic size-limit error.
	}
}
