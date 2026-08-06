import { adaptResponsesWebSocketMessage } from "./request";

export function bridgeResponsesWebSocket(response: Response): Response {
	const upstream = response.webSocket;
	if (!upstream) return response;

	const pair = new WebSocketPair();
	const downstream = pair[0];
	const proxy = pair[1];
	relayWebSocket(proxy, upstream, adaptResponsesWebSocketMessage);
	relayWebSocket(upstream, proxy);
	proxy.accept({ allowHalfOpen: true });
	upstream.accept({ allowHalfOpen: true });

	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		webSocket: downstream,
	});
}

function relayWebSocket(
	source: WebSocket,
	target: WebSocket,
	adaptText?: (message: string) => string,
): void {
	source.binaryType = "arraybuffer";
	source.addEventListener("message", (event) => {
		const data =
			typeof event.data === "string" && adaptText
				? adaptText(event.data)
				: event.data;
		forwardWebSocketMessage(source, target, data);
	});
	source.addEventListener("close", (event) => {
		const code = isForwardableCloseCode(event.code) ? event.code : 1011;
		closeWebSocket(target, code, event.reason);
		closeWebSocket(source, code, event.reason);
	});
	source.addEventListener("error", () => closeWebSocketPair(source, target));
}

function forwardWebSocketMessage(
	source: WebSocket,
	target: WebSocket,
	data: unknown,
): void {
	try {
		if (
			typeof data === "string" ||
			data instanceof ArrayBuffer ||
			ArrayBuffer.isView(data)
		) {
			target.send(data);
			return;
		}
	} catch {
		// Both peers are closed below.
	}
	closeWebSocketPair(source, target);
}

function closeWebSocketPair(first: WebSocket, second: WebSocket): void {
	closeWebSocket(first, 1011, "WebSocket proxy error");
	closeWebSocket(second, 1011, "WebSocket proxy error");
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
	if (socket.readyState === WebSocket.CLOSED) return;
	try {
		socket.close(code, reason);
	} catch {
		// The peer may already be closing.
	}
}

function isForwardableCloseCode(code: number): boolean {
	return (
		code >= 1000 &&
		code <= 4999 &&
		code !== 1004 &&
		code !== 1005 &&
		code !== 1006 &&
		code !== 1015
	);
}
