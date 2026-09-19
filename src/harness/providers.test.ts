import { describe, it, expect } from "vitest";
import { ProviderRegistry, type ProviderSpec } from "./providers.js";

const SPECS: ProviderSpec[] = [
  { alias: "venice", baseURL: "https://api.venice.ai/api/v1", apiKeyEnv: "VENICE_TEST_KEY", model: "zai-org-glm-5-2" },
  { alias: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_TEST_KEY", model: "deepseek/deepseek-chat-v3-0324" },
];

const ENV = { VENICE_TEST_KEY: "v-key", OPENROUTER_TEST_KEY: "o-key" } as NodeJS.ProcessEnv;

describe("ProviderRegistry.fromEnv", () => {
  it("returns an empty registry when FORGE_PROVIDERS is unset", () => {
    const reg = ProviderRegistry.fromEnv({ ...ENV });
    expect(reg.hasAny()).toBe(false);
    expect(reg.names()).toEqual([]);
  });

  it("returns an empty registry when FORGE_PROVIDERS is whitespace", () => {
    const reg = ProviderRegistry.fromEnv({ ...ENV, FORGE_PROVIDERS: "  ,  ,  " });
    expect(reg.hasAny()).toBe(false);
  });

  it("parses a single provider entry and resolves by alias", () => {
    const reg = ProviderRegistry.fromEnv({
      ...ENV,
      FORGE_PROVIDERS: "venice|https://api.venice.ai/api/v1|VENICE_TEST_KEY|zai-org-glm-5-2",
    });
    expect(reg.names()).toEqual(["venice"]);
    const p = reg.get("venice");
    expect(p.model).toBe("zai-org-glm-5-2");
  });

  it("parses multiple entries in declaration order", () => {
    const reg = ProviderRegistry.fromEnv({
      ...ENV,
      FORGE_PROVIDERS:
        "venice|https://api.venice.ai/api/v1|VENICE_TEST_KEY|zai-org-glm-5-2," +
        "openrouter|https://openrouter.ai/api/v1|OPENROUTER_TEST_KEY|deepseek/deepseek-chat-v3-0324",
    });
    expect(reg.names()).toEqual(["venice", "openrouter"]);
    expect(reg.get("venice").model).toBe("zai-org-glm-5-2");
    expect(reg.get("openrouter").model).toBe("deepseek/deepseek-chat-v3-0324");
  });

  it("throws on malformed entry (wrong field count)", () => {
    expect(() =>
      ProviderRegistry.fromEnv({
        ...ENV,
        FORGE_PROVIDERS: "venice|only-two-fields",
      }),
    ).toThrow(/expected 4 pipe-separated/);
  });

  it("throws on empty field", () => {
    expect(() =>
      ProviderRegistry.fromEnv({
        ...ENV,
        FORGE_PROVIDERS: "|https://x.com/api/v1|VENICE_TEST_KEY|model",
      }),
    ).toThrow(/empty field/);
  });

  it("throws when the referenced apiKeyEnv is not present", () => {
    expect(() =>
      ProviderRegistry.fromEnv({
        FORGE_PROVIDERS: "venice|https://x.com/api/v1|MISSING_VAR|model",
      }),
    ).toThrow(/MISSING_VAR.*not present/);
  });
});

describe("ProviderRegistry.defaultProvider", () => {
  it("returns FORGE_PROVIDER_DEFAULT when set and known", () => {
    const reg = ProviderRegistry.fromEnv({
      ...ENV,
      FORGE_PROVIDERS:
        "venice|https://api.venice.ai/api/v1|VENICE_TEST_KEY|zai-org-glm-5-2," +
        "openrouter|https://openrouter.ai/api/v1|OPENROUTER_TEST_KEY|deepseek/deepseek-chat-v3-0324",
      FORGE_PROVIDER_DEFAULT: "openrouter",
    });
    expect(reg.defaultProvider().model).toBe("deepseek/deepseek-chat-v3-0324");
  });

  it("falls back to the first registered when FORGE_PROVIDER_DEFAULT is unset", () => {
    const reg = ProviderRegistry.fromEnv({
      ...ENV,
      FORGE_PROVIDERS:
        "venice|https://api.venice.ai/api/v1|VENICE_TEST_KEY|zai-org-glm-5-2," +
        "openrouter|https://openrouter.ai/api/v1|OPENROUTER_TEST_KEY|deepseek/deepseek-chat-v3-0324",
    });
    expect(reg.defaultProvider().model).toBe("zai-org-glm-5-2");
  });

  it("ignores FORGE_PROVIDER_DEFAULT when it points at an unknown alias", () => {
    const reg = ProviderRegistry.fromEnv({
      ...ENV,
      FORGE_PROVIDERS: "venice|https://api.venice.ai/api/v1|VENICE_TEST_KEY|zai-org-glm-5-2",
      FORGE_PROVIDER_DEFAULT: "no-such-alias",
    });
    // Falls through to first registered (venice), not throwing on the bad default.
    expect(reg.defaultProvider().model).toBe("zai-org-glm-5-2");
  });

  it("falls back to the legacy single-env path when no providers are registered", () => {
    const reg = ProviderRegistry.fromEnv({
      FORGE_API_KEY: "legacy-key",
      FORGE_BASE_URL: "https://legacy.example.com/api/v1",
      FORGE_MODEL: "legacy-model",
    });
    expect(reg.hasAny()).toBe(false);
    const p = reg.defaultProvider();
    expect(p.model).toBe("legacy-model");
  });
});

describe("ProviderRegistry.get", () => {
  it("throws with a helpful message when alias is unknown", () => {
    const reg = new ProviderRegistry([]);
    expect(() => reg.get("nope")).toThrow(/unknown provider alias "nope"/);
  });

  it("throws even when the alias is empty", () => {
    const reg = new ProviderRegistry([]);
    expect(() => reg.get("")).toThrow();
  });
});

describe("ProviderRegistry constructor", () => {
  it("throws eagerly when an api key env is missing", () => {
    expect(() => new ProviderRegistry(SPECS)).toThrow(/VENICE_TEST_KEY.*not set/);
  });

  it("accepts specs when all env vars are present", () => {
    const orig = process.env.VENICE_TEST_KEY;
    process.env.VENICE_TEST_KEY = "v";
    process.env.OPENROUTER_TEST_KEY = "o";
    try {
      const reg = new ProviderRegistry(SPECS);
      expect(reg.names()).toEqual(["venice", "openrouter"]);
    } finally {
      if (orig === undefined) delete process.env.VENICE_TEST_KEY;
      else process.env.VENICE_TEST_KEY = orig;
      delete process.env.OPENROUTER_TEST_KEY;
    }
  });
});
