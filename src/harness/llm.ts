import OpenAI from "openai";
import type { Message, ToolCall } from "../schemas/events.js";

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported cost in USD when available (OpenRouter includes this). */
  costUsd: number | null;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  /** True when the model signaled it is finished (no tool calls, final text). */
  finishReason: string;
  /** Token usage reported by the provider, when present. */
  usage: LLMUsage | null;
}

export interface LLMProvider {
  complete(messages: Message[], tools: LLMToolSpec[]): Promise<LLMResponse>;
  summarize(messages: Message[]): Promise<string>;
  readonly model: string;
}

export interface ProviderConfig {
  /** OpenAI-compatible base URL — works for OpenRouter, Together, Ollama, vLLM, etc. */
  baseURL?: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

/**
 * OpenAI-compatible provider. One interface, any backend — model choice is
 * config, not code. Default policy: point baseURL at an open-weight host
 * (OpenRouter/Together/Ollama) and pick an open-weight model slug.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  public readonly model: string;
  private temperature: number;

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.temperature = cfg.temperature ?? 0.2;
  }

  async complete(messages: Message[], tools: LLMToolSpec[]): Promise<LLMResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      })) as OpenAI.ChatCompletionMessageParam[],
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });

    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeParseArgs(tc.function.arguments),
    }));
    return {
      content: choice.message.content ?? "",
      toolCalls,
      finishReason: choice.finish_reason,
      usage: extractUsage(res.usage),
    };
  }

  async summarize(messages: Message[]): Promise<string> {
    // Serialize as a plain-text transcript in a single user message — avoids
    // provider-specific shape rules (tool messages need tool_call_id, etc.)
    // that strict backends like Venice reject with 400.
    const transcript = serializeTranscript(messages);
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Summarize this agent conversation into a compact state brief: goal, decisions made, files touched, pending work, and any errors encountered. Preserve exact paths, commands, and identifiers. Max 400 words.",
        },
        { role: "user", content: transcript },
      ],
    });
    // Compaction usage is intentionally not returned — it's overhead, not
    // part of the agent conversation's token accounting.
    return res.choices[0].message.content ?? "";
  }
}

/** Normalize OpenAI-compatible usage into our shape (cost only when reported). */
function extractUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined): LLMUsage | null {
  if (!u) return null;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.total_tokens ?? promptTokens + completionTokens,
    // OpenRouter returns `cost` in USD on non-standard usage; others omit it.
    costUsd: typeof (u as { cost?: unknown }).cost === "number" ? (u as { cost: number }).cost : null,
  };
}

/**
 * Render an agent conversation as a single plain-text transcript. Exported
 * so the message-shape fix (Venice 400 rejection of multi-role inputs) can
 * be unit-tested without HTTP mocks. Capped at 60k chars to defend the
 * summarization prompt window.
 */
export function serializeTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      const who = m.role === "tool" ? `tool(${m.toolCallId ?? "result"})` : m.role;
      const calls = m.toolCalls?.length
        ? ` [called: ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 120)})`).join(", ")}]`
        : "";
      return `[${who}]${calls} ${m.content}`;
    })
    .join("\n\n")
    .slice(0, 60_000);
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    // Refusals/malformed JSON are programmatic, never regex-parsed prose.
    return { __malformed: raw };
  }
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleProvider {
  const apiKey = env.FORGE_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Set FORGE_API_KEY (or OPENAI_API_KEY) — points at any OpenAI-compatible backend.");
  return new OpenAICompatibleProvider({
    baseURL: env.FORGE_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey,
    model: env.FORGE_MODEL ?? "deepseek/deepseek-chat-v3-0324",
    temperature: env.FORGE_TEMPERATURE ? Number(env.FORGE_TEMPERATURE) : undefined,
  });
}
