set fallback := true

alias i := install

_default:
    just --list

install:
    pnpm install
    @if [ ! -f .env ]; then \
        echo "Creating .env from .env.example..."; \
        cp .env.example .env; \
    fi
    @echo "Install complete!"

dev:
    @echo "Starting API (Bun hot reload) and Web (Nuxt dev)..."
    pnpm --filter api dev & pnpm --filter web dev & wait

dev-ai:
    @echo "Starting AI Workflow (Mastra dev) and The Architect..."
    pnpm --filter ai-workflow dev & pnpm --filter the-architect dev & wait

build:
    pnpm install --frozen-lockfile
    pnpm --filter @repo/shared build
    pnpm --filter @repo/logger build
    pnpm --filter api build
    pnpm --filter web build
    #pnpm --filter ai-workflow build

test-unit:
    pnpm vitest run

test-ai-workflow:
    pnpm --filter ai-workflow test

test-e2e:
    pnpm --filter e2e test

test-e2e-ci:
    pnpm --filter e2e test:ci

build-tools:
    @echo "Building all CLI tools..."
    @for tool in tools/*/; do \
        tool_name=`basename "$tool"`; \
        echo "  Building $tool_name..."; \
        cd "$tool" && pnpm run build:binary && cd - > /dev/null || exit 1; \
    done
    @echo "All CLI tools built successfully!"

azure-deploy:
    @echo "=== Pre-deployment validation ==="
    pnpm lint
    pnpm typecheck
    just test-unit
    just build
    @echo "=== Ready for Azure deployment ==="
