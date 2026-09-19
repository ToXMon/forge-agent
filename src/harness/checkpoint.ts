import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, AgentStateSchema, type HarnessEvent, type AgentState, type Message } from "../schemas/events.js";

/**
 * Durable checkpoint store. Events are append-only JSONL (replayable);
 * state snapshots are written at every transition for instant resume.
 * File-backed (no DB dependency): .forge/sessions/<id>/
 */
export class Checkpointer {
  private dir: string;
  private eventsPath: string;
  private statePath: string;

  constructor(
    rootDir: string,
    public readonly sessionId: string,
  ) {
    this.dir = join(rootDir, ".forge", "sessions", sessionId);
    this.eventsPath = join(this.dir, "events.jsonl");
    this.statePath = join(this.dir, "state.json");
    mkdirSync(this.dir, { recursive: true });
  }

  append(event: HarnessEvent): number {
    const parsed = EventSchema.parse(event);
    const line = JSON.stringify(parsed);
    appendFileSync(this.eventsPath, line + "\n", "utf8");
    return this.eventCount() - 1;
  }

  events(): HarnessEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => EventSchema.parse(JSON.parse(l)));
  }

  eventCount(): number {
    if (!existsSync(this.eventsPath)) return 0;
    return readFileSync(this.eventsPath, "utf8").split("\n").filter(Boolean).length;
  }

  saveState(state: AgentState): void {
    AgentStateSchema.parse(state);
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  loadState(): AgentState | null {
    if (!existsSync(this.statePath)) return null;
    return AgentStateSchema.parse(JSON.parse(readFileSync(this.statePath, "utf8")));
  }

  /** Rebuild the active message window from the log: summary + events since compaction. */
  messages(state: AgentState): Message[] {
    const msgs: Message[] = [];
    if (state.summary) {
      msgs.push({
        role: "system",
        content: `Conversation summary so far (older history compacted):\n${state.summary}`,
      });
    }
    for (const ev of this.events().slice(state.compactedUpTo)) {
      if (ev.type === "user_message" || ev.type === "assistant_message") msgs.push(ev.message);
      if (ev.type === "tool_result") {
        msgs.push({
          role: "tool",
          toolCallId: ev.result.callId,
          content: ev.result.ok ? ev.result.output : `ERROR: ${ev.result.output}`,
        });
      }
    }
    return msgs;
  }

  static listSessions(rootDir: string): string[] {
    const base = join(rootDir, ".forge", "sessions");
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}
