import { describe, expect, it } from "vitest";
import {
	BodySizeLimitError,
	readLimitedBody,
} from "../../worker/shared/limited-body";

describe("bounded body reader", () => {
	it("accepts a body exactly at the byte limit", async () => {
		const bytes = await readLimitedBody(
			{
				headers: new Headers({ "Content-Length": "3" }),
				body: byteStream([1, 2, 3]),
			},
			3,
		);

		expect(Array.from(bytes ?? [])).toEqual([1, 2, 3]);
	});

	it("rejects a declared oversized body and cancels its stream", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			readLimitedBody(
				{ headers: new Headers({ "Content-Length": "4" }), body },
				3,
			),
		).rejects.toBeInstanceOf(BodySizeLimitError);
		expect(cancelled).toBe(true);
	});

	it("rejects a chunked body once its observed bytes exceed the limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4]));
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			readLimitedBody({ headers: new Headers(), body }, 3),
		).rejects.toBeInstanceOf(BodySizeLimitError);
		expect(cancelled).toBe(true);
	});
});

function byteStream(...bytes: number[][]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of bytes) controller.enqueue(new Uint8Array(chunk));
			controller.close();
		},
	});
}
