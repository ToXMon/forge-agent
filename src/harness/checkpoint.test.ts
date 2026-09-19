import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpointer } from "./checkpoint.js";
import type { AgentState } from "../schemas/events.js";

describe("Checkpointer", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "forge-test-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const baseState = (over: Partial<AgentState> = {}): AgentState => ({
    sessionId: "s1",
    status: "running",
    summary: "",
    compactedUpTo: 0,
    pendingApproval: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });

  it("appends and replays events", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "user_message", message: { role: "user", content: "hi" } });
    cp.append({ type: "tool_call", call: { id: "c1", name: "grep", args: { pattern: "x" } } });
    const events = cp.events();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("user_message");
    expect(events[1].type).toBe("tool_call");
  });

  it("round-trips state snapshots", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.saveState(baseState({ summary: "did stuff" }));
    const loaded = cp.loadState();
    expect(loaded?.summary).toBe("did stuff");
  });

  it("rebuilds message window respecting compaction pointer", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "user_message", message: { role: "user", content: "old" } });
    cp.append({ type: "summary_compacted", summary: "old summary", upToEvent: 1 });
    cp.append({ type: "user_message", message: { role: "user", content: "new" } });
    const msgs = cp.messages(baseState({ summary: "old summary", compactedUpTo: 2 }));
    expect(msgs[0].content).toContain("old summary");
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.at(-1)?.content).toBe("new");
  });

  it("resumes a session from disk after simulated crash", () => {
    const cp1 = new Checkpointer(dir, "s1");
    cp1.append({ type: "user_message", message: { role: "user", content: "remember me" } });
    cp1.saveState(baseState({ status: "awaiting_approval" }));

    const cp2 = new Checkpointer(dir, "s1"); // new instance, same session
    expect(cp2.loadState()?.status).toBe("awaiting_approval");
    expect(cp2.events()).toHaveLength(1);
  });

  it("lists sessions", () => {
    new Checkpointer(dir, "alpha");
    new Checkpointer(dir, "beta");
    expect(Checkpointer.listSessions(dir).sort()).toEqual(["alpha", "beta"]);
  });
});
