set fallback := true

alias i := install

_default:
    just --list

install:
    @if [ -n "${CI:-}" ]; then \
        echo "Installing dependencies (frozen lockfile)..."; \
        pnpm install --frozen-lockfile; \
    else \
        pnpm install; \
    fi
    @if [ ! -f .env ]; then \
        echo "Creating .env from .env.example..."; \
        cp .env.example .env; \
    fi
    @echo "Install complete!"

lint:
    pnpm lint

typecheck:
    pnpm typecheck

stage:
    git add -A
    @echo "Staged all changes"

dev:
    @echo "Starting API (Bun hot reload) and Web (Nuxt dev)..."
    pnpm --filter @repo/agent-rooms-core build & pnpm --filter @repo/room-supervisor dev & pnpm --filter api dev & pnpm --filter web dev & wait

dev-ai:
    @echo "Starting API, Web, and AI Workflow..."
    pnpm --filter api dev & pnpm --filter web dev & pnpm --filter ai-workflow dev & wait

build:
    pnpm install --frozen-lockfile
    pnpm --filter @repo/shared build
    pnpm --filter @repo/logger build
    pnpm --filter @repo/agent-rooms-core build
    pnpm --filter @repo/room-supervisor build
    pnpm --filter api build
    pnpm --filter web build
    #pnpm --filter ai-workflow build

clean:
    pnpm clean

test:
    pnpm vitest run

alias test-unit := test

test-ai-workflow:
    pnpm --filter ai-workflow test

test-e2e:
    pnpm --filter e2e test

test-e2e-ci:
    pnpm --filter e2e test:ci

bootup:
    just install
    @echo "Building workspace packages (libs and tooling)..."
    pnpm --filter @repo/shared build
    pnpm --filter @repo/logger build
    @echo "Bootup complete!"

build-tools:
    @echo "Building all CLI tools..."
    @mkdir -p .bin
    @for tool in tools/*/; do \
        tool_name=`basename "$tool"`; \
        echo "  Building $tool_name..."; \
        cd "$tool" && pnpm run build:binary && cd - > /dev/null || exit 1; \
        mv "tools/${tool_name}/${tool_name}" .bin/; \
        echo "  Moved $tool_name to .bin/"; \
    done
    @echo "All CLI tools built successfully!"

azure-deploy:
    @echo "=== Pre-deployment validation ==="
    just lint
    just typecheck
    just test
    just build
    @echo "=== Ready for Azure deployment ==="
