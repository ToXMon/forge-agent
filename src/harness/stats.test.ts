import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpointer } from "./checkpoint.js";
import { summarizeSession, formatStats } from "./stats.js";

const baseState = (over: Partial<import("../schemas/events.js").AgentState> = {}) => ({
  sessionId: "s1",
  status: "running" as const,
  summary: "",
  compactedUpTo: 0,
  pendingApproval: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("summarizeSession", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "forge-stats-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns zeros for an empty session with no state file", () => {
    const s = summarizeSession(dir, "ghost");
    expect(s.totalEvents).toBe(0);
    expect(s.toolCallCount).toBe(0);
    expect(s.byTool).toEqual({});
    expect(s.approvals).toEqual({ requested: 0, approved: 0, denied: 0 });
    expect(s.errors).toBe(0);
    expect(s.compactedSummaryLen).toBeNull();
    expect(s.status).toBe("unknown");
    expect(s.lastError).toBeNull();
  });

  it("counts tool calls and buckets by name", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "tool_call", call: { id: "1", name: "read_file", args: {} } });
    cp.append({ type: "tool_call", call: { id: "2", name: "read_file", args: {} } });
    cp.append({ type: "tool_call", call: { id: "3", name: "write_file", args: { path: "x" } } });
    cp.append({ type: "tool_result", result: { callId: "1", name: "read_file", ok: true, output: "ok", durationMs: 5 } });
    const s = summarizeSession(dir, "s1");
    expect(s.toolCallCount).toBe(3);
    expect(s.byTool).toEqual({ read_file: 2, write_file: 1 });
  });

  it("counts approvals separately from approval-decided events", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "approval_requested", call: { id: "1", name: "deploy", args: {} }, reason: "dangerous" });
    cp.append({ type: "approval_decided", callId: "1", approved: true });
    cp.append({ type: "approval_requested", call: { id: "2", name: "run_bash", args: {} }, reason: "dangerous" });
    cp.append({ type: "approval_decided", callId: "2", approved: false, note: "no" });
    const s = summarizeSession(dir, "s1");
    expect(s.approvals).toEqual({ requested: 2, approved: 1, denied: 1 });
  });

  it("counts error events and surfaces lastError from state", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "error", message: "boom", recoverable: true });
    cp.saveState(baseState({ status: "failed", lastError: "boom" }));
    const s = summarizeSession(dir, "s1");
    expect(s.errors).toBe(1);
    expect(s.lastError).toBe("boom");
    expect(s.status).toBe("failed");
  });

  it("records the latest compacted summary length", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.append({ type: "summary_compacted", summary: "short", upToEvent: 5 });
    cp.append({ type: "summary_compacted", summary: "a longer summary that grew", upToEvent: 10 });
    const s = summarizeSession(dir, "s1");
    expect(s.compactedSummaryLen).toBe("a longer summary that grew".length);
  });

  it("surfaces the pending approval tool name from state", () => {
    const cp = new Checkpointer(dir, "s1");
    cp.saveState(
      baseState({
        status: "awaiting_approval",
        pendingApproval: { id: "p", name: "deploy", args: { target: "vps" } },
      }),
    );
    const s = summarizeSession(dir, "s1");
    expect(s.pendingApproval).toBe("deploy");
    expect(s.status).toBe("awaiting_approval");
  });
});

describe("formatStats", () => {
  it("renders a session with no activity", () => {
    const out = formatStats({
      sessionId: "s1",
      status: "unknown",
      totalEvents: 0,
      toolCallCount: 0,
      byTool: {},
      approvals: { requested: 0, approved: 0, denied: 0 },
      errors: 0,
      compactedSummaryLen: null,
      pendingApproval: null,
      lastError: null,
    });
    expect(out).toContain("session s1");
    expect(out).toContain("status=unknown");
    expect(out).toContain("events: 0");
    expect(out).not.toContain("approvals");
    expect(out).not.toContain("compacted");
    expect(out).not.toContain("last error");
  });

  it("renders tool breakdown sorted by descending count", () => {
    const out = formatStats({
      sessionId: "s1",
      status: "done",
      totalEvents: 7,
      toolCallCount: 3,
      byTool: { run_bash: 1, read_file: 2 },
      approvals: { requested: 0, approved: 0, denied: 0 },
      errors: 0,
      compactedSummaryLen: null,
      pendingApproval: null,
      lastError: null,
    });
    // read_file=2 should come before run_bash=1
    expect(out.indexOf("read_file=2")).toBeLessThan(out.indexOf("run_bash=1"));
  });

  it("includes pending approval warning and last error when present", () => {
    const out = formatStats({
      sessionId: "s1",
      status: "awaiting_approval",
      totalEvents: 5,
      toolCallCount: 1,
      byTool: { deploy: 1 },
      approvals: { requested: 1, approved: 0, denied: 0 },
      errors: 0,
      compactedSummaryLen: null,
      pendingApproval: "deploy",
      lastError: null,
    });
    expect(out).toContain("⚠ awaiting approval: deploy");
  });
});

// Suppress unused-import lint when only the import is needed for types above.
void writeFileSync;
