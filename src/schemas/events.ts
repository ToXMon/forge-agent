import { z } from "zod";

/**
 * Every state transition in the harness is an event. The event log is the
 * single source of truth: replay it to reconstruct agent state after a crash.
 */

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), message: MessageSchema }),
  z.object({ type: z.literal("assistant_message"), message: MessageSchema }),
  z.object({ type: z.literal("tool_call"), call: ToolCallSchema }),
  z.object({ type: z.literal("tool_result"), result: ToolResultSchema }),
  z.object({
    type: z.literal("approval_requested"),
    call: ToolCallSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal("approval_decided"),
    callId: z.string(),
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  z.object({ type: z.literal("summary_compacted"), summary: z.string(), upToEvent: z.number() }),
  z.object({ type: z.literal("error"), message: z.string(), recoverable: z.boolean() }),
  z.object({ type: z.literal("done"), reason: z.string() }),
]);
export type HarnessEvent = z.infer<typeof EventSchema>;

export const AgentStateSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["running", "awaiting_approval", "done", "failed"]),
  /** Rolling summary of compacted history (progressive summarization). */
  summary: z.string(),
  /** Index into the event log: events before this are represented by summary. */
  compactedUpTo: z.number(),
  /** Tool call currently blocked on human approval, if any. */
  pendingApproval: ToolCallSchema.nullable(),
  /** Error message when status === "failed". */
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;
