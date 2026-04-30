# The Master Blueprint v4.3.1: Modular Logic-Driven Kanban Engine (Single-Node Architecture)

> **Status:** Final Implementation-Ready  
> **Version:** 4.3.1 (Patched: `last_health_check` naming, HMAC secret storage, `is_editable` semantics, callback hard-delete)  
> **Date:** 2026-04-26  
> **Classification:** Architecture Specification — Implementation Handoff

---

## 1. Executive Summary

This document defines a **decentralized, event-driven Kanban platform** where workflow logic is externalized into independent, stateless microservices called **Processors**. The system is governed by a central **Orchestrator** built for a **single-node, vertically scaled environment** utilizing SQLite. It enforces optimistic concurrency, manages asynchronous state transitions, and broadcasts real-time updates via Server-Sent Events (SSE).

The architecture is designed for **single-node speed** utilizing SQLite in WAL mode, **strict data integrity** via document-level optimistic locking, and **operational resilience** through idempotency, dead-letter queues, and explicit failure domains. Horizontal scaling requires a future migration to PostgreSQL and Redis.

---

## 2. Core System Vision

### 2.1 Design Principles

| Principle | Implementation |
|:---|:---|
| **Decentralized Logic** | Business rules live in independent Processor microservices, not in the Orchestrator |
| **Event-Driven State** | All state mutations emit events; the UI is a reactive projection of the event stream |
| **Optimistic Concurrency** | Document-level `version` tokens prevent silent overwrites in multi-user environments |
| **Idempotency by Default** | Every mutation carries an idempotency key; retries are safe |
| **Single-Node Speed** | Uses SQLite in WAL mode for blazing fast, low-latency state management |
| **Fail-Fast Validation** | Synchronous hooks (`can-exit`, `on-update`) block invalid actions immediately |
| **Async Resilience** | Long-running operations use ACK/callback patterns with SLA enforcement and DLQ |
| **Immutable Audit** | Every action is append-only logged for compliance and traceability |
| **Event Coalescing** | Roll-up broadcasts are debounced in-memory to prevent SSE event storms |

### 2.2 System Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL WORLD                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Client A   │  │   Client B   │  │   Client C   │  │  Processor X │   │
│  │   (Browser)  │  │   (Browser)  │  │   (Mobile)   │  │ (Microservice)│   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
└─────────┼─────────────────┼─────────────────┼─────────────────┼───────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           THE ORCHESTRATOR (Single Node)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   API GW    │  │   State     │  │   Event     │  │  Processor  │        │
│  │  (REST/SSE) │  │   Machine   │  │   Bus/SSE   │  │   Registry  │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │               │
│         └────────────────┴────────────────┴────────────────┘               │
│                                    │                                        │
│  ┌─────────────┐  ┌─────────────┐  ▼  ┌─────────────┐  ┌─────────────┐   │
│  │   SQLite    │  │  Event Log  │◄────►│   DLQ /     │  │  Callback   │   │
│  │  (WAL Mode) │  │ (Immutable) │     │  Timeout    │  │  Verifier   │   │
│  └─────────────┘  └─────────────┘     └─────────────┘  └─────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. System Architecture & Components

### 3.1 The Client (UI Layer)

**Responsibilities:**
- Render Kanban boards, columns, and cards with drag-and-drop interactions
- Generate `X-Idempotency-Key` headers (UUID v4) for every user-initiated mutation
- Subscribe to SSE stream for real-time state updates
- Fetch initial state via paginated `/snapshot` endpoint before SSE subscription
- Respect `is_editable` flag by disabling interactions on locked cards
- Render `processing_state` overlays (spinner, error, retry button)

**Key Behaviors:**
- On page load: `snapshot` → render → `SSE subscribe`
- On SSE disconnect: exponential backoff reconnect
- On `409 Conflict`: refresh card state from snapshot and notify user
- On `processing_state: ERROR`: display error banner, enable retry/override UI (admin only)

### 3.2 The Orchestrator (Backend Core)

**Responsibilities:**
- **State Machine:** Owns the canonical state of every card
- **Concurrency Guard:** Enforces `version` token checks on all writes
- **Idempotency Manager:** Deduplicates requests via `X-Idempotency-Key` cache
- **Hook Router:** Dispatches to Processors with circuit breakers for failing endpoints
- **Callback Verifier:** Validates `callback_token` and HMAC signatures on Processor callbacks
- **DLQ Manager:** Monitors SLA timeouts and transitions cards to `ERROR`
- **SSE Broadcaster:** Emits `CARD_UPDATED`, `CARD_MOVED`, `PROCESSING_ERROR` events
- **Processor Registry:** Maintains health status and SLA configs for all Processors
- **Rate Limiter:** Token-bucket limiter protecting against request floods

**Internal Services:**

```
Orchestrator
├── API Gateway (REST endpoints + SSE streams)
├── Rate Limiter (Token-bucket DoS prevention)
├── State Manager (CRUD + version checks)
├── Hook Dispatcher (Sync vs Async routing + Circuit Breakers)
├── Callback Handler (HMAC verification + atomic token deletion)
├── DLQ Monitor (cron/scheduler for SLA breaches)
├── Event Publisher (SSE broadcast + Event Log append)
├── Roll-up Debouncer (In-memory Node.js Map coalescing buffer)
└── Processor Registry (health polling + metadata store)
```

---

## 4. Data Architecture & State Management

### 4.1 Core Entities

#### Board Entity
```json
{
  "uid": "board-uuid",
  "title": "Marketing Sprint Q2",
  "prefix": "MKT",
  "schema": {
    "columns": [
      {
        "uid": "col-1",
        "title": "Backlog",
        "type": "Normal",
        "processor_id": "default-manual",
        "exit_logic": { "default": "col-2" }
      },
      {
        "uid": "col-2",
        "title": "In Review",
        "type": "Processing",
        "processor_id": "manager-approval",
        "exit_logic": {
          "approved": "col-3",
          "rejected": "col-1"
        }
      }
    ]
  },
  "permissions": {
    "read": ["role:marketing"],
    "write": ["role:marketing-lead"]
  }
}
```

#### Column Entity
| Field | Description |
|:---|:---|
| `uid` | Unique identifier |
| `title` | Display name |
| `type` | `Normal` (manual) or `Processing` (automated) |
| `processor_id` | Reference to Processor Registry |
| `exit_logic` | Map of action → next column uid |
| `order` | Visual position on board |

#### Card Entity (Canonical Document)
```json
{
  "uid": "card-uuid-string",
  "display_id": "MKT-501",
  "title": "Campaign Launch",
  "version": 4,
  "processing_state": "IDLE",
  "is_editable": true,
  "parents": [
    {
      "uid": "p-1",
      "display_id": "PRJ-01",
      "status": "col-88",
      "title": "Q3 Marketing Push"
    }
  ],
  "payload": {
    "custom_data": "value",
    "available_actions": ["Complete", "Force Close"],
    "assignee": "alice@corp.com",
    "priority": "high"
  },
  "current_status": "column-id-123",
  "created_at": "2026-04-20T10:00:00Z",
  "updated_at": "2026-04-26T08:30:00Z"
}
```

**Field Semantics:**
| Field | Mutable | Source | Description |
|:---|:---|:---|:---|
| `uid` | ❌ | System | Immutable UUID |
| `display_id` | ❌ | System | Auto-incremented prefixed ID |
| `version` | ✅ | Orchestrator | Incremented on every successful write |
| `processing_state` | ✅ | Orchestrator | `IDLE`, `PROCESSING`, `ERROR` |
| `is_editable` | ✅ | Orchestrator | **Materialized boolean:** defaults to `(processing_state === 'IDLE')`, but Processors may override via `payload_updates` |
| `parents` | ✅ | Orchestrator | Injected shallow metadata (max depth: 1) |
| `payload` | ✅ | User/Processor | Custom data + UI actions |
| `current_status` | ✅ | Orchestrator | Current column uid |

#### Event Log Entity (Immutable)
```json
{
  "event_id": "evt-uuid",
  "card_uid": "MKT-501",
  "timestamp": "2026-04-26T08:30:00Z",
  "actor": "user:alice@corp.com",
  "action": "MOVED",
  "category": "routing",
  "lifecycle_event": "PROCESSING_STARTED",
  "from_column": "col-1",
  "to_column": "col-2",
  "idempotency_key": "client-uuid-123",
  "payload_delta": {
    "processing_state": { "old": "IDLE", "new": "PROCESSING" },
    "is_editable": { "old": true, "new": false }
  },
  "metadata": {
    "processor_id": "manager-approval",
    "hook": "on-enter",
    "client_ip": "203.0.113.42"
  }
}
```

**Event Categories:**
| Category | Actions | Use Case |
|:---|:---|:---|
| `routing` | `MOVED` | Column transitions, board navigation |
| `lifecycle` | `PROCESSING_STARTED`, `PROCESSING_COMPLETED`, `PROCESSING_ERROR` | Async hook state changes |
| `user_action` | `CARD_CREATED`, `CARD_UPDATED`, `ACTION_TRIGGERED` | Direct user mutations |
| `system` | `ROLLUP_CHANGED`, `ADMIN_OVERRIDE` | Automated or admin events |

**Event Types:**
- `CARD_CREATED`, `CARD_UPDATED`, `CARD_MOVED`
- `PROCESSING_STARTED`, `PROCESSING_COMPLETED`, `PROCESSING_ERROR`
- `ACTION_TRIGGERED`, `ROLLUP_CHANGED`

> **Engineering Note:** The `action` and `lifecycle_event` fields are intentionally separated. Query routing history with `WHERE category = 'routing'`, and query async lifecycle with `WHERE category = 'lifecycle'`. This prevents semantic ambiguity when a `MOVED` action also triggers a `PROCESSING_STARTED` lifecycle event.

> **Event Log Retention & Archival:** Because this is a single-node architecture, the SQLite event log will grow indefinitely. The system retains 90 days of hot data. A monthly application-layer background job exports partitions older than 90 days to cold storage (e.g., compressed NDJSON files) and deletes them from the active database.

### 4.2 Parent-Child Relationships (Fractal Model)

**Rules:**
- Any card can be a parent, child, or both
- Relationships are **Many-to-Many**
- The Orchestrator injects only **shallow metadata** (uid, display_id, status, title) into `parents`
- **No circular references allowed** — the Orchestrator validates via app-layer graph traversal
- **Archive Block Policy:** A parent card cannot be archived unless all children are in `Done` or `Archive` state

**Relationship Table (SQL):**
```sql
CREATE TABLE card_relationships (
    parent_card_uid UUID REFERENCES cards(uid),
    child_card_uid UUID REFERENCES cards(uid),
    relationship_type VARCHAR(50) DEFAULT 'dependency',
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (parent_card_uid, child_card_uid)
);
```

### 4.3 Concurrency, Idempotency & Integrity Rules

#### Optimistic Locking
1. Client reads card → receives `version: 4`
2. Client sends update with `version: 4` in payload
3. Orchestrator checks DB version:
   - If DB version == 4: apply update, increment to 5, return success
   - If DB version > 4: reject with `409 Conflict`, return current state

#### Idempotency Flow
```
Client Request
    ├── X-Idempotency-Key: "uuid-abc-123"
    └── If key exists in SQLite cache (24h TTL):
        ├── Return cached response (200/201)
        └── Do NOT mutate state
    └── If key is new:
        ├── Execute mutation
        ├── Cache response against key
        └── Return response
```

> **Engineering Note (Cache Sizing):** To prevent the SQLite `idempotency_cache` table from blooming, an application-layer `setInterval` cron job MUST run every hour to execute `DELETE FROM idempotency_cache WHERE expires_at < NOW()`.

---

## 5. The Engine: 5-Hook API Contract

### 5.1 Communication Patterns

#### Synchronous Hooks (Blocking, Strict 3s Timeout)
Used for immediate validation and data transformation.

**Retry Policy:**
| Condition | Behavior |
|:---|:---|
| `2xx` | Success — apply result |
| `4xx` | Fail fast — no retry, reject user action |
| `5xx` / `429` | Exponential backoff — max 1 retry within the 3s window |
| Network drop / Timeout | Fail fast immediately — **do not retry** to protect UI UX |

#### Asynchronous Hooks (ACK + Callback)
Used for state transitions and long-running operations.

**Security & Flow:**
1. Orchestrator POST to Processor
2. Processor immediately returns `202 Accepted` (Card → `PROCESSING`)
3. Processor does work
4. Processor POST to callback_url
   - **MUST** include `Authorization: Bearer {callback_token}`
   - **MUST** include an HMAC-SHA256 signature of the JSON payload (`X-Callback-Signature: sha256={hmac}`) to prevent transit tampering.
5. Orchestrator verifies HMAC (using the shared `hmac_secret` from `processor_registry`) and token. Uses **atomic hard-delete** of the token row on first valid use (prevents replay attacks).

### 5.2 Hook Specifications

#### `POST /on-enter` — Initialize (Async)
**Triggered:** When a card enters a Processing column.

**Request:**
```json
{
  "card": { /* full card context */ },
  "board": { /* board schema */ },
  "column": { /* current column config */ },
  "callback_url": "https://api.kanban.com/callbacks/v1/processor/{callback_token}",
  "idempotency_key": "orch-key-456"
}
```

**Processor Response (202):**
```json
{ "status": "accepted", "estimated_duration": "30s" }
```

**Callback Payload:**
```json
{
  "status": "success",
  "payload_updates": {
    "is_editable": false,
    "available_actions": ["Approve", "Reject"]
  },
  "move_to_column": null
}
```

#### `POST /on-update` — Gatekeeper & Transformer (Sync)
**Triggered:** When user attempts to edit card payload.

**Request:**
```json
{
  "card": { /* current card state */ },
  "proposed_payload": { /* user edits */ },
  "actor": "user:alice@corp.com"
}
```

**Success Response (200):**
```json
{
  "allowed": true,
  "transformed_payload": {
    "custom_data": "normalized-value",
    "available_actions": ["Complete"]
  }
}
```

**Rejection Response (200):**
```json
{
  "allowed": false,
  "message": "Priority must be one of: low, medium, high"
}
```

#### `POST /on-action` — Interaction (Async)
**Triggered:** When user clicks a custom action button.

**Request:**
```json
{
  "card": { /* full card context */ },
  "action": "Approve",
  "actor": "user:alice@corp.com",
  "callback_url": "https://api.kanban.com/callbacks/v1/processor/{callback_token}"
}
```

**Callback Payload (move card):**
```json
{
  "status": "success",
  "payload_updates": {
    "available_actions": []
  },
  "move_to_column": "col-approved"
}
```

#### `POST /can-exit` — Guard (Sync)
**Triggered:** When user or system attempts to move card out of column.

**Request:**
```json
{
  "card": { /* current card state */ },
  "target_column": "col-3",
  "actor": "user:alice@corp.com"
}
```

**Response:**
```json
{
  "allowed": true,
  "message": null
}
```

**Archive Block Example:**
```json
{
  "allowed": false,
  "message": "Cannot archive: 3 child cards are still active"
}
```

#### `POST /on-exit` — Side-Effect (Fire-and-Forget)
**Triggered:** After card has successfully exited the column.

**Request:**
```json
{
  "card": { /* final state in previous column */ },
  "next_column": "col-3",
  "actor": "system"
}
```

**Processor Response:** `200 OK` (Orchestrator does not wait or retry)

**Best Practices:**
- ✅ Use for: cleanup, metrics, non-critical notifications
- ❌ Do NOT use for: billing, compliance logging, mission-critical side effects
- The Orchestrator logs the invocation attempt but **does not track the outcome**. Processors MUST implement their own internal retries for critical side-effects triggered here.

---

## 6. Processor Registry & Discovery

### 6.1 Registry Schema
```json
{
  "processor_id": "manager-approval",
  "name": "Manager Approval Gate",
  "base_url": "https://approval.internal.company.com",
  "health_endpoint": "/health",
  "hooks": ["on-enter", "on-update", "on-action", "can-exit", "on-exit"],
  "sla_seconds": 300,
  "max_sla_seconds": 86400,
  "auth_type": "bearer",
  "auth_config": {
    "token_url": "https://auth.company.com/oauth/token"
  },
  "hmac_secret": "shared-secret-for-callback-signing",
  "last_health_check": "2026-04-26T08:25:00Z",
  "status": "healthy"
}
```

### 6.2 Health Check Flow
```
Every 30 seconds:
  Orchestrator → GET {base_url}/health
  ├── 200 OK → status: "healthy"
  └── 5xx/timeout → status: "unhealthy", trip circuit breaker

On card move to Processing column:
  If circuit breaker is open (unhealthy):
    ├── Reject move immediately
    └── Return 503: "Processor {id} is currently unavailable"
```

---

## 7. Real-Time Flow & UX Guardrails

### 7.1 SSE Protocol

**Endpoint:** `GET /api/boards/{board_uid}/stream`

**Headers:**
```
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Last-Event-ID: {optional_last_event_id}
```

**Event Format:**
```
id: evt-uuid-123
event: CARD_UPDATED
data: {"card_uid":"MKT-501","changes":{"processing_state":"PROCESSING"},"timestamp":"2026-04-26T08:30:00Z"}

```

**Event Types:**
| Event | Trigger | Client Action |
|:---|:---|:---|
| `CARD_CREATED` | New card added | Insert card into column |
| `CARD_UPDATED` | Payload/version changed | Update card render |
| `CARD_MOVED` | Column changed | Animate card to new column |
| `PROCESSING_STARTED` | Card entered Processing | Show spinner, lock interactions |
| `PROCESSING_COMPLETED` | Callback success | Hide spinner, enable interactions |
| `PROCESSING_ERROR` | SLA breach or callback failure | Show error banner, enable retry |
| `BOARD_RELOAD` | Major state change | Client should fetch snapshot |
| `ROLLUP_CHANGED` | Parent health score updated | Update progress bar |

### 7.2 State Hydration Protocol (Paginated)

**Initial Load:**
```
1. Client loads page
2. GET /api/boards/{id}/snapshot?columns=col-1,col-2&limit=100&cursor=xxx
   └── Returns paginated board state
3. Client renders board
4. Client opens SSE connection
5. Client applies deltas from SSE
```

**Reconnection:**
```
1. SSE disconnect detected
2. Exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s)
3. On reconnect: include Last-Event-ID header
4. If Last-Event-ID is too old (buffer expired):
   └── Orchestrator sends `event: BOARD_RELOAD`
   └── Client fetches snapshot again
```

### 7.3 UX Locking States

| `processing_state` | `is_editable` | UI Render |
|:---|:---|:---|
| `IDLE` | `true` | Normal — full interactions |
| `IDLE` | `false` | Read-only — view only, no edits |
| `PROCESSING` | `false` (forced) | Locked — spinner overlay, no interactions |
| `ERROR` | `false` (forced) | Error banner — "Processing failed" + retry button (admin) |

---

## 8. Cross-Board Intelligence & Traceability

### 8.1 Status Roll-up (Health View)

Parent cards display a real-time "Health View" computed from child metadata:

```
Health Score = (completed_children / total_children) × 100
Status =
  100% → "Complete"
  > 0% → "In Progress ({score}%)"
  0%   → "Not Started"
```

**Update Trigger:** When any child card moves columns, the Orchestrator:
1. Updates the child's state
2. Marks all parents as "dirty" in the in-memory debounce Map
3. Starts/extends a 500ms debounce timer per parent
4. When timer fires: recomputes health score once, broadcasts single `ROLLUP_CHANGED` SSE

> **Engineering Note (Event Storm Prevention):** If an automated processor bulk-updates 50 sub-tasks simultaneously, naive implementation would emit 50 `ROLLUP_CHANGED` events. The debounce buffer coalesces these into a single broadcast per parent after 500ms. Use a per-parent coalescing queue (Node.js `Map` + `setTimeout`) so multiple workers don't duplicate debounces. Document the debounce delay in API docs so clients know roll-ups are "eventually consistent" within ~500ms.

**Debounce Implementation Pattern (Single-Node):**
Because polling SQLite every 100ms creates a database bottleneck, debouncing is handled in-memory via Node.js.

```
On child card move:
  1. Identify all parent_uids of moved card
  2. For each parent_uid:
     a. If timer exists in Node.js Map, clear it
     b. Set new setTimeout for 500ms in Map
  3. On timer fire:
     a. Compute health score for parent_uid
     b. Broadcast single ROLLUP_CHANGED SSE
     c. Delete from Map
```
*(The SQLite `rollup_debounce_buffer` table is only written to during graceful shutdown for disaster recovery).*

### 8.2 Lineage Map (Breadcrumbs)

Every card UI includes:
- **Parents:** Clickable breadcrumb trail (up to 3 levels)
- **Children:** Expandable list with status indicators
- **Cross-board links:** Navigation to parent/child boards

### 8.3 Global Event Bus

All events are written to:
1. **Event Log table** (immutable, queryable)
2. **SSE stream** (real-time)
3. **Optional external sink** (webhook, Kafka, etc.)

---

## 9. Security & Governance (RBAC)

### 9.1 Access Control Layers

| Layer | Mechanism | Scope |
|:---|:---|:---|
| **Board Visibility** | Role-based | User can only see boards they have `read` permission on |
| **Column Actions** | Processor-enforced | `can-exit` hook validates business rules |
| **Card Editing** | Dual-layer | `is_editable` (UX) + `on-update` (integrity) |
| **Cross-Board Moves** | System Admin | Only Orchestrator can move cards between boards |
| **Automation Override** | Admin only | Force-exit from Processing columns requires `admin` role |

### 9.2 Service Authentication

**Orchestrator → Processor:**
- OAuth 2.0 Client Credentials flow
- Short-lived access tokens (5 min TTL)
- mTLS for internal network deployments

**Processor → Orchestrator (Callback):**
- Stateless `callback_token` (UUID) stored in SQLite `callback_tokens`.
- Payload must be **HMAC-SHA256 signed** using the shared `hmac_secret` stored in `processor_registry`.
- **Atomic Hard-Delete:** Token row is deleted immediately upon validation to prevent replay attacks. Audit trail is preserved in the immutable Event Log, not in the token table.

### 9.3 Immutable Automation

- Users **cannot** manually drag cards out of Processing columns
- The only valid exit paths are:
  1. Processor callback commands `move_to_column`
  2. Admin force-override (logged as `ACTION: ADMIN_OVERRIDE`)
- All automated actions are logged with `actor: "processor:{id}"`

---

## 10. Failure Domains & Recovery

### 10.1 Failure Matrix

| Scenario | Detection | Response | Recovery |
|:---|:---|:---|:---|
| **Request flood** | Rate limiter triggers | `429 Too Many Requests` | Client backs off |
| Processor down | Health check fails | Trip circuit breaker, reject move | Auto-retry health check |
| Sync hook timeout | 3s elapsed | Fail fast, reject action | User retries manually |
| Async callback late | SLA timer expires | Card → ERROR, DLQ log | Admin retry or force-override |
| Callback tampered | HMAC validation fails | Log security event, discard | Security alert |
| DB version conflict | `version` mismatch | `409 Conflict` | Client refreshes and retries |
| Duplicate idempotency key | Cache hit | Return cached response | Automatic (no action needed) |
| SSE client disconnect | TCP close | Buffer events (5 min) | Client reconnects with Last-Event-ID |
| Roll-up event storm | Multiple child moves | Debounce 500ms per parent | Single coalesced broadcast |

### 10.2 Dead Letter Queue (DLQ) & Admin Override

When an async hook SLA expires, it enters the `dlq` table.

```json
{
  "dlq_id": "dlq-uuid",
  "card_uid": "MKT-501",
  "processor_id": "auto-qa-tester",
  "hook": "on-enter",
  "idempotency_key": "orch-key-456",
  "submitted_at": "2026-04-26T08:00:00Z",
  "deadline_at": "2026-04-26T08:05:00Z",
  "reason": "SLA_BREACH",
  "retry_count": 0,
  "status": "pending_admin"
}
```

**Admin Actions:**
- `Retry`: Re-dispatch to Processor with same context
- `Force Complete`: Manually set state to `IDLE`. **CRITICAL:** This action strictly *bypasses* the `on-exit` hook to prevent double-firing side effects. Logged as `ADMIN_OVERRIDE`.
- `Cancel`: Move card to error column, notify creator

---

## 11. Technical Implementation Roadmap

### Phase 1: Foundation
- SQLite schema generation (Drizzle ORM) with WAL mode pragmas.
- Card CRUD API with `version` optimistic locking.
- Node.js hourly cron for Idempotency Cache cleanup.

### Phase 2: The Engine
- 5-Hook dispatcher (sync fail-fast + async routing).
- Callback verifier with HMAC and atomic token deletion.
- DLQ monitor with SLA enforcement and `Force Complete` bypass logic.

### Phase 3: Linkage & Intelligence
- Many-to-Many relationship table.
- App-layer cycle detection.
- In-memory Node.js debounce map for parent roll-ups.

### Phase 4: Advanced Processors
- CI/CD and Approval Processors.
- Script-based exit logic.

### Phase 5: Observability & Resilience
- Implement Token Bucket Rate Limiter.
- Setup structured JSON logging (Pino/Winston) focusing on `on-exit` fires and `ADMIN_OVERRIDE` actions.
- Load testing SSE endpoints.

---

## 12. Appendix

### A. Glossary
| Term | Definition |
|:---|:---|
| **Processor** | Independent microservice implementing business logic via 5 hooks |
| **Orchestrator** | Central state machine managing cards, concurrency, and dispatch |
| **Hook** | Defined endpoint in the Processor contract (on-enter, on-update, etc.) |
| **SLA** | Service Level Agreement — max time for Processor callback |
| **DLQ** | Dead Letter Queue — holds failed async operations for admin review |
| **SSE** | Server-Sent Events — push protocol for real-time UI updates |
| **Fractal Model** | Any card can be parent or child; no fixed hierarchy |
| **Block Policy** | Restriction preventing parent archive with active children |
| **Debounced Roll-up** | Coalesced health score broadcast after 500ms buffer |

### B. Decision Log
| Decision | Rationale |
|:---|:---|
| SQLite over PostgreSQL | Maximizes MVP speed/simplicity; Drizzle makes future migration easy |
| In-Memory Map Debouncing | Prevents SQLite polling bottleneck; DB only used for shutdown backup |
| Fail-Fast Sync Hooks | Network drops within a 3s window cannot be safely retried without UX degradation |
| DLQ Force Complete Bypass | Forcing a card forward should not trigger `on-exit` side effects blindly |
| HMAC Callback Signing | UUID tokens in URLs are insufficient to prevent payload tampering |
| Atomic Hard-Delete Tokens | Prevents replay attacks more strictly than soft-delete; audit lives in Event Log |
| Materialized `is_editable` | Stored boolean allows Processor override while still defaulting to IDLE logic |

### C. Related Documents
- OpenAPI 3.0 Specification (`openapi-spec.yaml`)
- Database Schema (`db-schema-rev4-patched.md`)
- State Machine Diagram (`state-machine.mmd`)
- Sequence Diagram (`sequence-diagram.mmd`)

---

*End of Document*
