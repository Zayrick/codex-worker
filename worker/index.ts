import { handleFetch } from "./app/fetch-handler";
import { handleScheduled } from "./app/scheduled-handler";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return handleFetch(request, env, ctx);
	},
	async scheduled(controller, env, _ctx): Promise<void> {
		await handleScheduled(controller, env);
	},
} satisfies ExportedHandler<Env>;
