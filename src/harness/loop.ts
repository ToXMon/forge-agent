import { randomUUID } from "node:crypto";
import type { AgentState, HarnessEvent, ToolCall } from "../schemas/events.js";
import { Checkpointer } from "./checkpoint.js";
import { ContextHydrator } from "./context.js";
import { PolicyGuard } from "./policy.js";
import { HarnessBus } from "./bus.js";
import { ToolRegistry, type ToolContext } from "./tools.js";
import type { LLMProvider } from "./llm.js";

export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  /** Docs injected into context every step (AGENTS.md, playbooks, etc.). */
  contextDocs?: string[];
}

export interface LoopOptions {
  maxSteps?: number;
  /** When true, dangerous tools execute without human approval (YOLO). */
  autoApprove?: boolean;
}

const TOOL_TIMEOUT_MS = 120_000;

/**
 * The durable agent loop — the harness spine.
 *
 *   load state → hydrate context → LLM next step → policy check →
 *   append event → execute → checkpoint → repeat
 *
 * Every transition is an event in an append-only log, so a crashed session
 * resumes from the last checkpoint with full fidelity. Dangerous tool calls
 * suspend the loop and resume on human approval via the bus.
 */
export class AgentLoop {
  private store: Checkpointer;
  private hydrator: ContextHydrator;

  constructor(
    private deps: {
      llm: LLMProvider;
      tools: ToolRegistry;
      policy: PolicyGuard;
      bus: HarnessBus;
      workDir: string;
      sessionId?: string;
    },
  ) {
    const sessionId = deps.sessionId ?? randomUUID();
    this.store = new Checkpointer(deps.workDir, sessionId);
    this.hydrator = new ContextHydrator(deps.llm, this.store);
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  private emit(event: HarnessEvent): void {
    this.store.append(event);
    this.deps.bus.publish(this.sessionId, event);
  }

  private loadOrInitState(): AgentState {
    const existing = this.store.loadState();
    if (existing) return existing;
    const now = new Date().toISOString();
    const state: AgentState = {
      sessionId: this.sessionId,
      status: "running",
      summary: "",
      compactedUpTo: 0,
      pendingApproval: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveState(state);
    return state;
  }

  private saveState(state: AgentState): void {
    this.store.saveState({ ...state, updatedAt: new Date().toISOString() });
  }

  /**
   * Run the agent on a user message until it finishes (no more tool calls),
   * hits maxSteps, fails, or suspends awaiting approval.
   */
  async run(agent: AgentDefinition, userMessage: string, opts: LoopOptions = {}): Promise<AgentState> {
    const maxSteps = opts.maxSteps ?? 40;
    let state = this.loadOrInitState();

    // Resume a suspended session: if a tool call was pending approval, decide it first.
    if (state.status === "awaiting_approval" && state.pendingApproval) {
      state = await this.resumeApproval(state, opts);
      if (state.status !== "running") return state;
    }

    this.emit({ type: "user_message", message: { role: "user", content: userMessage } });
    state = { ...state, status: "running" };
    this.saveState(state);

    const ctx: ToolContext = { workDir: this.deps.workDir, session: {} };

    for (let step = 0; step < maxSteps; step++) {
      state = await this.hydrator.maybeCompact(state);
      const messages = this.hydrator.hydrate(state, agent.systemPrompt, agent.contextDocs ?? []);

      let response;
      try {
        response = await this.deps.llm.complete(messages, this.deps.tools.specs());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", message: `LLM call failed: ${msg}`, recoverable: true });
        state = { ...state, status: "failed", lastError: msg };
        this.saveState(state);
        return state;
      }

      this.emit({
        type: "assistant_message",
        message: { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      });

      if (response.toolCalls.length === 0) {
        this.emit({ type: "done", reason: "agent finished — final message, no tool calls" });
        state = { ...state, status: "done" };
        this.saveState(state);
        return state;
      }

      for (const call of response.toolCalls) {
        this.emit({ type: "tool_call", call });
        const decision = this.deps.policy.check(call);

        if (decision.requiresApproval && !opts.autoApprove) {
          // Register the waiter BEFORE emitting — a fast responder (eval harness,
          // auto-deny) can answer synchronously during emit and must not be missed.
          const verdictPromise = this.deps.bus.awaitApproval(this.sessionId, call.id);
          this.emit({ type: "approval_requested", call, reason: decision.reason });
          state = { ...state, status: "awaiting_approval", pendingApproval: call };
          this.saveState(state);

          const verdict = await verdictPromise;
          this.emit({ type: "approval_decided", callId: call.id, approved: verdict.approved, note: verdict.note });
          if (!verdict.approved) {
            this.emit({
              type: "tool_result",
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                output: `DENIED by human reviewer${verdict.note ? `: ${verdict.note}` : ""}`,
                durationMs: 0,
              },
            });
            state = { ...state, status: "running", pendingApproval: null };
            this.saveState(state);
            continue; // model sees the denial and adjusts
          }
          state = { ...state, status: "running", pendingApproval: null };
          this.saveState(state);
        }

        const result = await this.executeTool(call, ctx);
        this.emit({ type: "tool_result", result });
      }
    }

    this.emit({ type: "error", message: `max steps (${maxSteps}) reached`, recoverable: true });
    state = { ...state, status: "failed", lastError: "max steps reached" };
    this.saveState(state);
    return state;
  }

  private async resumeApproval(state: AgentState, opts: LoopOptions): Promise<AgentState> {
    const call = state.pendingApproval;
    if (!call) return { ...state, status: "running" };
    if (opts.autoApprove) {
      this.emit({ type: "approval_decided", callId: call.id, approved: true, note: "auto-approved (yolo)" });
      const ctx: ToolContext = { workDir: this.deps.workDir, session: {} };
      const result = await this.executeTool(call, ctx);
      this.emit({ type: "tool_result", result });
      const next = { ...state, status: "running" as const, pendingApproval: null };
      this.saveState(next);
      return next;
    }
    // Register the waiter before any synchronous responder can fire.
    const verdict = await this.deps.bus.awaitApproval(this.sessionId, call.id);
    this.emit({ type: "approval_decided", callId: call.id, approved: verdict.approved, note: verdict.note });
    if (verdict.approved) {
      const ctx: ToolContext = { workDir: this.deps.workDir, session: {} };
      const result = await this.executeTool(call, ctx);
      this.emit({ type: "tool_result", result });
    } else {
      this.emit({
        type: "tool_result",
        result: { callId: call.id, name: call.name, ok: false, output: "DENIED by human reviewer", durationMs: 0 },
      });
    }
    const next = { ...state, status: "running" as const, pendingApproval: null };
    this.saveState(next);
    return next;
  }

  private async executeTool(call: ToolCall, ctx: ToolContext) {
    const started = Date.now();
    try {
      const output = await Promise.race([
        this.deps.tools.execute(call.name, call.args, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`tool ${call.name} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS),
        ),
      ]);
      return { callId: call.id, name: call.name, ok: true, output: truncate(output), durationMs: Date.now() - started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { callId: call.id, name: call.name, ok: false, output: truncate(msg), durationMs: Date.now() - started };
    }
  }
}

/** Tool outputs are capped so a single result can't flood the context window. */
function truncate(s: string, max = 30_000): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}
