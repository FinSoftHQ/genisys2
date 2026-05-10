import {
	openIndexDb,
	listRoomsIndex,
	upsertRoom,
} from "@repo/agent-rooms-core";

export async function performCrashRecovery(): Promise<void> {
	openIndexDb();
	const now = Date.now();
	const rooms = listRoomsIndex();
	let recovered = 0;
	for (const row of rooms) {
		if (row.status !== "running" && row.status !== "initialized") continue;
		upsertRoom({
			id: row.id,
			status: "error",
			tag: row.tag,
			created_at: row.created_at,
			updated_at: now,
			last_activity_at: row.last_activity_at,
			protocol_body: row.protocol_body ?? "",
			facilitator: row.facilitator,
			routing_strategy: row.routing_strategy,
			failed_agent: null,
			failed_reason: "supervisor_restart",
			callback_url: row.callback_url,
			callback_secret: row.callback_secret,
			completed_at: null,
		});
		recovered++;
		console.info(`[supervisor] crash recovery: transitioned room ${row.id} to error (supervisor_restart)`);
	}
	if (recovered > 0) {
		console.info(`[supervisor] crash recovery: ${recovered} room(s) recovered`);
	}
}
