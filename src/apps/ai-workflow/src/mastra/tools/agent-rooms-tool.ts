import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

const DEFAULT_API_BASE_URL = 'http://localhost:8080/api/v1/agent-rooms';

function getBaseUrl(apiBaseUrl?: string): string {
  return (apiBaseUrl ?? process.env.AGENT_ROOMS_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

export const createAgentRoomTool = createTool({
  id: 'create-agent-room',
  description: 'Create a new agent room from a protocol markdown file with YAML front matter containing a team block.',
  inputSchema: z.object({
    protocolFilePath: z.string().describe('Absolute or relative path to the protocol markdown file'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    status: z.string(),
  }),
  execute: async ({ protocolFilePath, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const markdown = readFileSync(protocolFilePath, 'utf-8');

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: markdown,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create agent room: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { roomId: string; status: string };
    return { roomId: data.roomId, status: data.status };
  },
});

export const listAgentRoomsTool = createTool({
  id: 'list-agent-rooms',
  description: 'List active agent rooms with optional filtering and pagination.',
  inputSchema: z.object({
    status: z.string().optional().describe('Filter by status: initialized, running, suspended, error, completed'),
    limit: z.number().optional().describe('Maximum rooms to return (default 50, max 200)'),
    offset: z.number().optional().describe('Number of rooms to skip (default 0)'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    rooms: z.array(z.unknown()),
  }),
  execute: async ({ status, limit, offset, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString();

    const res = await fetch(`${baseUrl}/${query ? `?${query}` : ''}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to list agent rooms: ${res.status} ${text}`);
    }

    const rooms = (await res.json()) as unknown[];
    return { rooms };
  },
});

export const getAgentRoomStatusTool = createTool({
  id: 'get-agent-room-status',
  description: 'Get the status snapshot for an agent room, including per-agent status and latest event pointer.',
  inputSchema: z.object({
    roomId: z.string().describe('The room ID'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    status: z.string(),
    agents: z.record(z.string(), z.object({ status: z.string() })),
    lastEventId: z.number().optional(),
    lastEventAt: z.string().optional(),
    lastEventType: z.string().optional(),
    lastEventFrom: z.string().optional(),
    failedAgent: z.string().optional(),
    reason: z.string().optional(),
  }),
  execute: async ({ roomId, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const res = await fetch(`${baseUrl}/${roomId}/status`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get room status: ${res.status} ${text}`);
    }

    const data = (await res.json()) as {
      roomId: string;
      status: string;
      agents: Record<string, { status: string }>;
      lastEventId?: number;
      lastEventAt?: string;
      lastEventType?: string;
      lastEventFrom?: string;
      failedAgent?: string;
      reason?: string;
    };

    return {
      roomId: data.roomId,
      status: data.status,
      agents: data.agents,
      lastEventId: data.lastEventId,
      lastEventAt: data.lastEventAt,
      lastEventType: data.lastEventType,
      lastEventFrom: data.lastEventFrom,
      failedAgent: data.failedAgent,
      reason: data.reason,
    };
  },
});

export const getAgentRoomEventsTool = createTool({
  id: 'get-agent-room-events',
  description: 'Retrieve a batch of stored events for an agent room. Use since cursor and check hasMore to paginate through all events.',
  inputSchema: z.object({
    roomId: z.string().describe('The room ID'),
    since: z.number().optional().describe('Event ID cursor — return only events with id > since. Defaults to 0.'),
    limit: z.number().optional().describe('Maximum events to return in this batch. Uses server default (100) if omitted.'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    total: z.number(),
    returned: z.number(),
    hasMore: z.boolean(),
    events: z.array(z.unknown()),
    nextSince: z.number(),
  }),
  execute: async ({ roomId, since, limit, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const sinceParam = since ?? 0;
    const params = new URLSearchParams();
    params.set('since', String(sinceParam));
    if (limit !== undefined) params.set('limit', String(limit));
    const res = await fetch(`${baseUrl}/${roomId}/events?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get room events: ${res.status} ${text}`);
    }

    const data = (await res.json()) as {
      roomId: string;
      total: number;
      returned: number;
      hasMore: boolean;
      events: Array<{ id: number }>;
    };

    const maxId = data.events.reduce((max, ev) => Math.max(max, ev.id ?? 0), sinceParam);
    return {
      roomId: data.roomId,
      total: data.total,
      returned: data.returned,
      hasMore: data.hasMore,
      events: data.events,
      nextSince: maxId,
    };
  },
});

export const sendAgentRoomInstructionsTool = createTool({
  id: 'send-agent-room-instructions',
  description: 'Send follow-up instructions to one or more agents in a room.',
  inputSchema: z.object({
    roomId: z.string().describe('The room ID'),
    targetAgents: z.array(z.string().min(1)).min(1).describe('Agent names to send instructions to'),
    followUp: z.array(z.string().min(1)).min(1).describe('Instruction messages to queue'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    queuedItems: z.number(),
  }),
  execute: async ({ roomId, targetAgents, followUp, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const res = await fetch(`${baseUrl}/${roomId}/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgents, followUp }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to send instructions: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { roomId: string; queuedItems: number };
    return { roomId: data.roomId, queuedItems: data.queuedItems };
  },
});

export const destroyAgentRoomTool = createTool({
  id: 'destroy-agent-room',
  description: 'Destroy (complete) an agent room and clean up its processes.',
  inputSchema: z.object({
    roomId: z.string().describe('The room ID'),
    apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    status: z.string(),
  }),
  execute: async ({ roomId, apiBaseUrl }) => {
    const baseUrl = getBaseUrl(apiBaseUrl);
    const res = await fetch(`${baseUrl}/${roomId}`, { method: 'DELETE' });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to destroy room: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { roomId: string; status: string };
    return { roomId: data.roomId, status: data.status };
  },
});
