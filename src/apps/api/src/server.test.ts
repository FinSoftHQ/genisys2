import { describe, it, expect, afterAll } from 'vitest';
import { app } from './server.js';

describe('server.ts', () => {
  afterAll(async () => {
    await app.close();
  });

  describe('app instance', () => {
    it('exports the fastify app instance for programmatic use', () => {
      expect(app).toBeDefined();
      expect(typeof app.inject).toBe('function');
    });

    it('does not start the server at module evaluation time', () => {
      expect(app.server.listening).toBe(false);
    });
  });

  describe('health endpoints', () => {
    it('GET /api/health returns 200 with status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });

    it('GET /api/health/ready returns 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ready');
      expect(body.timestamp).toBeDefined();
    });

    it('GET /api/health/live returns 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/live',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('alive');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('squad routes deleted (Phase 1.1)', () => {
    it('GET /api/v1/squads returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/squads',
      });
      expect(response.statusCode).toBe(404);
    });

    it('GET /api/v1/squads/anything returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/squads/anything',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('processor routes registered', () => {
    it('GET /api/kanban-processor/default/health returns 200 healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/default/health',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('healthy');
    });

    it('GET /api/kanban-processor/todo/health returns 200 healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/todo/health',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('healthy');
    });

    it('GET /api/kanban-processor/done/health returns 200 healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/kanban-processor/done/health',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('healthy');
    });
  });
});
