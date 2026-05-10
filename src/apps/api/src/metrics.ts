import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
import { getIndexDb } from "@repo/agent-rooms-core";

const register = new Registry();
collectDefaultMetrics({ register });

export const agentRoomsTotalGauge = new Gauge({
	name: "agent_rooms_total",
	help: "Total number of agent rooms in index",
	registers: [register],
});

export const agentRoomsActiveAgentsGauge = new Gauge({
	name: "agent_rooms_active_agents",
	help: "Total number of active (non-idle) agents across running rooms",
	registers: [register],
});

export const agentRoomsSseSubscribersGauge = new Gauge({
	name: "agent_rooms_sse_subscribers",
	help: "Current number of agent room SSE subscribers",
	registers: [register],
});

export const agentRoomsRequestsTotal = new Counter({
	name: "agent_rooms_requests_total",
	help: "Total HTTP requests for agent room endpoints",
	labelNames: ["method", "route", "status"],
	registers: [register],
});

export const agentRoomsCallbackFailuresTotal = new Counter({
	name: "agent_rooms_callback_failures_total",
	help: "Total callback failures recorded for agent rooms",
	registers: [register],
});

export const agentRoomsIpcErrorsTotal = new Counter({
	name: "agent_rooms_ipc_errors_total",
	help: "Total IPC errors while handling agent room requests",
	labelNames: ["operation"],
	registers: [register],
});

let sseSubscribers = 0;
let callbackFailureObserved = 0;

export function setAgentRoomsSseSubscribers(delta: number): void {
	sseSubscribers = Math.max(0, sseSubscribers + delta);
	agentRoomsSseSubscribersGauge.set(sseSubscribers);
}

export function refreshAgentRoomsSnapshotMetrics(): void {
	const db = getIndexDb();
	const totalRow = db.prepare("SELECT COUNT(*) AS count FROM rooms").get() as { count: number };
	const activeAgentsRow = db
		.prepare(
			"SELECT COUNT(*) AS count FROM agents a INNER JOIN rooms r ON r.id = a.room_id WHERE r.status = 'running' AND a.status != 'idle'",
		)
		.get() as { count: number };
	const callbackFailureRow = db
		.prepare("SELECT COUNT(*) AS count FROM rooms WHERE failed_reason LIKE 'callback_failed:%'")
		.get() as { count: number };

	agentRoomsTotalGauge.set(totalRow.count);
	agentRoomsActiveAgentsGauge.set(activeAgentsRow.count);
	if (callbackFailureRow.count > callbackFailureObserved) {
		agentRoomsCallbackFailuresTotal.inc(callbackFailureRow.count - callbackFailureObserved);
	}
	callbackFailureObserved = callbackFailureRow.count;
}

export async function registerMetricsRoute(app: { get: (path: string, handler: (request: unknown, reply: { header: (name: string, value: string) => void; send: (body: string) => unknown }) => unknown) => void }): Promise<void> {
	app.get("/metrics", async (_request, reply) => {
		refreshAgentRoomsSnapshotMetrics();
		reply.header("Content-Type", register.contentType);
		return reply.send(await register.metrics());
	});
}
