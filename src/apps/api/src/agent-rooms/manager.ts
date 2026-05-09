import { attachAgentEventHandlers } from "./internal/event-handlers.js";
import type { Room, AgentState } from "./types.js";
import { sendToAgent, spawnAgentProcess } from "./spawn.js";
import {
	type CreateRoomDeps,
	createRoom as createRoomImpl,
	createRoomFromMarkdown as createRoomFromMarkdownImpl,
} from "./lifecycle.js";

function setupAgentAfterSpawn(room: Room, agent: AgentState): void {
	attachAgentEventHandlers(room, agent, spawnAndSendToSingleShot);
	sendToAgent(agent, { type: "get_state" });
	if (agent._readyTimeout) clearTimeout(agent._readyTimeout);
	agent._readyTimeout = setTimeout(() => {
		agent._readyReject?.(new Error(`Agent ${agent.name} did not become ready in time`));
	}, 30000);
}

export async function spawnAndSendToSingleShot(
	room: Room,
	agentName: string,
	message: string,
): Promise<void> {
	const agent = room.agents.get(agentName);
	if (!agent || agent.executionMode !== "single-shot" || agent.proc !== null) return;

	agent.taskCompleted = false;
	agent.ready = false;
	agent._readyTimeout = undefined;

	spawnAgentProcess(room, agent);
	setupAgentAfterSpawn(room, agent);

	await new Promise<void>((resolve, reject) => {
		agent._readyResolve = resolve;
		agent._readyReject = reject;
	});

	sendToAgent(agent, { type: "prompt", message });
}

const createRoomDeps: CreateRoomDeps = {
	setupAgentAfterSpawn,
};

export async function createRoom(
	protocol: import("@repo/shared").Protocol,
	options?: import("./types.js").RoomCreateOptions,
): Promise<{ roomId: string }> {
	return createRoomImpl(protocol, createRoomDeps, options);
}

export async function createRoomFromMarkdown(
	markdown: string,
	options?: import("./types.js").RoomCreateOptions,
): Promise<{ roomId: string }> {
	return createRoomFromMarkdownImpl(markdown, createRoomDeps, options);
}

