import type { Room, AgentState } from "./types.js";
import { pushEvent, broadcast } from "./event-store.js";

export interface RouterDeps {
	sendToAgent(agent: AgentState, cmd: object): void;
	clearIdleCompletionTimeout(room: Room): void;
	spawnAndSendToSingleShot(
		room: Room,
		agentName: string,
		message: string,
	): Promise<void>;
}

export function determineRecipients(
	room: Room,
	fromAgent: string,
	text: string,
): string[] {
	if (room.routingStrategy === "broadcast") {
		return [...room.agents.keys()].filter((name) => name !== fromAgent);
	}

	// Explicit mode: combine dynamic @attn: mentions with static routes
	const pool = new Set<string>();

	// Dynamic targeting (inline mentions)
	const mentionRegex = /@attn:([\w-]+)/g;
	let match: RegExpExecArray | null;
	while ((match = mentionRegex.exec(text)) !== null) {
		const identifier = match[1];
		// Name match
		if (room.agents.has(identifier)) {
			pool.add(identifier);
		}
		// Role match — route to all agents with this role
		for (const [name, agent] of room.agents) {
			if (agent.role === identifier) {
				pool.add(name);
			}
		}
	}

	// Static targeting (configured routes)
	if (room.routes && room.routes[fromAgent]) {
		for (const name of room.routes[fromAgent]) {
			if (room.agents.has(name)) {
				pool.add(name);
			}
		}
	}

	// Self-exclusion
	pool.delete(fromAgent);

	return Array.from(pool);
}

export function resolveMessageTargets(
	room: Room,
	fromAgent: string,
	text: string,
): string[] {
	const recipients = determineRecipients(room, fromAgent, text);
	if (recipients.length > 0) {
		return recipients;
	}

	if (!room.facilitator) {
		return [];
	}
	if (room.facilitator === fromAgent) {
		return [];
	}
	if (!room.agents.has(room.facilitator)) {
		return [];
	}
	return [room.facilitator];
}

export function shouldCheckCompletionAfterTaskMarker(
	room: Room,
	fromAgent: string,
	text: string,
): boolean {
	const targets = resolveMessageTargets(room, fromAgent, text);
	if (targets.length === 0) {
		return true;
	}
	return targets.every(
		(targetName) => room.agents.get(targetName)?.taskCompleted === true,
	);
}

export function routeMessageToAgents(
	room: Room,
	fromAgent: string,
	text: string,
	deps: RouterDeps,
): void {
	const recipients = determineRecipients(room, fromAgent, text);

	if (recipients.length > 0) {
		// Reset facilitator orphan counter on successful routing from facilitator
		if (fromAgent === room.facilitator) {
			room.facilitatorConsecutiveOrphanFailures = 0;
		}

		deps.clearIdleCompletionTimeout(room);
		const formattedMessage = `[${fromAgent}]: ${text}`;
		for (const recipientName of recipients) {
			const agent = room.agents.get(recipientName);
			if (!agent) continue;

			if (agent.executionMode === "single-shot" && agent.proc === null) {
				deps
					.spawnAndSendToSingleShot(room, recipientName, formattedMessage)
					.catch((err: unknown) => {
						const reason =
							err instanceof Error ? err.message : String(err);
						pushEvent(room, {
							type: "room_error",
							from: recipientName,
							at: new Date().toISOString(),
							reason,
						});
						broadcast(room, {
							type: "room_error",
							from: recipientName,
							reason,
						});
					});
				continue;
			}

			deps.sendToAgent(agent, {
				type: agent.isStreaming ? "follow_up" : "prompt",
				message: formattedMessage,
			});
		}
		return;
	}

	// Phase 3: Fallback Protocol
	if (!room.facilitator) {
		console.warn(
			`[SYSTEM WARNING] Dropped message from ${fromAgent}: no recipients and no facilitator configured.`,
		);
		return;
	}

	if (room.facilitator === fromAgent) {
		const failures = room.facilitatorConsecutiveOrphanFailures ?? 0;
		if (failures >= 1) {
			console.error(
				`[CRITICAL ERROR] Facilitator ${fromAgent} sent a message with no recipients. This creates an infinite loop. Configure routes for the facilitator agent.`,
			);
			return;
		}

		room.facilitatorConsecutiveOrphanFailures = failures + 1;

		const facilitatorAgent = room.agents.get(fromAgent);
		if (facilitatorAgent) {
			deps.clearIdleCompletionTimeout(room);
			const retryMessage =
				`[SYSTEM_ROUTING_FAILURE]\n**Original Sender:** ${fromAgent}\n**Status:** No recipients resolved. One retry allowed before drop. Please use @attn:<name|role> or configured routes.\n**Content:**\n> ---\n${text}`;
			deps.sendToAgent(facilitatorAgent, {
				type: facilitatorAgent.isStreaming ? "follow_up" : "prompt",
				message: retryMessage,
			});
		}
		return;
	}

	const facilitatorAgent = room.agents.get(room.facilitator);
	if (!facilitatorAgent) {
		console.warn(
			`[SYSTEM WARNING] Facilitator ${room.facilitator} not found in room. Dropping message from ${fromAgent}.`,
		);
		return;
	}

	deps.clearIdleCompletionTimeout(room);
	const wrappedMessage =
		`[SYSTEM_ROUTING_FAILURE]\n**Original Sender:** ${fromAgent}\n**Status:** This message reached no one because no attention tags were used and no static routes exist.\n**Content:**\n> ---\n${text}`;
	deps.sendToAgent(facilitatorAgent, {
		type: facilitatorAgent.isStreaming ? "follow_up" : "prompt",
		message: wrappedMessage,
	});
}
