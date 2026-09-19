import { z } from "zod";
import type { LLMToolSpec } from "./llm.js";

export interface ToolContext {
  /** Absolute working directory the agent is scoped to. */
  workDir: string;
  /** Extra session-scoped values tools may need (deploy config, etc.). */
  session: Record<string, unknown>;
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  /** Zod schema — validated BEFORE execution. Structured output, never prose-parsing. */
  schema: z.ZodType<A>;
  /** JSON Schema emitted to the LLM (derived from the zod schema). */
  parameters: Record<string, unknown>;
  execute(args: A, ctx: ToolContext): Promise<string>;
}

/**
 * Global tool registry. Registration declares the contract; the policy
 * guard decides risk separately (safe vs dangerous lives in policy.ts).
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register<A>(tool: Tool<A>): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): LLMToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    if ("__malformed" in rawArgs) {
      throw new Error(`malformed tool arguments from model: ${String(rawArgs.__malformed).slice(0, 200)}`);
    }
    const args = tool.schema.parse(rawArgs); // throws ZodError on contract violation
    return tool.execute(args, ctx);
  }
}

/** Helper: declare a tool from a zod schema with minimal boilerplate. */
export function defineTool<A>(
  def: Omit<Tool<A>, "parameters"> & { parameters: Record<string, unknown> },
): Tool<A> {
  return def;
}
