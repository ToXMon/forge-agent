"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forge, clearToken, getToken, setToken, streamSession, toolLabel, type HarnessEvent, type Me, type SessionStats, type ToolCall, type WorkspaceFile } from "@/lib/forge";

interface ChatItem {
  key: string;
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
  call?: ToolCall;
  result?: { ok: boolean; output: string; durationMs: number };
  pendingApproval?: boolean;
}

/** Collapse the event log into renderable chat items (tool_call + result merged). */
function buildItems(events: HarnessEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const openCalls = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "user_message") {
      items.push({ key: `u${items.length}`, kind: "user", text: ev.message.content });
    } else if (ev.type === "assistant_message" && ev.message.content.trim()) {
      items.push({ key: `a${items.length}`, kind: "assistant", text: ev.message.content });
    } else if (ev.type === "tool_call") {
      openCalls.set(ev.call.id, items.length);
      items.push({ key: `t-${ev.call.id}`, kind: "tool", text: toolLabel(ev.call), call: ev.call });
    } else if (ev.type === "tool_result") {
      const idx = openCalls.get(ev.result.callId);
      if (idx != null && items[idx]) items[idx].result = { ok: ev.result.ok, output: ev.result.output, durationMs: ev.result.durationMs };
    } else if (ev.type === "approval_requested") {
      const idx = openCalls.get(ev.call.id);
      if (idx != null && items[idx]) items[idx].pendingApproval = true;
    } else if (ev.type === "approval_decided") {
      items.push({ key: `ad${items.length}`, kind: "system", text: ev.approved ? "✅ approved" : "❌ denied" });
    } else if (ev.type === "error") {
      items.push({ key: `e${items.length}`, kind: "system", text: `⚠️ ${ev.message}` });
    } else if (ev.type === "done") {
      items.push({ key: `d${items.length}`, kind: "system", text: "✅ finished" });
    }
  }
  return items;
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessions, setSessions] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [model, setModel] = useState<string>("…");
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshSessions = useCallback(() => {
    forge.listSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setAuthChecked(true);
      return;
    }
    forge
      .me()
      .then(setMe)
      .catch(() => clearToken())
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!me) return;
    forge.health().then((h) => setModel(h.model)).catch(() => setModel("backend offline"));
    refreshSessions();
  }, [me, refreshSessions]);

  const refreshStats = useCallback((id: string) => {
    forge.sessionStats(id).then(setStats).catch(() => setStats(null));
  }, []);

  // Load a session: historical events, then live stream.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setItems([]);
    forge
      .sessionEvents(active)
      .then((r) => alive && setItems(buildItems(r.events)))
      .catch(() => alive && setItems([]));
    refreshStats(active);
    forge.workspaceFiles(active).then(setFiles).catch(() => setFiles([]));
    setPortalUrl(null);
    setVerifyError(null);

    const stop = streamSession(active, (ev) => {
      setItems((prev) => appendEvent(prev, ev));
      if (ev.type === "tool_result") {
        // Artifacts may have changed — refresh the workspace listing lazily.
        setTimeout(() => forge.workspaceFiles(active).then(setFiles).catch(() => {}), 1500);
      }
      if (ev.type === "done" || ev.type === "error" || ev.type === "llm_usage") refreshStats(active);
    });
    // Poll stats lightly so token counters tick while the agent runs.
    statsTimer.current = setInterval(() => refreshStats(active), 5000);
    return () => {
      alive = false;
      stop();
      if (statsTimer.current) clearInterval(statsTimer.current);
    };
  }, [active, refreshStats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const startSession = async () => {
    const task = input.trim();
    if (!task || starting) return;
    setStarting(true);
    try {
      const { sessionId } = await forge.newSession(task);
      setInput("");
      refreshSessions();
      setActive(sessionId);
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || !active) return;
    setInput("");
    setItems((prev) => [...prev, { key: `me${Date.now()}`, kind: "user", text: message }]);
    await forge.sendMessage(active, message);
  };

  const decide = async (callId: string, approved: boolean) => {
    if (!active) return;
    await forge.decide(active, callId, approved);
    setItems((prev) => prev.map((it) => (it.call?.id === callId ? { ...it, pendingApproval: false } : it)));
    refreshStats(active);
  };

  const verifyInBrowser = async () => {
    if (!active || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const cfg = await forge.config();
      if (!cfg.browserpod) throw new Error("BROWSERPOD_API_KEY not configured on the server");
      const { BrowserPod } = await import("@leaningtech/browserpod");
      const pod = await BrowserPod.boot({ apiKey: cfg.browserpod.apiKey, nodeVersion: cfg.browserpod.nodeVersion });

      let portal: string | null = null;
      pod.onPortal(({ url }: { url: string }) => {
        portal = url;
        setPortalUrl(url);
      });
      const logs: string[] = [];
      const decoder = new TextDecoder();
      const terminal = await pod.createCustomTerminal({
        // BrowserPod hands us a resizable ArrayBuffer, which TextDecoder
        // rejects — copy into a fresh view first.
        onOutput: (buf: ArrayBuffer) => logs.push(decoder.decode(new Uint8Array(buf.slice(0)))),
      });

      // Push the workspace into the pod's filesystem (BrowserPod needs
      // absolute paths).
      const workspaceFiles = await forge.workspaceFiles(active);
      for (const f of workspaceFiles) {
        if (f.size > 512 * 1024) continue;
        const podPath = `/${f.path}`;
        const dir = podPath.includes("/") ? podPath.slice(0, podPath.lastIndexOf("/")) : "";
        if (dir && dir !== "/") await pod.createDirectory(dir, { recursive: true });
        const fh = await pod.createFile(podPath, "utf-8");
        const { content } = await forge.fileContent(active, f.path);
        await (fh as import("@leaningtech/browserpod").TextFile).write(content);
        await fh.close();
      }

      // Boot the app: package.json start script, else node server.js.
      // NOTE: pod.run never resolves for a long-running server — don't await
      // it; wait for the portal instead.
      const pkg = workspaceFiles.find((f) => f.path === "package.json");
      let startCmd = "node server.js";
      if (pkg) {
        const { content } = await forge.fileContent(active, "package.json");
        const scripts = JSON.parse(content).scripts as Record<string, string> | undefined;
        if (scripts?.start) startCmd = scripts.start;
      }
      // run() returns a Process, not a promise — normalize for error handling.
      Promise.resolve(pod.run("sh", ["-c", startCmd], { terminal, cwd: "/" })).catch((e: unknown) => {
        logs.push(`\n[run error] ${e instanceof Error ? e.message : String(e)}`);
      });

      // Wait up to 30s for the portal, then report the result into the session.
      const deadline = Date.now() + 30_000;
      while (!portal && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const tail = logs.join("").slice(-800);
      void forge.sendMessage(
        active,
        `BrowserPod verification: app booted in the browser sandbox.${portal ? ` Portal: ${portal}` : " No portal after 30s (is a server listening on a port?)"}\nConsole tail:\n${tail || "(no output)"}`,
      );
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };

  const statsInfo = useMemo(() => {
    if (!stats) return null;
    const t = stats.tokens;
    const cost = t.costUsd != null ? `$${t.costUsd.toFixed(4)}` : null;
    return `${t.totalTokens.toLocaleString()} tok · ${t.promptTokens.toLocaleString()} in / ${t.completionTokens.toLocaleString()} out${cost ? ` · ${cost}` : ""} · ${stats.toolCallCount} tools · ${stats.approvals.approved}/${stats.approvals.requested} approved`;
  }, [stats]);

  if (!authChecked) return null;
  if (!me) return <AuthPanel onAuth={setMe} />;

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60 md:flex">
        <div className="flex items-center justify-between px-4 py-4">
          <span className="text-sm font-semibold tracking-wide text-orange-400">⚒ FORGE</span>
          <span className={`h-2 w-2 rounded-full ${model !== "backend offline" ? "bg-emerald-500" : "bg-zinc-600"}`} />
        </div>
        <button
          onClick={() => setActive(null)}
          className="mx-3 mb-2 rounded-lg border border-zinc-700 px-3 py-2 text-left text-sm hover:bg-zinc-800"
        >
          + New session
        </button>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {sessions.map((id) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm truncate ${
                active === id ? "bg-orange-500/15 text-orange-300" : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {id.slice(0, 8)}…
            </button>
          ))}
        </nav>
        <div className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
          <div className="truncate">{model}</div>
          {stats?.status && <div>status: {stats.status}</div>}
        </div>
        {active && (
          <div className="max-h-56 overflow-y-auto border-t border-zinc-800 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">workspace ({files.length})</span>
              <button
                onClick={() => void verifyInBrowser()}
                disabled={verifying || files.length === 0}
                className="rounded-md border border-emerald-700 px-2 py-1 text-[10px] text-emerald-400 hover:bg-emerald-900/40 disabled:opacity-40"
              >
                {verifying ? "booting…" : "▶ verify in browser"}
              </button>
            </div>
            {portalUrl && (
              <a href={portalUrl} target="_blank" rel="noreferrer" className="mb-2 block truncate text-[11px] text-emerald-400 underline">
                🌐 {portalUrl}
              </a>
            )}
            {verifyError && <p className="mb-2 text-[10px] text-red-400">{verifyError}</p>}
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => forge.fileContent(active, f.path).then(setPreview).catch(() => {})}
                className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                {f.path} <span className="text-zinc-700">{f.size > 1024 ? `${(f.size / 1024).toFixed(1)}k` : `${f.size}b`}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div className="text-sm text-zinc-400">
            {active ? <>session <span className="font-mono text-zinc-200">{active.slice(0, 8)}</span></> : "New session"}
          </div>
          <div className="flex items-center gap-4">
            {statsInfo && <div className="hidden text-xs text-zinc-500 sm:block">{statsInfo}</div>}
            <span className="hidden text-xs text-zinc-400 sm:block">
              {me?.email}
              {me?.creditsTokens != null && <span className="ml-1 text-orange-400">· {me.creditsTokens.toLocaleString()} cr</span>}
            </span>
            <button
              onClick={() => {
                void forge.logout();
                clearToken();
                setMe(null);
                setActive(null);
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Log out
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-4">
            {items.length === 0 && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
                <h1 className="mb-2 text-xl font-semibold">Forge</h1>
                <p className="text-sm text-zinc-400">
                  A durable, always-on coding agent. Describe a task below — dangerous tool calls will
                  ask for your approval here (or via Telegram).
                </p>
              </div>
            )}
            {items.map((it) => (
              <ChatRow key={it.key} item={it} onDecide={decide} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-800 px-4 py-4 sm:px-8">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void (active ? send() : startSession());
                }
              }}
              rows={1}
              placeholder={active ? "Send a follow-up message… (Enter to send, Shift+Enter for newline)" : "Describe a task to start a session…"}
              className="max-h-40 flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-orange-500/60"
            />
            <button
              onClick={() => void (active ? send() : startSession())}
              disabled={!input.trim() || starting}
              className="rounded-xl bg-orange-500 px-4 py-3 text-sm font-medium text-white hover:bg-orange-400 disabled:opacity-40"
            >
              {starting ? "…" : active ? "Send" : "Start"}
            </button>
          </div>
        </div>
      </main>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={() => setPreview(null)}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <span className="font-mono text-xs text-zinc-300">{preview.path}</span>
              <button onClick={() => setPreview(null)} className="text-xs text-zinc-500 hover:text-zinc-300">✕</button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-zinc-400">{preview.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function appendEvent(items: ChatItem[], ev: HarnessEvent): ChatItem[] {
  if (ev.type === "user_message") return [...items, { key: `u${items.length}`, kind: "user", text: ev.message.content }];
  if (ev.type === "assistant_message")
    return ev.message.content.trim()
      ? [...items, { key: `a${items.length}`, kind: "assistant", text: ev.message.content }]
      : items;
  if (ev.type === "tool_call")
    return [...items, { key: `t-${ev.call.id}`, kind: "tool", text: toolLabel(ev.call), call: ev.call }];
  if (ev.type === "tool_result") {
    const idx = items.findIndex((it) => it.call?.id === ev.result.callId);
    if (idx === -1) return items;
    const next = [...items];
    next[idx] = { ...next[idx], result: { ok: ev.result.ok, output: ev.result.output, durationMs: ev.result.durationMs } };
    return next;
  }
  if (ev.type === "approval_requested") {
    const idx = items.findIndex((it) => it.call?.id === ev.call.id);
    if (idx === -1) return items;
    const next = [...items];
    next[idx] = { ...next[idx], pendingApproval: true };
    return next;
  }
  if (ev.type === "approval_decided")
    return [...items, { key: `ad${items.length}`, kind: "system", text: ev.approved ? "✅ approved" : "❌ denied" }];
  if (ev.type === "error") return [...items, { key: `e${items.length}`, kind: "system", text: `⚠️ ${ev.message}` }];
  if (ev.type === "done") return [...items, { key: `d${items.length}`, kind: "system", text: "✅ finished" }];
  return items;
}

function ChatRow({ item, onDecide }: { item: ChatItem; onDecide: (callId: string, approved: boolean) => void }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-orange-500/90 px-4 py-2.5 text-sm text-white">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-zinc-800/80 px-4 py-2.5 text-sm leading-relaxed">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "system") {
    return <div className="text-center text-xs text-zinc-500">{item.text}</div>;
  }

  // Tool card
  const r = item.result;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 text-sm">
      <details open={item.pendingApproval}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r ? (r.ok ? "bg-emerald-500" : "bg-red-500") : "animate-pulse bg-yellow-500"}`} />
          <span className="font-mono text-xs text-zinc-300">{item.text}</span>
          {r && <span className="ml-auto text-xs text-zinc-600">{r.durationMs}ms</span>}
        </summary>
        {r && (
          <pre className="max-h-64 overflow-auto border-t border-zinc-800 px-4 py-3 text-xs text-zinc-400">
            {r.output || "(no output)"}
          </pre>
        )}
      </details>
      {item.pendingApproval && item.call && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
          <span className="text-xs text-yellow-400">🔐 needs approval</span>
          <button
            onClick={() => onDecide(item.call!.id, true)}
            className="ml-auto rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500"
          >
            Approve
          </button>
          <button
            onClick={() => onDecide(item.call!.id, false)}
            className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium hover:bg-zinc-600"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

function AuthPanel({ onAuth }: { onAuth: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = mode === "signup" ? await forge.signup(email, password) : await forge.login(email, password);
      setToken(res.token);
      onAuth(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <h1 className="mb-1 text-lg font-semibold text-orange-400">⚒ FORGE</h1>
        <p className="mb-6 text-xs text-zinc-500">
          {mode === "signup"
            ? "New accounts start with trial credits. The first account becomes the admin."
            : "Sign in to your Forge account."}
        </p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mb-3 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-orange-500/60"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Password (8+ characters)"
          className="mb-3 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-orange-500/60"
        />
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="w-full rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-orange-400 disabled:opacity-40"
        >
          {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
        <button
          onClick={() => setMode(mode === "signup" ? "login" : "signup")}
          className="mt-4 w-full text-center text-xs text-zinc-500 hover:text-zinc-300"
        >
          {mode === "signup" ? "Already have an account? Sign in" : "No account? Sign up"}
        </button>
      </div>
    </div>
  );
}
