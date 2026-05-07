import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

// In-memory cache to avoid disk I/O on every call
let cachedApiKey: string | null = null;
let cachedExpiresAt = 0;

interface AuthJson {
  [provider: string]: {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    [key: string]: unknown;
  };
}

function loadAuthJson(): AuthJson {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `GitHub Copilot auth file not found at ${AUTH_PATH}. Please run \`pi login github-copilot\` or set COPILOT_GITHUB_TOKEN environment variable.`
    );
  }
  try {
    const raw = readFileSync(AUTH_PATH, "utf-8");
    return JSON.parse(raw) as AuthJson;
  } catch (err) {
    throw new Error(
      `Failed to read GitHub Copilot auth file at ${AUTH_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function saveAuthJson(data: AuthJson): void {
  try {
    writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(
      `[ai-auth] Warning: failed to write refreshed auth to ${AUTH_PATH}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Get an API key for a given provider.
 * For github-copilot, uses the OAuth flow via getCopilotApiKey().
 * For all other providers, reads directly from environment variables
 * without touching any configuration files.
 */
export async function getApiKey(provider: string): Promise<string> {
  if (provider === "github-copilot") {
    return getCopilotApiKey();
  }

  const envVar = PROVIDER_ENV_MAP[provider];
  if (!envVar) {
    throw new Error(
      `No environment variable mapping for provider "${provider}". Please set the appropriate API key environment variable.`
    );
  }

  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider}". Please set the ${envVar} environment variable.`
    );
  }

  return apiKey;
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  "opencode-go": "OPENCODE_API_KEY",
  "opencode": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "openai": "OPENAI_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "google": "GEMINI_API_KEY",
  "deepseek": "DEEPSEEK_API_KEY",
  "groq": "GROQ_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "xai": "XAI_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
};

/**
 * Get a valid GitHub Copilot API key, refreshing the OAuth token if needed.
 * Uses in-memory caching to avoid repeated disk I/O.
 */
export async function getCopilotApiKey(): Promise<string> {
  // Return cached key if it has more than 5 minutes of life left
  if (cachedApiKey && cachedExpiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedApiKey;
  }

  const authData = loadAuthJson();
  const credentials = authData["github-copilot"];

  if (!credentials) {
    throw new Error(
      `No GitHub Copilot credentials found in ${AUTH_PATH}. Please run \`pi login github-copilot\` or set COPILOT_GITHUB_TOKEN environment variable.`
    );
  }

  const result = await getOAuthApiKey("github-copilot", authData);

  if (!result) {
    throw new Error(
      `Failed to retrieve GitHub Copilot API key. Please run \`pi login github-copilot\` or set COPILOT_GITHUB_TOKEN environment variable.`
    );
  }

  // If credentials were refreshed, persist them back to disk
  if (result.newCredentials !== credentials) {
    authData["github-copilot"] = result.newCredentials as AuthJson["github-copilot"];
    saveAuthJson(authData);
  }

  cachedApiKey = result.apiKey;
  cachedExpiresAt = result.newCredentials.expires;
  return result.apiKey;
}
