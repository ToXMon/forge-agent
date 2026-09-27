/**
 * Typed client for the Forge harness API. Mirrors src/schemas/events.ts.
 * The backend URL defaults to the local Hono server; set
 * NEXT_PUBLIC_FORGE_API for remote (Akash/VPS) deployments.
 */
export const FORGE_API = process.env.NEXT_PUBLIC_FORGE_API ?? "http://127.0.0.1:8787";

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type HarnessEvent =
  | { type: "user_message"; message: { role: "user"; content: string } }
  | { type: "assistant_message"; message: { role: "assistant"; content: string; toolCalls?: ToolCall[] } }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: { callId: string; name: string; ok: boolean; output: string; durationMs: number } }
  | { type: "approval_requested"; call: ToolCall; reason: string }
  | { type: "approval_decided"; callId: string; approved: boolean; note?: string }
  | { type: "summary_compacted"; summary: string; upToEvent: number }
  | { type: "llm_usage"; model: string; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number | null }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done"; reason: string };

export interface SessionStats {
  sessionId: string;
  status: "running" | "awaiting_approval" | "done" | "failed" | "unknown";
  totalEvents: number;
  toolCallCount: number;
  byTool: Record<string, number>;
  approvals: { requested: number; approved: number; denied: number };
  errors: number;
  tokens: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number; costUsd: number | null };
  models: string[];
  pendingApproval: string | null;
  lastError: string | null;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FORGE_API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const forge = {
  listSessions: () => json<{ sessions: string[] }>("/sessions").then((r) => r.sessions),
  sessionEvents: (id: string) =>
    json<{ events: HarnessEvent[]; state: { status: string } | null }>(`/sessions/${id}/events`),
  sessionStats: (id: string) => json<SessionStats>(`/sessions/${id}/stats`),
  health: () => json<{ ok: boolean; model: string; providers: string[] }>("/health"),
  newSession: (task: string) =>
    json<{ sessionId: string }>("/sessions", { method: "POST", body: JSON.stringify({ task }) }),
  sendMessage: (id: string, message: string) =>
    fetch(`${FORGE_API}/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  decide: (id: string, callId: string, approved: boolean) =>
    json<{ ok: boolean }>(`/sessions/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ callId, approved, note: approved ? "ui approve" : "ui deny" }),
    }),
};

/** Subscribe to a session's live event stream over the backend WebSocket. */
export function streamSession(id: string, onEvent: (ev: HarnessEvent) => void): () => void {
  const wsUrl = `${FORGE_API.replace(/^http/, "ws")}/sessions/${id}/stream`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as HarnessEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (!closed) {
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, 500 * 2 ** retry);
      }
    };
    ws.onopen = () => (retry = 0);
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

/** Render a tool call's primary argument for card headers. */
export function toolLabel(call: ToolCall): string {
  const a = call.args as Record<string, unknown>;
  const v = a.command ?? a.path ?? a.url ?? a.skill ?? "";
  return typeof v === "string" && v ? `${call.name}: ${v}` : call.name;
}
