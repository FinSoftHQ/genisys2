CREATE TABLE IF NOT EXISTS processor_registry (
  processor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  health_endpoint TEXT NOT NULL,
  hooks TEXT NOT NULL,
  sla_seconds INTEGER NOT NULL,
  max_sla_seconds INTEGER NOT NULL,
  auth_type TEXT NOT NULL,
  auth_config TEXT,
  hmac_secret TEXT NOT NULL,
  status TEXT NOT NULL,
  last_health_check TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
