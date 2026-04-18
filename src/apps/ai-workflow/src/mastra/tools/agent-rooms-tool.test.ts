import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAgentRoomTool,
  listAgentRoomsTool,
  getAgentRoomStatusTool,
  getAgentRoomEventsTool,
  sendAgentRoomInstructionsTool,
  destroyAgentRoomTool,
} from './agent-rooms-tool.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => '# Protocol\n\nTest protocol body'),
  };
});

describe('agent-rooms tools', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createAgentRoomTool', () => {
    it('should have correct configuration', () => {
      expect(createAgentRoomTool.id).toBe('create-agent-room');
      expect(createAgentRoomTool.description).toContain('Create a new agent room');
    });

    it('should create a room successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ roomId: 'room-123', status: 'initialized' }),
      });

      const result = await createAgentRoomTool.execute!(
        { protocolFilePath: '/path/to/protocol.md' },
        {} as any
      );

      expect(result).toEqual({ roomId: 'room-123', status: 'initialized' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/agent-rooms/',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'text/markdown' },
        })
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 415,
        text: async () => 'Expected text/markdown',
      });

      await expect(
        createAgentRoomTool.execute!({ protocolFilePath: '/path/to/protocol.md' }, {} as any)
      ).rejects.toThrow('Failed to create agent room: 415 Expected text/markdown');
    });
  });

  describe('listAgentRoomsTool', () => {
    it('should list rooms successfully', async () => {
      const rooms = [{ roomId: 'room-1', status: 'running' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => rooms,
      });

      const result = await listAgentRoomsTool.execute!({}, {} as any);
      expect(result).toEqual({ rooms });
    });

    it('should pass query params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await listAgentRoomsTool.execute!(
        { status: 'running', limit: 10, offset: 5 },
        {} as any
      );

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('status=running');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
    });
  });

  describe('getAgentRoomStatusTool', () => {
    it('should return room status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          roomId: 'room-123',
          status: 'running',
          agents: { smith: { status: 'idle' }, john: { status: 'streaming' } },
          lastEventId: 5,
        }),
      });

      const result = (await getAgentRoomStatusTool.execute!(
        { roomId: 'room-123' },
        {} as any
      )) as { roomId: string; status: string; agents: Record<string, { status: string }>; lastEventId?: number };

      expect(result.roomId).toBe('room-123');
      expect(result.status).toBe('running');
      expect(result.agents).toEqual({ smith: { status: 'idle' }, john: { status: 'streaming' } });
      expect(result.lastEventId).toBe(5);
    });
  });

  describe('getAgentRoomEventsTool', () => {
    it('should return events and nextSince', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          roomId: 'room-123',
          total: 10,
          events: [
            { id: 1, from: 'smith', type: 'message', text: 'Hello' },
            { id: 3, from: 'john', type: 'thinking', thinking: 'Hmm' },
          ],
        }),
      });

      const result = (await getAgentRoomEventsTool.execute!(
        { roomId: 'room-123' },
        {} as any
      )) as { roomId: string; total: number; events: unknown[]; nextSince: number };

      expect(result.roomId).toBe('room-123');
      expect(result.total).toBe(10);
      expect(result.events).toHaveLength(2);
      expect(result.nextSince).toBe(3);
    });

    it('should respect since parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          roomId: 'room-123',
          total: 10,
          events: [{ id: 7, from: 'smith', type: 'message', text: 'Done' }],
        }),
      });

      const result = (await getAgentRoomEventsTool.execute!(
        { roomId: 'room-123', since: 5 },
        {} as any
      )) as { roomId: string; total: number; events: unknown[]; nextSince: number };

      expect(result.nextSince).toBe(7);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('since=5');
    });
  });

  describe('sendAgentRoomInstructionsTool', () => {
    it('should send instructions successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ roomId: 'room-123', queuedItems: 2 }),
      });

      const result = await sendAgentRoomInstructionsTool.execute!(
        { roomId: 'room-123', targetAgents: ['smith', 'john'], followUp: ['Please continue'] },
        {} as any
      );

      expect(result).toEqual({ roomId: 'room-123', queuedItems: 2 });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/agent-rooms/room-123/instructions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ targetAgents: ['smith', 'john'], followUp: ['Please continue'] }),
        })
      );
    });
  });

  describe('destroyAgentRoomTool', () => {
    it('should destroy a room successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ roomId: 'room-123', status: 'deleted' }),
      });

      const result = await destroyAgentRoomTool.execute!(
        { roomId: 'room-123' },
        {} as any
      );

      expect(result).toEqual({ roomId: 'room-123', status: 'deleted' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/v1/agent-rooms/room-123',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
