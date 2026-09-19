import type { Message } from "../schemas/events.js";
import type { LLMProvider } from "./llm.js";
import type { Checkpointer } from "./checkpoint.js";
import type { AgentState } from "../schemas/events.js";

/** Progressive summarization thresholds (Agents-in-Production pattern). */
const COMPACT_AFTER_MESSAGES = 12;
const KEEP_RECENT_EVENTS = 6;

/**
 * Context hydrator: builds the prompt window as
 *   system prompt + rolling summary + recent events + injected docs.
 * When the window grows past the threshold, older events are compacted
 * into the rolling summary and the compaction pointer advances.
 */
export class ContextHydrator {
  constructor(
    private llm: LLMProvider,
    private store: Checkpointer,
  ) {}

  hydrate(state: AgentState, systemPrompt: string, docs: string[] = []): Message[] {
    const msgs: Message[] = [{ role: "system", content: systemPrompt }];
    for (const doc of docs) {
      msgs.push({ role: "system", content: `Reference document:\n${doc}` });
    }
    msgs.push(...this.store.messages(state));
    return msgs;
  }

  /** Compact if needed; returns the (possibly updated) state. */
  async maybeCompact(state: AgentState): Promise<AgentState> {
    const events = this.store.events();
    const activeCount = events.length - state.compactedUpTo;
    if (activeCount < COMPACT_AFTER_MESSAGES) return state;

    const cut = events.length - KEEP_RECENT_EVENTS;
    if (cut <= state.compactedUpTo) return state;

    const oldMessages = this.eventsToMessages(events.slice(state.compactedUpTo, cut));
    if (state.summary) {
      oldMessages.unshift({ role: "system", content: `Prior summary:\n${state.summary}` });
    }
    const summary = await this.llm.summarize(oldMessages);
    this.store.append({ type: "summary_compacted", summary, upToEvent: cut });

    const next: AgentState = {
      ...state,
      summary,
      compactedUpTo: cut,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveState(next);
    return next;
  }

  private eventsToMessages(events: ReturnType<Checkpointer["events"]>): Message[] {
    const msgs: Message[] = [];
    for (const ev of events) {
      if (ev.type === "user_message" || ev.type === "assistant_message") msgs.push(ev.message);
      if (ev.type === "tool_result") {
        msgs.push({ role: "tool", toolCallId: ev.result.callId, content: ev.result.output });
      }
    }
    return msgs;
  }
}
