import { isRecord } from "./types";

const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BITS = 128;

interface EncryptedEnvelope {
	v: 1;
	alg: "A256GCM";
	iv: string;
	ciphertext: string;
}

export class SecretEnvelopeError extends Error {
	constructor() {
		super("Secret material is unavailable.");
		this.name = "SecretEnvelopeError";
	}
}

export async function sealJson(
	value: unknown,
	encodedMasterKey: string,
	purpose: string,
): Promise<string> {
	try {
		const key = await importMasterKey(encodedMasterKey);
		const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
		const plaintext = new TextEncoder().encode(JSON.stringify(value));
		const ciphertext = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new TextEncoder().encode(purpose),
				tagLength: AES_GCM_TAG_BITS,
			},
			key,
			plaintext,
		);
		const envelope: EncryptedEnvelope = {
			v: 1,
			alg: "A256GCM",
			iv: encodeBase64Url(iv),
			ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
		};
		return JSON.stringify(envelope);
	} catch {
		throw new SecretEnvelopeError();
	}
}

export async function openJson(
	serializedEnvelope: string,
	encodedMasterKey: string,
	purpose: string,
): Promise<unknown> {
	try {
		const parsed: unknown = JSON.parse(serializedEnvelope);
		if (
			!isRecord(parsed) ||
			parsed.v !== 1 ||
			parsed.alg !== "A256GCM" ||
			typeof parsed.iv !== "string" ||
			typeof parsed.ciphertext !== "string"
		) {
			throw new SecretEnvelopeError();
		}

		const iv = decodeBase64Url(parsed.iv);
		const ciphertext = decodeBase64Url(parsed.ciphertext);
		if (iv.byteLength !== AES_GCM_IV_BYTES || ciphertext.byteLength < 16) {
			throw new SecretEnvelopeError();
		}

		const key = await importMasterKey(encodedMasterKey);
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new TextEncoder().encode(purpose),
				tagLength: AES_GCM_TAG_BITS,
			},
			key,
			ciphertext,
		);
		return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
	} catch {
		throw new SecretEnvelopeError();
	}
}

async function importMasterKey(encodedMasterKey: string): Promise<CryptoKey> {
	const keyBytes = decodeBase64Url(encodedMasterKey);
	if (keyBytes.byteLength !== AES_KEY_BYTES) {
		throw new SecretEnvelopeError();
	}
	return crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new SecretEnvelopeError();
	}
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
