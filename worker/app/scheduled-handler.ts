import { refreshOAuthCredentials } from "../auth/refresh";
import { errorCode } from "../shared/logging";

export async function handleScheduled(
	controller: ScheduledController,
	env: Env,
): Promise<void> {
	try {
		const status = await refreshOAuthCredentials(env);
		console.log(
			JSON.stringify({
				event: "oauth_refresh",
				status,
				scheduled_time: controller.scheduledTime,
			}),
		);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "oauth_refresh",
				status: "failed",
				code: errorCode(error),
			}),
		);
	}
}
