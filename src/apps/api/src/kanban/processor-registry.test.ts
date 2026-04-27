import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  ProcessorRegistryEntitySchema,
  UpsertProcessorRegistryRequestSchema,
  ProcessorHealthPollConfigSchema,
  ProcessorHealthCheckResultSchema,
  type ProcessorRegistryEntity,
} from '@repo/shared';
import {
  openDb,
  closeDb,
  upsertProcessorRegistry,
  getProcessorById,
  runHealthCheck,
  getHealthPollConfig,
} from './processor-registry.js';

describe('processor registry', () => {
  let db: unknown;

  beforeAll(() => {
    db = openDb(':memory:');
  });

  afterAll(() => {
    closeDb(db);
  });

  describe('upsert validation', () => {
    it('creates a processor that validates against ProcessorRegistryEntitySchema', () => {
      const processor = upsertProcessorRegistry(db, {
        processor_id: 'manager-approval',
        name: 'Manager Approval Gate',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'bearer',
        auth_config: { token_header: 'X-Api-Key' },
        hmac_secret: 'temp-secret-ignore',
      });

      expect(ProcessorRegistryEntitySchema.safeParse(processor).success).toBe(true);
      expect(processor.processor_id).toBe('manager-approval');
    });

    it('updates an existing processor without creating a duplicate', () => {
      upsertProcessorRegistry(db, {
        processor_id: 'duplicate-test',
        name: 'First Name',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 60,
        max_sla_seconds: 120,
        auth_type: 'none',
        hmac_secret: 'temp-secret-ignore',
      });

      const updated = upsertProcessorRegistry(db, {
        processor_id: 'duplicate-test',
        name: 'Second Name',
        base_url: 'http://localhost:4002',
        health_endpoint: '/ping',
        hooks: ['on-enter', 'on-action'],
        sla_seconds: 90,
        max_sla_seconds: 180,
        auth_type: 'bearer',
        hmac_secret: 'new-secret',
      });

      const found = getProcessorById(db, 'duplicate-test');
      expect(found).toBeDefined();
      expect(found!.name).toBe('Second Name');
      expect(found!.base_url).toBe('http://localhost:4002');
    });

    it('rejects upsert when sla_seconds exceeds max_sla_seconds', () => {
      expect(() =>
        upsertProcessorRegistry(db, {
          processor_id: 'bad-sla',
          name: 'Bad SLA',
          base_url: 'http://localhost:4001',
          health_endpoint: '/health',
          hooks: ['on-enter'],
          sla_seconds: 600,
          max_sla_seconds: 300,
          auth_type: 'none',
          hmac_secret: 'temp-secret-ignore',
        }),
      ).toThrow();
    });

    it('rejects upsert with empty hmac_secret', () => {
      expect(() =>
        upsertProcessorRegistry(db, {
          processor_id: 'no-secret',
          name: 'No Secret',
          base_url: 'http://localhost:4001',
          health_endpoint: '/health',
          hooks: ['on-enter'],
          sla_seconds: 300,
          max_sla_seconds: 600,
          auth_type: 'none',
          hmac_secret: '',
        }),
      ).toThrow();
    });

    it('accepts placeholder hmac_secret for Slice 3 seeding', () => {
      const processor = upsertProcessorRegistry(db, {
        processor_id: 'placeholder-test',
        name: 'Placeholder Test',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        hmac_secret: 'temp-secret-ignore',
      });

      expect(processor.hmac_secret).toBe('temp-secret-ignore');
      expect(ProcessorRegistryEntitySchema.safeParse(processor).success).toBe(true);
    });
  });

  describe('health poll configuration', () => {
    it('returns 30s interval and 3000ms default timeout', () => {
      const config = getHealthPollConfig();
      expect(ProcessorHealthPollConfigSchema.safeParse(config).success).toBe(true);
      expect(config.interval_seconds).toBe(30);
      expect(config.timeout_ms).toBe(3000);
    });

    it('allows timeout in 250..10000ms range', () => {
      expect(ProcessorHealthPollConfigSchema.safeParse({ interval_seconds: 30, timeout_ms: 250 }).success).toBe(true);
      expect(ProcessorHealthPollConfigSchema.safeParse({ interval_seconds: 30, timeout_ms: 10000 }).success).toBe(true);
      expect(ProcessorHealthPollConfigSchema.safeParse({ interval_seconds: 30, timeout_ms: 249 }).success).toBe(false);
      expect(ProcessorHealthPollConfigSchema.safeParse({ interval_seconds: 30, timeout_ms: 10001 }).success).toBe(false);
    });
  });

  describe('health check dispatch', () => {
    it('POSTs to processor health endpoint and returns validated result', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'healthy' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const processor: ProcessorRegistryEntity = {
        processor_id: 'health-test',
        name: 'Health Test',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        auth_config: null,
        hmac_secret: 'temp-secret-ignore',
        status: 'unknown',
        last_health_check: null,
        created_at: '2026-04-26T08:30:00.000Z',
        updated_at: '2026-04-26T08:30:00.000Z',
      };

      const result = await runHealthCheck(processor);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:4001/health',
        expect.objectContaining({
          method: 'GET',
          signal: expect.any(AbortSignal),
        }),
      );

      expect(ProcessorHealthCheckResultSchema.safeParse(result).success).toBe(true);
      expect(result.processor_id).toBe('health-test');
      expect(result.status).toBe('healthy');
      expect(result.http_status).toBe(200);
      expect(result.response_time_ms).toBeGreaterThanOrEqual(0);

      fetchSpy.mockRestore();
    });

    it('marks degraded on non-2xx health response', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('Service Unavailable', { status: 503 }),
      );

      const processor: ProcessorRegistryEntity = {
        processor_id: 'degraded-test',
        name: 'Degraded Test',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        auth_config: null,
        hmac_secret: 'temp-secret-ignore',
        status: 'healthy',
        last_health_check: '2026-04-26T08:30:00.000Z',
        created_at: '2026-04-26T08:30:00.000Z',
        updated_at: '2026-04-26T08:30:00.000Z',
      };

      const result = await runHealthCheck(processor);
      expect(result.status).toBe('degraded');
      expect(result.http_status).toBe(503);
    });

    it('marks unhealthy on fetch failure', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const processor: ProcessorRegistryEntity = {
        processor_id: 'unhealthy-test',
        name: 'Unhealthy Test',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        auth_config: null,
        hmac_secret: 'temp-secret-ignore',
        status: 'healthy',
        last_health_check: '2026-04-26T08:30:00.000Z',
        created_at: '2026-04-26T08:30:00.000Z',
        updated_at: '2026-04-26T08:30:00.000Z',
      };

      const result = await runHealthCheck(processor);
      expect(result.status).toBe('unhealthy');
      expect(result.error_message).toBeDefined();
    });
  });

  describe('getProcessorById', () => {
    it('returns undefined for unknown processor', () => {
      const found = getProcessorById(db, 'nonexistent-processor');
      expect(found).toBeUndefined();
    });

    it('returns parsed processor for existing entry', () => {
      upsertProcessorRegistry(db, {
        processor_id: 'findable',
        name: 'Findable',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        hmac_secret: 'temp-secret-ignore',
      });

      const found = getProcessorById(db, 'findable');
      expect(found).toBeDefined();
      expect(found!.processor_id).toBe('findable');
      expect(ProcessorRegistryEntitySchema.safeParse(found).success).toBe(true);
    });
  });
});
