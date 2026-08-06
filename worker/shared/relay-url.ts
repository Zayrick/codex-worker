export function resolveChatGptRelayUrl(
	origin: string,
	pathname: string,
	search = "",
): URL {
	const url = new URL(pathname, origin);
	if (url.protocol !== "https:" || url.origin !== origin) {
		throw new TypeError("CHATGPT_RELAY_URL must be an HTTPS origin.");
	}
	url.search = search;
	return url;
}
