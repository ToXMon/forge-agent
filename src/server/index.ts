import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { providerFromEnv } from "../harness/llm.js";
import { HarnessBus } from "../harness/bus.js";
import { PolicyGuard } from "../harness/policy.js";
import { AgentLoop } from "../harness/loop.js";
import { codingToolRegistry } from "../tools/index.js";
import { fullstackAgent } from "../agents/fullstack.js";
import { Checkpointer } from "../harness/checkpoint.js";

/**
 * Forge server: HTTP + WebSocket API for remote sessions.
 *   POST /sessions              { task, workDir?, autoApprove? } → { sessionId }
 *   GET  /sessions              → [sessionId]
 *   GET  /sessions/:id/events   → full event log
 *   POST /sessions/:id/approve  { callId, approved, note? }
 *   WS   /sessions/:id/stream   → live events as they happen
 */
const app = new Hono();
const bus = new HarnessBus();
const llm = providerFromEnv();
const workDir = process.cwd();
const sessions = new Map<string, AgentLoop>();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get("/health", (c) => c.json({ ok: true, model: llm.model }));

app.get("/sessions", (c) => c.json({ sessions: Checkpointer.listSessions(workDir) }));

app.post("/sessions", async (c) => {
  const body = await c.req.json<{ task: string; autoApprove?: boolean }>();
  if (!body.task) return c.json({ error: "task required" }, 400);

  const loop = new AgentLoop({ llm, tools: codingToolRegistry(), policy: new PolicyGuard(), bus, workDir });
  sessions.set(loop.sessionId, loop);
  loop.run(fullstackAgent(), body.task, { autoApprove: Boolean(body.autoApprove) }).catch((err) => {
    bus.publish(loop.sessionId, { type: "error", message: String(err), recoverable: false });
  });
  return c.json({ sessionId: loop.sessionId }, 201);
});

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

const port = Number(process.env.FORGE_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`forge server listening on http://127.0.0.1:${info.port}`);
});
injectWebSocket(server);
