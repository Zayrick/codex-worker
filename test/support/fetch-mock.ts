interface FetchMatcher {
	origin: string;
	path: string;
	method: string;
}

interface FetchCall {
	url: URL;
	method: string;
	headers: Headers;
	body: BodyInit | null | undefined;
	signal: AbortSignal | null | undefined;
}

interface MockResponse {
	statusCode: number;
	data?: BodyInit | null;
	responseOptions?: {
		headers?: HeadersInit;
	};
}

type ReplyFactory = (call: FetchCall) => MockResponse | Promise<MockResponse>;

interface PendingInterceptor {
	matcher: FetchMatcher;
	reply: ReplyFactory;
}

interface ReplyOptions {
	headers?: HeadersInit;
}

class DirectFetchMock {
	private originalFetch: typeof globalThis.fetch | undefined;
	private readonly pending: PendingInterceptor[] = [];

	install(): void {
		if (this.originalFetch) return;
		this.originalFetch = globalThis.fetch;
		globalThis.fetch = this.dispatch;
	}

	restore(): void {
		if (this.originalFetch) globalThis.fetch = this.originalFetch;
		this.originalFetch = undefined;
		this.pending.length = 0;
	}

	verify(): void {
		if (this.pending.length === 0) return;
		const pending = this.pending
			.map(
				({ matcher }) =>
					`${matcher.method.toUpperCase()} ${matcher.origin}${matcher.path}`,
			)
			.join(", ");
		throw new Error(`Pending mocked fetch requests: ${pending}`);
	}

	intercept(matcher: FetchMatcher): {
		reply: {
			(
				statusCode: number,
				data?: BodyInit | null,
				options?: ReplyOptions,
			): void;
			(factory: ReplyFactory): void;
		};
	} {
		const reply = (
			statusOrFactory: number | ReplyFactory,
			data?: BodyInit | null,
			options?: ReplyOptions,
		): void => {
			const factory: ReplyFactory =
				typeof statusOrFactory === "function"
					? statusOrFactory
					: () => ({
							statusCode: statusOrFactory,
							...(data !== undefined ? { data } : {}),
							...(options !== undefined ? { responseOptions: options } : {}),
						});
			this.pending.push({
				matcher: {
					...matcher,
					method: matcher.method.toUpperCase(),
				},
				reply: factory,
			});
		};
		return { reply };
	}

	private readonly dispatch: typeof globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const url = new URL(request?.url ?? String(input));
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(request?.headers);
		if (init?.headers) {
			for (const [name, value] of new Headers(init.headers)) {
				headers.set(name, value);
			}
		}

		let body = init?.body;
		if (body === undefined && request?.body) {
			body = await request.clone().text();
		}

		const path = `${url.pathname}${url.search}`;
		const index = this.pending.findIndex(
			({ matcher }) =>
				matcher.origin === url.origin &&
				matcher.path === path &&
				matcher.method === method,
		);
		if (index < 0) {
			throw new Error(`Unexpected fetch request: ${method} ${url.toString()}`);
		}

		const interceptor = this.pending.splice(index, 1)[0];
		if (!interceptor) throw new Error("Matched fetch interceptor disappeared.");
		const mocked = await interceptor.reply({
			url,
			method,
			headers,
			body,
			signal: init?.signal ?? request?.signal,
		});
		return new Response(mocked.data ?? null, {
			status: mocked.statusCode,
			...(mocked.responseOptions?.headers
				? { headers: mocked.responseOptions.headers }
				: {}),
		});
	};
}

export const fetchMock = new DirectFetchMock();
