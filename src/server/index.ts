import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { streamSSE } from "hono/streaming";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProviderRegistry } from "../harness/providers.js";
import { HarnessBus } from "../harness/bus.js";
import { PolicyGuard } from "../harness/policy.js";
import { AgentLoop } from "../harness/loop.js";
import { codingToolRegistry } from "../tools/index.js";
import { fullstackAgent } from "../agents/fullstack.js";
import { Checkpointer } from "../harness/checkpoint.js";
import { summarizeSession } from "../harness/stats.js";
import { loadSkills } from "../skills/loader.js";
import { GOLDEN_TASKS } from "../../evals/golden/tasks.js";
import { scoreToolCallMatch } from "../../evals/scorers/toolCallMatch.js";
import type { ToolCall } from "../schemas/events.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { layout, sidebar, emptyMain } from "./views/layout.js";
import { eventFragment, historicalEventsHtml } from "./views/messages.js";
import { statsPanel } from "./views/stats.js";
import { evalDashboard, evalGrid, evalHeader, type EvalResults } from "./views/eval.js";
import type { EvalScore } from "../../evals/scorers/toolCallMatch.js";
import { escapeHtml } from "./views/escape.js";

const here = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(here, "../../evals/.last-results.json");
const workDir = process.cwd();

const app = new Hono();
const bus = new HarnessBus();
const registry = ProviderRegistry.fromEnv();
const llm = registry.defaultProvider();
const tools = codingToolRegistry();
const policy = new PolicyGuard();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// ── Static assets (htmx, CSS) ────────────────────────────────────
app.use(
  "/static/*",
  serveStatic({
    root: join(here, "../../public"),
    // Strip the /static prefix so /static/styles.css resolves to ./public/styles.css.
    rewriteRequestPath: (path) => path.replace(/^\/static/, ""),
  }),
);

// ── Health + existing JSON API (unchanged) ────────────────────────
app.get("/health", (c) => c.json({ ok: true, model: llm.model, providers: registry.names() }));
app.get("/sessions", (c) => c.json({ sessions: Checkpointer.listSessions(workDir) }));

// ── HTML pages ────────────────────────────────────────────────────

/** Build the sidebar markup once per request (cheap). */
function renderSidebar(currentSessionId: string | null): string {
  const sessionIds = Checkpointer.listSessions(workDir);
  const sessions = sessionIds.map((id) => {
    const state = new Checkpointer(workDir, id).loadState();
    return { id, status: state?.status ?? "unknown" };
  });
  return sidebar({
    currentSessionId,
    sessions,
    model: llm.model,
    providers: registry.names(),
  });
}

app.get("/", (c) => {
  // Redirect to last session if any exist.
  const sessions = Checkpointer.listSessions(workDir);
  if (sessions.length > 0) return c.redirect(`/sessions/${sessions[0]}`);
  return c.html(layout({ sidebar: renderSidebar(null), main: emptyMain() }));
});

app.post("/sessions", async (c) => {
  const body = await c.req.parseBody();
  const task = String(body.task ?? "").trim();
  if (!task) return c.text("task required", 400);

  const loop = new AgentLoop({ llm, tools, policy, bus, workDir });
  loop
    .run(fullstackAgent(), task, { autoApprove: false })
    .catch((err) => bus.publish(loop.sessionId, { type: "error", message: String(err), recoverable: false }));
  return c.redirect(`/sessions/${loop.sessionId}`, 303);
});

app.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const store = new Checkpointer(workDir, id);
  if (!existsSync(join(workDir, ".forge", "sessions", id, "events.jsonl"))) {
    return c.text("session not found", 404);
  }
  const events = store.events();
  const main = sessionMain(id, events);
  return c.html(layout({ title: `Forge · ${id.slice(0, 8)}`, sidebar: renderSidebar(id), main }));
});

function sessionMain(sessionId: string, events: ReturnType<Checkpointer["events"]>): string {
  const stats = summarizeSession(workDir, sessionId);
  const messagesHtml = historicalEventsHtml(sessionId, events);

  return `
    <header>
      <div>
        <div><strong>${escapeHtml(sessionId.slice(0, 8))}</strong> <span class="meta">${escapeHtml(sessionId)}</span></div>
        <div class="session-id">model: <strong>${escapeHtml(llm.model)}</strong></div>
      </div>
      <div class="live" id="live-indicator">streaming</div>
    </header>
    <div class="messages" id="messages" hx-ext="sse" sse-connect="/sessions/${encodeURIComponent(sessionId)}/events-stream">
      ${messagesHtml}
    </div>
    ${statsPanel(stats)}
    <form class="compose" hx-post="/sessions/${encodeURIComponent(sessionId)}/messages" hx-target="#messages" hx-swap="beforeend">
      <textarea name="message" placeholder="Send a follow-up message..." required></textarea>
      <button type="submit">Send</button>
    </form>
  `;
}

// ── Live event stream (SSE) ──────────────────────────────────────

app.get("/sessions/:id/events-stream", (c) => {
  const id = c.req.param("id");
  if (!id) return c.text("id required", 400);

  return streamSSE(c, async (stream) => {
    const pendingCalls = new Map<string, ToolCall>();
    let closed = false;

    const send = (eventName: string, data: string) => {
      if (closed) return;
      stream.writeSSE({ event: eventName, data }).catch(() => {
        closed = true;
      });
    };

    // Replay historical events first so a page refresh shows the full session.
    const store = new Checkpointer(workDir, id);
    for (const ev of store.events()) {
      const html = eventFragment(ev, { sessionId: id, pendingCalls });
      if (html) send("message", html);
    }

    const unsub = bus.subscribe(id, (ev) => {
      const html = eventFragment(ev, { sessionId: id, pendingCalls });
      if (html) send("message", html);
    });

    // Heartbeat keeps proxies from closing the connection.
    const heartbeat = setInterval(() => send("ping", "keepalive"), 15_000);

    stream.onAbort(() => {
      closed = true;
      clearInterval(heartbeat);
      unsub();
    });

    // Block forever; the connection closes when the client disconnects.
    await new Promise(() => {});
  });
});

// ── Approve / deny / send message (form posts) ───────────────────

app.post("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const message = String(body.message ?? "").trim();
  if (!message) return c.text("message required", 400);

  // Resume the session from disk and run a new message.
  const loop = new AgentLoop({ llm, tools, policy, bus, workDir, sessionId: id });
  loop
    .run(fullstackAgent(), message, { autoApprove: false })
    .catch((err) => bus.publish(id, { type: "error", message: String(err), recoverable: false }));

  // Return an empty fragment — the SSE stream will deliver the events.
  return c.body(null, 204);
});

app.post("/sessions/:id/approve/:callId", (c) => {
  const { id, callId } = c.req.param();
  bus.submitApproval(id, callId, true, "ui approve");
  return c.body(null, 204);
});

app.post("/sessions/:id/deny/:callId", (c) => {
  const { id, callId } = c.req.param();
  bus.submitApproval(id, callId, false, "ui deny");
  return c.body(null, 204);
});

// ── Eval dashboard ───────────────────────────────────────────────

function readResults(): EvalResults | null {
  if (!existsSync(resultsPath)) return null;
  try {
    return JSON.parse(readFileSync(resultsPath, "utf8")) as EvalResults;
  } catch {
    return null;
  }
}

app.get("/eval", (c) => {
  const sidebarHtml = renderSidebar(null);
  const main = evalDashboard(readResults());
  return c.html(layout({ title: "Forge · eval dashboard", sidebar: sidebarHtml, main }));
});

const exec = promisify(execFile);

async function runEvalTask(taskId: string): Promise<EvalScore> {
  const llm2 = ProviderRegistry.fromEnv().defaultProvider();
  const workDir2 = workDir;
  // We delegate to the eval runner via subprocess to keep scoring logic in
  // one place. This costs a tsx startup per task — acceptable for a demo.
  const { stdout } = await exec("npx", ["tsx", "evals/run.ts", "--tasks", taskId], {
    cwd: workDir2,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
  // The runner logs one line per task; we re-score by reading the on-disk
  // results file written by the most recent run.
  const results = readResults();
  return (
    results?.results.find((r) => r.taskId === taskId) ?? {
      taskId,
      pass: false,
      failures: ["re-run did not produce a result"],
      toolCallCount: 0,
      eventCount: 0,
      approvalRate: null,
      retryRate: 0,
      durationMs: 0,
    }
  );
}

app.post("/eval/run/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  if (!GOLDEN_TASKS.find((t) => t.id === taskId)) return c.text("unknown task", 404);
  const score = await runEvalTask(taskId);
  // Return just the updated card so htmx swaps it in place.
  return c.html(evalCardFragment(score));
});

app.post("/eval/run-all", async (c) => {
  await exec("npx", ["tsx", "evals/run.ts"], {
    cwd: workDir,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => undefined);
  // Return just the grid — htmx targets .eval-grid, header stays put.
  return c.html(`<div class="eval-grid">${evalGrid(readResults())}</div>`);
});

function evalCardFragment(score: ReturnType<typeof scoreToolCallMatch>): string {
  // Wrap a single result so the dashboard renderer emits one card.
  const results: EvalResults = {
    ranAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: llm.model,
    totalTasks: 1,
    passed: score.pass ? 1 : 0,
    results: [score],
  };
  return evalDashboard(results).match(/<div class="eval-card[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
}

// ── Existing JSON endpoints (kept for API consumers) ──────────────
app.get("/sessions/:id/events", (c) => {
  const store = new Checkpointer(workDir, c.req.param("id"));
  return c.json({ events: store.events(), state: store.loadState() });
});

app.post("/sessions/:id/approve", async (c) => {
  const { callId, approved, note } = await c.req.json<{ callId: string; approved: boolean; note?: string }>();
  bus.submitApproval(c.req.param("id"), callId, approved, note);
  return c.json({ ok: true });
});

app.get(
  "/sessions/:id/stream",
  upgradeWebSocket((c) => {
    const id = c.req.param("id");
    return {
      onOpen(_evt, ws) {
        if (!id) return;
        const unsub = bus.subscribe(id, (ev) => ws.send(JSON.stringify(ev)));
        (ws as unknown as { __unsub?: () => void }).__unsub = unsub;
      },
      onClose(_evt, ws) {
        (ws as unknown as { __unsub?: () => void }).__unsub?.();
      },
    };
  }),
);

// Suppress unused-import warnings for symbols referenced only in JSDoc.
void loadSkills;

const port = Number(process.env.FORGE_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`forge server listening on http://127.0.0.1:${info.port}`);
  console.log(`  open the UI: http://127.0.0.1:${info.port}/`);
});
injectWebSocket(server);
