import { Checkpointer } from "./checkpoint.js";

/**
 * Aggregate session metrics computed from the event log. Used by the CLI
 * `/stats` command, the eval scorer, and (in commit 3) the htmx UI stats panel.
 *
 * Times are NOT included because the event log does not carry timestamps —
 * the bus wraps events with `at` when publishing, but the durable log is
 * timestamp-free. Adding per-event timestamps is a schema change deferred to
 * Tier 2. For now, "how much did this session cost?" is the question that
 * metrics can answer; "how long did it take?" needs a different approach
 * (runner-side wall clock).
 */
export interface SessionStats {
  sessionId: string;
  status: "running" | "awaiting_approval" | "done" | "failed" | "unknown";
  totalEvents: number;
  toolCallCount: number;
  /** Per-tool call counts, e.g., { write_file: 3, run_bash: 5 }. */
  byTool: Record<string, number>;
  /** Approval gate traffic: how many requests, how many approved/denied. */
  approvals: { requested: number; approved: number; denied: number };
  /** Count of `error` events emitted. */
  errors: number;
  /** Aggregate LLM token usage across all calls in the session. */
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    llmCalls: number;
    /** Sum of provider-reported costs in USD (null when the provider doesn't report cost). */
    costUsd: number | null;
  };
  /** LLM models used in this session, e.g. ["deepseek/deepseek-chat-v3-0324"]. */
  models: string[];
  /** Length of the latest compacted summary in chars; null if no compaction yet. */
  compactedSummaryLen: number | null;
  /** Name of the tool currently awaiting approval, if any. */
  pendingApproval: string | null;
  /** Last terminal error message, if status is "failed". */
  lastError: string | null;
}

/**
 * Compute session stats from the on-disk event log. Read-only — never
 * modifies state. Safe to call repeatedly.
 */
export function summarizeSession(workDir: string, sessionId: string): SessionStats {
  const store = new Checkpointer(workDir, sessionId);
  const events = store.events();
  const state = store.loadState();

  let toolCallCount = 0;
  const byTool: Record<string, number> = {};
  let approvalRequested = 0;
  let approvalApproved = 0;
  let approvalDenied = 0;
  let errors = 0;
  let lastSummary: string | null = null;
  const tokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0, costUsd: null as number | null };
  const models = new Set<string>();

  for (const ev of events) {
    if (ev.type === "tool_call") {
      toolCallCount++;
      byTool[ev.call.name] = (byTool[ev.call.name] ?? 0) + 1;
    } else if (ev.type === "approval_requested") {
      approvalRequested++;
    } else if (ev.type === "approval_decided") {
      if (ev.approved) approvalApproved++;
      else approvalDenied++;
    } else if (ev.type === "error") {
      errors++;
    } else if (ev.type === "summary_compacted") {
      lastSummary = ev.summary;
    } else if (ev.type === "llm_usage") {
      tokens.promptTokens += ev.promptTokens;
      tokens.completionTokens += ev.completionTokens;
      tokens.totalTokens += ev.totalTokens;
      tokens.llmCalls++;
      if (ev.costUsd != null) tokens.costUsd = (tokens.costUsd ?? 0) + ev.costUsd;
      models.add(ev.model);
    }
  }

  return {
    sessionId,
    status: (state?.status ?? "unknown") as SessionStats["status"],
    totalEvents: events.length,
    toolCallCount,
    byTool,
    approvals: { requested: approvalRequested, approved: approvalApproved, denied: approvalDenied },
    errors,
    tokens,
    models: [...models],
    compactedSummaryLen: lastSummary?.length ?? null,
    pendingApproval: state?.pendingApproval?.name ?? null,
    lastError: state?.lastError ?? null,
  };
}

/**
 * Render stats as a multi-line text block for CLI output. The htmx UI panel
 * (commit 3) will render the same data as HTML fragments instead.
 */
export function formatStats(s: SessionStats): string {
  const lines: string[] = [];
  lines.push(`session ${s.sessionId} · status=${s.status}`);
  lines.push(`events: ${s.totalEvents} · tool calls: ${s.toolCallCount} · errors: ${s.errors}`);
  const entries = Object.entries(s.byTool).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    lines.push(`tools: ${entries.map(([n, c]) => `${n}=${c}`).join(", ")}`);
  }
  const t = s.tokens;
  if (t.llmCalls > 0) {
    const cost = t.costUsd != null ? ` · $${t.costUsd.toFixed(4)}` : "";
    lines.push(`tokens: ${t.totalTokens.toLocaleString()} (${t.promptTokens.toLocaleString()} in / ${t.completionTokens.toLocaleString()} out) over ${t.llmCalls} calls${cost}`);
    if (s.models.length) lines.push(`models: ${s.models.join(", ")}`);
  }
  const a = s.approvals;
  if (a.requested > 0) {
    lines.push(`approvals: ${a.approved}/${a.requested} approved${a.denied ? `, ${a.denied} denied` : ""}`);
  }
  if (s.compactedSummaryLen != null) {
    lines.push(`compacted summary: ${s.compactedSummaryLen} chars`);
  }
  if (s.pendingApproval) {
    lines.push(`⚠ awaiting approval: ${s.pendingApproval}`);
  }
  if (s.lastError) {
    lines.push(`last error: ${s.lastError}`);
  }
  return lines.join("\n");
}
