# Genisys

Enterprise-grade `pnpm` monorepo optimized for **Azure App Service Linux Code Deployment** (Oryx build system). Uses **Node.js 22 LTS** in production, with optional **Bun 1.2+** for local API hot-reload only.

[TODO:] Here is additional information ...

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Package Manager | **pnpm 10.6+** with workspace `catalog:` versions |
| Local Dev Runtime | **Bun 1.2+** (API hot reload only) |
| Production Runtime | **Node.js 22 LTS** |
| API Framework | **Fastify 5.x** + `@fastify/websocket` |
| Web Framework | **Nuxt 4 Stable** (Nitro `node-server` preset) |
| Language | **TypeScript 5.7** (`module: NodeNext`) |
| Validation | **Zod 3.24+** with `fastify-type-provider-zod` |
| Logging | **Pino 9.x** (JSON stdout, Azure Monitor-friendly) |
| Testing | **Vitest 2.x** (unit) + **Playwright 1.49+** (e2e) |
| Linting | **ESLint 9** flat config + `typescript-eslint` |
| Task Runner | **just** |

---

## Monorepo Layout

```
src/
├── libs/
│   ├── shared/          # Zod schemas, tsup-built, dual ESM/CJS
│   └── logger/          # Pino with Azure JSON formatting
├── apps/
│   ├── api/             # Fastify 5.x (Azure Linux App Service)
│   └── web/             # Nuxt 4 (Nitro preset: node-server)
├── e2e/                 # Playwright tests
└── tooling/             # Shared ESLint 9 + TypeScript configs
```

---

## Quick Start

### Prerequisites
- **Node.js** `>=22.0.0 <23.0.0`
- **pnpm** `10.6+`
- **Bun** `1.2+` (local dev only)
- **just** (`cargo install just` or see [just.systems](https://just.systems))

### Install
```bash
pnpm install
```

### Develop
Start the API (Bun hot reload) and the Web app (Nuxt dev) concurrently:
```bash
just dev
```
- API: http://localhost:8080
- Web: http://localhost:3000
- Web devProxy forwards `/api/**` and `/ws/**` to `localhost:8080`

---

## Build

Topological build order is enforced by `just build`:
```bash
just build
```
Order: `shared` → `logger` → `api` → `web`

Outputs:
- API: `src/apps/api/dist/index.js` (ESM, Node 22 target)
- Web: `src/apps/web/.output/` (Nitro `node-server` output)

> **Azure Note:** Oryx runs `pnpm install && pnpm build`, then uses the `start` script (`node src/apps/api/dist/index.js`).

---

## Test

### Unit Tests (Vitest workspace)
```bash
just test
```
Runs all tests in `src/apps/*/vitest.config.ts` and `src/libs/*/vitest.config.ts`.

### E2E Tests (Playwright)
```bash
# Auto-starts API + Web, then runs tests
just test-e2e

# Headless CI mode
just test-e2e-ci
```

---

## Lint & Type Check

```bash
pnpm lint
pnpm typecheck
```

---

## Azure Deployment

### Pre-deployment Validation
```bash
just azure-deploy
```
Runs `lint` → `typecheck` → `test` → `build`.

### Required App Settings
Copy `.env.example` to `.env` and set your values in Azure App Service **Configuration**:

```env
# Azure App Service Linux
PORT=8080
WEBSITE_WEBSOCKET_ENABLED=true
SCM_DO_BUILD_DURING_DEPLOYMENT=true
WEBSITE_NODE_DEFAULT_VERSION=22.x

# App Config
NODE_ENV=production
API_BASE_URL=https://your-app.azurewebsites.net
NUXT_PUBLIC_API_BASE_URL=https://your-app.azurewebsites.net
NUXT_PUBLIC_WS_URL=wss://your-app.azurewebsites.net
CORS_ORIGIN=https://your-app.azurewebsites.net
API_SECRET=change-me-in-production
```

> **Critical:** `WEBSITE_WEBSOCKET_ENABLED=true` is required for the `/ws` route to function on Azure App Service Linux.

---

## API Details (`src/apps/api/`)

### Health Checks
- `GET /health` → `{ status: "ok", timestamp: ISO8601 }`
- `GET /health/ready` → extended stub (DB/cache placeholder)
- `GET /health/live` → process liveness check

### WebSocket Stub
- `GET /ws` — echoes messages back to the client.
- Requires `WEBSITE_WEBSOCKET_ENABLED=true` in Azure.

### Graceful Shutdown
`SIGTERM` is handled to close Fastify within Azure's ~5s grace window:
```typescript
process.on('SIGTERM', async () => {
  await fastify.close();
  process.exit(0);
});
```

### Security
- `@fastify/helmet` defaults
- `@fastify/cors` with `CORS_ORIGIN` whitelist
- `@fastify/rate-limit` (100 req/min)

---

## Design Constraints

- **NO** database connection logic in health checks (stub only)
- **NO** authentication middleware (all routes public)
- **NO** Application Insights package
- **NO** Bun-specific APIs in production code paths (`Bun.file`, etc.)
- **YES** WebSocket infrastructure ready (routes, deps, env vars documented)

---

## License

See [LICENSE](./LICENSE).
