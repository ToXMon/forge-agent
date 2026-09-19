import { describe, it, expect } from "vitest";
import { serializeTranscript } from "./llm.js";
import type { Message } from "../schemas/events.js";

describe("serializeTranscript", () => {
  it("tags every role consistently", () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "ask" },
      { role: "assistant", content: "answer" },
      { role: "tool", toolCallId: "abc", content: "result" },
    ];
    const out = serializeTranscript(msgs);
    expect(out).toContain("[system] sys");
    expect(out).toContain("[user] ask");
    expect(out).toContain("[assistant] answer");
    expect(out).toContain("[tool(abc)] result");
  });

  it("renders assistant tool calls inline as [called: name(args)]", () => {
    const out = serializeTranscript([
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "1", name: "grep", args: { pattern: "zod", glob: "*.ts" } }],
      },
    ]);
    expect(out).toMatch(/\[assistant\] \[called: grep\(\{[^)]*\}\)\] checking/);
    expect(out).toContain("zod");
  });

  it("falls back to tool(result) when toolCallId is missing", () => {
    const out = serializeTranscript([{ role: "tool", content: "x" }]);
    expect(out).toContain("[tool(result)] x");
  });

  it("joins multiple messages with a blank line", () => {
    const out = serializeTranscript([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(out).toBe("[user] a\n\n[assistant] b");
  });

  it("caps output at 60_000 characters", () => {
    const big = "x".repeat(70_000);
    const out = serializeTranscript([{ role: "user", content: big }]);
    expect(out.length).toBe(60_000);
  });

  it("produces a single string safe to ship as one user message body", () => {
    // This is the actual Venice-400 fix: the summarization call must NOT carry
    // a tool/assistant/system role in its messages array. The transcript is
    // always one big string — verified by structural shape, not HTTP.
    const out = serializeTranscript([
      { role: "system", content: "s" },
      { role: "tool", toolCallId: "1", content: "t" },
      { role: "assistant", content: "a", toolCalls: [{ id: "1", name: "x", args: {} }] },
    ]);
    expect(typeof out).toBe("string");
    expect(out).not.toMatch(/^\{/); // never JSON
    expect(out.startsWith("[")).toBe(true);
    // Tool-call args are truncated to 120 chars in the rendered string — defends
    // against one massive args payload blowing the prompt budget.
    const huge = serializeTranscript([
      { role: "assistant", content: "y", toolCalls: [{ id: "1", name: "write_file", args: { content: "z".repeat(500) } }] },
    ]);
    const renderedArgs = huge.match(/write_file\(([^)]*)\)/)?.[1] ?? "";
    expect(renderedArgs.length).toBeLessThanOrEqual(120);
  });
});
