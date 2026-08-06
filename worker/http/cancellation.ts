export function cancellationAwareReadable(
	source: ReadableStream<Uint8Array>,
	onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		reader.releaseLock();
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel(reason) {
			onCancel(reason);
			try {
				await reader.cancel(reason);
			} catch {
				// The transform may already be closed or errored.
			} finally {
				release();
			}
		},
	});
}
