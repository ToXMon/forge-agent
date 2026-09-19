import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextHydrator } from "./context.js";
import { Checkpointer } from "./checkpoint.js";
import type { LLMProvider, LLMResponse } from "./llm.js";

const emptyResponse: LLMResponse = { content: "", toolCalls: [], finishReason: "stop" };

const stubLLM = (over: Partial<LLMProvider> = {}): LLMProvider => ({
  model: "stub",
  async complete() { return emptyResponse; },
  async summarize() { return ""; },
  ...over,
});

const failingLLM = (msg: string): LLMProvider => stubLLM({
  async summarize() { throw new Error(msg); },
});

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

describe("ContextHydrator.maybeCompact", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "forge-ctx-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the original state and logs an error when summarization fails", async () => {
    const cp = new Checkpointer(dir, "s1");
    // 14 user_messages > COMPACT_AFTER_MESSAGES (12) → compaction triggered
    for (let i = 0; i < 14; i++) {
      cp.append({ type: "user_message", message: { role: "user", content: `msg ${i}` } });
    }
    const state = baseState();
    const hydrator = new ContextHydrator(failingLLM("rate limit"), cp);

    const result = await hydrator.maybeCompact(state);

    // Identity unchanged — caller keeps working with the same state reference
    expect(result).toBe(state);
    // State file was NOT overwritten with a half-built compacted state
    const onDisk = cp.loadState();
    expect(onDisk).toBeNull(); // saveState only happens on success

    const events = cp.events();
    expect(events.some((e) => e.type === "error" && /summarization failed/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "summary_compacted")).toBe(false);
  });

  it("does not invoke summarize when below the compaction threshold", async () => {
    const cp = new Checkpointer(dir, "s1");
    for (let i = 0; i < 5; i++) {
      cp.append({ type: "user_message", message: { role: "user", content: `m${i}` } });
    }
    const summarize = vi.fn(async () => "x");
    const hydrator = new ContextHydrator(stubLLM({ summarize }), cp);
    const state = baseState();

    const result = await hydrator.maybeCompact(state);

    expect(summarize).not.toHaveBeenCalled();
    expect(result).toBe(state);
    expect(cp.events().some((e) => e.type === "summary_compacted")).toBe(false);
  });

  it("compacts successfully when summarize returns a valid string", async () => {
    const cp = new Checkpointer(dir, "s1");
    for (let i = 0; i < 14; i++) {
      cp.append({ type: "user_message", message: { role: "user", content: `msg ${i}` } });
    }
    const summarize = vi.fn(async () => "## Compacted state\n- did stuff");
    const hydrator = new ContextHydrator(stubLLM({ summarize }), cp);
    const state = baseState();

    const result = await hydrator.maybeCompact(state);

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.summary).toBe("## Compacted state\n- did stuff");
    expect(result.compactedUpTo).toBeGreaterThan(0);
    expect(cp.events().some((e) => e.type === "summary_compacted")).toBe(true);
  });
});
