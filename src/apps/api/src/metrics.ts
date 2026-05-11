import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
import { countActiveAgents, countFailedPermanentCallbacks, countLiveRooms } from "@repo/agent-rooms-core";

const register = new Registry();
collectDefaultMetrics({ register });

export const agentRoomsTotalGauge = new Gauge({
	name: "agent_rooms_total",
	help: "Total number of active agent rooms",
	registers: [register],
	collect() {
		try {
			this.set(countLiveRooms());
		} catch {
			this.set(0);
		}
	},
});

export const agentRoomsActiveAgentsGauge = new Gauge({
	name: "agent_rooms_active_agents",
	help: "Total number of active (non-idle) agents across running rooms",
	registers: [register],
	collect() {
		try {
			this.set(countActiveAgents());
		} catch {
			this.set(0);
		}
	},
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

export function refreshAgentRoomsCallbackFailureCounter(): void {
	let current = 0;
	try {
		current = countFailedPermanentCallbacks();
	} catch {
		current = callbackFailureObserved;
	}
	if (current > callbackFailureObserved) {
		agentRoomsCallbackFailuresTotal.inc(current - callbackFailureObserved);
	}
	callbackFailureObserved = current;
}

export async function registerMetricsRoute(app: { get: (path: string, handler: (request: unknown, reply: { header: (name: string, value: string) => void; send: (body: string) => unknown }) => unknown) => void }): Promise<void> {
	app.get("/metrics", async (_request, reply) => {
		refreshAgentRoomsCallbackFailureCounter();
		reply.header("Content-Type", register.contentType);
		return reply.send(await register.metrics());
	});
}
