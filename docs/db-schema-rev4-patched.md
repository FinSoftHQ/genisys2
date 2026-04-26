# Database Schema — Kanban Engine v4.3.1 (SQLite + Drizzle)

> **Status:** Implementation-Ready  
> **Compatibility:** SQLite 3+ / Drizzle ORM  
> **Date:** 2026-04-26  
> **Revisions:** Patched for `last_health_check` naming, HMAC secret storage, callback token hard-delete, and Drizzle type safety.

---

## 1. Design Principles & SQLite Mitigations

1. **Type Mapping:** SQLite uses `TEXT` for UUIDs and JSON payloads. Drizzle's `mode: 'json'` and `mode: 'boolean'` handle serialization and boolean (`0`/`1`) mapping automatically.
2. **Single Source of Truth:** Column definitions live **strictly** inside the `boards.schema` JSON payload. There is no split-brain denormalization.
3. **Display ID Generation:** SQLite lacks `CREATE SEQUENCE`. A `board_sequences` table handles safe, transactional auto-increments for the `{prefix}-{number}` logic.
4. **Optimistic Locking:** Document-level `version` integer on all mutable entities to prevent concurrency overwrites.
5. **Write Concurrency Mitigation:** To prevent database locks during high-frequency updates, the SQLite connection MUST initialize with:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   PRAGMA busy_timeout = 5000;
   ```
6. **Debounce Buffer:** The `rollup_debounce_buffer` table acts as a persistent backup for disaster recovery. Primary debouncing should occur in the application layer (e.g., Node.js `Map` + `setTimeout`) to avoid SQLite polling bottlenecks.

---

## 2. Drizzle ORM Definitions

### 2.1 Core Domain: Boards & Sequences

#### `boards`
Stores board metadata and the JSON configuration for columns.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `uid` | `TEXT` | PK, Default: UUIDv4 | Primary identifier |
| `title` | `TEXT` | Not Null | Display name |
| `prefix` | `TEXT` | Not Null, Unique | 1-10 char prefix (e.g., "MKT") |
| `schema` | `TEXT` | Not Null, JSON | Contains `columns` array and `exit_logic` |
| `permissions` | `TEXT` | Not Null, JSON | Role-based access maps |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `updated_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |

**JSON Schema Shape:**
```typescript
type BoardSchema = {
  columns: Array<{
    uid: string;
    title: string;
    type: 'Normal' | 'Processing';
    processor_id: string;
    exit_logic: Record<string, string>;
    order: number;
  }>;
};
```

#### `board_sequences` 
Tracks the auto-increment counter transactionally.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `prefix` | `TEXT` | PK, FK (`boards.prefix`) | Matches the board prefix |
| `seq_value` | `INTEGER` | Not Null, Default: 0 | The latest integer used |

---

### 2.2 Core Domain: Cards & Relationships

#### `cards`
The central mutable entity with optimistic concurrency.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `uid` | `TEXT` | PK, Default: UUIDv4 | Immutable identifier |
| `display_id` | `TEXT` | Not Null, Unique | e.g., "MKT-501" |
| `title` | `TEXT` | Not Null | Card title |
| `version` | `INTEGER` | Not Null, Default: 1 | Incremented on every valid update |
| `processing_state` | `TEXT` | Not Null, Default: 'IDLE' | Enum: `IDLE`, `PROCESSING`, `ERROR` |
| `is_editable` | `INTEGER` | Not Null, Default: 1 | Mode: boolean (`true`/`false`). Defaults to `processing_state === 'IDLE'` but may be overridden by Processor `payload_updates`. |
| `payload` | `TEXT` | Not Null, JSON | Custom fields, actions, assignees |
| `current_status` | `TEXT` | Not Null | UID of the current column |
| `board_uid` | `TEXT` | Not Null, FK (`boards.uid`) | Cascade on delete |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `updated_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |

*Indexes:* `idx_cards_board_uid`, `idx_cards_current_status`, `idx_cards_processing_state`.

#### `card_relationships`
Fractal many-to-many parent/child linkages. *(Cycle detection managed in app layer).*

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `parent_card_uid` | `TEXT` | PK, FK (`cards.uid`) | Cascade on delete |
| `child_card_uid` | `TEXT` | PK, FK (`cards.uid`) | Cascade on delete |
| `relationship_type` | `TEXT` | Default: 'dependency' | - |

*Indexes:* `idx_relationships_child` (Reverse lookup).

---

### 2.3 Audit & Telemetry

#### `event_log`
Immutable audit trail. **NO UPDATES. NO DELETES.**

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `event_id` | `TEXT` | PK, Default: UUIDv4 | - |
| `card_uid` | `TEXT` | Not Null, FK (`cards.uid`) | - |
| `board_uid` | `TEXT` | FK (`boards.uid`) | For board-level history views |
| `timestamp` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `actor` | `TEXT` | Not Null | e.g., "user:alice@corp.com" |
| `action` | `TEXT` | Not Null | e.g., "MOVED", "UPDATED" |
| `category` | `TEXT` | Not Null | Enum: `routing`, `lifecycle`, `user_action`, `system` |
| `lifecycle_event` | `TEXT` | Nullable | e.g., "PROCESSING_STARTED" |
| `from_column` | `TEXT` | Nullable | - |
| `to_column` | `TEXT` | Nullable | - |
| `idempotency_key` | `TEXT` | Nullable | Traceability to original request |
| `payload_delta` | `TEXT` | Nullable, JSON | What changed |
| `metadata` | `TEXT` | Nullable, JSON | Processor details, IP address, etc. |

*Indexes:* `idx_event_log_card_time`, `idx_event_log_board_time`, `idx_event_log_cat_time`.

---

### 2.4 Orchestrator State & Processors

#### `processor_registry`
Known processors and their configurations.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `processor_id` | `TEXT` | PK | e.g., "manager-approval" |
| `name` | `TEXT` | Not Null | Display name |
| `base_url` | `TEXT` | Not Null | - |
| `health_endpoint`| `TEXT` | Default: '/health' | - |
| `hooks` | `TEXT` | Not Null, JSON | Array of supported hooks |
| `sla_seconds` | `INTEGER` | Default: 300 | Default SLA limit |
| `max_sla_seconds`| `INTEGER` | Default: 86400 | Hard ceiling on SLA |
| `auth_type` | `TEXT` | Default: 'bearer' | Enum: `bearer`, `oauth2`, `none` |
| `auth_config` | `TEXT` | Nullable, JSON | Token URLs, etc. |
| `hmac_secret` | `TEXT` | Not Null | Shared secret for signing/verifying callback payloads |
| `status` | `TEXT` | Default: 'unknown' | Enum: `healthy`, `degraded`, `unhealthy`, `unknown` |
| `last_health_check` | `INTEGER` | Nullable | Timestamp of last successful health probe |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `updated_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |

#### `callback_tokens`
Pending async operation tokens allowing processors to reply. **Hard-deleted on first valid use** to prevent replay attacks.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `token` | `TEXT` | PK, Default: UUIDv4 | Secure callback identity |
| `card_uid` | `TEXT` | Not Null, FK (`cards.uid`) | - |
| `processor_id` | `TEXT` | Not Null | - |
| `hook` | `TEXT` | Not Null | e.g., "on-enter" |
| `idempotency_key`| `TEXT` | Not Null | Prevents duplicate callbacks |
| `context` | `TEXT` | Not Null, JSON | Snapshot of state |
| `expires_at` | `INTEGER` | Not Null | Mode: timestamp (SLA deadline) |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |

> **Note:** There is no `used_at` column. Tokens are atomically deleted upon validation. Audit trail is preserved in the immutable `event_log`.

*Indexes:* `idx_callback_tokens_expires`, `idx_callback_tokens_card`.

#### `dlq` (Dead Letter Queue)
Failed async operations awaiting human intervention.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `dlq_id` | `TEXT` | PK, Default: UUIDv4 | - |
| `card_uid` | `TEXT` | Not Null, FK (`cards.uid`) | - |
| `processor_id` | `TEXT` | Not Null | - |
| `hook` | `TEXT` | Not Null | e.g., "on-enter" |
| `idempotency_key`| `TEXT` | Not Null | Traces back to original action |
| `reason` | `TEXT` | Not Null | e.g., "SLA_BREACH", "PROCESSOR_ERROR" |
| `status` | `TEXT` | Not Null, Default: 'pending_admin'| Enum: `pending_admin`, `retried`, `cancelled`, `forced` |
| `retry_count` | `INTEGER` | Not Null, Default: 0 | Times admin retried dispatch |
| `context` | `TEXT` | Not Null, JSON | Full hook payload snapshot |
| `submitted_at` | `INTEGER` | Not Null | Mode: timestamp |
| `deadline_at` | `INTEGER` | Not Null | Mode: timestamp |
| `resolved_at` | `INTEGER` | Nullable | Mode: timestamp |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |

---

### 2.5 Ephemeral State (Self-Contained SQLite)

#### `idempotency_cache`
Deduplicates client requests. Application cron job MUST delete rows where `expires_at < NOW()`.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `key` | `TEXT` | PK | Client-provided UUID |
| `response_status`| `INTEGER` | Not Null | HTTP Code |
| `response_body` | `TEXT` | Nullable, JSON | Cached payload |
| `created_at` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `expires_at` | `INTEGER` | Not Null | Set 24h into the future |

*Indexes:* `idx_idempotency_expires`.

#### `rollup_debounce_buffer`
Persistent backup for parent health score coalescing timers. Written only during graceful shutdown.

| Field | Type | Modifiers | Description |
|:---|:---|:---|:---|
| `parent_card_uid`| `TEXT` | PK, FK (`cards.uid`) | - |
| `dirty_since` | `INTEGER` | Default: `CURRENT_TIMESTAMP` | Mode: timestamp |
| `timer_deadline` | `INTEGER` | Not Null | Mode: timestamp (Current time + 500ms) |
| `pending_children`| `INTEGER` | Not Null, Default: 1 | Count of children triggering updates |
| `processed_at` | `INTEGER` | Nullable | Mode: timestamp |

*Indexes:* `idx_rollup_deadline`.
