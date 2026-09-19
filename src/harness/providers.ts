import { OpenAICompatibleProvider, providerFromEnv } from "./llm.js";

/**
 * One configured provider: human-readable alias, base URL, the *name* of the
 * env var that holds the API key (not the key itself — keys are radioactive),
 * and the model slug to use on that host. Format: `alias|baseURL|apiKeyEnv|model`.
 *
 * `|` is the delimiter because URLs contain `:` (e.g., `https://…`) and model
 * slugs on OpenRouter sometimes contain `:` too.
 */
export interface ProviderSpec {
  alias: string;
  baseURL: string;
  apiKeyEnv: string;
  model: string;
}

/**
 * A registry of OpenAI-compatible providers configured via env. Lets a single
 * Forge install talk to multiple backends (Venice today, OpenRouter tomorrow,
 * a local Ollama next week) and pick at runtime — no restart, no code change.
 *
 * Bootstrap path:
 *   FORGE_PROVIDERS="venice|https://api.venice.ai/api/v1|VENICE_API_KEY|zai-org-glm-5-2,\
 *                     openrouter|https://openrouter.ai/api/v1|OPENROUTER_API_KEY|deepseek/deepseek-chat-v3-0324"
 *   FORGE_PROVIDER_DEFAULT=venice   # optional; first listed wins if unset
 *
 * Falls back to the legacy single-env path (FORGE_BASE_URL / FORGE_API_KEY /
 * FORGE_MODEL) when FORGE_PROVIDERS is not set, so existing setups keep working.
 */
export class ProviderRegistry {
  private byAlias = new Map<string, OpenAICompatibleProvider>();
  private env: NodeJS.ProcessEnv;

  constructor(specs: ProviderSpec[] = [], env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    for (const spec of specs) {
      const apiKey = env[spec.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `FORGE_PROVIDERS references "${spec.alias}" but ${spec.apiKeyEnv} is not set in the environment`,
        );
      }
      this.byAlias.set(
        spec.alias,
        new OpenAICompatibleProvider({ baseURL: spec.baseURL, apiKey, model: spec.model }),
      );
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
    const raw = env.FORGE_PROVIDERS;
    if (!raw || !raw.trim()) return new ProviderRegistry([], env);
    const specs: ProviderSpec[] = [];
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      specs.push(parseSpec(trimmed, env));
    }
    return new ProviderRegistry(specs, env);
  }

  /** Resolve by alias. Throws if unknown — callers should check `names()` first. */
  get(alias: string): OpenAICompatibleProvider {
    const p = this.byAlias.get(alias);
    if (!p) throw new Error(`unknown provider alias "${alias}". Known: ${this.names().join(", ") || "(none)"}`);
    return p;
  }

  /** Aliases in declaration order — first-listed is the default if FORGE_PROVIDER_DEFAULT is unset. */
  names(): string[] {
    return [...this.byAlias.keys()];
  }

  /** True if at least one provider is registered. */
  hasAny(): boolean {
    return this.byAlias.size > 0;
  }

  /**
   * Resolve the default provider. Order:
   *   1. FORGE_PROVIDER_DEFAULT (if set and known)
   *   2. First provider in FORGE_PROVIDERS
   *   3. Legacy single-env path (FORGE_API_KEY + FORGE_BASE_URL + FORGE_MODEL)
   *
   * Throws if none of the above yields a provider — fail loud, never silently
   * fall back to a provider the user didn't configure.
   */
  defaultProvider(env: NodeJS.ProcessEnv = this.env): OpenAICompatibleProvider {
    const explicit = env.FORGE_PROVIDER_DEFAULT;
    if (explicit && this.byAlias.has(explicit)) return this.byAlias.get(explicit)!;
    if (this.byAlias.size > 0) return this.byAlias.values().next().value!;
    return providerFromEnv(env);
  }
}

function parseSpec(raw: string, env: NodeJS.ProcessEnv): ProviderSpec {
  const parts = raw.split("|");
  if (parts.length !== 4) {
    throw new Error(
      `Bad FORGE_PROVIDERS entry "${raw}" — expected 4 pipe-separated fields: alias|baseURL|apiKeyEnv|model`,
    );
  }
  const [alias, baseURL, apiKeyEnv, model] = parts.map((s) => s.trim());
  if (!alias || !baseURL || !apiKeyEnv || !model) {
    throw new Error(`Bad FORGE_PROVIDERS entry "${raw}" — empty field`);
  }
  if (!(apiKeyEnv in env)) {
    // We deliberately don't surface the value, only the var name.
    throw new Error(
      `FORGE_PROVIDERS entry "${alias}" references apiKeyEnv "${apiKeyEnv}" which is not present in the environment`,
    );
  }
  return { alias, baseURL, apiKeyEnv, model };
}
