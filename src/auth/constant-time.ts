const encoder = new TextEncoder();

export function sha256Text(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export function equalDigests(left: ArrayBuffer, right: ArrayBuffer): boolean {
	return crypto.subtle.timingSafeEqual(left, right);
}

export async function constantTimeEqual(
	left: string,
	right: string,
): Promise<boolean> {
	const [leftDigest, rightDigest] = await Promise.all([
		sha256Text(left),
		sha256Text(right),
	]);
	return equalDigests(leftDigest, rightDigest);
}
