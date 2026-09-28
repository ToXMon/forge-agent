/**
 * Typed client for the Forge harness API. Mirrors src/schemas/events.ts.
 * The backend URL defaults to the local Hono server; set
 * NEXT_PUBLIC_FORGE_API for remote (Akash/VPS) deployments.
 */
export const FORGE_API = process.env.NEXT_PUBLIC_FORGE_API ?? "http://127.0.0.1:8787";

// ── Auth token (localStorage; sent as bearer + ?token= for WS) ────
const TOKEN_KEY = "forge_token";
export const getToken = () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY));
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}
export interface Me {
  email: string;
  admin: boolean;
  creditsTokens: number | null;
}

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

export interface WorkspaceFile {
  path: string;
  size: number;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FORGE_API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...init?.headers },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export class UnauthorizedError extends Error {}

export const forge = {
  signup: (email: string, password: string) =>
    json<{ token: string; user: Me }>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    json<{ token: string; user: Me }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => json<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => json<Me>("/auth/me"),
  listSessions: () => json<{ sessions: string[] }>("/sessions").then((r) => r.sessions),
  sessionEvents: (id: string) =>
    json<{ events: HarnessEvent[]; state: { status: string } | null }>(`/sessions/${id}/events`),
  sessionStats: (id: string) => json<SessionStats>(`/sessions/${id}/stats`),
  workspaceFiles: (id: string) => json<{ files: WorkspaceFile[] }>(`/sessions/${id}/files`).then((r) => r.files),
  fileContent: (id: string, path: string) =>
    json<{ path: string; content: string }>(`/sessions/${id}/files/${path}`),
  config: () => json<{ browserpod: { apiKey: string; nodeVersion: string } | null }>("/config"),
  health: () => json<{ ok: boolean; model: string; providers: string[] }>("/health"),
  newSession: (task: string) =>
    json<{ sessionId: string }>("/sessions", { method: "POST", body: JSON.stringify({ task }) }),
  sendMessage: (id: string, message: string) =>
    fetch(`${FORGE_API}/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
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
    const token = getToken();
    ws = new WebSocket(token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl);
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
